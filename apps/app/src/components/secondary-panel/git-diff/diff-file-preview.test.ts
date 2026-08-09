import { describe, expect, it } from "vitest";
import type { DiffFileEntry } from "@bb/server-contract";
import type { WorkspaceDiffTarget } from "@bb/domain";
import { buildDiffFilePreviewRequest } from "./diff-file-preview";

function buildEntry(changeKind: DiffFileEntry["changeKind"]): DiffFileEntry {
  return {
    path: "src/file.ts",
    previousPath: null,
    changeKind,
    additions: 1,
    deletions: 1,
    binary: false,
    origin: "tracked",
    loadMode: "auto",
  };
}

function resolve(
  target: WorkspaceDiffTarget,
  changeKind: DiffFileEntry["changeKind"],
  mergeBaseRef: string | null = null,
) {
  return buildDiffFilePreviewRequest({
    entry: buildEntry(changeKind),
    mergeBaseRef,
    target,
  });
}

describe("buildDiffFilePreviewRequest", () => {
  it("opens deleted uncommitted files from HEAD", () => {
    expect(resolve({ type: "uncommitted" }, "deleted")).toEqual({
      path: "src/file.ts",
      source: { kind: "head" },
      statusLabel: "deleted",
    });
  });

  it("uses the resolved merge base for deleted branch changes", () => {
    expect(
      resolve(
        { type: "branch_committed", mergeBaseBranch: "origin/main" },
        "deleted",
        "abc1234",
      ),
    ).toEqual({
      path: "src/file.ts",
      source: { kind: "merge-base", ref: "abc1234" },
      statusLabel: "deleted",
    });
  });

  it("opens commit changes from the commit side that exists", () => {
    expect(resolve({ type: "commit", sha: "abc1234" }, "deleted")).toEqual({
      path: "src/file.ts",
      source: { kind: "commit", sha: "abc1234", side: "old" },
      statusLabel: "deleted",
    });
    expect(resolve({ type: "commit", sha: "abc1234" }, "modified")).toEqual({
      path: "src/file.ts",
      source: { kind: "commit", sha: "abc1234", side: "new" },
      statusLabel: null,
    });
  });
});
