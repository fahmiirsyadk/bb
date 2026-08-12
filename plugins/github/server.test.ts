import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRpcContract } from "@bb/plugin-sdk";
import type { PluginRpcClient, PluginRpcHandlers } from "@bb/plugin-sdk";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import {
  default as githubPlugin,
  fetchRepoItems,
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
        commands.push({
          hostId,
          executable: input.executable,
          args: input.args,
        });
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
      discovery: { state: "ready" },
      hosts: [
        {
          hostId: "host_remote",
          repositories: ["get-bb/bb"],
          state: "ready",
          detail: null,
          login: null,
        },
      ],
      repositories: [
        { repo: "get-bb/bb", projectId: "proj_remote", hostId: "host_remote" },
      ],
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

  it("distinguishes an empty repository topology from an authentication failure", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-empty",
      sdk: { projects: { list: () => [] } },
      runHostCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      discovery: {
        state: "no-repositories",
        detail: expect.stringContaining("No GitHub repository machines"),
      },
      hosts: [],
      repositories: [],
    });
    expect(harness.needsConfigurationMessages).toEqual([]);
    await harness.dispose();
  });

  it("uses the machine name in host command errors", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-machine-error-name",
      sdk: {
        hosts: {
          get: () => ({ id: "host_remote", name: "void-PC" }),
        },
        projects: {
          list: () => [
            {
              id: "proj_remote",
              sources: [
                {
                  id: "src_remote",
                  projectId: "proj_remote",
                  type: "local_path" as const,
                  hostId: "host_remote",
                  path: "/work/repo",
                  isDefault: true,
                },
              ],
            },
          ],
        },
      },
      runHostCommand: async (_hostId, input) =>
        input.executable === "git"
          ? {
              exitCode: 0,
              stdout: "https://github.com/acme/repo.git\n",
              stderr: "",
            }
          : {
              exitCode: 1,
              stdout: "",
              stderr: "unexpected gh failure",
            },
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      hosts: [
        expect.objectContaining({
          hostId: "host_remote",
          detail: expect.stringContaining("void-PC"),
        }),
      ],
    });
    await harness.dispose();
  });

  it("ignores non-GitHub checkouts without turning discovery into an error", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-non-github-source",
      sdk: {
        projects: {
          list: () => [
            {
              id: "proj-docs",
              sources: [
                {
                  id: "src-docs",
                  projectId: "proj-docs",
                  type: "local_path" as const,
                  hostId: "host-docs",
                  path: "/work/docs",
                  isDefault: true,
                },
              ],
            },
          ],
        },
      },
      runHostCommand: async (_hostId, input) =>
        input.executable === "git"
          ? {
              exitCode: 1,
              stdout: "",
              stderr: "fatal: No such remote 'origin'",
            }
          : { exitCode: 0, stdout: "", stderr: "" },
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      discovery: { state: "no-repositories" },
      hosts: [],
      repositories: [],
    });
    await harness.dispose();
  });

  it("shows an unavailable repository host even when its git remote cannot be read", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-discovery-host-failure",
      sdk: {
        projects: {
          list: () => [
            {
              id: "proj-offline",
              sources: [
                {
                  id: "src-offline",
                  projectId: "proj-offline",
                  type: "local_path" as const,
                  hostId: "host-offline",
                  path: "/work/offline",
                  isDefault: true,
                },
              ],
            },
          ],
        },
      },
      runHostCommand: async () => {
        throw new Error("host host-offline is offline");
      },
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      discovery: { state: "failed" },
      hosts: [
        expect.objectContaining({ hostId: "host-offline", state: "offline" }),
      ],
      repositories: [],
    });
    await harness.dispose();
  });

  it("reports authentication independently for multiple repository machines", async () => {
    const projects = [
      {
        id: "proj-alice",
        sources: [
          {
            id: "src-alice",
            projectId: "proj-alice",
            type: "local_path" as const,
            hostId: "host-alice",
            path: "/work/alice",
            isDefault: true,
          },
        ],
      },
      {
        id: "proj-bob",
        sources: [
          {
            id: "src-bob",
            projectId: "proj-bob",
            type: "local_path" as const,
            hostId: "host-bob",
            path: "/work/bob",
            isDefault: true,
          },
        ],
      },
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-host-status",
      sdk: { projects: { list: () => projects } },
      runHostCommand: async (hostId, input) => {
        if (input.executable === "git") {
          return {
            exitCode: 0,
            stdout:
              hostId === "host-alice"
                ? "https://github.com/acme/alice.git\n"
                : "https://github.com/acme/bob.git\n",
            stderr: "",
          };
        }
        if (hostId === "host-bob") {
          return {
            exitCode: 1,
            stdout: "You are not logged into any GitHub hosts.\n",
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: "Logged in to github.com account alice (keyring)\n",
          stderr: "",
        };
      },
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      discovery: { state: "ready" },
      hosts: [
        {
          hostId: "host-alice",
          repositories: ["acme/alice"],
          state: "ready",
          login: "alice",
        },
        {
          hostId: "host-bob",
          repositories: ["acme/bob"],
          state: "gh-not-authenticated",
          detail: expect.stringContaining("gh auth login"),
          login: null,
        },
      ],
      repositories: [
        { repo: "acme/alice", projectId: "proj-alice", hostId: "host-alice" },
        { repo: "acme/bob", projectId: "proj-bob", hostId: "host-bob" },
      ],
    });
    expect(harness.needsConfigurationMessages).toEqual([]);
    await harness.dispose();
  });

  it("removes a host from the status snapshot after forced discovery", async () => {
    let projects: Array<Record<string, unknown>> = [
      {
        id: "proj-remote",
        sources: [
          {
            id: "src-remote",
            projectId: "proj-remote",
            type: "local_path" as const,
            hostId: "host-remote",
            path: "/work/repo",
            isDefault: true,
          },
        ],
      },
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-topology",
      sdk: { projects: { list: () => projects } },
      runHostCommand: async (hostId, input) => {
        if (input.executable === "git") {
          return {
            exitCode: 0,
            stdout: "https://github.com/acme/repo.git\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "[]", stderr: "" };
      },
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      hosts: [{ hostId: "host-remote" }],
    });
    projects = [];
    await harness.callRpc("refresh", null);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      discovery: { state: "no-repositories" },
      hosts: [],
      repositories: [],
    });
    await harness.dispose();
  });

  it("recovers a host from unauthenticated to ready without plugin reload", async () => {
    let authenticated = false;
    const projects = [
      {
        id: "proj-remote",
        sources: [
          {
            id: "src-remote",
            projectId: "proj-remote",
            type: "local_path" as const,
            hostId: "host-remote",
            path: "/work/repo",
            isDefault: true,
          },
        ],
      },
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-recovery",
      sdk: { projects: { list: () => projects } },
      runHostCommand: async (_hostId, input) => {
        if (input.executable === "git") {
          return {
            exitCode: 0,
            stdout: "https://github.com/acme/repo.git\n",
            stderr: "",
          };
        }
        if (input.args[0] === "auth" && !authenticated) {
          return { exitCode: 1, stdout: "not logged in\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "[]", stderr: "" };
      },
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      hosts: [{ state: "gh-not-authenticated" }],
    });
    authenticated = true;
    await harness.callRpc("refresh", null);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      hosts: [{ state: "ready" }],
    });
    expect(harness.needsConfigurationMessages).toEqual([]);
    await harness.dispose();
  });

  it("does not discard ready-host items when another host is offline", async () => {
    let offline = false;
    const projects = [
      {
        id: "proj-ready",
        sources: [
          {
            id: "src-ready",
            projectId: "proj-ready",
            type: "local_path" as const,
            hostId: "host-ready",
            path: "/work/ready",
            isDefault: true,
          },
        ],
      },
      {
        id: "proj-offline",
        sources: [
          {
            id: "src-offline",
            projectId: "proj-offline",
            type: "local_path" as const,
            hostId: "host-offline",
            path: "/work/offline",
            isDefault: true,
          },
        ],
      },
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-partial-refresh",
      sdk: { projects: { list: () => projects } },
      runHostCommand: async (hostId, input) => {
        if (input.executable === "git") {
          return {
            exitCode: 0,
            stdout: `https://github.com/acme/${hostId === "host-ready" ? "ready" : "offline"}.git\n`,
            stderr: "",
          };
        }
        if (hostId === "host-offline" && offline) {
          throw new Error("host host-offline is offline");
        }
        if (input.args[0] === "auth") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return hostId === "host-ready"
          ? {
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  number: 7,
                  title: "Keep this item",
                  state: "OPEN",
                  author: { login: "alice" },
                  labels: [],
                  assignees: [],
                  url: "https://github.com/acme/ready/issues/7",
                  body: "body",
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              ]),
              stderr: "",
            }
          : { exitCode: 0, stdout: "[]", stderr: "" };
      },
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("refresh", null)).resolves.toMatchObject({
      repos: 2,
      items: 2,
      failedHosts: [],
    });
    const signalsAfterFirstRefresh = harness.realtimeSignals.length;
    offline = true;
    await expect(harness.callRpc("refresh", null)).resolves.toMatchObject({
      repos: 2,
      items: 2,
      failedHosts: [
        expect.objectContaining({
          hostId: "host-offline",
          detail: expect.any(String),
        }),
      ],
    });
    expect(harness.realtimeSignals.length).toBeGreaterThan(
      signalsAfterFirstRefresh,
    );
    await expect(
      harness.callRpc("listItems", { kind: "issue" }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ repo: "acme/ready", number: 7 })],
    });
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      hosts: expect.arrayContaining([
        expect.objectContaining({ hostId: "host-offline", state: "offline" }),
        expect.objectContaining({ hostId: "host-ready", state: "ready" }),
      ]),
    });
    await harness.dispose();
  });

  it("invalidates extra repository routing when the default project changes", async () => {
    const projects = [
      {
        id: "proj-one",
        sources: [
          {
            id: "src-one",
            projectId: "proj-one",
            type: "local_path" as const,
            hostId: "host-one",
            path: "/work/one",
            isDefault: true,
          },
        ],
      },
      {
        id: "proj-two",
        sources: [
          {
            id: "src-two",
            projectId: "proj-two",
            type: "local_path" as const,
            hostId: "host-two",
            path: "/work/two",
            isDefault: true,
          },
        ],
      },
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-default-project",
      settings: { extraRepos: "acme/extra", defaultProject: "proj-one" },
      sdk: { projects: { list: () => projects } },
      runHostCommand: async (_hostId, input) =>
        input.executable === "git"
          ? {
              exitCode: 0,
              stdout: "https://example.com/not-github.git\n",
              stderr: "",
            }
          : { exitCode: 0, stdout: "", stderr: "" },
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      repositories: [{ repo: "acme/extra", hostId: "host-one" }],
    });
    await harness.setSettings({ defaultProject: "proj-two" });
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      repositories: [{ repo: "acme/extra", hostId: "host-two" }],
    });
    await harness.dispose();
  });

  it("reports discovery errors instead of converting them to an empty state", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-discovery-error",
      sdk: {
        projects: {
          list: () => {
            throw new Error("project database unavailable");
          },
        },
      },
      runHostCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      discovery: {
        state: "failed",
        detail: expect.stringContaining("project database unavailable"),
      },
      repositories: [],
      hosts: [],
    });
    await harness.dispose();
  });

  it("rejects duplicate repository ownership across machines", async () => {
    const projects = [
      {
        id: "proj-one",
        sources: [
          {
            id: "src-one",
            projectId: "proj-one",
            type: "local_path" as const,
            hostId: "host-one",
            path: "/work/one",
            isDefault: true,
          },
        ],
      },
      {
        id: "proj-two",
        sources: [
          {
            id: "src-two",
            projectId: "proj-two",
            type: "local_path" as const,
            hostId: "host-two",
            path: "/work/two",
            isDefault: true,
          },
        ],
      },
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-conflict",
      sdk: { projects: { list: () => projects } },
      runHostCommand: async () => ({
        exitCode: 0,
        stdout: "https://github.com/acme/shared.git\n",
        stderr: "",
      }),
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      discovery: {
        state: "failed",
        detail: expect.stringContaining("multiple BB machines"),
      },
      hosts: [],
      repositories: [],
    });
    await harness.dispose();
  });

  it("keeps pull requests when a repository has GitHub Issues disabled", async () => {
    const calls: string[][] = [];
    const openPulls = JSON.stringify([
      {
        number: 17,
        title: "Keep syncing pull requests",
        state: "OPEN",
        author: { login: "octocat" },
        labels: [{ name: "bug" }],
        assignees: [],
        url: "https://github.com/acme/widgets/pull/17",
        body: "",
        updatedAt: "2026-08-10T00:00:00Z",
      },
    ]);

    const items = await fetchRepoItems(async (args) => {
      calls.push(args);
      if (args[0] === "issue") {
        throw new Error(
          "gh issue list failed: the 'acme/widgets' repository has disabled Issues",
        );
      }
      return args.includes("open") ? openPulls : "[]";
    }, "acme/widgets");

    expect(calls).toHaveLength(4);
    expect(calls.filter(([kind]) => kind === "pr")).toHaveLength(2);
    expect(items).toEqual([
      expect.objectContaining({
        repo: "acme/widgets",
        number: 17,
        kind: "pr",
        title: "Keep syncing pull requests",
      }),
    ]);
  });

  it("starts a review on the repository's owning machine", async () => {
    const projects = [
      {
        id: "proj-review",
        kind: "standard" as const,
        sources: [
          {
            id: "src-review",
            projectId: "proj-review",
            type: "local_path" as const,
            hostId: "host-review",
            path: "/work/review",
            isDefault: true,
          },
        ],
      },
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-review-routing",
      sdk: {
        projects: { list: () => projects },
        threads: { spawn: () => ({ id: "thr-review" }) },
      },
      runHostCommand: async (hostId, input) => {
        expect(hostId).toBe("host-review");
        if (input.executable === "git") {
          return {
            exitCode: 0,
            stdout: "https://github.com/acme/review.git\n",
            stderr: "",
          };
        }
        if (input.args[0] === "auth") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args[0] === "pr" && input.args.includes("open")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                number: 42,
                title: "Review this change",
                state: "OPEN",
                author: { login: "alice" },
                labels: [],
                assignees: [],
                url: "https://github.com/acme/review/pull/42",
                body: "Please review",
                updatedAt: "2026-08-12T00:00:00Z",
              },
            ]),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "[]", stderr: "" };
      },
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("refresh", null)).resolves.toMatchObject({
      repos: 1,
      items: 1,
    });
    await expect(
      harness.callRpc("startReview", { repo: "acme/review", number: 42 }),
    ).resolves.toEqual({ threadId: "thr-review" });
    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: "proj-review",
      environment: {
        type: "host",
        hostId: "host-review",
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    });
    await harness.dispose();
  });

  it("routes extra repositories using the Personal project host", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-personal-routing",
      settings: {
        extraRepos: "acme/extra",
        defaultProject: "proj_personal",
      },
      sdk: {
        projects: {
          list: () => [
            {
              id: "proj_personal",
              kind: "personal" as const,
              sources: [],
            },
          ],
        },
        system: { config: () => ({ primaryHostId: "host-primary" }) },
        threads: { spawn: () => ({ id: "thr-personal-review" }) },
      },
      runHostCommand: async (hostId, input) => {
        expect(hostId).toBe("host-primary");
        return input.args[0] === "auth"
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: "[]", stderr: "" };
      },
    });

    await githubPlugin(bb);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      repositories: [
        { repo: "acme/extra", projectId: null, hostId: "host-primary" },
      ],
    });
    await expect(
      harness.callRpc("startReview", { repo: "acme/extra", number: 7 }),
    ).resolves.toEqual({ threadId: "thr-personal-review" });
    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: "proj_personal",
      environment: {
        type: "host",
        hostId: "host-primary",
        workspace: { type: "personal" },
      },
    });
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
