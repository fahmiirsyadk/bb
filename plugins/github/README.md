# bb-plugin-github

GitHub issues and pull requests inside BB, with one-click agent dispatch.

Install it from the BB Official catalog:

```sh
bb plugin install github
```

## What it does

- **Sidebar panel** (GitHub logo, full width): Issues and Pull requests tabs
  across every tracked repo, with a repo filter (persisted in localStorage)
  and a New issue form.
- **Issue detail**: markdown body, comments, comment box, status,
  assignee, and label editing, plus "Send agent".
  Deep-linkable via the URL hash: `#/issues/<owner>/<repo>/<number>`.
- **Send agent / Review with agent**: spawns a BB worker thread on the issue
  (or a review thread on the PR) in the repo's BB project. The issue/PR then
  shows a ⚡ pill linking to the thread.
- **Homepage section**: recent open issues with the same Send agent buttons.
- **Mentions**: `@` or `#` in any composer completes GitHub issues and PRs; the
  selected item's title/body/state is attached as agent context at send time.
- **`bb github` CLI**: `repos`, `issues [repo]`, `prs [repo]`, `sync` — also
  discoverable by agents through the plugin-commands skill.

## Auth

Uses the GitHub CLI on each repository's owning BB machine. Install `gh` and
run `gh auth login` on that machine. The central BB server neither supplies nor
stores the credential. Status is reported per repository machine.

BB does not switch a GitHub account on the server. The account used for an
operation is the account that the local `gh` CLI selects on the host mapped to
that repository. For example, with three project sources:

| BB machine | Local GitHub identity | Repositories routed there |
| --- | --- | --- |
| `VM-ubuntu` | `alice` | `owner/repo-a` |
| `void-PC` | `bob` | `owner/repo-b` |
| `build-01` | `ci-bot` | `owner/repo-c` |

When BB reads or changes `owner/repo-b`, it invokes `gh` on `void-PC`; it does
not copy `bob`'s token to the server or use `alice`'s credentials. To change
the identity for a host, run the GitHub CLI authentication flow on that host
(for a host with multiple saved accounts, use `gh auth switch --hostname
github.com --user <login>`), then press **Refresh** in the GitHub panel. A
plugin reload is not required for ordinary authentication recovery.

The interim plugin has no active-machine selector for its global panel. Its
panel is an aggregate of repositories discovered from project sources, and a
repository operation follows the repository's owning source host. Switching a
machine in the composer does not yet filter every GitHub panel, mention, or
cached-result surface. This is intentional interim behavior; active-machine
routing belongs to the
[machine-scoped plugin runtime plan](../../plans/machine-scoped-plugin-runtime.md).
Because the aggregate may contain multiple GitHub identities, the current-user
(`assignee:@me`) filter is unavailable when more than one repository machine
is present; use an explicit assignee until machine selection is added.

## Which repos are tracked

- Every BB project source whose checkout has a GitHub `origin` remote
  (repo → project mapping is also how spawn picks the project).
- Plus the `extraRepos` setting: comma-separated `owner/repo` list. These run
  on the machine that owns the configured `defaultProject` source.
- `defaultProject` setting: where threads spawn, and which machine handles
  extra repositories that have no attached project source.

The `extraRepos` fallback has one `defaultProject`, not one project per extra
repository. Therefore all unattached extra repositories use that project's
machine and that machine's GitHub identity. They cannot be independently
assigned to three machines until the machine-scoped runtime is available.
Avoid configuring the same `owner/repo` on more than one project source while
using this interim implementation: repository name alone is not enough to
choose safely between hosts with different identities or permissions. The
patch should report such a duplicate as an explicit routing conflict rather
than silently choosing one source.

```
bb plugin config github set extraRepos "owner/repo, owner/other"
bb plugin reload github
```

A background service refreshes an in-memory issue/PR cache every 5 minutes;
GitHub content is not persisted in the central server's plugin database. This
means the cache is not durable, but its content is still temporarily present
in the BB server process. The panel's Refresh button (or `bb github sync`)
forces a refresh. The machine-scoped rebuild will move this cache and related
viewer/label data to machine-local workers.

## Three-machine verification

To verify that identities stay on their intended hosts, create one
machine-backed project source per host, give each checkout a distinct GitHub
repository, and authenticate locally:

```text
VM-ubuntu  → owner/repo-a → `gh auth status` shows alice
void-PC    → owner/repo-b → `gh auth status` shows bob
build-01   → owner/repo-c → `gh auth status` shows ci-bot
```

Refresh the GitHub panel and check the machine rows. A missing or offline host
must be shown as that host's problem; it must not hide repositories that sync
successfully on the other two hosts. After authenticating the failed host,
press Refresh again and confirm that its row becomes ready without reloading
the plugin. The status label refers to repository-owning machines, not every
enrolled BB machine.

## Development

Run the checks from the repository root:

```sh
pnpm exec turbo run typecheck test --filter=bb-plugin-github
```
