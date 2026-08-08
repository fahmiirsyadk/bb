import { describe, expect, it } from "vitest";
import { actionPreview } from "./server";

describe("workstream action previews", () => {
  it("includes the complete pull-request destination and content", () => {
    const preview = actionPreview({
      action: "open_pr",
      targetId: "workstream-42",
      parameters: {
        repo: "acme/project",
        head: "feature/review-feedback",
        base: "main",
        title: "Address review feedback",
        body: "Please review the updated implementation.",
        draft: true,
      },
    });

    expect(preview).toContain("Repository: acme/project");
    expect(preview).toContain("Head: feature/review-feedback");
    expect(preview).toContain("Base: main");
    expect(preview).toContain("Title: Address review feedback");
    expect(preview).toContain("Draft: yes");
    expect(preview).toContain(
      "Body:\nPlease review the updated implementation.",
    );
  });

  it("rejects unsupported action previews", () => {
    expect(() =>
      actionPreview({
        action: "delete_repo",
        targetId: "repo-1",
        parameters: {},
      }),
    ).toThrow();
  });
});
