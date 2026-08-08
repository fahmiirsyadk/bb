import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  actionIntentSchema,
  bbThreadIdSchema,
  blockerKindSchema,
  blockerSchema,
  blockerStatusSchema,
  checklistItemSchema,
  checklistStatusSchema,
  confirmationSchema,
  confirmationIdSchema,
  domainErrorSchema,
  jsonObjectSchema,
  type ActionIntent,
  type Blocker,
  type ChecklistItem,
  type Confirmation,
  type Workstream,
  responsibleAgentIdSchema,
  workstreamIdSchema,
  workstreamSchema,
  workstreamStatusSchema,
} from "./domain";
import {
  formatReviewFeedbackMessage,
  formatReviewFeedbackAgentMessage,
  openPullRequest,
  readPullRequest,
  repositorySchema,
  reviewBlockers,
} from "./github";
import {
  createWorkstreamsStore,
  type WorkstreamsStore,
  WORKSTREAM_MIGRATIONS,
} from "./store";

const limitSchema = z.number().int().min(1).max(100).default(50);
const actionSchema = z.enum([
  "commit",
  "open_pr",
  "mark_ready",
  "merge",
  "archive",
]);
const supportedActionIntentSchema = actionIntentSchema.extend({
  action: actionSchema,
});
const ACTION_CONFIRMATION_RENDERER = "workstreams-action-confirmation";
const actionConfirmationResponseSchema = z
  .object({ approved: z.literal(true) })
  .strict();

const workstreamSummarySchema = z.object({
  workstream: workstreamSchema,
  checklist: z.object({
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
  openReviewBlockers: z.number().int().nonnegative(),
});

const workstreamDetailSchema = z.object({
  workstream: workstreamSchema,
  checklist: z.array(checklistItemSchema),
  blockers: z.array(blockerSchema),
  confirmations: z.array(confirmationSchema),
});

const actionResultSchema = z.object({
  action: z.string(),
  targetId: z.string(),
  result: z.object({
    url: z.string().url().optional(),
  }),
});

function mutationSchema<T extends z.ZodType>(value: T) {
  return z.union([
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: domainErrorSchema }),
  ]);
}

const mutationWorkstreamSchema = mutationSchema(workstreamSchema);
const mutationChecklistSchema = mutationSchema(checklistItemSchema);
const mutationBlockerSchema = mutationSchema(blockerSchema);
const mutationConfirmationSchema = mutationSchema(confirmationSchema);

const actionRequestSchema = z.object({
  confirmation: confirmationSchema,
  token: z.string().min(1),
  preview: z.string(),
});

const executeActionSchema = z.union([
  z.object({ ok: z.literal(false), error: domainErrorSchema }),
  z.object({
    ok: z.literal(true),
    confirmation: confirmationSchema,
    actionResult: actionResultSchema,
  }),
]);

const checklistAgentInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    workstreamId: workstreamIdSchema,
    title: z.string().trim().min(1).max(1000),
    position: z.number().int().nonnegative().nullable().default(null),
    status: checklistStatusSchema.default("pending"),
  }),
  z.object({
    action: z.literal("transition"),
    itemId: z.string().regex(/^chk_[A-Za-z0-9_-]+$/u),
    status: checklistStatusSchema,
  }),
]);

const blockerAgentInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    workstreamId: workstreamIdSchema,
    kind: blockerKindSchema,
    title: z.string().trim().min(1).max(500),
    description: z.string().max(20_000),
  }),
  z.object({
    action: z.literal("transition"),
    blockerId: z.string().regex(/^blk_[A-Za-z0-9_-]+$/u),
    status: blockerStatusSchema,
  }),
]);

