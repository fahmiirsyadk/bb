# Handoff: remote diff file reads and unrenderable fallbacks

Status: focused implementation and QA plan

This is a narrow follow-up for the environment diff panel. It covers the
browser's full-file reads (used for context expansion and binary previews) and
the terminal states where a per-file patch cannot be rendered. It does not
redesign the workspace diff protocol or the machine-scoped plugin runtime.

## Findings from the current implementation

- `/environments/:id/diff/files` and `/diff/patch` already resolve the
  environment's canonical workspace target and route to its `hostId`. The
  server does not read the remote filesystem itself.
- `/environments/:id/diff/file` resolves a ready environment and routes the
  read to that environment's host. Working-tree reads use the root-relative
  host command; ref reads use `host.read_file` with `rootPath` and a host-native
  absolute path. Keep this split: the server may run on Linux while a remote
  environment is on Windows.
- The client carries the diff TOC's resolved `mergeBaseRef` into the file-read
  query. The query key includes environment, target/ref, path, and side, so a
  local/remote or old/new response must not be reused across cards.
- The host daemon already enforces absolute-root containment, symlink safety,
  git-ref validation, size limits, and content encoding. Keep those checks at
  the host boundary; do not weaken them to make a preview work.
- `parseGitDiffFiles` currently catches parser failures and returns an empty
  list. A loaded empty result therefore does not identify whether the patch is
  genuinely metadata-only, binary/unrenderable, or malformed. The card must
  classify this terminal state rather than treating it as a loading state.
- The shared card body has metadata/raw fallback components, but the secondary
  panel still needs to pass the raw patch and an appropriate open action through
  the fallback path. A parsed `rename-pure` file has zero hunks and must not
  fall through to an empty diff renderer.

