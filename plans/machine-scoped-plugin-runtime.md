# Plan: machine-scoped plugin runtime

Status: architecture plan; implement in vertical slices

Interim GitHub correction:
[github-plugin-machine-status-patch-handoff.md](github-plugin-machine-status-patch-handoff.md)

## Outcome

Make plugin availability, execution, configuration, credentials, and data
follow the machine selected by a thread or composer, while keeping BB's server
as the authoritative control plane.

The target is not "copy every plugin everywhere." A plugin package is
registered and versioned once by the BB server. Plugins that need host-local
capabilities additionally have an explicitly enabled, version-matched worker
on each selected machine.

```text
BB server: GitHub plugin 0.2.0
  ├─ VM-ubuntu  enabled · ready · gh user A
  ├─ void-PC    enabled · needs authentication
  └─ build-01   not enabled
```

Switching the active machine in the new-thread composer, or opening a thread
on another environment, changes the effective plugin set immediately.

## Three machines, three GitHub identities

The machine boundary is also the credential boundary. For example:

```text
VM-ubuntu  · GitHub login alice  · repos repo-a
void-PC    · GitHub login bob    · repos repo-b
build-01   · GitHub login ci-bot · repos repo-c
```

Each machine runs its own local `gh auth login`; BB never receives the token
and never attempts to "switch" one machine's account into another. A request
for `repo-a` is routed to `VM-ubuntu`, where GitHub sees `alice`. A request for
`repo-b` is routed to `void-PC`, where GitHub sees `bob`.

The UI must show the identity as host-scoped metadata, such as `bob on
void-PC`, and may only show a safe login name or account fingerprint returned
by the worker. It must never display, persist, or compare tokens.

When the user switches the composer from `void-PC` to `VM-ubuntu`, the active
GitHub context changes with it:

1. the server resolves the selected host from the composer environment;
2. the server verifies GitHub is enabled and ready on that host;
3. mentions, panel queries, tools, and actions route to that host;
4. results are tagged and cached, if at all, under `github + hostId + repo`;
5. data from the previous host is removed from the active view or explicitly
   labeled as an aggregate from another host.

An aggregate view over all three machines must be opt-in and visibly label the
machine/account for every result. The safe initial default is one selected
machine, not a silent fan-out.

If the same repository is present on multiple machines, the binding must be
explicit. Repository name alone is not a safe routing key because the copies
can have different branches, permissions, or GitHub identities. Prefer the
project source/environment binding; otherwise show a conflict and ask the
user to choose a machine.

Keep these two concepts separate in the implementation:

- **Repository owner host**: where BB discovered a particular checkout and
  where local `git` inspection should run.
- **Execution host**: the host selected by the current thread/composer
  environment.

For a thread operating on a local checkout, they normally match. If they do
not match, the server must apply an explicit policy: either route the GitHub
operation to the execution host and require that its checkout/repository is
available, or present a host/source choice. It must not silently use the
repository owner's credentials while the user believes they selected another
machine. The chosen policy should be encoded in the operation contract and
shown in the UI.

This is different from the interim GitHub patch. The interim patch routes
project-discovered repositories to their owning hosts, but its one
`defaultProject` fallback cannot assign arbitrary extra repositories to three
different machines and its server-side panel/cache is still global.

## Product invariants

1. Credentials and machine-local secrets never leave their machine.
2. Machine plugin content is not persisted in the central server database.
3. One machine's failure does not degrade the same plugin on another machine.
4. Every plugin operation has an explicit, server-authorized execution scope.
5. The client cannot select an arbitrary host ID and bypass thread, project,
   user, or machine permissions.
6. Plugin package version and worker protocol version are observable and
   compatible before work is routed.
7. Server-global plugins remain possible; machine scoping is not forced onto
   integrations whose data is genuinely shared.
8. Every end-user operation ships through UI, SDK, and `bb` CLI surfaces.
9. A disconnected machine produces an offline state, not missing data or a
   global configuration error.
10. Server/daemon wire changes always increment
    `HOST_DAEMON_PROTOCOL_VERSION`.

## Runtime classes

Add an experimental manifest declaration while the contract is audited:

```jsonc
{
  "bb": {
    "experimental_runtime": {
      "kind": "server" | "machine" | "hybrid"
    }
  }
}
```

- `server`: backend, state, and credentials intentionally live at the server.
  Existing plugins retain this behavior during migration.
- `machine`: backend worker and state live on enabled machines. The server
  serves metadata/UI and routes typed operations.
- `hybrid`: a server coordinator may contribute shared UI/policy while
  machine workers own local commands, credentials, and machine data.

