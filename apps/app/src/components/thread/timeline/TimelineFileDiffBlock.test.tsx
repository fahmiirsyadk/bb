// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineFileChange } from "@bb/server-contract";
import { TimelineFileDiffBlock } from "./TimelineFileDiffBlock";

function buildChange(
  overrides: Partial<TimelineFileChange> = {},
): TimelineFileChange {
  return {
    path: "src/new.ts",
    kind: "renamed",
    movePath: "src/old.ts",
    diff: null,
    diffStats: { added: 0, removed: 0 },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("TimelineFileDiffBlock", () => {
  it("renders metadata when a rename has no textual patch", () => {
    render(
      <TimelineFileDiffBlock
        change={buildChange()}
        themeType="dark"
        workspaceRootPath={undefined}
      />,
    );

    expect(screen.getByText("File metadata")).toBeTruthy();
    expect(
      screen.getByText("Renamed from src/old.ts to src/new.ts."),
    ).toBeTruthy();
    expect(screen.queryByText("No diff available.")).toBeNull();
  });

  it("keeps malformed non-metadata text visible as a raw fallback", () => {
    const rawPatch = "malformed patch payload";
    render(
      <TimelineFileDiffBlock
        change={buildChange({
          kind: "modified",
          movePath: null,
          diff: rawPatch,
        })}
        themeType="dark"
        workspaceRootPath={undefined}
      />,
    );

    expect(screen.getByText(rawPatch)).toBeTruthy();
    expect(screen.queryByText("No diff available.")).toBeNull();
  });
});
