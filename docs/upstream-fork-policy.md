# Upstream fork policy

This checkout is the maintained `fahmiirsyadk/bb` fork of `get-bb/bb`.

## Remote policy

- `origin` is the writable fork: `https://github.com/fahmiirsyadk/bb.git`.
- `upstream` is the source repository: `https://github.com/get-bb/bb.git`.
- Git's default push remote is `origin`.
- The local `upstream` push URL is intentionally unusable. Use `git fetch
  upstream` for updates; do not push to upstream.

The local remote configuration is not stored in Git history, so recreate this
policy after cloning:

```bash
git remote set-url origin https://github.com/fahmiirsyadk/bb.git
git remote add upstream https://github.com/get-bb/bb.git
git config remote.pushDefault origin
git config remote.upstream.pushurl file:///C:/Users/void/Documents/GitHub/bb/.git/upstream-push-disabled
```

## Pull-request policy

- Do not run `gh pr create --repo get-bb/bb`.
- Do not install or enable automation that opens or comments on pull requests
  in the upstream repository.
- The project-scoped `upstream-read-only` agent skill blocks upstream write
  operations and requires an explicit user request before any PR action.
- Fetching and reviewing upstream code is allowed; publishing changes goes to
  the fork and is an explicit, separately approved action.

When checking new work against the fork baseline, use a fork branch and run
React Doctor in diff mode against `origin/main`. Keep upstream synchronization
as a fetch/merge operation, never as a PR target.
