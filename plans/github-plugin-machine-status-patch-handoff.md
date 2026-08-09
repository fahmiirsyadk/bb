# Handoff: GitHub plugin machine-status patch

Status: ready for implementation

Related long-term plan:
[machine-scoped-plugin-runtime.md](machine-scoped-plugin-runtime.md)

## Purpose

Ship a narrow correction for the GitHub plugin's current contradictory and
misleading state while the machine-scoped plugin runtime is being designed.
This patch must make the existing hybrid implementation understandable and
usable, but must not add more server-global behavior that later has to be
unwound.

The patch is intentionally not the machine-plugin rebuild. GitHub commands
continue to use the existing `bb.hosts.experimental_runCommand` bridge, and
the plugin backend continues to load on the BB server for this interim slice.

## Current failure

The plugin can currently show combinations such as:

- `needs-configuration` in the plugin detail page;
- `0 machines` in the GitHub panel;
- `Sync failed — check gh auth status`;
- an instruction to authenticate on the repository's BB machine, without
  identifying a usable machine or explaining that repository discovery found
  none.

The implementation has four distinct state bugs behind that presentation:

1. `checkAuth()` derives its host list from discovered project repositories.
   Therefore `0 machines` means "zero repository-owning hosts discovered",
   not "zero BB machines enrolled".
2. `ghAuthByHost` is retained across checks. Removed or replaced host IDs can
   remain visible after repository discovery changes.
3. A failure on any discovered host calls `bb.status.needsConfiguration`,
   which marks the one server-global plugin instance unhealthy even when
   another host works.
4. Repository discovery, machine availability, `gh` installation, `gh`
   authentication, and sync failures are collapsed into one message.

Relevant implementation:

- [`plugins/github/server.ts`](../plugins/github/server.ts)
- [`plugins/github/app.tsx`](../plugins/github/app.tsx)
- [`plugins/github/server.test.ts`](../plugins/github/server.test.ts)
- [`plugins/github/README.md`](../plugins/github/README.md)

## Patch behavior

### 1. Keep plugin lifecycle status global and machine health local

Do not call `bb.status.needsConfiguration` merely because `gh` is missing,
unauthenticated, a host is offline, or a repository sync fails on one host.
Those are per-machine operational states and belong in the GitHub status RPC
and panel.

Reserve plugin-level `needs-configuration` for configuration that prevents the
plugin factory itself from providing any useful surface, such as malformed
required global settings. With the current optional settings, the GitHub
plugin should normally remain `running` and explain its machine state inside
the panel.

This prevents one machine from disabling GitHub for every machine.

### 2. Replace the ambiguous status shape

Replace the current `ghOk`, `ghError`, and loosely populated `hosts` fields
with an explicit discriminated per-host result. Keep the type local to the
GitHub RPC contract.

Suggested shape:

```ts
type GithubHostStatus = {
  hostId: string;
  repositories: string[];
  state:
    | "ready"
    | "offline"
    | "gh-not-installed"
    | "gh-not-authenticated"
    | "check-failed";
  detail: string | null;
};

type GithubStatus = {
  discovery:
    | { state: "ready" }
    | { state: "no-repositories"; detail: string }
    | { state: "failed"; detail: string };
  hosts: GithubHostStatus[];
  repositories: Array<{
    repo: string;
    projectId: string | null;
    hostId: string;
  }>;
  lastSyncedAt: string | null;
};
```

Do not add optional fields to hide defaults. Every variant must carry the
fields its UI needs, and the RPC boundary must validate the full result.

The interim status list is explicitly "repository machines," not "all BB
machines." Label it that way in the UI. Enumerating all enrolled machines and
installing a plugin onto them belongs to the rebuild plan, not this patch.

### Three-machine behavior during the interim

Assume three enrolled machines:

```text
VM-ubuntu  → project source owner/repo-a → gh identity alice
void-PC    → project source owner/repo-b → gh identity bob
build-01   → project source owner/repo-c → gh identity ci-bot
```

Each machine must be authenticated locally with its own `gh auth login`.
When the plugin handles `repo-a`, `repo-b`, or `repo-c`, it routes the command
to that repository's `hostId`; it does not copy or switch credentials on the
server. The GitHub login identity should be displayed as part of that host's
status when it can be obtained without exposing a token.

The interim implementation has two deliberate limitations:

- `extraRepos` has one `defaultProject`, so repositories that are not attached
  to project sources all fall back to that one project's machine. They cannot
  be assigned independently to three machines yet.
- The panel may still show an aggregate of all discovered repositories. It is
  not an active-machine view, and changing the composer machine does not yet
  filter every GitHub surface.

If the same GitHub repository is discovered on more than one machine, the
interim code must report an explicit routing conflict and require a project
source/machine choice. It must not silently keep whichever host happened to be
visited first, because the three machines may have different GitHub identities
and permissions.

