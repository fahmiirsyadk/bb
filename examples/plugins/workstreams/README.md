# Workstreams plugin

This is a standalone BB plugin prototype for agent-led task and GitHub
workflow coordination. It deliberately lives under `examples/plugins` so it
can be installed and evolved independently of BB's bundled Tasks and GitHub
plugins.

It provides:

- workstreams assigned to a responsible BB thread/agent;
- ordered checklists and explicit blocker/review-blocker records;
- review snapshots from `gh`, with review feedback sent back to the assigned
  thread and review blockers tracked locally;
- preview-first actions for commit, open PR, mark ready, merge, and archive;
- one-time, expiring confirmation tokens for every mutating action;
- both `bb workstreams ...` commands and a small Workstreams app panel.

The plugin owns its SQLite database. It does not import the internal RPC
contract of the bundled GitHub or Tasks plugins, and it never performs a
mutating action without an explicit confirmation token.

## Local WSL2 loop

From the BB checkout:

```bash
bb plugin install ./examples/plugins/workstreams
bb plugin dev ./examples/plugins/workstreams
```

The source checkout already supplies the workspace SDK types. For a separate
plugin repository, run `bb plugin types` in the plugin directory and install
its declared dependencies before `bb plugin build`.

Useful commands:

```bash
bb workstreams list --json
bb workstreams create --title "Review worker" --thread thr_... --agent agent-...
bb workstreams show ws_... --json
bb workstreams checklist add ws_... --title "Run checks"
bb workstreams checklist transition chk_... --status done
bb workstreams blocker add ws_... --kind review_blocker --title "Checks" --description "CI is pending"
bb workstreams blocker transition blk_... --status resolved
bb workstreams review ws_... --repo owner/repo --pr 42
bb workstreams action request ws_... merge environment-... --params-json '{"method":"squash"}'
bb workstreams action confirm cnf_... --token '<one-time-token>' --thread thr_...
```

`review` may call `gh pr view` and may send the resulting summary to the
responsible BB thread. GitHub CLI authentication and repository access remain
the user's responsibility. Action execution is never implicit; inspect the
preview and confirm it separately.
