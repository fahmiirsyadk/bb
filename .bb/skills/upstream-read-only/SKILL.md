---
name: upstream-read-only
description: Enforce a fetch-and-inspect-only workflow for a parent Git remote. Use when an agent synchronizes a fork, retrieves upstream commits, reviews upstream branches or pull requests, or encounters push, merge, or pull-request actions.
---

# Upstream Read-Only

Treat the parent repository as a source of commits and review data only. Keep
all changes and any explicitly approved publishing work on the fork's
`origin`; never turn an upstream read into a write or a pull request.

## Required workflow

1. Inspect both remote URLs before acting:

   ```bash
   git remote -v
   git remote get-url --fetch upstream
   git remote get-url --push upstream
   ```

2. Retrieve upstream commits with `git fetch --no-tags upstream <ref>`. Do not
   use `git pull upstream`; fetching must not change the current branch.
3. Inspect fetched data with `git show`, `git log`, `git diff`, or `git
   branch --contains`. Keep the result in `FETCH_HEAD` or a remote-tracking
   ref unless the user explicitly asks to integrate it.
4. If the task asks for a PR, merge, review submission, branch push, or any
   other upstream mutation, stop and report that the upstream-read-only policy
   blocks it. Do not reinterpret “sync” or “retrieve” as permission to publish.

## Allowed operations

- `git fetch upstream <branch-or-commit>` and `git ls-remote upstream`.
- Read-only inspection of `upstream/*`, `FETCH_HEAD`, and upstream commit
  objects.
- Read-only GitHub queries such as `gh pr view` or `gh pr list` when the
  repository is explicitly specified.
- Creating a local Markdown finding, patch, test, or analysis artifact in the
  fork workspace.

## Forbidden operations

- `git push upstream` or any push to a URL resolving to `get-bb/bb`.
- `gh pr create`, `gh pr edit`, `gh pr close`, `gh pr merge`, or `gh pr review`
  targeting `get-bb/bb`.
- GitHub API mutations against the parent repository (`POST`, `PATCH`, or
  `DELETE` requests).
- `git pull`, merge, rebase, or cherry-pick from upstream unless the user
  explicitly changes the task from retrieval to local integration.
- `react-doctor install`, `react-doctor ci install`, or CI configuration that
  would add PR reporting when the requested task is only a read-only audit.

## Retrieving one upstream commit

Use this sequence and stop after inspection:

```bash
git fetch --no-tags upstream <branch-or-commit>
git show --stat --oneline FETCH_HEAD
git show FETCH_HEAD:<path>
```

If the user asks to apply that commit to the fork, ask for explicit approval
to cherry-pick or merge it. That is a separate local mutation, not retrieval.

## Safe React Doctor usage

For a local audit, use the read-only command:

```bash
npx -y react-doctor@latest --no-telemetry
```

For fork-branch regression checks, use `--diff origin/main`. Do not run the
install or CI subcommands as part of a scan; they can add agent skills or
workflow/PR automation.