The `@pierre/diffs` parser is intentionally best-effort by default: its
documented `throwOnError` option is false unless requested. BB therefore owns
the user-facing fallback and must not rely on a parser error being thrown. See
the [official Diffs documentation](https://diffs.com/docs).

## Read contract

The old/new side must use the exact refs that produced the diff. The server
should keep this mapping in one helper and the route tests should assert the
actual host command, not just the response body.

| Diff target        | Old side                | New side | Working-tree path            | History path                      |
| ------------------ | ----------------------- | -------- | ---------------------------- | --------------------------------- |
| `uncommitted`      | `HEAD`                  | disk     | relative to environment root | host-native absolute path + `ref` |
| `branch_committed` | resolved `mergeBaseRef` | `HEAD`   | none                         | host-native absolute path + `ref` |
| `all`              | resolved `mergeBaseRef` | disk     | relative to environment root | host-native absolute path + `ref` |
| `commit`           | `${sha}^`               | `sha`    | none                         | host-native absolute path + `ref` |

For a rename, the old read uses `previousPath` and the new read uses `path`.
For an add/delete, the missing side is an empty synthetic text side; do not
ask the host for `/dev/null`.

### Open-file source must survive a fallback

`Open file` and `Show full diff` are not source-neutral actions. They must
retain the selected environment, target, side, and resolved ref. In particular:

- a deleted file opens its old `HEAD`/merge-base content, not a missing
  working-tree path;
- branch and commit targets do not silently switch to the current working
  tree;
- a modified/added file normally opens the new side, while a rename can expose
  both old and new paths;
- a parse-error/raw fallback must open the same diff slice represented by the
  card, or label the action explicitly as `Open current file` if that is the
  only supported behavior.

The current callback shape is path-only in parts of the diff panel. Before
calling this behavior complete, either make the callback carry a typed source
(`path`, `side`, target/ref, and environment) or close over that source at the
panel boundary. Do not infer it later from the path alone.

## Fallback contract

Every loaded card keeps its TOC header and server-provided additions/deletions.
No fallback fabricates line counts from a failed parse.

Classify the body as one of:

1. `rendered`: one valid text file with hunks, or an explicitly supported
   image/SVG preview;
2. `metadata-only`: pure rename, mode-only/type-only change, or a valid file
   section with zero textual hunks;
3. `binary-unrenderable`: binary content that is not browser-previewable;
4. `parse-failed`: malformed/partial patch or a parser exception; and
5. `source-unavailable`: the remote file read failed, the host is offline, or
   the requested ref has no readable content.

For `metadata-only`, show the rename/mode/type explanation and an appropriately
scoped `Open file` action. For `binary-unrenderable`, show `Binary file` and an
open/load action. For `parse-failed`, show a bounded raw patch when it exists,
an explicit `Diff unavailable to render` message, and the scoped open action.
For `source-unavailable`, show the host/read error and a retry; do not render a
blank body or retry forever. A loaded patch—empty, malformed, or metadata-only—
must never remain a skeleton.

## Implementation slices

1. **Server route and source plumbing**
   - Keep `diff/files`, `diff/patch`, and `diff/file` on the same ready
     environment/host authorization boundary.
   - Add route tests with two enrolled hosts and distinct marker contents to
     prove that the requested remote host answered every target/side variant.
   - Assert Windows-root and POSIX-root path joining separately. Working-tree
     reads must stay relative; ref reads must include `rootPath` and a safe
     `ref`.
   - Preserve path traversal, NUL, backslash, symlink escape, invalid-ref, and
     file-size protections.

2. **Client classification and fallbacks**
   - Return a structured parse outcome (or equivalent metadata) instead of
     collapsing every parser failure into `[]`.
   - Add focused card tests for pure rename, mode-only, empty, malformed,
     binary non-image, and remote read failure. Assert no skeleton after
     `patchState.status === "loaded"`.
   - Pass raw patch text and the source-aware open callback to metadata/raw
     fallbacks. Keep the TOC stats as the only line-count authority.

3. **Source-aware open actions**
   - Thread `{ environmentId, target, targetRef, path, side }` (or an equivalent
     typed object) from `GitDiffTabContent` through `DiffFilesPanel` and
     `DiffFileCard`.
   - Test deleted, branch, and commit fallback actions specifically; these are
     the cases most likely to regress into a working-tree read.

4. **Remote manual QA**
   - Use a project source on a second host whose checkout has a marker absent
     from the server host. Exercise uncommitted, branch/all, commit, rename,
     add, delete, binary image, and unknown binary cards.
   - Disconnect the remote daemon while expanding context. Verify one bounded
     unavailable/retry state and recovery after reconnect; no local marker or
     stale host response may appear.

No host command shape change is required when the existing relative-read and
`host.read_file.ref` commands are reused. If a new command or field is added,
increment `HOST_DAEMON_PROTOCOL_VERSION` and add mixed-version coverage before
shipping.

## Regression and acceptance matrix

| Case                               | Expected result                                                                              | Suggested coverage               |
| ---------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------- |
| Diff TOC on a secondary host       | `diff/files` uses that host's `hostId`; no server-local filesystem access                    | server route test with two hosts |
| Per-file patch on a secondary host | `diff/patch` uses the same environment host/workspace target                                 | server route test                |
| Working-tree old/new               | `uncommitted`: old reads `HEAD`, new reads disk; `all`: old merge base, new disk             | route assertions for command/ref |
| Branch/commit old/new              | branch old=`mergeBaseRef`, new=`HEAD`; commit old=`sha^`, new=`sha`                          | route table test                 |
| Moved branch after TOC             | file contents still come from the TOC's exact merge-base SHA                                 | server + client requester test   |
| Rename                             | old side requests `previousPath`; new side requests `path`                                   | requester/card test              |
| Add/delete                         | missing side is empty; delete fallback opens old ref                                         | requester + UI interaction test  |
| Windows remote root                | `C:\repo\file` reaches the Windows daemon; no POSIX join corruption                          | server route test                |
| POSIX remote root                  | `/repo/file` remains POSIX-safe                                                              | server route test                |
| Traversal/symlink/unsafe ref       | request is rejected by server or daemon; no host escape                                      | route + host-daemon tests        |
| Image binary                       | remote bytes map to image preview and size stat                                              | requester/card test              |
| Unknown binary                     | no text renderer; clear binary/open or load fallback                                         | card test                        |
| Pure rename/mode-only              | metadata explanation; no blank diff or infinite skeleton                                     | parser/card test                 |
| Empty or malformed patch           | terminal raw/error fallback, optional scoped open action                                     | parser/card test                 |
| Parser best-effort partial result  | partial output is not silently presented as a complete diff; raw/error fallback is available | parser fixture test              |
| Remote read failure                | bounded source-unavailable error and retry; no local fallback                                | card/query test                  |
| Loaded patch state                 | `loaded` always exits skeleton, including `""` and parse failure                             | card test                        |
| Cached side isolation              | environment + target/ref + path + side prevent cross-host/side reuse                         | query-key test                   |
| Source-aware open                  | deleted/branch/commit actions preserve old/new ref; no silent working-tree switch            | panel interaction test           |

## Acceptance criteria

- A diff opened for a remote environment never reads the server's filesystem.
- Every file-side read is attributable to the selected environment host and the
  exact diff target/ref.
- Old/new and rename paths are correct for all four target types.
- A loaded unrenderable patch produces a useful terminal fallback within one
  render; it never spins a skeleton indefinitely.
- Metadata, binary, parse-failed, and source-unavailable states are distinct in
  the UI and in diagnostics.
- Open-file and Show-full-diff actions preserve target/ref/side, especially for
  deleted files and committed diff views.
- Traversal, symlink, unsafe-ref, encoding, and size protections remain intact.
- Existing workspace diff splitting/per-file fallback tests continue to pass;
  add the remote route and card regressions before calling the patch complete.

## Non-goals

- Moving diff parsing into the host daemon.
- Replacing `@pierre/diffs` or changing its default parser policy globally.
- Adding a cross-machine content cache or server-side copy of remote files.
- Solving the broader machine-scoped plugin runtime in this patch.