GitHub should become `hybrid` initially, with all GitHub API access and caches
inside its machine worker. A Tasks plugin chooses its class from the data it
owns: shared team tasks can remain `server`; filesystem-backed tasks are
`machine`; shared task metadata plus repository inspection is `hybrid`.

Document `experimental_runtime` in `docs/api_to_audit.md` before exposing it.
Audit whether more explicit capabilities are preferable to three broad kinds
before stabilization.

## Ownership model

### Server control plane

The server owns:

- plugin catalog source, artifact, version, and frontend bundle;
- desired per-machine enablement;
- permission and consent policy;
- routing from thread/composer context to an authorized host;
- compatibility and update coordination;
- BB-native references such as plugin-to-thread attribution;
- aggregate health metadata that contains no plugin content or secrets.

The server must not own, for a machine-scoped worker:

- third-party credentials;
- raw local configuration secrets;
- GitHub issues, pull requests, task files, or repository indexes;
- a cross-machine content cache;
- an unscoped background sync loop.

### Host daemon

The host daemon owns only generic host-local primitives:

- install/verify a versioned worker artifact supplied by the server;
- start, stop, and supervise isolated plugin workers;
- expose typed invoke/configure/status operations over the daemon channel;
- maintain plugin-local storage under the daemon's server-scoped data dir;
- enforce declared executable/filesystem/network capabilities;
- report bounded, redacted diagnostics.

Product policy and plugin-specific orchestration remain server/plugin code;
the daemon must not acquire GitHub- or Tasks-specific behavior.

### Plugin machine worker

The worker owns:

- local CLI and credential access;
- machine-specific settings and secrets;
- local schedules and background services;
- machine-local content caches and indexes;
- validation/translation between plugin operations and local tools.

## Persistent model

Keep the existing `plugins` row as the server registration. Add a separate
desired-binding table rather than adding nullable machine fields to the global
row:

```text
plugin_machine_bindings
  plugin_id       FK-like plugin identity
  host_id         enrolled host identity
  enabled         explicit desired state
  created_at
  updated_at
  PRIMARY KEY (plugin_id, host_id)
```

Do not persist live worker state in that table. Connected/offline, starting,
ready, needs-configuration, version mismatch, and failure are live daemon
observations. If historical diagnostics are later required, design an
explicit bounded event log rather than overloading desired state.

Machine settings live in the worker's local data directory, namespaced by BB
server identity and plugin ID. The central server may persist a schema and a
redacted indication that a value is set, but not its value. Team-global
settings continue to use the existing server plugin settings store.

The settings schema must declare scope per field rather than infer it:

```ts
scope: "server" | "machine"
```

No optional scope with an internal guess: the server boundary fills the
explicit default for legacy descriptors.

Generate schema migrations with Drizzle. Do not edit snapshot JSON manually.
Use in-memory SQLite plus real migrations in database tests.

## Execution context and routing

Introduce one internal execution-context value resolved at the server
boundary:

```ts
type PluginExecutionContext = {
  hostId: string;
  projectId: string | null;
  threadId: string | null;
  principalId: string | null;
};
```

The exact identity field should reuse BB's real authorization principal when
multi-user authorization is available; do not invent a fake user scope.

Resolution rules:

- existing thread: resolve the environment and use its host;
- new-thread composer: resolve the current environment selection using the
  same canonical resolver used for thread creation;
- project surface: use a selected machine-backed project source;
- global plugin panel: require an explicit machine selection or an explicit
  aggregate mode;
- CLI: require `--machine` when neither a thread nor a project resolves one;
- agent tool execution: use the current thread/session host, never a caller
  supplied arbitrary host ID.

Every RPC, mention search/resolve, native tool, command, panel action, and
background operation must either receive this context or be declared
server-global. Accepted-but-ignored context fields are forbidden.

The server verifies:

1. the principal can access the thread/project;
2. the host is the canonical host for that context;
3. the plugin binding is enabled on that host;
4. the worker is connected and compatible;
5. the requested operation is declared by the plugin artifact.

## Frontend adaptation

Plugin frontend code can still be downloaded once from the server. Its
contributions are filtered by an effective-machine availability snapshot.

The app already resolves the selected environment/host in composer and thread
surfaces. Extend the plugin composer/view context with a read-only effective
plugin execution context; do not create a second host-selection algorithm.

When the machine changes:

- composer actions and banners re-filter;
- plugin mentions query the newly selected worker;
- machine tools unavailable on that worker disappear or show a reason;
- a mounted global panel changes to the selected machine or asks explicitly;
- drafts remain intact;
- no plugin is silently executed on the previous machine.