const rpcContract = defineRpcContract({
  list: {
    input: z
      .object({
        status: workstreamStatusSchema.nullable().default(null),
        responsibleThreadId: bbThreadIdSchema.nullable().default(null),
        limit: limitSchema,
      })
      .strict(),
    output: z.object({ workstreams: z.array(workstreamSummarySchema) }),
  },
  get: {
    input: z.object({ id: workstreamIdSchema }).strict(),
    output: workstreamDetailSchema.nullable(),
  },
  create: {
    input: z
      .object({
        title: z.string().trim().min(1).max(500),
        description: z.string().max(20_000).default(""),
        responsibleThreadId: bbThreadIdSchema,
        responsibleAgentId: responsibleAgentIdSchema,
        status: workstreamStatusSchema.default("planned"),
      })
      .strict(),
    output: workstreamSchema,
  },
  assign: {
    input: z
      .object({
        id: workstreamIdSchema,
        responsibleThreadId: bbThreadIdSchema,
        responsibleAgentId: responsibleAgentIdSchema,
      })
      .strict(),
    output: mutationWorkstreamSchema,
  },
  transition: {
    input: z
      .object({ id: workstreamIdSchema, status: workstreamStatusSchema })
      .strict(),
    output: mutationWorkstreamSchema,
  },
  checklistAdd: {
    input: z
      .object({
        workstreamId: workstreamIdSchema,
        title: z.string().trim().min(1).max(1000),
        position: z.number().int().nonnegative().nullable().default(null),
        status: checklistStatusSchema.default("pending"),
      })
      .strict(),
    output: mutationChecklistSchema,
  },
  checklistTransition: {
    input: z
      .object({ id: z.string().regex(/^chk_[A-Za-z0-9_-]+$/u), status: checklistStatusSchema })
      .strict(),
    output: mutationChecklistSchema,
  },
  blockerAdd: {
    input: z
      .object({
        workstreamId: workstreamIdSchema,
        kind: z.enum(["blocker", "review_blocker"]),
        title: z.string().trim().min(1).max(500),
        description: z.string().max(20_000),
      })
      .strict(),
    output: mutationBlockerSchema,
  },
  blockerTransition: {
    input: z
      .object({
        id: z.string().regex(/^blk_[A-Za-z0-9_-]+$/u),
        status: blockerStatusSchema,
      })
      .strict(),
    output: mutationBlockerSchema,
  },
  review: {
    input: z
      .object({
        workstreamId: workstreamIdSchema,
        repo: repositorySchema,
        pullNumber: z.number().int().positive(),
        sendToAgent: z.boolean().default(true),
      })
      .strict(),
    output: z.object({
      message: z.string(),
      feedbackCount: z.number().int().nonnegative(),
      blockerCount: z.number().int().nonnegative(),
      delivered: z.boolean(),
    }),
  },
  requestAction: {
    input: z
      .object({
        workstreamId: workstreamIdSchema,
        requestedByThreadId: bbThreadIdSchema,
        intent: supportedActionIntentSchema,
        expiresInSeconds: z.number().int().min(60).max(86_400).default(600),
      })
      .strict(),
    output: actionRequestSchema,
  },
  confirmAction: {
    input: z
      .object({
        confirmationId: z.string().regex(/^cnf_[A-Za-z0-9_-]+$/u),
        token: z.string().min(1),
        intent: supportedActionIntentSchema,
        resolvedByThreadId: bbThreadIdSchema,
      })
      .strict(),
    output: executeActionSchema,
  },
  rejectAction: {
    input: z
      .object({
        confirmationId: z.string().regex(/^cnf_[A-Za-z0-9_-]+$/u),
        token: z.string().min(1),
        intent: supportedActionIntentSchema,
        resolvedByThreadId: bbThreadIdSchema,
      })
      .strict(),
    output: mutationConfirmationSchema,
  },
});

export { rpcContract };

function stringParameter(intent: ActionIntent, name: string): string {
  const value = intent.parameters[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`action parameter ${name} must be a non-empty string`);
  }
  return value.trim();
}

function booleanParameter(
  intent: ActionIntent,
  name: string,
  fallback: boolean,
): boolean {
  const value = intent.parameters[name];
  return value === undefined ? fallback : z.boolean().parse(value);
}

function environmentId(intent: ActionIntent): string {
  const value = intent.parameters.environmentId;
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : intent.targetId;
}

