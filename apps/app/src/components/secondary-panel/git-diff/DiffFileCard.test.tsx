// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffFileEntry } from "@bb/server-contract";
import type {
  DiffFileContentsResult,
  RequestDiffFileContents,
} from "@/components/git-diff/GitDiffCardBody";
import type { DiffPatchState } from "@/hooks/queries/use-environment-diff-patches";
import { DiffFileCard } from "./DiffFileCard";

const IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/Qo3AAAAAElFTkSuQmCC";

function buildEntry(overrides: Partial<DiffFileEntry> = {}): DiffFileEntry {
  return {
    path: "src/file.ts",
    previousPath: null,
    changeKind: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    origin: "tracked",
    loadMode: "auto",
    ...overrides,
  };
}

function renderCard({
  entry,
  onLoadPatch = vi.fn(),
  onRequestFileContents,
  onOpenFilePreview,
  patchState = { status: "idle" },
}: {
  entry: DiffFileEntry;
  onLoadPatch?: () => void;
  onRequestFileContents?: RequestDiffFileContents;
  onOpenFilePreview?: (path: string) => void;
  patchState?: DiffPatchState;
}) {
  render(
    <DiffFileCard
      entry={entry}
      diffViewOptions={{}}
      isCollapsed={false}
      onToggleCollapsed={() => {}}
      patchState={patchState}
      onLoadPatch={onLoadPatch}
      onRetry={() => {}}
      onOpenFilePreview={onOpenFilePreview}
      onRequestFileContents={onRequestFileContents}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("DiffFileCard", () => {
  it("previews on-demand binary images without loading the binary patch", async () => {
    const imageResult: DiffFileContentsResult = {
      kind: "image",
      dataUrl: IMAGE_DATA_URL,
      sizeBytes: 20_480,
    };
    const onLoadPatch = vi.fn();
    const onRequestFileContents = vi.fn<RequestDiffFileContents>(
      async () => imageResult,
    );

    renderCard({
      entry: buildEntry({
        path: "assets/logo.png",
        changeKind: "added",
        additions: 0,
        deletions: 0,
        binary: true,
        loadMode: "on_demand",
      }),
      onLoadPatch,
      onRequestFileContents,
    });

    const preview = await screen.findByRole("img", {
      name: "assets/logo.png",
    });

    expect(preview.getAttribute("src")).toBe(IMAGE_DATA_URL);
    expect(screen.queryByText("Load diff")).toBeNull();
    expect(onLoadPatch).not.toHaveBeenCalled();
    expect(onRequestFileContents).toHaveBeenCalledTimes(1);
    expect(onRequestFileContents).toHaveBeenCalledWith(
      "assets/logo.png",
      "new",
    );
  });

  it("keeps the load gate for non-image binary files", async () => {
    const onLoadPatch = vi.fn();
    const onRequestFileContents = vi.fn<RequestDiffFileContents>(async () => ({
      kind: "image",
      dataUrl: IMAGE_DATA_URL,
      sizeBytes: 20_480,
    }));

    renderCard({
      entry: buildEntry({
        path: "assets/archive.bin",
        additions: 0,
        deletions: 0,
        binary: true,
        loadMode: "on_demand",
      }),
      onLoadPatch,
      onRequestFileContents,
    });

    await waitFor(() => {
      expect(screen.getByText("Binary file.")).toBeTruthy();
    });
    expect(screen.getByText("Load diff")).toBeTruthy();
    expect(onRequestFileContents).not.toHaveBeenCalled();
  });

  it("falls back to the load gate when an image-looking path is not previewable", async () => {
    const onLoadPatch = vi.fn();
    const onRequestFileContents = vi.fn<RequestDiffFileContents>(
      async () => null,
    );

    renderCard({
      entry: buildEntry({
        path: "assets/not-actually-image.png",
        additions: 0,
        deletions: 0,
        binary: true,
        loadMode: "on_demand",
      }),
      onLoadPatch,
      onRequestFileContents,
    });

    await waitFor(() => {
      expect(screen.getByText("Binary file.")).toBeTruthy();
    });
    expect(screen.getByText("Load diff")).toBeTruthy();
    expect(onRequestFileContents).toHaveBeenCalledTimes(2);
    expect(onLoadPatch).not.toHaveBeenCalled();
  });

  it("renders metadata for a loaded empty patch instead of a dead end", async () => {
    const onOpenFilePreview = vi.fn();
    renderCard({
      entry: buildEntry({
        path: "src/new-name.ts",
        previousPath: "src/old-name.ts",
        changeKind: "renamed",
        additions: 0,
        deletions: 0,
      }),
      onOpenFilePreview,
      patchState: { status: "loaded", patch: "", truncated: false },
    });

    expect(await screen.findByText("Metadata-only change")).toBeTruthy();
    expect(
      screen.getByText("Renamed from src/old-name.ts to src/new-name.ts."),
    ).toBeTruthy();
    expect(screen.queryByText("No renderable diff for this file.")).toBeNull();
    screen.getByRole("button", { name: "Open file" }).click();
    expect(onOpenFilePreview).toHaveBeenCalledWith("src/new-name.ts");
  });

  it("shows malformed or truncated patch text with an open-file fallback", async () => {
    const onOpenFilePreview = vi.fn();
    const rawPatch = "not a parseable unified diff";
    renderCard({
      entry: buildEntry(),
      onOpenFilePreview,
      patchState: { status: "loaded", patch: rawPatch, truncated: true },
    });

    expect(await screen.findByText("Raw diff")).toBeTruthy();
    expect(
      screen.getByText("This patch was truncated before it could be rendered."),
    ).toBeTruthy();
    expect(screen.getByText(rawPatch)).toBeTruthy();
    screen.getByRole("button", { name: "Show full diff" }).click();
    expect(onOpenFilePreview).toHaveBeenCalledWith("src/file.ts");
  });
});
