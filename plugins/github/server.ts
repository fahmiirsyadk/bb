// bb-plugin-github — GitHub issues & pull requests inside BB.
//
// Auth rides on the GitHub CLI: if `gh auth status` passes, the plugin
// works. Repos are discovered from BB project sources (each local checkout's
// `origin` remote) plus an optional extraRepos setting. A background service
// syncs open + recently-closed issues/PRs into process memory;
// the frontend panel and mention providers read that cache, while
// mutations (comment, create, close/reopen, assign, label) and detail views go
// straight through `gh`.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

const SYNC_INTERVAL_MS = 5 * 60_000;
const ISSUE_PAGE = 100;
const CLOSED_ISSUE_PAGE = 50;
const PR_PAGE = 50;
const CLOSED_PR_PAGE = 30;

const repoNameSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const itemNumberSchema = z.number().int().positive();
const itemInputSchema = z
  .object({ repo: repoNameSchema, number: itemNumberSchema })
  .strict();
const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
const repoInfoSchema = z
  .object({
    repo: repoNameSchema,
    projectId: z.string().nullable(),
    hostId: z.string().min(1),
  })
  .strict();
const githubHostStateSchema = z.enum([
  "ready",
  "offline",
  "gh-not-installed",
  "gh-not-authenticated",
  "check-failed",
]);
const githubHostStatusSchema = z
  .object({
    hostId: z.string().min(1),
    repositories: z.array(repoNameSchema),
    state: githubHostStateSchema,
    detail: z.string().nullable(),
    login: z.string().min(1).nullable(),
  })
  .strict();
const githubDiscoverySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready") }).strict(),
  z
    .object({
      state: z.literal("no-repositories"),
      detail: z.string().min(1),
    })
    .strict(),
  z.object({ state: z.literal("failed"), detail: z.string().min(1) }).strict(),
]);
const itemSchema = z
  .object({
    repo: repoNameSchema,
    number: itemNumberSchema,
    kind: z.enum(["issue", "pr"]),
    title: z.string(),
    state: z.string(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const syncResultSchema = z
  .object({
    repos: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
    failedHosts: z.array(
      z
        .object({
          hostId: z.string().min(1),
          detail: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
const okResultSchema = z.object({ ok: z.literal(true) }).strict();
const commentSchema = z
  .object({ author: z.string(), body: z.string(), createdAt: z.string() })
  .strict();
const threadLinkSchema = z
  .object({
    kind: z.enum(["issue", "pr"]),
    repo: repoNameSchema,
    number: itemNumberSchema,
    threadId: z.string().min(1),
    createdAt: z.string(),
  })
  .strict();
const pullSchema = z
  .object({
    repo: repoNameSchema,
    number: itemNumberSchema,
    title: z.string(),
    state: z.string(),
    author: z.string(),
    body: z.string(),
    url: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    baseRefName: z.string(),
    headRefName: z.string(),
    additions: z.number().nonnegative(),
    deletions: z.number().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    reviewDecision: z.string(),
    mergeStateStatus: z.string(),
    reviewRequests: z.array(z.string()),
    checks: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(["success", "failure", "pending", "neutral"]),
          url: z.string(),
        })
        .strict(),
    ),
    comments: z.array(commentSchema),
    reviews: z.array(
      z
        .object({
          author: z.string(),
          state: z.string(),
          body: z.string(),
          createdAt: z.string(),
        })
        .strict(),
    ),
    reviewThreads: z.array(
      z
        .object({
          path: z.string(),
          line: z.number().int().nonnegative().nullable(),
          diffHunk: z.string(),
          comments: z.array(commentSchema),
        })
        .strict(),
    ),
    files: z.array(
      z
        .object({
          path: z.string(),
          status: z.string(),
          additions: z.number().nonnegative(),
          deletions: z.number().nonnegative(),
          patch: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const githubRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z
      .object({
        discovery: githubDiscoverySchema,
        hosts: z.array(githubHostStatusSchema),
        repositories: z.array(repoInfoSchema),
        lastSyncedAt: z.string().nullable(),
      })
      .strict(),
  },
  refresh: { input: z.null(), output: syncResultSchema },
  listItems: {
    input: z
      .object({
        kind: z.enum(["issue", "pr"]).optional(),
        repo: repoNameSchema.optional(),
        query: z.string().optional(),
        state: z.enum(["open", "closed"]).optional(),
        mine: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ items: z.array(itemSchema) }).strict(),
  },
  viewer: {
    input: z.null(),
    output: z.object({ login: z.string().min(1) }).strict(),
  },
  assignableUsers: {
    input: z.object({ repo: repoNameSchema }).strict(),
    output: z.object({ users: z.array(z.string().min(1)) }).strict(),
  },
  repositoryLabels: {
    input: z.object({ repo: repoNameSchema }).strict(),
    output: z.object({ labels: z.array(z.string().min(1)) }).strict(),
  },
  setIssueState: {
    input: itemInputSchema
      .extend({ state: z.enum(["open", "closed"]) })
      .strict(),
    output: okResultSchema,
  },
  setAssignees: {
    input: itemInputSchema
      .extend({ assignees: z.array(z.string().min(1)) })
      .strict(),
    output: z
      .object({ ok: z.literal(true), assignees: z.array(z.string().min(1)) })
      .strict(),
  },
  setLabels: {
    input: itemInputSchema.extend({ labels: z.array(z.string()) }).strict(),
    output: z
      .object({ ok: z.literal(true), labels: z.array(z.string().min(1)) })
      .strict(),
  },
  getIssue: {
    input: itemInputSchema,
    output: z
      .object({
        issue: z
          .object({
            repo: repoNameSchema,
            number: itemNumberSchema,
            title: z.string(),
            state: z.string(),
            author: z.string(),
            body: z.string(),
            labels: z.array(z.string()),
            assignees: z.array(z.string()),
            url: z.string(),
            updatedAt: z.string(),
            comments: z.array(commentSchema),
          })
          .strict(),
      })
      .strict(),
  },
  getPull: {
    input: itemInputSchema,
    output: z.object({ pull: pullSchema }).strict(),
  },
  commentPull: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  pullForThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ pull: itemInputSchema.nullable() }).strict(),
  },
  commentIssue: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  createIssue: {
    input: z
      .object({
        repo: repoNameSchema,
        title: nonBlankStringSchema,
        body: z.string().optional(),
      })
      .strict(),
    output: z
      .object({ number: itemNumberSchema.nullable(), url: z.string() })
      .strict(),
  },
  startWork: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  startReview: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  listLinks: {
    input: z.null(),
    output: z
      .object({ links: z.record(z.string(), z.array(threadLinkSchema)) })
      .strict(),
  },
});

interface RepoInfo {
  repo: string; // "owner/name"
  projectId: string | null;
  hostId: string;
}

type RepoDiscovery =
  | {
      state: "ready";
      repos: RepoInfo[];
      conflicts: string[];
      hostFailures: Array<{ hostId: string; detail: string }>;
      detail: null;
    }
  | {
      state: "no-repositories";
      repos: [];
      conflicts: string[];
      hostFailures: Array<{ hostId: string; detail: string }>;
      detail: string;
    }
  | {
      state: "failed";
      repos: RepoInfo[];
      conflicts: string[];
      hostFailures: Array<{ hostId: string; detail: string }>;
      detail: string;
    };

type GithubHostState = z.infer<typeof githubHostStateSchema>;

interface GithubHostStatus {
  hostId: string;
  repositories: string[];
  state: GithubHostState;
  detail: string | null;
  login: string | null;
}

interface GithubStatusSnapshot {
  discovery: RepoDiscovery;
  hosts: GithubHostStatus[];
  discoveryKey: string;
  checkedAt: number;
}

interface CachedItem {
  repo: string;
  number: number;
  kind: "issue" | "pr";
  title: string;
  state: string;
  author: string;
  labels: string[];
  assignees: string[];
  url: string;
  body: string;
  updatedAt: string;
}

interface GhListEntry {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  author?: { login?: unknown };
  labels?: Array<{ name?: unknown }>;
  assignees?: Array<{ login?: unknown }>;
  url?: unknown;
  body?: unknown;
  updatedAt?: unknown;
}

type GhRunner = (args: string[]) => Promise<string>;

interface ThreadLink {
  kind: "issue" | "pr";
  repo: string;
  number: number;
  threadId: string;
  createdAt: string;
}

/** owner/name from any GitHub remote URL (https, ssh, git@), else null. */
export function parseGithubRemote(url: string): string | null {
  const match = url
    .trim()
    .match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (match === null) return null;
  return `${match[1]}/${match[2]}`;
}

function isRepoName(value: unknown): value is string {
  return typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value);
}

async function runOnHost(
  bb: BbPluginApi,
  hostId: string,
  executable: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  const result = await bb.hosts.experimental_runCommand(hostId, {
    executable,
    args,
    cwd: null,
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    let hostName = hostId;
    try {
      hostName = (await bb.sdk.hosts.get({ hostId })).name;
    } catch {
      // The command error is still actionable when host metadata is unavailable.
    }
    throw new Error(
      `${executable} ${args.slice(0, 3).join(" ")} failed on ${hostName}: ${
        result.stderr.trim() ||
        result.stdout.trim() ||
        `exit ${result.exitCode}`
      }`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export function parsePaginatedGhApi(raw: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub API pagination returned a non-array response");
  }
  const rows: Record<string, unknown>[] = [];
  for (const page of parsed) {
    if (!Array.isArray(page)) {
      throw new Error("GitHub API pagination returned a malformed page");
    }
    for (const row of page) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error("GitHub API pagination returned a malformed row");
      }
      rows.push(row as Record<string, unknown>);
    }
  }
  return rows;
}

export function validateGithubCliArgs(argv: string[]): string | null {
  const [sub, arg, ...rest] = argv;
  if (rest.length > 0) return `Unexpected argument "${rest[0]}".`;
  if (sub === undefined) return null;
  if (sub === "help" || sub === "--help") {
    return arg === undefined ? null : `Unexpected argument "${arg}".`;
  }
  if (sub === "repos" || sub === "sync") {
    return arg === undefined
      ? null
      : `Subcommand "${sub}" does not accept arguments.`;
  }
  if ((sub === "issues" || sub === "prs") && arg !== undefined) {
    return isRepoName(arg)
      ? null
      : `Invalid repository "${arg}"; expected owner/repo.`;
  }
  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keep command diagnostics useful without allowing credential-shaped values
 * from a host command to cross the plugin RPC boundary. */
function sanitizeDetail(message: string): string {
  const sanitized = message
    .replace(/\bgh[pousr]_[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted-token]")
    .replace(/\b(token|oauth|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > 500 ? `${sanitized.slice(0, 497)}…` : sanitized;
}

function classifyAuthFailure(error: unknown): {
  state: Exclude<GithubHostState, "ready">;
  detail: string;
} {
  const raw = errorText(error);
  const message = raw.toLowerCase();
  if (
    /not logged in|not authenticated|authentication required|no active account|\bgh auth login\b|not logged into any github/.test(
      message,
    )
  ) {
    return {
      state: "gh-not-authenticated",
      detail:
        "GitHub CLI is not authenticated on this machine. Run `gh auth login` there.",
    };
  }
  if (
    /command not found|enoent|no such file or directory|not recognized as an internal or external command|executable .* not found|cannot find .*\bgh\b/.test(
      message,
    )
  ) {
    return {
      state: "gh-not-installed",
      detail:
        "GitHub CLI is not installed on this machine. Install it, then run `gh auth login` there.",
    };
  }
  if (
    /host .*\b(?:offline|unavailable|not connected|disconnected|unknown)\b|(?:connection|transport|socket) .*\b(?:closed|refused|failed)\b|daemon .*\b(?:offline|unavailable|not connected)\b/.test(
      message,
    )
  ) {
    return {
      state: "offline",
      detail: "This BB machine is offline or unavailable.",
    };
  }
  return {
    state: "check-failed",
    detail: sanitizeDetail(raw) || "GitHub CLI authentication check failed.",
  };
}

function classifyDiscoveryFailure(detail: string): {
  state: Exclude<GithubHostState, "ready">;
  detail: string;
} {
  const message = detail.toLowerCase();
  if (
    /host .*\b(?:offline|unavailable|not connected|disconnected|unknown)\b|(?:connection|transport|socket) .*\b(?:closed|refused|failed)\b|daemon .*\b(?:offline|unavailable|not connected)\b/.test(
      message,
    )
  ) {
    return {
      state: "offline",
      detail: "This BB machine is offline or unavailable.",
    };
  }
  return {
    state: "check-failed",
    detail: detail || "GitHub repository discovery failed on this machine.",
  };
}

/** A local checkout without a GitHub origin is not a discovery failure. */
function isMissingGitRemote(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return (
    /not a git repository/.test(message) ||
    /no such remote ['"]?origin/.test(message) ||
    /does not appear to be a git repository/.test(message)
  );
}

function parseGhLogin(stdout: string, stderr: string): string | null {
  const output = `${stdout}\n${stderr}`;
  const match = output.match(/\baccount\s+([A-Za-z0-9][A-Za-z0-9-]*)\b/i);
  return match?.[1] ?? null;
}

function toItems(raw: string, repo: string, kind: "issue" | "pr"): CachedItem[] {
  const entries = JSON.parse(raw) as GhListEntry[];
  return entries
    .filter(
      (entry): entry is GhListEntry & { number: number } =>
        typeof entry?.number === "number",
    )
    .map((entry) => ({
      repo,
      number: entry.number,
      kind,
      title: String(entry.title ?? ""),
      state: String(entry.state ?? "OPEN"),
      author: String(entry.author?.login ?? ""),
      labels: (entry.labels ?? []).map((label) => String(label?.name ?? "")),
      assignees: (entry.assignees ?? []).map((user) => String(user?.login ?? "")),
      url: String(entry.url ?? ""),
      body: typeof entry.body === "string" ? entry.body : "",
      updatedAt: String(entry.updatedAt ?? ""),
    }));
}

// Open items plus a page of recently-closed ones, so the Closed filter has
// something to show without a live gh call per view.
export async function fetchRepoItems(
  gh: GhRunner,
  repo: string,
): Promise<CachedItem[]> {
  const fields = "number,title,state,author,labels,assignees,url,body,updatedAt";
  // A repo with GitHub Issues disabled must not abort the whole sync —
  // PRs still exist and should be cached.
  const ghIssuesTolerant = (args: string[]) =>
    gh(args).catch((error: unknown) => {
      if (String(error).toLowerCase().includes("disabled issues")) return "[]";
      throw error;
    });
  const [openIssues, closedIssues, openPrs, closedPrs] = await Promise.all([
    ghIssuesTolerant([
      "issue", "list", "-R", repo, "--state", "open",
      "--limit", String(ISSUE_PAGE), "--json", fields,
    ]),
    ghIssuesTolerant([
      "issue", "list", "-R", repo, "--state", "closed",
      "--limit", String(CLOSED_ISSUE_PAGE), "--json", fields,
    ]),
    gh([
      "pr", "list", "-R", repo, "--state", "open",
      "--limit", String(PR_PAGE), "--json", fields,
    ]),
    gh([
      "pr", "list", "-R", repo, "--state", "closed",
      "--limit", String(CLOSED_PR_PAGE), "--json", fields,
    ]),
  ]);
  const rows = [
    ...toItems(openIssues, repo, "issue"),
    ...toItems(closedIssues, repo, "issue"),
    ...toItems(openPrs, repo, "pr"),
    ...toItems(closedPrs, repo, "pr"),
  ];
  return [
    ...new Map(
      rows.map((item) => [`${item.kind}:${item.repo}#${item.number}`, item]),
    ).values(),
  ];
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    extraRepos: {
      type: "string",
      label: "Extra repositories",
      description:
        'Comma-separated "owner/repo" list to track in addition to repos discovered from BB projects.',
      default: "",
    },
    defaultProject: {
      type: "project",
      label: "Default BB project",
      description:
        "Where agent threads spawn for repos that are not attached to a BB project.",
    },
  });

  // ------------------------------------------------------------------
  // gh CLI plumbing. Commands execute on each repository's owning BB host;
  // credentials never come from the central server process.
  // ------------------------------------------------------------------
  async function ghOnHost(
    hostId: string,
    args: string[],
    timeoutMs?: number,
  ): Promise<string> {
    const { stdout } = await runOnHost(bb, hostId, "gh", args, timeoutMs);
    return stdout;
  }

  async function ghForRepo(
    repo: string,
    args: string[],
    timeoutMs?: number,
  ): Promise<string> {
    const info = (await discoverRepos()).repos.find(
      (entry) => entry.repo === repo,
    );
    if (info === undefined) {
      throw new Error(
        `No BB machine is configured for GitHub repository ${repo}`,
      );
    }
    return ghOnHost(info.hostId, args, timeoutMs);
  }

  // ------------------------------------------------------------------
  // Repo discovery: BB project sources → git origin → owner/repo.
  // ------------------------------------------------------------------
  let repoCache: { result: RepoDiscovery; fetchedAt: number } | null = null;

  async function discoverRepos(force = false): Promise<RepoDiscovery> {
    if (
      !force &&
      repoCache !== null &&
      Date.now() - repoCache.fetchedAt < 60_000
    ) {
      return repoCache.result;
    }
    const byRepo = new Map<string, RepoInfo>();
    const conflicts = new Map<string, Set<string>>();
    const hostFailures = new Map<string, string>();
    const failures: string[] = [];

    function addRepo(info: RepoInfo): void {
      if (conflicts.has(info.repo)) return;
      const existing = byRepo.get(info.repo);
      if (existing === undefined || existing.hostId === info.hostId) {
        if (existing === undefined) byRepo.set(info.repo, info);
        return;
      }
      byRepo.delete(info.repo);
      conflicts.set(info.repo, new Set([existing.hostId, info.hostId]));
    }

    try {
      // Project settings can select the implicit Personal project. The SDK's
      // compatibility default omits it, but GitHub's defaultProject setting
      // must be able to use it for extra repositories.
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const { defaultProject, extraRepos } = await settings.get();
      const defaultProjectRow = projects.find(
        (project) => project.id === defaultProject,
      );
      const fallbackSource =
        defaultProjectRow?.sources.find((source) => source.isDefault) ??
        defaultProjectRow?.sources[0];
      let fallbackHostId = fallbackSource?.hostId;
      if (
        fallbackHostId === undefined &&
        defaultProjectRow?.kind === "personal" &&
        extraRepos.trim().length > 0
      ) {
        // Personal has no project source. Its thread policy uses the server's
        // primary host, so ask the same server-owned config for the host that
        // should run `gh` for an extra repository.
        fallbackHostId =
          (await bb.sdk.system.config()).primaryHostId ?? undefined;
      }
      for (const project of projects) {
        for (const source of project.sources ?? []) {
          if (source.type !== "local_path") continue;
          try {
            const { stdout } = await runOnHost(
              bb,
              source.hostId,
              "git",
              ["-C", source.path, "remote", "get-url", "origin"],
              5_000,
            );
            const repo = parseGithubRemote(stdout);
            if (repo !== null) {
              addRepo({
                repo,
                projectId: project.id,
                hostId: source.hostId,
              });
            }
          } catch (error) {
            // A project may intentionally contain a non-GitHub checkout or a
            // local directory that has no origin. Neither should make GitHub
            // discovery look broken for every other project.
            if (!isMissingGitRemote(error)) {
              const detail = sanitizeDetail(errorText(error));
              hostFailures.set(source.hostId, detail);
              failures.push(`${source.hostId}: ${detail}`);
            }
          }
        }
      }
      for (const raw of extraRepos.split(/[\s,]+/)) {
        if (isRepoName(raw) && !byRepo.has(raw) && !conflicts.has(raw)) {
          if (fallbackHostId === undefined) {
            failures.push(
              `No BB machine is available for ${raw}. Select a default BB project with a machine-backed source.`,
            );
            continue;
          }
          addRepo({
            repo: raw,
            projectId: null,
            hostId: fallbackHostId,
          });
        }
      }
    } catch (error) {
      failures.push(
        `Project discovery failed: ${sanitizeDetail(errorText(error))}`,
      );
    }
    const repos = [...byRepo.values()];
    for (const { hostId } of repos) hostFailures.delete(hostId);
    for (const [repo, hosts] of conflicts) {
      failures.push(
        `Repository ${repo} is configured on multiple BB machines: ${[...hosts].join(", ")}. Choose one machine.`,
      );
    }
    const result: RepoDiscovery =
      failures.length > 0
        ? {
            state: "failed",
            repos,
            conflicts: [...conflicts.keys()].sort(),
            hostFailures: [...hostFailures.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([hostId, detail]) => ({ hostId, detail })),
            detail:
              failures
                .map((failure) => sanitizeDetail(failure))
                .filter((failure) => failure.length > 0)
                .join("; ") || "GitHub repository discovery failed.",
          }
        : repos.length === 0
          ? {
              state: "no-repositories",
              repos: [],
              conflicts: [],
              hostFailures: [],
              detail:
                "No GitHub repository machines are configured. Add a machine-backed source to a BB project. Extra repositories also require a Default BB project so BB knows which machine should run GitHub CLI.",
            }
          : {
              state: "ready",
              repos,
              conflicts: [],
              hostFailures: [],
              detail: null,
            };
    repoCache = { result, fetchedAt: Date.now() };
    return result;
  }

  let statusSnapshot: GithubStatusSnapshot | null = null;
  let cachedItems: CachedItem[] = [];
  const viewerCache = new Map<string, { login: string; fetchedAt: number }>();
  const assignableCache = new Map<
    string,
    { users: string[]; fetchedAt: number }
  >();
  const labelsCache = new Map<
    string,
    { labels: string[]; fetchedAt: number }
  >();

  function clearCachedRepos(repos: ReadonlySet<string>): void {
    if (repos.size === 0) return;
    cachedItems = cachedItems.filter((item) => !repos.has(item.repo));
    for (const repo of repos) {
      viewerCache.delete(repo);
      assignableCache.delete(repo);
      labelsCache.delete(repo);
    }
  }

  function discoveryKey(discovery: RepoDiscovery): string {
    return JSON.stringify({
      state: discovery.state,
      repos: discovery.repos.map(({ repo, projectId, hostId }) => [
        repo,
        projectId,
        hostId,
      ]),
      hostFailures: discovery.hostFailures,
      detail: discovery.detail,
    });
  }

  function statusForRpc(snapshot: GithubStatusSnapshot) {
    return {
      discovery:
        snapshot.discovery.state === "ready"
          ? { state: "ready" as const }
          : {
              state: snapshot.discovery.state,
              detail: snapshot.discovery.detail,
            },
      hosts: snapshot.hosts,
      repositories: snapshot.discovery.repos.map(
        ({ repo, projectId, hostId }) => ({
          repo,
          projectId,
          hostId,
        }),
      ),
      lastSyncedAt,
    };
  }

  async function checkAuth(force = false): Promise<GithubStatusSnapshot> {
    const discovery = await discoverRepos(force);
    const key = discoveryKey(discovery);
    if (
      !force &&
      statusSnapshot !== null &&
      statusSnapshot.discoveryKey === key &&
      Date.now() - statusSnapshot.checkedAt < 60_000
    ) {
      return statusSnapshot;
    }
    const previousSnapshot = statusSnapshot;
    const hostIds = [
      ...new Set([
        ...discovery.repos.map((repo) => repo.hostId),
        ...discovery.hostFailures.map(({ hostId }) => hostId),
      ]),
    ];
    const discoveryFailures = new Map(
      discovery.hostFailures.map(({ hostId, detail }) => [hostId, detail]),
    );
    const hosts = await Promise.all(
      hostIds.map(async (hostId): Promise<GithubHostStatus> => {
        const repositories = discovery.repos
          .filter((repo) => repo.hostId === hostId)
          .map((repo) => repo.repo)
          .sort();
        const discoveryFailure = discoveryFailures.get(hostId);
        if (discoveryFailure !== undefined) {
          const failure = classifyDiscoveryFailure(discoveryFailure);
          return {
            hostId,
            repositories,
            state: failure.state,
            detail: failure.detail,
            login: null,
          };
        }
        try {
          const result = await runOnHost(
            bb,
            hostId,
            "gh",
            ["auth", "status"],
            10_000,
          );
          return {
            hostId,
            repositories,
            state: "ready",
            detail: null,
            login: parseGhLogin(result.stdout, result.stderr),
          };
        } catch (error) {
          const failure = classifyAuthFailure(error);
          return {
            hostId,
            repositories,
            state: failure.state,
            detail: failure.detail,
            login: null,
          };
        }
      }),
    );
    const nextSnapshot: GithubStatusSnapshot = {
      discovery,
      hosts,
      discoveryKey: key,
      checkedAt: Date.now(),
    };
    const staleRepos = new Set<string>();
    if (previousSnapshot !== null) {
      const previousRepoHosts = new Map(
        previousSnapshot.discovery.repos.map(({ repo, hostId }) => [
          repo,
          hostId,
        ]),
      );
      for (const { repo, hostId } of discovery.repos) {
        if (
          previousRepoHosts.get(repo) !== undefined &&
          previousRepoHosts.get(repo) !== hostId
        ) {
          staleRepos.add(repo);
        }
      }
      const previousHosts = new Map(
        previousSnapshot.hosts.map((host) => [host.hostId, host]),
      );
      for (const host of hosts) {
        const previousHost = previousHosts.get(host.hostId);
        if (
          previousHost !== undefined &&
          (previousHost.state !== host.state ||
            previousHost.login !== host.login)
        ) {
          for (const repo of previousHost.repositories) staleRepos.add(repo);
        }
      }
    }
    // A repository can keep the same name while its checkout moves to another
    // host or while that host switches its local gh account. Never show rows
    // or viewer metadata fetched under the old identity after that change.
    clearCachedRepos(staleRepos);
    // Replace the complete snapshot only after every host check has settled.
    // This drops removed hosts and prevents a partial check from retaining
    // auth state belonging to the previous repository topology.
    statusSnapshot = nextSnapshot;
    return nextSnapshot;
  }

  // ------------------------------------------------------------------
  // Process-memory cache of open issues + PRs. GitHub content must not be
  // persisted on the central BB server; the owning host remains the source.
  // ------------------------------------------------------------------
  // Remove content persisted by older GitHub plugin versions. The plugin's
  // database may also contain its migration ledger, so only delete item rows.
  const legacyDb = bb.storage.database();
  try {
    legacyDb.prepare("DELETE FROM items").run();
  } catch {
    // Fresh installations have no legacy items table.
  }
  await bb.storage.kv.delete("sync-cursor");

  function listCachedItems(options: {
    kind?: "issue" | "pr";
    repo?: string;
    query?: string;
    /** "open" → OPEN only; "closed" → everything else (CLOSED, MERGED). */
    state?: "open" | "closed";
    /** Only items whose assignees include this login. */
    assignee?: string;
  }): CachedItem[] {
    const query = options.query?.trim().replace(/^#/, "").toLowerCase() ?? "";
    return cachedItems
      .filter(
        (item) => options.kind === undefined || item.kind === options.kind,
      )
      .filter(
        (item) => options.repo === undefined || item.repo === options.repo,
      )
      .filter(
        (item) =>
          options.state === undefined ||
          (options.state === "open"
            ? item.state === "OPEN"
            : item.state !== "OPEN"),
      )
      .filter(
        (item) =>
          options.assignee === undefined ||
          item.assignees.includes(options.assignee),
      )
      .filter(
        (item) =>
          query.length === 0 ||
          item.title.toLowerCase().includes(query) ||
          String(item.number).includes(query) ||
          item.repo.toLowerCase().includes(query),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  function getCachedItem(
    kind: "issue" | "pr",
    repo: string,
    number: number,
  ): CachedItem | null {
    return (
      cachedItems.find(
        (item) =>
          item.repo === repo && item.kind === kind && item.number === number,
      ) ?? null
    );
  }

  function replaceRepoRows(repo: string, items: CachedItem[]): void {
    cachedItems = [
      ...cachedItems.filter((item) => item.repo !== repo),
      ...items,
    ];
  }

  /** Patch a cached row in place after a mutation so the UI updates without
      waiting for the next full sync. */
  function patchCachedItem(
    kind: "issue" | "pr",
    repo: string,
    number: number,
    patch: { state?: string; assignees?: string[]; labels?: string[] },
  ): void {
    cachedItems = cachedItems.map((item) =>
      item.repo === repo && item.kind === kind && item.number === number
        ? { ...item, ...patch }
        : item,
    );
    bb.realtime.publish("data-changed", {});
  }

  let lastSyncedAt: string | null = null;

  async function syncAll(force = false): Promise<{
    repos: number;
    items: number;
    failedHosts: Array<{ hostId: string; detail: string }>;
  }> {
    const snapshot = await checkAuth(force);
    const repos = snapshot.discovery.repos;
    const readyHosts = new Set(
      snapshot.hosts
        .filter((host) => host.state === "ready")
        .map((host) => host.hostId),
    );
    let total = 0;
    const syncFailures = new Map<string, string>();
    for (const { repo, hostId } of repos) {
      if (!readyHosts.has(hostId)) continue;
      try {
        const items = await fetchRepoItems(
          (args) => ghForRepo(repo, args),
          repo,
        );
        replaceRepoRows(repo, items);
        total += items.length;
      } catch (error) {
        const detail =
          sanitizeDetail(errorText(error)) || "GitHub sync failed.";
        syncFailures.set(hostId, detail);
        bb.log.warn(`sync failed for ${repo}: ${detail}`);
      }
    }
    const currentRepos = new Set(repos.map(({ repo }) => repo));
    // Discovery failures are fail-closed for stale content: retain rows from
    // repositories discovered on ready hosts, but do not continue showing a
    // repository whose current host/topology could not be verified.
    cachedItems = cachedItems.filter((item) => currentRepos.has(item.repo));
    lastSyncedAt = new Date().toISOString();
    if (
      syncFailures.size > 0 &&
      statusSnapshot?.discoveryKey === snapshot.discoveryKey
    ) {
      statusSnapshot = {
        ...statusSnapshot,
        hosts: statusSnapshot.hosts.map((host) => {
          const detail = syncFailures.get(host.hostId);
          return detail === undefined
            ? host
            : { ...host, state: "check-failed", detail };
        }),
      };
    }
    const failedHosts = new Map(
      snapshot.hosts
        .filter((host) => host.state !== "ready")
        .map((host) => [
          host.hostId,
          host.detail ?? "GitHub machine is not ready.",
        ]),
    );
    for (const [hostId, detail] of syncFailures)
      failedHosts.set(hostId, detail);
    // The status snapshot is part of the panel's data too. Publish after every
    // completed refresh so authentication, offline, and topology changes are
    // visible even when the item cache itself did not change.
    bb.realtime.publish("data-changed", { items: total });
    bb.log.info(`synced ${total} item(s) across ${repos.length} repo(s)`);
    return {
      repos: repos.length,
      items: total,
      failedHosts: [...failedHosts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([hostId, detail]) => ({ hostId, detail })),
    };
  }

  // Initial sync + 5-minute refresh loop. Per-machine gh failures are kept in
  // the status snapshot, so one unavailable machine cannot stop the others.
  bb.background.service("sync", {
    async start(signal) {
      while (!signal.aborted) {
        await syncAll();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SYNC_INTERVAL_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  // Build the initial status snapshot before registering the RPC handlers.
  // This is deliberately not a plugin-level needsConfiguration state: missing
  // gh or credentials belongs to the individual repository machine.
  await checkAuth(true);

  // ------------------------------------------------------------------
  // Issue/PR ↔ thread links (the pills in the UI).
  // kv: "link:<kind>:<repo>#<number>" → ThreadLink[]
  // ------------------------------------------------------------------
  function linkKey(kind: "issue" | "pr", repo: string, number: number): string {
    return `link:${kind}:${repo}#${number}`;
  }

  async function addLink(link: ThreadLink): Promise<void> {
    const key = linkKey(link.kind, link.repo, link.number);
    const existing = (await bb.storage.kv.get<ThreadLink[]>(key)) ?? [];
    await bb.storage.kv.set(key, [...existing, link]);
    bb.realtime.publish("links-changed", { key });
  }

  async function listAllLinks(): Promise<Record<string, ThreadLink[]>> {
    const keys = await bb.storage.kv.list("link:");
    const result: Record<string, ThreadLink[]> = {};
    for (const key of keys) {
      const links = await bb.storage.kv.get<ThreadLink[]>(key);
      if (links !== undefined && links.length > 0) {
        result[key.slice("link:".length)] = links;
      }
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Spawning agent threads on issues / PR reviews.
  // ------------------------------------------------------------------
  async function resolveSpawnTarget(repo: string): Promise<{
    projectId: string;
    environment:
      | { type: "host"; hostId: string; workspace: { type: "personal" } }
      | {
          type: "host";
          hostId: string;
          workspace: {
            type: "managed-worktree";
            baseBranch: { kind: "default" };
          };
        };
  }> {
    const discovery = await discoverRepos();
    if (discovery.conflicts.includes(repo)) {
      throw new Error(
        `GitHub repository ${repo} is configured on multiple BB machines. Choose one machine before starting work.`,
      );
    }
    const info = discovery.repos.find((entry) => entry.repo === repo);
    if (info === undefined) {
      throw new Error(
        `No BB machine is configured for GitHub repository ${repo}. Refresh GitHub discovery and try again.`,
      );
    }
    const { defaultProject } = await settings.get();
    const projectId = info.projectId ?? defaultProject;
    if (projectId === undefined) {
      throw new Error(
        `No BB project is attached to ${repo}. Create a project whose checkout has ` +
          "that origin remote, or set the defaultProject plugin setting.",
      );
    }
    const project = (
      await bb.sdk.projects.list({ includePersonal: true })
    ).find((candidate) => candidate.id === projectId);
    if (project === undefined) {
      throw new Error(
        `BB project ${projectId} configured for ${repo} no longer exists. Select a different default project.`,
      );
    }
    if (project.kind === "personal") {
      return {
        projectId,
        environment: {
          type: "host",
          hostId: info.hostId,
          workspace: { type: "personal" },
        },
      };
    }
    return {
      projectId,
      environment: {
        type: "host",
        hostId: info.hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    };
  }

  async function spawnOnItem(
    kind: "issue" | "pr",
    repo: string,
    number: number,
  ): Promise<{ threadId: string }> {
    const item = getCachedItem(kind, repo, number);
    const title = item?.title ?? `${kind === "pr" ? "PR" : "issue"} #${number}`;
    const target = await resolveSpawnTarget(repo);
    const ref = `${repo}#${number}`;
    const prompt =
      kind === "issue"
        ? [
            `Work on GitHub issue ${ref}: ${title}`,
            "",
            "Read the full issue and its comments first:",
            `  gh issue view ${number} -R ${repo} --comments`,
            "",
            item !== null && item.body.length > 0
              ? `Issue description:\n\n${item.body}`
              : "(no cached description — read it with the command above)",
            "",
            "Implement a fix or the requested change in this checkout. " +
              `If you open a pull request, include "Fixes #${number}" in its body.`,
          ].join("\n")
        : [
            `Review GitHub pull request ${ref}: ${title}`,
            "",
            "Read the PR and its diff:",
            `  gh pr view ${number} -R ${repo} --comments`,
            `  gh pr diff ${number} -R ${repo}`,
            "",
            "Review the change for correctness, missing tests, and design issues. " +
              "Summarize your findings with file/line references. Do not push " +
              "changes or post to GitHub unless asked.",
          ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId: target.projectId,
      environment: target.environment,
      title: `${ref}: ${title}`.slice(0, 120),
      prompt,
    });
    await addLink({
      kind,
      repo,
      number,
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
    bb.log.info(`spawned thread ${thread.id} for ${kind} ${ref}`);
    return { threadId: thread.id };
  }

  // ------------------------------------------------------------------
  // Viewer identity + per-repo assignable users, cached in memory so the
  // filter chips and assignee picker don't hit the network on every render.
  // ------------------------------------------------------------------
  async function getViewer(repo?: string): Promise<string> {
    const discovery = await discoverRepos();
    const targetRepo = repo ?? discovery.repos[0]?.repo;
    if (targetRepo === undefined) {
      throw new Error("No GitHub repository is configured");
    }
    if (
      repo === undefined &&
      new Set(discovery.repos.map(({ hostId }) => hostId)).size > 1
    ) {
      throw new Error(
        "GitHub viewer identity is machine-specific. Select a repository before using the current-user filter.",
      );
    }
    const cached = viewerCache.get(targetRepo);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 60 * 60_000) {
      return cached.login;
    }
    const raw = await ghForRepo(targetRepo, ["api", "user"], 15_000);
    const login = String((JSON.parse(raw) as { login?: unknown })?.login ?? "");
    if (login.length === 0)
      throw new Error("could not resolve the gh viewer login");
    viewerCache.set(targetRepo, { login, fetchedAt: Date.now() });
    return login;
  }

  async function getAssignableUsers(repo: string): Promise<string[]> {
    const cached = assignableCache.get(repo);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached.users;
    }
    const raw = await ghForRepo(
      repo,
      ["api", `repos/${repo}/assignees?per_page=100`],
      15_000,
    );
    const entries = JSON.parse(raw) as Array<{ login?: unknown }>;
    const users = entries
      .map((entry) => String(entry?.login ?? ""))
      .filter((login) => login.length > 0)
      .sort((a, b) => a.localeCompare(b));
    assignableCache.set(repo, { users, fetchedAt: Date.now() });
    return users;
  }

  async function getRepoLabels(repo: string): Promise<string[]> {
    const cached = labelsCache.get(repo);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached.labels;
    }
    const raw = await ghForRepo(
      repo,
      ["api", `repos/${repo}/labels?per_page=100`],
      15_000,
    );
    const entries = JSON.parse(raw) as Array<{ name?: unknown }>;
    const labels = entries
      .map((entry) => String(entry?.name ?? "").trim())
      .filter((name) => name.length > 0)
      .sort((a, b) => a.localeCompare(b));
    labelsCache.set(repo, { labels, fetchedAt: Date.now() });
    return labels;
  }

  settings.onChange(() => {
    // extraRepos and defaultProject both affect repository ownership. Drop the
    // complete topology/auth snapshot and repo-scoped identity caches so a
    // newly selected fallback machine cannot inherit another host's login.
    repoCache = null;
    statusSnapshot = null;
    cachedItems = [];
    lastSyncedAt = null;
    viewerCache.clear();
    assignableCache.clear();
    labelsCache.clear();
    bb.realtime.publish("data-changed", {});
  });

  // ------------------------------------------------------------------
  // rpc — the frontend data plane.
  // ------------------------------------------------------------------
  bb.rpc.register(githubRpcContract, {
    /** () → auth/sync status for the panel banner. */
    async status() {
      return statusForRpc(await checkAuth());
    },

    /** () → force a full sync now. */
    async refresh() {
      return await syncAll(true);
    },

    /** { kind?, repo?, query?, state?, mine? } → cached items, newest first. */
    async listItems(input) {
      return {
        items: listCachedItems({
          kind: input.kind,
          repo: input.repo,
          query: input.query,
          state: input.state,
          assignee:
            input.mine === true ? await getViewer(input.repo) : undefined,
        }),
      };
    },

    /** () → the authenticated gh login, for "assign to me" affordances. */
    async viewer() {
      return { login: await getViewer() };
    },

    /** { repo } → logins that can be assigned to issues in that repo. */
    async assignableUsers(input) {
      return { users: await getAssignableUsers(input.repo) };
    },

    /** { repo } → labels available in that repo. */
    async repositoryLabels(input) {
      return { labels: await getRepoLabels(input.repo) };
    },

    /** { repo, number, state: "open"|"closed" } → close or reopen an issue. */
    async setIssueState({ repo, number, state }): Promise<{ ok: true }> {
      await ghForRepo(repo, [
        "issue",
        state === "closed" ? "close" : "reopen",
        String(number),
        "-R",
        repo,
      ]);
      patchCachedItem("issue", repo, number, {
        state: state === "closed" ? "CLOSED" : "OPEN",
      });
      return { ok: true };
    },

    /** { repo, number, assignees: string[] } → set the exact assignee list. */
    async setAssignees({
      repo,
      number,
      assignees,
    }): Promise<{ ok: true; assignees: string[] }> {
      const next = [...new Set(assignees)];
      const current = getCachedItem("issue", repo, number)?.assignees ?? [];
      const add = next.filter((login) => !current.includes(login));
      const remove = current.filter((login) => !next.includes(login));
      if (add.length === 0 && remove.length === 0)
        return { ok: true, assignees: next };
      const args = ["issue", "edit", String(number), "-R", repo];
      if (add.length > 0) args.push("--add-assignee", add.join(","));
      if (remove.length > 0) args.push("--remove-assignee", remove.join(","));
      await ghForRepo(repo, args);
      patchCachedItem("issue", repo, number, { assignees: next });
      return { ok: true, assignees: next };
    },

    /** { repo, number, labels: string[] } → set the exact issue label list. */
    async setLabels({
      repo,
      number,
      labels,
    }): Promise<{ ok: true; labels: string[] }> {
      const next = [
        ...new Set(labels.map((label) => label.trim()).filter(Boolean)),
      ];
      const currentRaw = await ghForRepo(
        repo,
        ["issue", "view", String(number), "-R", repo, "--json", "labels"],
        15_000,
      );
      const currentDetail = JSON.parse(currentRaw) as {
        labels?: Array<{ name?: unknown }>;
      };
      const current = (currentDetail.labels ?? [])
        .map((label) => String(label?.name ?? "").trim())
        .filter((label) => label.length > 0);
      const add = next.filter((label) => !current.includes(label));
      const remove = current.filter((label) => !next.includes(label));
      if (add.length === 0 && remove.length === 0)
        return { ok: true, labels: next };
      const args = ["issue", "edit", String(number), "-R", repo];
      for (const label of add) args.push("--add-label", label);
      for (const label of remove) args.push("--remove-label", label);
      await ghForRepo(repo, args);
      patchCachedItem("issue", repo, number, { labels: next });
      return { ok: true, labels: next };
    },

    /** { repo, number } → live issue detail incl. comments. */
    async getIssue({ repo, number }) {
      const raw = await ghForRepo(repo, [
        "issue",
        "view",
        String(number),
        "-R",
        repo,
        "--json",
        "number,title,body,state,author,createdAt,updatedAt,labels,assignees,url,comments",
      ]);
      const detail = JSON.parse(raw) as {
        comments?: Array<{
          author?: { login?: unknown };
          body?: unknown;
          createdAt?: unknown;
        }>;
      } & GhListEntry;
      return {
        issue: {
          repo,
          number,
          title: String(detail.title ?? ""),
          state: String(detail.state ?? ""),
          author: String(detail.author?.login ?? ""),
          body: typeof detail.body === "string" ? detail.body : "",
          labels: (detail.labels ?? []).map((label) =>
            String(label?.name ?? ""),
          ),
          assignees: (detail.assignees ?? []).map((user) =>
            String(user?.login ?? ""),
          ),
          url: String(detail.url ?? ""),
          updatedAt: String(detail.updatedAt ?? ""),
          comments: (detail.comments ?? []).map((comment) => ({
            author: String(comment.author?.login ?? ""),
            body: typeof comment.body === "string" ? comment.body : "",
            createdAt: String(comment.createdAt ?? ""),
          })),
        },
      };
    },

    /** { repo, number } → full PR detail: overview, checks, reviews, timeline
        comments, inline review threads (with diff hunks), and per-file
        patches. Three live calls in parallel: `gh pr view` covers the
        overview + reviews + issue-style comments, the REST pulls API covers
        what it cannot — inline review comments and file patches. */
    async getPull({ repo, number }) {
      const prFields =
        "number,title,body,state,isDraft,author,createdAt,updatedAt,labels," +
        "assignees,url,baseRefName,headRefName,additions,deletions," +
        "changedFiles,reviewDecision,mergeStateStatus,statusCheckRollup," +
        "comments,reviews,reviewRequests";
      const [viewRaw, reviewCommentsRaw, filesRaw] = await Promise.all([
        ghForRepo(
          repo,
          ["pr", "view", String(number), "-R", repo, "--json", prFields],
          30_000,
        ),
        ghForRepo(
          repo,
          [
            "api",
            "--paginate",
            "--slurp",
            `repos/${repo}/pulls/${number}/comments?per_page=100`,
          ],
          30_000,
        ),
        ghForRepo(
          repo,
          [
            "api",
            "--paginate",
            "--slurp",
            `repos/${repo}/pulls/${number}/files?per_page=100`,
          ],
          30_000,
        ),
      ]);

      interface GhPullView extends GhListEntry {
        isDraft?: unknown;
        createdAt?: unknown;
        baseRefName?: unknown;
        headRefName?: unknown;
        additions?: unknown;
        deletions?: unknown;
        changedFiles?: unknown;
        reviewDecision?: unknown;
        mergeStateStatus?: unknown;
        statusCheckRollup?: Array<{
          __typename?: unknown;
          name?: unknown;
          context?: unknown;
          status?: unknown;
          conclusion?: unknown;
          state?: unknown;
          detailsUrl?: unknown;
          targetUrl?: unknown;
        }>;
        comments?: Array<{
          author?: { login?: unknown };
          body?: unknown;
          createdAt?: unknown;
        }>;
        reviews?: Array<{
          author?: { login?: unknown };
          state?: unknown;
          body?: unknown;
          submittedAt?: unknown;
        }>;
        reviewRequests?: Array<{
          login?: unknown;
          name?: unknown;
          slug?: unknown;
        }>;
      }
      const view = JSON.parse(viewRaw) as GhPullView;

      // CheckRun rows carry status/conclusion; classic StatusContext rows a
      // single state. Normalize both to one traffic-light value.
      const checks = (view.statusCheckRollup ?? []).map((entry) => {
        const conclusion = String(
          entry.conclusion ?? entry.state ?? "",
        ).toUpperCase();
        const running =
          entry.conclusion === "" ||
          ["IN_PROGRESS", "QUEUED", "PENDING", "EXPECTED", "WAITING"].includes(
            String(entry.status ?? entry.state ?? "").toUpperCase(),
          );
        const status: "success" | "failure" | "pending" | "neutral" =
          conclusion === "SUCCESS"
            ? "success"
            : conclusion === "FAILURE" ||
                conclusion === "ERROR" ||
                conclusion === "TIMED_OUT"
              ? "failure"
              : running
                ? "pending"
                : "neutral";
        return {
          name: String(entry.name ?? entry.context ?? "check"),
          status,
          url: String(entry.detailsUrl ?? entry.targetUrl ?? ""),
        };
      });

      interface GhReviewComment {
        id?: unknown;
        in_reply_to_id?: unknown;
        path?: unknown;
        line?: unknown;
        original_line?: unknown;
        diff_hunk?: unknown;
        body?: unknown;
        created_at?: unknown;
        user?: { login?: unknown };
      }
      const reviewComments = parsePaginatedGhApi(
        reviewCommentsRaw,
      ) as GhReviewComment[];
      interface ReviewThread {
        path: string;
        line: number | null;
        diffHunk: string;
        comments: Array<{ author: string; body: string; createdAt: string }>;
      }
      // Group inline comments into threads: a comment without in_reply_to_id
      // roots a thread, replies chain onto their root's thread.
      const threadByRootId = new Map<number, ReviewThread>();
      for (const comment of reviewComments) {
        const id = Number(comment.id ?? NaN);
        const replyTo = Number(comment.in_reply_to_id ?? NaN);
        const entry = {
          author: String(comment.user?.login ?? ""),
          body: typeof comment.body === "string" ? comment.body : "",
          createdAt: String(comment.created_at ?? ""),
        };
        const rootThread = Number.isFinite(replyTo)
          ? threadByRootId.get(replyTo)
          : undefined;
        if (rootThread !== undefined) {
          rootThread.comments.push(entry);
          if (Number.isFinite(id)) threadByRootId.set(id, rootThread);
          continue;
        }
        const line = Number(comment.line ?? comment.original_line ?? NaN);
        const thread: ReviewThread = {
          path: String(comment.path ?? ""),
          line: Number.isFinite(line) ? line : null,
          diffHunk:
            typeof comment.diff_hunk === "string" ? comment.diff_hunk : "",
          comments: [entry],
        };
        if (Number.isFinite(id)) threadByRootId.set(id, thread);
      }
      const reviewThreads = [...new Set(threadByRootId.values())];

      interface GhPullFile {
        filename?: unknown;
        status?: unknown;
        additions?: unknown;
        deletions?: unknown;
        patch?: unknown;
      }
      const files = (parsePaginatedGhApi(filesRaw) as GhPullFile[]).map(
        (file) => {
          const patch = typeof file.patch === "string" ? file.patch : null;
          return {
            path: String(file.filename ?? ""),
            status: String(file.status ?? "modified"),
            additions: Number(file.additions ?? 0),
            deletions: Number(file.deletions ?? 0),
            // Very large patches stay on GitHub — the panel shows a link.
            patch: patch !== null && patch.length <= 20_000 ? patch : null,
          };
        },
      );

      return {
        pull: {
          repo,
          number,
          title: String(view.title ?? ""),
          state:
            view.isDraft === true && String(view.state ?? "") === "OPEN"
              ? "DRAFT"
              : String(view.state ?? ""),
          author: String(view.author?.login ?? ""),
          body: typeof view.body === "string" ? view.body : "",
          url: String(view.url ?? ""),
          createdAt: String(view.createdAt ?? ""),
          updatedAt: String(view.updatedAt ?? ""),
          baseRefName: String(view.baseRefName ?? ""),
          headRefName: String(view.headRefName ?? ""),
          additions: Number(view.additions ?? 0),
          deletions: Number(view.deletions ?? 0),
          changedFiles: Number(view.changedFiles ?? files.length),
          labels: (view.labels ?? []).map((label) => String(label?.name ?? "")),
          assignees: (view.assignees ?? []).map((user) =>
            String(user?.login ?? ""),
          ),
          reviewDecision: String(view.reviewDecision ?? ""),
          mergeStateStatus: String(view.mergeStateStatus ?? ""),
          reviewRequests: (view.reviewRequests ?? [])
            .map((entry) =>
              String(entry.login ?? entry.name ?? entry.slug ?? ""),
            )
            .filter((name) => name.length > 0),
          checks,
          comments: (view.comments ?? []).map((comment) => ({
            author: String(comment.author?.login ?? ""),
            body: typeof comment.body === "string" ? comment.body : "",
            createdAt: String(comment.createdAt ?? ""),
          })),
          reviews: (view.reviews ?? []).map((review) => ({
            author: String(review.author?.login ?? ""),
            state: String(review.state ?? ""),
            body: typeof review.body === "string" ? review.body : "",
            createdAt: String(review.submittedAt ?? ""),
          })),
          reviewThreads,
          files,
        },
      };
    },

    /** { repo, number, body } → add a PR conversation comment. */
    async commentPull({ repo, number, body }): Promise<{ ok: true }> {
      await ghForRepo(repo, [
        "pr",
        "comment",
        String(number),
        "-R",
        repo,
        "--body",
        body,
      ]);
      return { ok: true };
    },

    /** { threadId } → the PR most relevant to a BB thread: the thread's own
        environment PR (the branch the agent pushed) first, else a PR this
        thread was spawned to review. Null when neither exists. */
    async pullForThread({ threadId }) {
      try {
        const thread = (await bb.sdk.threads.get({ threadId })) as unknown as {
          environmentId?: string | null;
        };
        if (thread?.environmentId) {
          const result = await bb.sdk.environments.pullRequest({
            environmentId: thread.environmentId,
          });
          const url =
            result.outcome === "available" ? result.pullRequest.url : null;
          const match =
            typeof url === "string"
              ? url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
              : null;
          if (match !== null) {
            return { pull: { repo: match[1], number: Number(match[2]) } };
          }
        }
      } catch {
        // no environment / PR lookup failed — fall through to spawn links
      }
      const links = await listAllLinks();
      for (const [key, threadLinks] of Object.entries(links)) {
        const match = key.match(/^pr:([\w.-]+\/[\w.-]+)#(\d+)$/);
        if (match === null) continue;
        if (threadLinks.some((link) => link.threadId === threadId)) {
          return { pull: { repo: match[1], number: Number(match[2]) } };
        }
      }
      return { pull: null };
    },

    /** { repo, number, body } → add an issue comment. */
    async commentIssue({ repo, number, body }): Promise<{ ok: true }> {
      await ghForRepo(repo, [
        "issue",
        "comment",
        String(number),
        "-R",
        repo,
        "--body",
        body,
      ]);
      return { ok: true };
    },

    /** { repo, title, body? } → create an issue, sync, return number+url. */
    async createIssue(input) {
      const body = input.body ?? "";
      const stdout = await ghForRepo(input.repo, [
        "issue",
        "create",
        "-R",
        input.repo,
        "--title",
        input.title,
        "--body",
        body,
      ]);
      const match = stdout.trim().match(/\/issues\/(\d+)\s*$/);
      const number = match !== null ? Number(match[1]) : null;
      try {
        replaceRepoRows(
          input.repo,
          await fetchRepoItems(
            (args) => ghForRepo(input.repo, args),
            input.repo,
          ),
        );
        bb.realtime.publish("data-changed", {});
      } catch {
        // creation succeeded; the next scheduled sync will pick it up
      }
      return { number, url: stdout.trim() };
    },

    /** { repo, number } → spawn a worker thread on an issue. */
    async startWork({ repo, number }) {
      return await spawnOnItem("issue", repo, number);
    },

    /** { repo, number } → spawn a review thread on a PR. */
    async startReview({ repo, number }) {
      return await spawnOnItem("pr", repo, number);
    },

    /** () → every issue/PR → thread link, keyed "<kind>:<repo>#<number>". */
    async listLinks() {
      return { links: await listAllLinks() };
    },
  });

  // ------------------------------------------------------------------
  // Mentions: issues and PRs attach their details as agent context.
  // Search reads the cache (2s time box); resolve prefers a live gh view
  // and falls back to the cache so a network blip doesn't block the send.
  // ------------------------------------------------------------------
  function mentionItems(kind: "issue" | "pr", query: string) {
    return listCachedItems({ kind, query, state: "open" })
      .slice(0, 8)
      .map((item) => ({
        id: `${item.repo}#${item.number}`,
        title: `#${item.number} ${item.title}`,
        subtitle: item.repo,
      }));
  }

  function parseMentionId(itemId: string): { repo: string; number: number } {
    const match = itemId.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
    if (match === null) throw new Error(`malformed mention id "${itemId}"`);
    return { repo: match[1], number: Number(match[2]) };
  }

  async function mentionContext(
    kind: "issue" | "pr",
    itemId: string,
  ): Promise<{ context: string }> {
    const { repo, number } = parseMentionId(itemId);
    const noun = kind === "pr" ? "pull request" : "issue";
    try {
      const raw = await ghForRepo(
        repo,
        kind === "pr"
          ? [
              "pr",
              "view",
              String(number),
              "-R",
              repo,
              "--json",
              "number,title,body,state,author,url",
            ]
          : [
              "issue",
              "view",
              String(number),
              "-R",
              repo,
              "--json",
              "number,title,body,state,author,url",
            ],
        15_000,
      );
      const detail = JSON.parse(raw) as GhListEntry;
      return {
        context: [
          `# GitHub ${noun} ${repo}#${number}: ${String(detail.title ?? "")}`,
          "",
          `State: ${String(detail.state ?? "")} · Author: ${String(detail.author?.login ?? "")}`,
          `URL: ${String(detail.url ?? "")}`,
          "",
          typeof detail.body === "string" && detail.body.length > 0
            ? detail.body
            : "(no description)",
          "",
          `For full comments/diff run: gh ${kind === "pr" ? "pr" : "issue"} view ${number} -R ${repo} --comments`,
        ].join("\n"),
      };
    } catch (error) {
      const cached = getCachedItem(kind, repo, number);
      if (cached === null)
        throw error instanceof Error ? error : new Error(String(error));
      return {
        context: [
          `# GitHub ${noun} ${repo}#${number}: ${cached.title}`,
          "",
          `State: ${cached.state} · Author: ${cached.author}`,
          `URL: ${cached.url}`,
          "",
          cached.body.length > 0 ? cached.body : "(no description)",
        ].join("\n"),
      };
    }
  }

  bb.ui.registerMentionProvider({
    id: "issue",
    label: "GitHub issues",
    triggers: ["@", "#"],
    search({ query }) {
      return mentionItems("issue", query);
    },
    resolve(itemId) {
      return mentionContext("issue", itemId);
    },
  });

  bb.ui.registerMentionProvider({
    id: "pr",
    label: "GitHub pull requests",
    triggers: ["@", "#"],
    search({ query }) {
      return mentionItems("pr", query);
    },
    resolve(itemId) {
      return mentionContext("pr", itemId);
    },
  });

  // ------------------------------------------------------------------
  // CLI: `bb github …` for agents and terminals.
  // ------------------------------------------------------------------
  const USAGE = [
    "Usage:",
    "  bb github repos              List tracked repositories",
    "  bb github issues [repo]      List cached open issues",
    "  bb github prs [repo]         List cached open pull requests",
    "  bb github sync               Refresh the cache from GitHub now",
  ].join("\n");

  bb.cli.register({
    name: "github",
    summary: "Browse tracked GitHub repos, issues, and PRs",
    commands: [
      {
        name: "repos",
        summary: "List tracked repositories",
        usage: "bb github repos",
      },
      {
        name: "issues",
        summary: "List cached open issues",
        usage: "bb github issues [owner/repo]",
      },
      {
        name: "prs",
        summary: "List cached open pull requests",
        usage: "bb github prs [owner/repo]",
      },
      {
        name: "sync",
        summary: "Refresh the cache from GitHub now",
        usage: "bb github sync",
      },
    ],
    async run(argv) {
      const [sub, arg] = argv;
      try {
        const validationError = validateGithubCliArgs(argv);
        if (validationError !== null) {
          return { exitCode: 1, stderr: `${validationError}\n${USAGE}` };
        }
        if (sub === undefined || sub === "help" || sub === "--help") {
          return { exitCode: 0, stdout: USAGE };
        }
        if (sub === "repos") {
          const discovery = await discoverRepos(true);
          if (discovery.repos.length === 0) {
            return {
              exitCode: 0,
              stdout:
                "No tracked repos. Attach a project with a GitHub remote or set extraRepos.",
            };
          }
          return {
            exitCode: 0,
            stdout: discovery.repos
              .map(
                (entry) =>
                  `${entry.repo}${entry.projectId !== null ? `\t(${entry.projectId})` : ""}`,
              )
              .join("\n"),
          };
        }
        if (sub === "issues" || sub === "prs") {
          const items = listCachedItems({
            kind: sub === "prs" ? "pr" : "issue",
            repo: isRepoName(arg) ? arg : undefined,
            state: "open",
          });
          if (items.length === 0) {
            return {
              exitCode: 0,
              stdout: "Nothing cached. Run `bb github sync` first.",
            };
          }
          return {
            exitCode: 0,
            stdout: items
              .map(
                (item) =>
                  `${item.repo}#${item.number}\t[${item.state}]\t${item.title}`,
              )
              .join("\n"),
          };
        }
        if (sub === "sync") {
          const { repos, items } = await syncAll(true);
          return {
            exitCode: 0,
            stdout: `Synced ${items} item(s) across ${repos} repo(s).`,
          };
        }
        return {
          exitCode: 1,
          stderr: `Unknown subcommand "${sub}".\n${USAGE}`,
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