export function actionPreview(intent: ActionIntent): string {
  const action = actionSchema.parse(intent.action);
  const parameters = jsonObjectSchema.parse(intent.parameters);
  switch (action) {
    case "commit":
      return [
        "Action: commit",
        `Target: ${intent.targetId}`,
        `Environment: ${environmentId(intent)}`,
      ].join("\n");
    case "mark_ready":
      return [
        "Action: mark pull request ready",
        `Target: ${intent.targetId}`,
        `Environment: ${environmentId(intent)}`,
      ].join("\n");
    case "merge":
      return [
        "Action: merge pull request",
        `Target: ${intent.targetId}`,
        `Environment: ${environmentId(intent)}`,
        `Method: ${z.enum(["merge", "squash", "rebase"]).parse(
          intent.parameters.method ?? "squash",
        )}`,
      ].join("\n");
    case "archive":
      return [
        "Action: archive threads",
        `Target: ${intent.targetId}`,
        `Environment: ${environmentId(intent)}`,
      ].join("\n");
    case "open_pr": {
      const body = typeof parameters.body === "string" ? parameters.body : "";
      return [
        "Action: open pull request",
        `Target: ${intent.targetId}`,
        `Repository: ${stringParameter(intent, "repo")}`,
        `Head: ${stringParameter(intent, "head")}`,
        `Base: ${stringParameter(intent, "base")}`,
        `Title: ${stringParameter(intent, "title")}`,
        `Draft: ${booleanParameter(intent, "draft", false) ? "yes" : "no"}`,
        `Body:\n${body || "(empty)"}`,
      ].join("\n");
    }
    default:
      throw new Error(`unsupported action ${action}`);
  }
}

async function executeConfirmedAction(
  bb: BbPluginApi,
  intent: ActionIntent,
): Promise<{ url?: string }> {
  switch (actionSchema.parse(intent.action)) {
    case "commit":
      await bb.sdk.environments.commit({ environmentId: environmentId(intent) });
      return {};
    case "mark_ready":
      await bb.sdk.environments.markPullRequestReady({
        environmentId: environmentId(intent),
      });
      return {};
    case "merge":
      await bb.sdk.environments.mergePullRequest({
        environmentId: environmentId(intent),
        method: z.enum(["merge", "squash", "rebase"]).parse(
          intent.parameters.method ?? "squash",
        ),
      });
      return {};
    case "archive":
      await bb.sdk.environments.archiveThreads({
        environmentId: environmentId(intent),
      });
      return {};
    case "open_pr": {
      const parameters = jsonObjectSchema.parse(intent.parameters);
      const result = await openPullRequest({
        repo: stringParameter(intent, "repo"),
        head: stringParameter(intent, "head"),
        base: stringParameter(intent, "base"),
        title: stringParameter(intent, "title"),
        body: typeof parameters.body === "string" ? parameters.body : "",
        draft: booleanParameter(intent, "draft", false),
      });
      return result;
    }
    default:
      throw new Error(
        `unsupported mutating action ${intent.action}; supported actions are commit, open_pr, mark_ready, merge, and archive`,
      );
  }
}

async function confirmRequestedAction(
  bb: BbPluginApi,
  store: WorkstreamsStore,
  input: {
    confirmationId: string;
    token: string;
    intent: ActionIntent;
    resolvedByThreadId: string;
  },
) {
  const started = store.beginConfirmation({
    id: input.confirmationId,
    token: input.token,
    intent: input.intent,
  });
  if (!started.ok) return started;

  let actionResult: { url?: string };
  try {
    actionResult = await executeConfirmedAction(bb, started.value.intent);
  } catch (error) {
    store.releaseConfirmation(started.value.confirmation.id);
    throw error;
  }

  const completed = store.completeConfirmation({
    id: started.value.confirmation.id,
    resolvedByThreadId: input.resolvedByThreadId,
  });
  if (!completed.ok) {
    throw new Error(
      `action completed but confirmation ${input.confirmationId} could not be finalized: ${completed.error.message}`,
    );
  }
  bb.realtime.publish("workstreams", { at: Date.now() });
  return {
    ok: true as const,
    confirmation: completed.value,
    actionResult: {
      action: completed.value.intent.action,
      targetId: completed.value.intent.targetId,
      result: actionResult,
    },
  };
}

function detail(
  store: WorkstreamsStore,
  id: string,
): z.infer<typeof workstreamDetailSchema> | null {
  const workstream = store.getWorkstream(id);
  if (workstream === null) return null;
  return {
    workstream,
    checklist: store.listChecklistItems(id),
    blockers: store.listBlockers(id),
    confirmations: store.listConfirmations(id, null),
  };
}