Distinguish these UI states:

- available;
- not enabled on this machine;
- installing/updating;
- machine offline;
- worker incompatible;
- needs configuration on this machine;
- blocked by permission/consent.

Do not reuse the server-global plugin lifecycle status for them.

## Worker protocol

Add typed daemon commands/events for generic worker management. Names are
illustrative; finalize them in `@bb/host-daemon-contract`:

- ensure a content-addressed worker artifact/version;
- enable/start and disable/stop a worker;
- query worker inventory and live status;
- invoke one declared operation with validated input;
- read/update machine-scoped non-secret settings;
- initiate a machine-local secret/configuration interaction;
- stream bounded result/events and cancellation;
- remove unused worker artifacts with recoverable retention.

Do not send shell strings. A plugin worker operation is versioned and typed.
If a lower-level executable capability remains, keep argv, cwd, timeout,
output bounds, executable allowlist, redaction, and audit metadata explicit.

The first implementation of any of these messages increments
`HOST_DAEMON_PROTOCOL_VERSION`. Add tests proving an old daemon is rejected
and automatically updated instead of entering an invalid-message loop.

## Installation and updates

Installing from the catalog registers one canonical server artifact. Enabling
it on a machine then:

1. shows requested worker permissions and machine target;
2. records desired binding after consent;
3. asks the connected daemon to ensure the exact worker artifact;
4. verifies content hash, BB compatibility, and plugin worker protocol;
5. starts the worker;
6. reports machine-local configuration state;
7. activates machine-filtered contributions only when routing is safe.

Updates are coordinated by the server so UI and workers do not drift. Roll
out one machine at a time, retain the previous content-addressed artifact for
rollback, and never route new-schema operations to an old worker.

Offline machines retain desired bindings and update when they reconnect.
Removing server access to a machine makes all its bindings unavailable; it
does not pretend to erase an offline machine's disk. A future local uninstall
operation must clearly state its recoverability and offline behavior.

## Configuration UX

The plugin detail page gets two levels:

- global registration: version, source, update, server-global settings;
- Machines: one row per enrolled machine with enablement and live status.

Selecting a machine shows only that machine's settings. Secret setup happens
through a local interaction or an exact command displayed for that machine.
For GitHub:

> GitHub is enabled on `void-PC`, but GitHub CLI is not authenticated there.

The user can Retry check, configure locally, disable on that machine, or
enable on another machine. A healthy VM remains healthy when `void-PC` fails.

## SDK and CLI parity

Ship the end-user workflow through supported SDK and CLI surfaces in the same
slices as the UI. Candidate CLI surface:

```text
bb plugin machines <plugin-id>
bb plugin enable <plugin-id> --machine <host-id-or-name>
bb plugin disable <plugin-id> --machine <host-id-or-name>
bb plugin config <plugin-id> --machine <host-id-or-name> get
bb plugin config <plugin-id> --machine <host-id-or-name> set <key> <value>
bb plugin status <plugin-id> --machine <host-id-or-name>
```

Machine-local secrets must not be accepted as ordinary CLI argv values. Use a
local interactive flow, stdin, or provider-owned authentication such as
`gh auth login`.

Update every surface required by `docs/cli-guide-and-skill.md`, including the
generated guide/templates and builtin CLI/agent skills. Public plugin API
members remain `experimental_` and get entries in `docs/api_to_audit.md`.

## Security decisions required before broad rollout

- Per-machine consent for worker installation and declared capabilities.
- Authorization when several BB users share a server or one daemon.
- Whether a plugin can use network access directly or only declared host
  operations.
- Filesystem roots visible to a worker.
- Worker process isolation and resource limits.
- Output size, cancellation, concurrency, rate limiting, and audit records.
- Redaction rules for stdout/stderr and crash diagnostics.
- Windows service PATH/executable resolution.
- Artifact signing/content verification and downgrade policy.

Do not stabilize `bb.hosts.experimental_runCommand` until this worker model
decides whether arbitrary declared executables remain part of the public API.

## Migration strategy

### Phase 0: interim correctness

Land the linked GitHub patch. It fixes misleading global status without new
runtime contracts.

### Phase 1: bindings and contextual availability

- Add `plugin_machine_bindings` and server routes.
- Add machine rows to plugin management.
- Add UI/SDK/CLI enable and disable operations.
- Resolve effective host from composer/thread context.
- Filter contributions by desired binding and connectivity.
- Keep existing plugin backends server-side during this phase.

This phase proves product semantics before worker transport is added. Do not
claim local credentials/state isolation yet.

