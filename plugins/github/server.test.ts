import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRpcContract } from "@bb/plugin-sdk";
import type { PluginRpcClient, PluginRpcHandlers } from "@bb/plugin-sdk";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import {
  default as githubPlugin,
  githubRpcContract,
  parsePaginatedGhApi,
  validateGithubCliArgs,
} from "./server";

type GithubRpcHandlers = PluginRpcHandlers<typeof githubRpcContract>;

function assertGithubFrontendInference(
  client: PluginRpcClient<typeof githubRpcContract>,
) {
  expectTypeOf(
    client.call("getPull", { repo: "get-bb/bb", number: 694 }),
  ).toEqualTypeOf<
    Promise<{
      pull: {
        repo: string;
        number: number;
        title: string;
        state: string;
        author: string;
        body: string;
        url: string;
        createdAt: string;
        updatedAt: string;
        baseRefName: string;
        headRefName: string;
        additions: number;
        deletions: number;
        changedFiles: number;
        labels: string[];
        assignees: string[];
        reviewDecision: string;
        mergeStateStatus: string;
        reviewRequests: string[];
        checks: Array<{
          name: string;
          status: "success" | "failure" | "pending" | "neutral";
          url: string;
        }>;
        comments: Array<{ author: string; body: string; createdAt: string }>;
        reviews: Array<{
          author: string;
          state: string;
          body: string;
          createdAt: string;
        }>;
        reviewThreads: Array<{
          path: string;
          line: number | null;
          diffHunk: string;
          comments: Array<{
            author: string;
            body: string;
            createdAt: string;
          }>;
        }>;
        files: Array<{
          path: string;
          status: string;
          additions: number;
          deletions: number;
          patch: string | null;
        }>;
      };
    }>
  >();

  // @ts-expect-error issue numbers must be numeric.
  void client.call("getIssue", { repo: "get-bb/bb", number: "694" });
  // @ts-expect-error unknown filter values are rejected by the contract.
  void client.call("listItems", { kind: "discussion" });
}

describe("GitHub RPC contract", () => {
  it("discovers and authenticates repositories on their owning BB host", async () => {
    const commands: Array<{
      hostId: string;
      executable: string;
      args: string[];
    }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "github",
      sdk: {
        projects: {
          list: () => [
            {
              id: "proj_remote",
              sources: [
                {
                  id: "src_remote",
                  projectId: "proj_remote",
                  type: "local_path",
                  hostId: "host_remote",
                  path: "/work/repo",
                  isDefault: true,
                },
              ],
            },
          ],
        },
      },
      runHostCommand: async (hostId, input) => {
        commands.push({ hostId, executable: input.executable, args: input.args });
        return {
          exitCode: 0,
          stdout:
            input.executable === "git" ? "git@github.com:get-bb/bb.git\n" : "",
          stderr: "",
        };
      },
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      ghOk: true,
      hosts: [{ hostId: "host_remote", ok: true, error: null }],
      repos: [{ repo: "get-bb/bb", projectId: "proj_remote" }],
    });
    expect(commands).toEqual([
      {
        hostId: "host_remote",
        executable: "git",
        args: ["-C", "/work/repo", "remote", "get-url", "origin"],
      },
      {
        hostId: "host_remote",
        executable: "gh",
        args: ["auth", "status"],
      },
    ]);
    await harness.dispose();
  });

  it("flattens every paginated GitHub API page", () => {
    expect(
      parsePaginatedGhApi(
        JSON.stringify([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]),
      ),
    ).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

    expect(() => parsePaginatedGhApi(JSON.stringify([{ id: 1 }]))).toThrow(
      "malformed page",
    );
  });

  it("rejects CLI arguments that would otherwise broaden a repository query", () => {
    expect(validateGithubCliArgs(["issues", "get-bb/bb"])).toBeNull();
    expect(validateGithubCliArgs(["issues", "bad/repo/shape"])).toContain(
      "expected owner/repo",
    );
    expect(validateGithubCliArgs(["prs", "get-bb/bb", "extra"])).toContain(
      "Unexpected argument",
    );
    expect(validateGithubCliArgs(["repos", "--json"])).toContain(
      "does not accept arguments",
    );
  });

  it("infers parsed handler inputs and frontend results", () => {
    expectTypeOf<
      Parameters<GithubRpcHandlers["createIssue"]>[0]
    >().toEqualTypeOf<{
      repo: string;
      title: string;
      body?: string;
    }>();
    expectTypeOf(assertGithubFrontendInference).toBeFunction();
  });

  it("rejects invalid method inputs and outputs at runtime", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-contract",
    });
    const contract = defineRpcContract({
      startWork: githubRpcContract.startWork,
    });
    bb.rpc.register(contract, {
      startWork() {
        return { threadId: "" };
      },
    });

    await expect(
      harness.callRpc("startWork", {
        repo: "not-a-repository",
        number: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("startWork", { repo: "get-bb/bb", number: 694 }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
});