function summary(
  store: WorkstreamsStore,
  workstream: Workstream,
): z.infer<typeof workstreamSummarySchema> {
  const checklist = store.listChecklistItems(workstream.id);
  const blockers = store.listBlockers(workstream.id);
  return {
    workstream,
    checklist: {
      total: checklist.length,
      done: checklist.filter((item) => item.status === "done").length,
      blocked: checklist.filter((item) => item.status === "blocked").length,
    },
    openReviewBlockers: blockers.filter(
      (blocker) =>
        blocker.kind === "review_blocker" && blocker.status === "open",
    ).length,
  };
}

function syncReviewBlockers(
  store: WorkstreamsStore,
  workstreamId: string,
  desired: Array<{ title: string; description: string }>,
): number {
  const existing = store.listBlockers(workstreamId).filter(
    (blocker) =>
      blocker.kind === "review_blocker" &&
      blocker.title.startsWith("GitHub "),
  );
  const desiredTitles = new Set(desired.map((blocker) => blocker.title));
  for (const blocker of existing) {
    if (!desiredTitles.has(blocker.title) && blocker.status === "open") {
      store.transitionBlocker(blocker.id, "resolved");
    }
  }
  for (const blocker of desired) {
    const match = existing.find((item) => item.title === blocker.title);
    if (match === undefined) {
      const created = store.createBlocker({
        workstreamId,
        kind: "review_blocker",
        title: blocker.title,
        description: blocker.description,
      });
      if (!created.ok) throw new Error(created.error.message);
    } else if (match.status !== "open") {
      const reopened = store.transitionBlocker(match.id, "open");
      if (!reopened.ok) throw new Error(reopened.error.message);
    }
  }
  return desired.length;
}

function parseFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function requiredFlag(args: readonly string[], name: string): string {
  const value = parseFlag(args, name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

function parseJsonObject(value: string): ActionIntent["parameters"] {
  return jsonObjectSchema.parse(JSON.parse(value));
}

function positional(args: readonly string[], index: number): string {
  const values = args.filter((arg) => !arg.startsWith("--"));
  const value = values[index];
  if (value === undefined) throw new Error("missing positional argument");
  return value;
}

function jsonOutput(value: unknown): { exitCode: number; stdout: string } {
  return { exitCode: 0, stdout: JSON.stringify(value, null, 2) };
}

async function reviewWorkstream(
  bb: BbPluginApi,
  store: WorkstreamsStore,
  input: {
    workstreamId: string;
    repo: string;
    pullNumber: number;
    sendToAgent: boolean;
  },
) {
  const workstream = store.getWorkstream(input.workstreamId);
  if (workstream === null) throw new Error("workstream was not found");
  const snapshot = await readPullRequest(input.repo, input.pullNumber);
  const feedback = snapshot.reviews.filter(
    (review) => review.body.length > 0 || review.state === "CHANGES_REQUESTED",
  );
  const blockerCount = syncReviewBlockers(
    store,
    input.workstreamId,
    reviewBlockers(snapshot),
  );
  const message = formatReviewFeedbackMessage(snapshot);
  const agentMessage = formatReviewFeedbackAgentMessage(snapshot);
  let delivered = false;
  if (input.sendToAgent) {
    await bb.sdk.threads.send({
      threadId: workstream.responsibleThreadId,
      mode: "auto",
      input: [{ type: "text", text: agentMessage, mentions: [] }],
    });
    delivered = true;
  }
  bb.realtime.publish("workstreams", { at: Date.now() });
  return {
    message,
    feedbackCount: feedback.length,
    blockerCount,
    delivered,
  };
}

export default async function plugin(bb: BbPluginApi) {
  const database = bb.storage.database();
  bb.storage.migrate(database, WORKSTREAM_MIGRATIONS);
  const store = createWorkstreamsStore(database);

  bb.rpc.register(rpcContract, {
    list(input) {
      return {
        workstreams: store
          .listWorkstreams(input)
          .map((workstream) => summary(store, workstream)),
      };
    },
    get(input) {
      return detail(store, input.id);
    },
    create(input) {
      const workstream = store.createWorkstream(input);
      bb.realtime.publish("workstreams", { at: Date.now() });
      return workstream;
    },
    assign(input) {
      const result = store.assignWorkstream(
        input.id,
        input.responsibleThreadId,
        input.responsibleAgentId,
      );
      if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
      return result;
    },
    transition(input) {
      const result = store.transitionWorkstream(input.id, input.status);
      if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
      return result;
    },
    checklistAdd(input) {
      const result = store.createChecklistItem(input);
      if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
      return result;
    },
    checklistTransition(input) {
      const result = store.transitionChecklistItem(input.id, input.status);
      if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
      return result;
    },
    blockerAdd(input) {
      const result = store.createBlocker(input);
      if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
      return result;
    },
    blockerTransition(input) {
      const result = store.transitionBlocker(input.id, input.status);
      if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
      return result;
    },
    async review(input) {
      return reviewWorkstream(bb, store, input);
    },
    requestAction(input) {
      const result = store.requestConfirmation(input);
      if (!result.ok) throw new Error(result.error.message);
      return {
        ...result.value,
        preview: actionPreview(input.intent),
      };
    },
    async confirmAction(input) {
      return confirmRequestedAction(bb, store, {
        confirmationId: input.confirmationId,
        token: input.token,
        intent: input.intent,
        resolvedByThreadId: input.resolvedByThreadId,
      });
    },
    rejectAction(input) {
      const result = store.rejectConfirmation({
        id: input.confirmationId,
        token: input.token,
        intent: input.intent,
        resolvedByThreadId: input.resolvedByThreadId,
      });
      if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
      return result;
    },
  });

  bb.cli.register({
    name: "workstreams",
    summary: "Track agent checklists, review blockers, and confirmed actions",
    commands: [
      { name: "list", summary: "List workstreams", usage: "bb workstreams list [--status <status>]" },
      { name: "show", summary: "Show a workstream", usage: "bb workstreams show <id>" },
      { name: "create", summary: "Create a workstream", usage: "bb workstreams create --title <title> --thread <thread-id> --agent <agent-id>" },
      { name: "transition", summary: "Transition a workstream", usage: "bb workstreams transition <id> --status <status>" },
      { name: "checklist", summary: "Add or transition checklist items", usage: "bb workstreams checklist add|transition ..." },
      { name: "blocker", summary: "Add or transition blockers", usage: "bb workstreams blocker add|transition ..." },
      { name: "review", summary: "Fetch GitHub review feedback", usage: "bb workstreams review <id> --repo owner/repo --pr <number>" },
      { name: "action", summary: "Request or confirm a guarded action", usage: "bb workstreams action request|confirm ..." },
    ],
    async run(argv) {
      const [command] = argv;
      if (command === "list") {
        const statusValue = parseFlag(argv, "--status");
        const status = statusValue === undefined ? null : workstreamStatusSchema.parse(statusValue);
        return jsonOutput({
          workstreams: store
            .listWorkstreams({
              status,
              responsibleThreadId: null,
              limit: limitSchema.parse(Number(parseFlag(argv, "--limit") ?? 50)),
            })
            .map((workstream) => summary(store, workstream)),
        });
      }
      if (command === "show") {
        return jsonOutput(detail(store, positional(argv, 1)));
      }
      if (command === "create") {
        const workstream = store.createWorkstream({
          title: requiredFlag(argv, "--title"),
          description: parseFlag(argv, "--description") ?? "",
          responsibleThreadId: bbThreadIdSchema.parse(requiredFlag(argv, "--thread")),
          responsibleAgentId: responsibleAgentIdSchema.parse(requiredFlag(argv, "--agent")),
          status: workstreamStatusSchema.parse(parseFlag(argv, "--status") ?? "planned"),
        });
        bb.realtime.publish("workstreams", { at: Date.now() });
        return jsonOutput(workstream);
      }
      if (command === "transition") {
        const result = store.transitionWorkstream(
          workstreamIdSchema.parse(positional(argv, 1)),
          workstreamStatusSchema.parse(requiredFlag(argv, "--status")),
        );
        if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
        return jsonOutput(result);
      }
      if (command === "checklist") {
        const checklistCommand = positional(argv, 1);
        if (checklistCommand === "add") {
          const positionValue = parseFlag(argv, "--position");
          const result = store.createChecklistItem({
            workstreamId: workstreamIdSchema.parse(positional(argv, 2)),
            title: requiredFlag(argv, "--title"),
            position:
              positionValue === undefined
                ? null
                : z.number().int().nonnegative().parse(Number(positionValue)),
            status: checklistStatusSchema.parse(
              parseFlag(argv, "--status") ?? "pending",
            ),
          });
          if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
          return jsonOutput(result);
        }
        if (checklistCommand === "transition") {
          const result = store.transitionChecklistItem(
            z.string().regex(/^chk_[A-Za-z0-9_-]+$/u).parse(positional(argv, 2)),
            checklistStatusSchema.parse(requiredFlag(argv, "--status")),
          );
          if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
          return jsonOutput(result);
        }
      }
      if (command === "blocker") {
        const blockerCommand = positional(argv, 1);
        if (blockerCommand === "add") {
          const result = store.createBlocker({
            workstreamId: workstreamIdSchema.parse(positional(argv, 2)),
            kind: blockerKindSchema.parse(requiredFlag(argv, "--kind")),
            title: requiredFlag(argv, "--title"),
            description: parseFlag(argv, "--description") ?? "",
          });
          if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
          return jsonOutput(result);
        }
        if (blockerCommand === "transition") {
          const result = store.transitionBlocker(
            z.string().regex(/^blk_[A-Za-z0-9_-]+$/u).parse(positional(argv, 2)),
            blockerStatusSchema.parse(requiredFlag(argv, "--status")),
          );
          if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
          return jsonOutput(result);
        }
      }
      if (command === "review") {
        const result = await reviewWorkstream(bb, store, {
          workstreamId: workstreamIdSchema.parse(positional(argv, 1)),
          repo: repositorySchema.parse(requiredFlag(argv, "--repo")),
          pullNumber: z.number().int().positive().parse(Number(requiredFlag(argv, "--pr"))),
          sendToAgent: !argv.includes("--no-send"),
        });
        return jsonOutput(result);
      }
      if (command === "action") {
        const actionCommand = positional(argv, 1);
        if (actionCommand === "request") {
          const workstreamId = workstreamIdSchema.parse(positional(argv, 2));
          const intent: ActionIntent = supportedActionIntentSchema.parse({
            action: positional(argv, 3),
            targetId: positional(argv, 4),
            parameters: parseJsonObject(parseFlag(argv, "--params-json") ?? "{}"),
          });
          const requested = store.requestConfirmation({
            workstreamId,
            requestedByThreadId: bbThreadIdSchema.parse(requiredFlag(argv, "--thread")),
            intent,
            expiresInSeconds: Number(parseFlag(argv, "--expires") ?? 600),
          });
          if (!requested.ok) throw new Error(requested.error.message);
          return jsonOutput({
            ...requested.value,
            preview: actionPreview(intent),
          });
        }
        if (actionCommand === "confirm") {
          const confirmationId = positional(argv, 2);
          const confirmation = store.getConfirmation(confirmationId);
          if (confirmation === null) throw new Error("confirmation was not found");
          const result = await confirmRequestedAction(bb, store, {
            confirmationId: confirmation.id,
            token: requiredFlag(argv, "--token"),
            intent: confirmation.intent,
            resolvedByThreadId: bbThreadIdSchema.parse(requiredFlag(argv, "--thread")),
          });
          return jsonOutput(result);
        }
      }
      return {
        exitCode: 1,
        stderr:
          "Usage: bb workstreams list|show|create|transition|checklist|blocker|review|action request|action confirm",
      };
    },
  });

  bb.agents.registerTool({
    name: "workstreams_status",
    description: "Read a BB workstream's checklist and blocker state.",
    parameters: z.object({ workstreamId: workstreamIdSchema }),
    async execute({ workstreamId }) {
      return JSON.stringify(detail(store, workstreamId));
    },
  });

  bb.agents.registerTool({
    name: "workstreams_transition",
    description: "Transition a BB workstream after checking its current state.",
    parameters: z.object({
      workstreamId: workstreamIdSchema,
      status: workstreamStatusSchema,
    }),
    execute(input) {
      const result = store.transitionWorkstream(input.workstreamId, input.status);
      if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
      return JSON.stringify(result);
    },
  });

  bb.agents.registerTool({
    name: "workstreams_checklist",
    description: "Add a checklist item or transition an existing checklist item.",
    parameters: checklistAgentInputSchema,
    execute(input) {
      const result =
        input.action === "add"
          ? store.createChecklistItem({
              workstreamId: input.workstreamId,
              title: input.title,
              position: input.position,
              status: input.status,
            })
          : store.transitionChecklistItem(input.itemId, input.status);
      if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
      return JSON.stringify(result);
    },
  });

  bb.agents.registerTool({
    name: "workstreams_blocker",
    description: "Add a blocker or transition an existing blocker.",
    parameters: blockerAgentInputSchema,
    execute(input) {
      const result =
        input.action === "add"
          ? store.createBlocker({
              workstreamId: input.workstreamId,
              kind: input.kind,
              title: input.title,
              description: input.description,
            })
          : store.transitionBlocker(input.blockerId, input.status);
      if (result.ok) bb.realtime.publish("workstreams", { at: Date.now() });
      return JSON.stringify(result);
    },
  });

  bb.agents.registerTool({
    name: "workstreams_request_confirmation",
    description:
      "Create a preview-only confirmation for a commit, PR, ready, merge, or archive action. It never executes the action.",
    parameters: z.object({
      workstreamId: workstreamIdSchema,
      requestedByThreadId: bbThreadIdSchema,
      action: z.enum(["commit", "open_pr", "mark_ready", "merge", "archive"]),
      targetId: z.string().trim().min(1),
      parameters: jsonObjectSchema.default({}),
    }),
    async execute(input) {
      const requested = store.requestConfirmation({
        workstreamId: input.workstreamId,
        requestedByThreadId: input.requestedByThreadId,
        intent: {
          action: input.action,
          targetId: input.targetId,
          parameters: input.parameters,
        },
        expiresInSeconds: 600,
      });
      if (!requested.ok) return JSON.stringify(requested);
      return JSON.stringify({
        confirmation: requested.value.confirmation,
        token: requested.value.token,
        preview: actionPreview(requested.value.confirmation.intent),
      });
    },
  });

  bb.agents.registerTool({
    name: "workstreams_confirm_action",
    description:
      "Execute a previously previewed action only after the user explicitly confirms the exact preview and supplies its one-time token.",
    parameters: z.object({
      confirmationId: confirmationIdSchema,
      token: z.string().min(1),
      intent: supportedActionIntentSchema,
    }),
    async execute(input, ctx) {
      const stored = store.getConfirmation(input.confirmationId);
      if (stored === null) {
        return "The confirmation was not found or has expired; no action ran.";
      }
      const preview = actionPreview(stored.intent);
      let approval;
      try {
        approval = await bb.ui.requestInput(
          {
            threadId: ctx.threadId,
            rendererId: ACTION_CONFIRMATION_RENDERER,
            title: `Confirm ${stored.intent.action.replaceAll("_", " ")}`,
            payload: {
              kind: "workstreams_action_confirmation",
              confirmationId: input.confirmationId,
              intent: stored.intent,
              preview,
            },
          },
          { signal: ctx.signal },
        );
      } catch (error) {
        return `The confirmation could not be shown (${error instanceof Error ? error.message : String(error)}); no action ran.`;
      }

      if (approval.outcome === "cancelled") {
        return "The user did not approve this action; no action ran.";
      }
      if (!actionConfirmationResponseSchema.safeParse(approval.value).success) {
        return "The confirmation form returned an invalid response; no action ran.";
      }

      return JSON.stringify(
        await confirmRequestedAction(bb, store, {
          confirmationId: input.confirmationId,
          token: input.token,
          intent: stored.intent,
          resolvedByThreadId: ctx.threadId,
        }),
      );
    },
  });

  bb.agents.registerTool({
    name: "workstreams_review_feedback",
    description:
      "Fetch GitHub pull-request review feedback, track review blockers, and send the summary to the responsible BB agent.",
    parameters: z.object({
      workstreamId: workstreamIdSchema,
      repo: repositorySchema,
      pullNumber: z.number().int().positive(),
    }),
    async execute(input) {
      return JSON.stringify(
        await reviewWorkstream(bb, store, { ...input, sendToAgent: true }),
      );
    },
  });

  bb.log.info("workstreams loaded");
}