### Phase 2: generic host worker runtime

- Define the worker artifact and operation contracts.
- Implement daemon supervision, local storage, diagnostics, cancellation, and
  compatibility checks.
- Add server routing and protocol-version bump.
- Add per-machine settings and local configuration interactions.
- Exercise reconnect, offline update, rollback, and mixed daemon versions.

### Phase 3: migrate GitHub

- Move all `gh`/`git` calls into the machine worker.
- Move issue/PR/viewer/label/assignee caches to that worker.
- Discover repositories per machine and return raw validated metadata.
- Keep only BB-owned issue-to-thread references centrally.
- Make panels, mentions, tools, and refresh use effective machine context.
- Remove GitHub's global `needs-configuration` and global sync service.
- Verify no GitHub content or credential is persisted centrally.

### Phase 4: migrate Tasks and other host-dependent plugins

Classify each plugin from its data ownership instead of copying GitHub:

- server-global task store stays server scoped;
- repository/file-backed tasks become machine scoped;
- hybrid plugins split shared coordination from local inspection.

Add migration adapters only where old user data has a defined destination.
Never silently duplicate global settings onto every machine.

### Phase 5: stabilize and remove legacy seams

- Audit and stabilize or replace experimental APIs.
- Remove obsolete global host-command paths when no plugin needs them.
- Remove migration-only compatibility code.
- Update authoring templates, skill, official plugin docs, system overview,
  lifecycle diagrams, and manual QA catalog.

## Test strategy

### Database and server

- Binding CRUD and host/plugin uniqueness using in-memory migrated SQLite.
- Destroyed/re-enrolled host identity does not inherit an old binding.
- Authorization rejects a client-supplied host outside canonical context.
- One failed worker does not affect another binding.
- Server-global plugins remain unchanged.
- Settings scope is explicit and machine secrets never enter server storage.

### Contract and daemon

- Full parser coverage for every new command, result, and event.
- Mixed protocol versions trigger update/rejection cleanly.
- Artifact hash/version mismatch fails closed.
- Worker cancellation, crash restart bounds, output limits, and redaction.
- Offline desired binding installs exactly once after reconnect.
- Windows, Linux, and macOS local storage/process lifecycle.

### App

- Switching composer machine changes plugin availability without losing draft.
- Existing thread always uses its environment host.
- Global panel requires explicit machine or aggregate mode.
- Machine-specific errors render independently.
- Install/configure/update/retry states are accessible and recoverable.

### Plugin migration

- GitHub identities differ across two machines without cross-contamination.
- Repository data from host A never appears as host B data.
- An offline host does not erase cached data on its own disk or working data
  from host B.
- Tasks fixtures cover server, machine, and hybrid ownership choices.

Use Turbo for all builds/typechecks. Pipe slow tests to files and inspect the
results. Add manual multi-machine QA to `plans/plugin-system-qa-catalog.md` as
each vertical slice lands.

## Release gates

The rebuild is ready for general use only when:

- machine binding is visible and manageable in UI, SDK, and CLI;
- active thread/composer host is the sole default execution target;
- a failing machine cannot globally degrade a plugin;
- secrets and scoped content have verified storage boundaries;
- daemon update and offline reconnect paths are tested on Windows and Linux;
- GitHub no longer keeps its content cache in the server process;
- shared-server authorization has an explicit policy;
- documentation no longer describes a server-global plugin as installed "on"
  every machine.

## Explicit non-goals

- Running plugin frontend React code inside the daemon.
- Letting plugins choose arbitrary hosts without server authorization.
- Duplicating the full catalog/download pipeline independently per machine.
- Making every plugin machine scoped.
- Persisting third-party content centrally merely to support an aggregate
  panel.
- Hiding offline, incompatible, or unconfigured states behind a generic
  `needs-configuration` badge.

## Open decisions

1. Worker isolation: child process with OS controls, worker thread, or a more
   constrained runtime. Child process is the practical first candidate, but
   the security review must decide.
2. Aggregate views: live fan-out only, machine-selected only, or an opt-in
   central index. Machine-selected is the safest initial behavior.
3. Settings transport: generic typed setting operations versus
   plugin-defined configuration interactions. Use generic non-secret settings
   plus explicit local secret interactions initially.
4. Worker artifact composition: separate machine entry in the plugin package
   versus deriving it from the backend bundle. Prefer an explicit entry and
   compatibility metadata.
5. Multi-user identity: one machine worker per daemon, per user, or per
   authenticated principal. This must be resolved before credentials can be
   safely shared on an internal multi-user server.
