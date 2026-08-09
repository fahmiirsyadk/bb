import type { DiffFileEntry } from "@bb/server-contract";
import type { WorkspaceDiffTarget } from "@bb/domain";
import type {
  EnvironmentFilePreviewSource,
  WorkspaceFilePreviewStatusLabel,
} from "@/lib/file-preview";

export interface DiffFilePreviewRequest {
  path: string;
  source: EnvironmentFilePreviewSource;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
}

interface BuildDiffFilePreviewRequestArgs {
  entry: DiffFileEntry;
  mergeBaseRef: string | null;
  target: WorkspaceDiffTarget;
}

/**
 * Keep a file opened from the diff on the same side/ref that produced its
 * hunks. In particular, deleted files must never fall back to the current
 * working tree, and commit diffs must not open a similarly named working-tree
 * file by accident.
 */
export function buildDiffFilePreviewRequest({
  entry,
  mergeBaseRef,
  target,
}: BuildDiffFilePreviewRequestArgs): DiffFilePreviewRequest {
  const isDeleted = entry.changeKind === "deleted";

  switch (target.type) {
    case "uncommitted":
      return {
        path: entry.path,
        source: isDeleted ? { kind: "head" } : { kind: "working-tree" },
        statusLabel: isDeleted ? "deleted" : null,
      };
    case "branch_committed":
      return {
        path: entry.path,
        source:
          isDeleted && mergeBaseRef
            ? { kind: "merge-base", ref: mergeBaseRef }
            : { kind: "head" },
        statusLabel: isDeleted ? "deleted" : null,
      };
    case "all":
      return {
        path: entry.path,
        source:
          isDeleted && mergeBaseRef
            ? { kind: "merge-base", ref: mergeBaseRef }
            : { kind: "working-tree" },
        statusLabel: isDeleted ? "deleted" : null,
      };
    case "commit":
      return {
        path: entry.path,
        source: {
          kind: "commit",
          sha: target.sha,
          side: isDeleted ? "old" : "new",
        },
        statusLabel: isDeleted ? "deleted" : null,
      };
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