The machine-scoped rebuild removes these limitations with explicit per-machine
bindings and machine-local caches. Until then, do not describe the aggregate
panel as representing one GitHub account.

### 3. Recompute status from scratch

Each forced refresh and authentication check must construct a new map and
replace the old snapshot only after the check completes. Do not mutate and
retain `ghAuthByHost` across topology changes.

Repository discovery should return a typed result instead of catching every
error and returning an empty list. An empty list and a failed discovery are
different user-visible states.

Classify command failures deliberately:

- host RPC unavailable/offline;
- executable not found;
- `gh auth status` reports unauthenticated;
- other command/check failure.

If the existing host-command result cannot distinguish those cases reliably,
use conservative matching only at this boundary and retain the raw sanitized
detail under `check-failed`. Do not change the daemon contract just for nicer
copy in this interim patch.

### 4. Make the empty state actionable

When no repositories are discovered, show:

> No GitHub repository machines are configured. Add a machine-backed source
> to a BB project. Extra repositories also require a Default BB project so BB
> knows which machine should run GitHub CLI.

Do not show `gh auth` instructions when there is no host on which BB can run
the check.

For each discovered host, show its independent state and the repositories
routed to it. Until host display names are available through a supported
plugin API, display the host ID without claiming it is a friendly machine
name.

### 5. Refresh and recovery

The panel's Refresh action must:

1. invalidate repository discovery;
2. rebuild the per-host authentication snapshot;
3. sync only repositories whose host is ready;
4. retain successful results from ready hosts even if another host fails;
5. publish the normal data-changed signal after the snapshot is replaced.

The refresh response should report partial success instead of throwing one
aggregate error that makes the entire UI look unavailable.

Saving `extraRepos` or `defaultProject` must invalidate discovery and status.
The existing automatic reload after saving a needs-configuration plugin must
not be required for ordinary GitHub machine recovery.

## Server-neutrality boundary for this patch

Be explicit in the UI and documentation about what this patch does not solve:

- GitHub credentials remain on repository machines and are accessed through
  their local `gh` CLI.
- The server process still temporarily holds the plugin's in-memory
  issue/pull-request cache.
- BB still persists plugin settings and issue-to-thread links centrally.
- There is still one server-global plugin installation and frontend
  registration.

Do not describe the server as holding no GitHub data until the cache is moved
to a machine worker. "Not persisted" and "never present on the server" are
different guarantees.

## Tests

Add focused tests in `plugins/github/server.test.ts` for behavior with actual
bug risk:

- no project repositories produces `discovery: no-repositories` and no false
  authentication failure;
- one ready host and one unauthenticated host reports both independently and
  keeps the plugin usable;
- a removed host disappears after forced discovery/status refresh;
- a host changing from unauthenticated to ready recovers without plugin
  reload;
- an offline host does not discard items synced from a ready host;
- changing `defaultProject` invalidates the extra-repository host mapping;
- discovery failure is not represented as an empty repository list;
- status and refresh RPC results pass their zod contracts.

Add focused app tests for:

- the no-repositories empty state;
- independent machine rows and partial-success messaging;
- absence of the global `needs-configuration` instruction for a per-host auth
  failure;
- Refresh changing a failed machine row to ready.

Use Turbo for build, typecheck, and tests. Pipe slow test output to a file.

## Documentation surfaces

Update together:

- `plugins/github/README.md`;
- the generated/discoverable plugin guide if its GitHub behavior is described
  there;
- the plugin CLI/agent skill only if a CLI command, flag, or configuration
  behavior changes.

Do not introduce a new public plugin API in this patch. If implementation
proves that one is unavoidable, prefix it with `experimental_`, add it to
`docs/api_to_audit.md`, and stop to reassess whether that work belongs in the
runtime rebuild instead.

## Acceptance criteria

- The UI never uses `0 machines` to mean `0 discovered repository hosts`.
- One failing machine never marks GitHub unavailable on a working machine.
- Removed/re-enrolled host IDs do not remain in GitHub status.
- The user can recover after `gh auth login` using Refresh, without a plugin
  reload.
- No GitHub credential is read or stored by the BB server.
- The patch does not add a daemon wire field or message. If implementation
  changes anything sent between server and daemon, increment
  `HOST_DAEMON_PROTOCOL_VERSION` and add mixed-version coverage.

## Non-goals

- Per-machine plugin installation or enablement.
- Filtering all plugin contributions by the active composer machine.
- Machine-local plugin settings or storage.
- Moving the GitHub background worker/cache off the server.
- Aggregating multiple users' GitHub identities.
- Treating a repository-owning host as proof that the plugin is installed on
  that host.
