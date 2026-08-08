# React Doctor baseline findings

Generated from the full monorepo audit on 2026-08-08.

## Scope and command

```bash
npx -y react-doctor@latest --no-telemetry
```

The run selected 23 workspace projects, including `@bb/app` and the
`bb-plugin-workstreams` example, and scanned 1,510 files in 24.6 seconds. It
returned exit code `1` because findings were present. No source fixes, agent
skill installation, CI workflow, or pull request was created.

This is a full baseline, not a change-only report. The counts include existing
upstream code and should not be interpreted as regressions caused by the fork
or by React Scan. Score calculation was unavailable.

## Summary

| Category | Result |
| --- | ---: |
| Total issues | 2,233 |
| Maintainability | 1,489 warnings |
| Performance | 146 errors, 266 warnings |
| Accessibility | 51 warnings |
| Bugs | 70 errors, 209 warnings |
| Security | 2 warnings |

## Highest-volume findings

| Priority | Rule | Count | Assessment |
| --- | --- | ---: | --- |
| P1 | `react-doctor/react-compiler-no-manual-memoization` | 672 | Review manually before changing memoization; the compiler may make some existing `useMemo`/`useCallback` calls redundant, but bulk removal can change behavior or performance. |
| P1 | `react-doctor/zod-v4-no-deprecated-schema-apis` | 312 | Broad Zod 3-to-4 migration surface. Treat as a coordinated API migration with typecheck and contract tests. |
| P2 | `react-doctor/only-export-components` | 181 | Many component modules export helpers, constants, or test fixtures. Separate true Fast Refresh hazards from intentional shared-module patterns before refactoring. |
| P2 | `react-doctor/no-multi-comp` | 144 | Component colocation is widespread. Split only where it improves ownership or testability; do not mechanically create hundreds of files. |
| P1 | `react-hooks-js/refs` | 83 | React Compiler cannot safely optimize ref usage; inspect reads/writes during render first. |
| P1 | `react-hooks-js/set-state-in-effect` | 76 | State updates in effects can create extra render passes or feedback loops. Verify whether each effect is synchronizing an external system. |
| P1 | `react-doctor/no-ref-current-in-render` | 58 | Ref reads during render can violate render purity and compiler assumptions. |
| P2 | `react-doctor/js-combine-iterations` | 59 | Repeated array passes are performance opportunities, but preserve ordering and short-circuit behavior. |
| P1 | `react-hooks-js/todo` | 43 | React Compiler-incompatible syntax; each occurrence needs a local explanation or a safe rewrite. |
| P2 | `react-doctor/no-adjust-state-on-prop-change` | 64 | State derived from props is being synchronized after render; prefer deriving values or resetting state at an explicit boundary. |

## Correctness and security queue

These are the first findings to triage because they can affect data integrity,
runtime safety, or user-visible behavior:

1. `react-doctor/dangerous-html-sink` (2):
   `src/components/thread/timeline/TerminalOutputBlock.tsx:166` and
   `src/components/ui/markdown-preview.tsx:772`. Confirm the content is
   sanitized at the boundary and add malicious-input tests before suppressing
   either finding.
2. `react-doctor/no-unsafe-json-parse`: validate the parsed value immediately
   at `server.ts:857` before using its fields. The Doctor output uses
   project-relative paths, so resolve the owning project before editing.
3. `react-doctor/no-fetch-response-used-without-status-check` (5): check
   `response.ok` or an equivalent status policy before consuming response data
   in `src/lib/api.ts:192`, `src/routes/dashboard.tsx:298`,
   `app.tsx:70`, and the attachment paths reported by the scan.
4. `react-doctor/no-impure-state-updater` (7) and
   `react-doctor/no-side-effect-in-state-updater-function` (8): move I/O,
   logging, navigation, and store writes outside updater callbacks. The most
   concentrated locations include
   `src/components/thread/embedded-chat/useInlineQueuedMessageEditing.ts:99`
   and `:101`.
5. `react-doctor/effect-needs-cleanup` (3): audit subscriptions and timers in
   `src/components/ui/carousel.tsx:107`,
   `src/components/commands/AppCommandProvider.tsx:120`, and
   `src/components/promptbox/WaveformVisualizer.tsx:31`.
6. `react-doctor/no-ref-current-in-render` (58): start with
   `src/components/ui/menu-item-hover.tsx:91`, the dialog locations, and
   `PromptBoxInternal.tsx` before addressing the broader compiler backlog.

## Accessibility queue

The scan reports 51 accessibility warnings. The highest-value patterns are:

- `react-doctor/click-events-have-key-events` (14): add keyboard behavior or
  replace noninteractive click targets with native controls.
- `react-doctor/no-static-element-interactions` (12): use semantic controls
  and preserve focus/keyboard behavior.
- `react-doctor/prefer-tag-over-role` (5) and
  `react-doctor/no-redundant-roles` (9): prefer native HTML semantics before
  adding ARIA.
- `react-doctor/interactive-supports-focus` (2),
  `react-doctor/label-has-associated-control`, and
  `react-doctor/anchor-is-valid` (2): verify with keyboard-only interaction
  tests, not just snapshots.

## Maintainability and performance queue

- The 312 Zod findings should be handled by API family, beginning with shared
  contracts and test helpers, then moving into app/server/plugin boundaries.
- The 672 manual-memoization findings should be grouped by compiler rule and
  component ownership. Keep memoization that protects expensive work or
  stabilizes an intentional identity contract; remove it only with profiling
  or a clear compiler-safe replacement.
- The `only-export-components` and `no-multi-comp` findings are largely
  structural. Establish file ownership and export conventions first; otherwise
  this backlog will produce noisy churn without improving behavior.
- `react-doctor/js-combine-iterations` (59),
  `react-doctor/async-await-in-loop` (38), and
  `react-doctor/js-set-map-lookups` (30) are suitable for focused performance
  changes after correctness findings are under control.
- `deslop/unused-dev-dependency` (39), `deslop/unused-export` (52), and
  `deslop/unused-file` (9) should be cleaned up only after confirming package
  entrypoints, plugin discovery, generated files, and test-only imports.

## Recommended execution order

1. Fix and test the HTML sinks, unsafe parsing, unchecked fetch responses,
   impure updaters, and missing effect cleanup.
2. Address compiler-purity findings (`refs`, state-in-effect, unsupported
   syntax) in small ownership-based batches.
3. Run the Zod migration as a separate contract-focused batch.
4. Improve keyboard and semantic accessibility behavior, then verify with
   focused interaction tests.
5. Triage the structural/performance backlog and delete only confirmed dead
   code or dependencies.

Every batch should run the narrowest relevant tests plus the repo-required
Turbo typecheck. Do not attempt an automatic fix for all 2,233 findings in one
change.

## Ongoing fork workflow

After creating a branch in the fork, use a change-only audit so the baseline
does not block unrelated work:

```bash
npx -y react-doctor@latest --no-telemetry --diff origin/main
```

The writable remote is `origin` (`fahmiirsyadk/bb`). The original
`get-bb/bb` repository remains fetch-only. The project-scoped
`upstream-read-only` agent skill prevents agents from turning upstream review
or synchronization into a PR action.
