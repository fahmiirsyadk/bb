import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";
import {
  definePluginApp,
  type PluginPendingInteractionProps,
  useBbContext,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import type {
  ActionIntent,
  Blocker,
  ChecklistItem,
  Confirmation,
  Workstream,
} from "./domain";
import {
  actionIntentSchema,
  confirmationIdSchema,
  jsonObjectSchema,
} from "./domain";
import type { rpcContract } from "./server";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

type Summary = {
  workstream: Workstream;
  checklist: { total: number; done: number; blocked: number };
  openReviewBlockers: number;
};

type Detail = {
  workstream: Workstream;
  checklist: ChecklistItem[];
  blockers: Blocker[];
  confirmations: Confirmation[];
};

const STATUS_LABELS: Record<Workstream["status"], string> = {
  planned: "Planned",
  active: "Active",
  blocked: "Blocked",
  in_review: "In review",
  completed: "Completed",
  canceled: "Canceled",
};

const ACTIONS = ["commit", "open_pr", "mark_ready", "merge", "archive"] as const;
const actionConfirmationPayloadSchema = z
  .object({
    kind: z.literal("workstreams_action_confirmation"),
    confirmationId: confirmationIdSchema,
    intent: actionIntentSchema,
    preview: z.string(),
  })
  .strict();

function actionLabel(action: ActionIntent["action"]): string {
  return action.replaceAll("_", " ");
}

function actionFromSelect(value: string): (typeof ACTIONS)[number] {
  const action = ACTIONS.find((candidate) => candidate === value);
  if (action === undefined) throw new Error("Unsupported action");
  return action;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

function statusClass(status: Workstream["status"]): string {
  switch (status) {
    case "blocked":
      return "border-attention text-attention-foreground";
    case "completed":
      return "border-success text-success-foreground";
    case "canceled":
      return "border-border text-subtle-foreground";
    default:
      return "border-border text-foreground";
  }
}

function WorkstreamsActionConfirmation({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = actionConfirmationPayloadSchema.safeParse(interaction.payload);

  const handleCancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await cancel();
    } catch (cancelError) {
      setError(errorText(cancelError));
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      await submit({ approved: true });
    } catch (submitError) {
      setError(errorText(submitError));
      setBusy(false);
    }
  };

  if (!parsed.success) {
    return (
      <section className="space-y-3 border-t border-border p-4" aria-labelledby={`workstreams-confirmation-${interaction.id}`}>
        <h2 id={`workstreams-confirmation-${interaction.id}`} className="text-sm font-medium">
          Unable to read action confirmation
        </h2>
        <p role="alert" className="text-sm text-destructive-text">
          The action details are invalid. Cancel this request and create a new preview.
        </p>
        <button
          type="button"
          className="min-h-9 rounded border border-border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
          onClick={() => void handleCancel()}
          disabled={busy}
        >
          Cancel request
        </button>
      </section>
    );
  }

  const label = actionLabel(parsed.data.intent.action);
  return (
    <section
      className="space-y-3 border-t border-border p-4"
      aria-labelledby={`workstreams-confirmation-${interaction.id}`}
      aria-busy={busy}
    >
      <div>
        <h2 id={`workstreams-confirmation-${interaction.id}`} className="text-sm font-medium">
          Confirm {label}
        </h2>
        <p className="mt-1 text-sm text-subtle-foreground">
          Review the exact action details. Nothing runs until you confirm.
        </p>
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-recessed p-3 font-mono text-xs" tabIndex={0}>
        {parsed.data.preview}
      </pre>
      {error ? <p role="alert" className="text-sm text-destructive-text">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="min-h-9 rounded border border-border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
          onClick={() => void handleCancel()}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="min-h-9 rounded border border-attention px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
          onClick={() => void handleConfirm()}
          disabled={busy}
        >
          {busy ? "Confirming…" : `Confirm ${label}`}
        </button>
      </div>
    </section>
  );
}

function DetailView({
  detail,
  rpc,
  onRefresh,
  currentThreadId,
}: {
  detail: Detail;
  rpc: Rpc;
  onRefresh: () => Promise<void>;
  currentThreadId: string;
}) {
  const [action, setAction] = useState<(typeof ACTIONS)[number]>("archive");
  const [targetId, setTargetId] = useState("");
  const [parameters, setParameters] = useState("{}");
  const [confirmation, setConfirmation] = useState<{
    confirmation: Confirmation;
    token: string;
    preview: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const requestAction = async () => {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const rawParameters: unknown = JSON.parse(parameters);
      const parsedParameters = jsonObjectSchema.parse(rawParameters);
      const result = await rpc.call("requestAction", {
        workstreamId: detail.workstream.id,
        requestedByThreadId: currentThreadId || detail.workstream.responsibleThreadId,
        intent: { action, targetId, parameters: parsedParameters },
        expiresInSeconds: 600,
      });
      setConfirmation(result);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setBusy(false);
    }
  };

  const confirmAction = async () => {
    if (confirmation === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("confirmAction", {
        confirmationId: confirmation.confirmation.id,
        token: confirmation.token,
        intent: confirmation.confirmation.intent,
        resolvedByThreadId: currentThreadId || detail.workstream.responsibleThreadId,
      });
      if (!result.ok) {
        setError(result.error.message);
      } else {
        setMessage(`Executed ${result.actionResult.action}.`);
        setConfirmation(null);
        await onRefresh();
      }
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`workstream-${detail.workstream.id}`} className="space-y-4 border-t border-border pt-4">
      <div>
        <h2 id={`workstream-${detail.workstream.id}`} className="text-base font-medium">
          {detail.workstream.title}
        </h2>
        <p className="mt-1 text-sm text-subtle-foreground">
          Responsible thread: <code>{detail.workstream.responsibleThreadId}</code>
        </p>
      </div>

      <section aria-labelledby={`${detail.workstream.id}-checklist`} className="space-y-2">
        <h3 id={`${detail.workstream.id}-checklist`} className="text-sm font-medium">
          Checklist
        </h3>
        {detail.checklist.length === 0 ? (
          <p className="text-sm text-subtle-foreground">No checklist items yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.checklist.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5">
                <span>{item.title}</span>
                <span className="text-xs text-subtle-foreground">{item.status.replace("_", " ")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${detail.workstream.id}-blockers`} className="space-y-2">
        <h3 id={`${detail.workstream.id}-blockers`} className="text-sm font-medium">
          Blockers and review blockers
        </h3>
        {detail.blockers.length === 0 ? (
          <p className="text-sm text-subtle-foreground">No blockers.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.blockers.map((blocker) => (
              <li key={blocker.id} className="rounded border border-border px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span>{blocker.title}</span>
                  <span className="text-xs text-subtle-foreground">{blocker.status}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-xs text-subtle-foreground">{blocker.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${detail.workstream.id}-actions`} className="space-y-2">
        <h3 id={`${detail.workstream.id}-actions`} className="text-sm font-medium">
          Explicitly confirmed actions
        </h3>
        <p className="text-xs text-subtle-foreground">
          Requesting only creates a preview token. The action runs after the separate Confirm button.
        </p>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void requestAction();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor={`${detail.workstream.id}-action`} className="text-xs font-medium">
                Action
              </label>
              <select
                id={`${detail.workstream.id}-action`}
                className="mt-1 h-9 w-full rounded border border-border bg-transparent px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
                value={action}
                onChange={(event) => setAction(actionFromSelect(event.target.value))}
              >
                {ACTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${detail.workstream.id}-target`} className="text-xs font-medium">
                Target ID
              </label>
              <input
                id={`${detail.workstream.id}-target`}
                className="mt-1 h-9 w-full rounded border border-border bg-transparent px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                placeholder="environment or target id"
                required
              />
            </div>
          </div>
          <div>
            <label htmlFor={`${detail.workstream.id}-parameters`} className="text-xs font-medium">
              Parameters JSON
            </label>
            <textarea
              id={`${detail.workstream.id}-parameters`}
              className="mt-1 min-h-16 w-full rounded border border-border bg-transparent px-2 py-1.5 font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-2"
              value={parameters}
              onChange={(event) => setParameters(event.target.value)}
              aria-describedby={`${detail.workstream.id}-parameters-help`}
            />
            <p id={`${detail.workstream.id}-parameters-help`} className="mt-1 text-xs text-subtle-foreground">
              Merge needs <code>{"{\"method\":\"squash\"}"}</code>; open_pr needs repo, head, base, and title.
            </p>
          </div>
          <button
            type="submit"
            className="min-h-9 rounded border border-border px-3 text-sm hover:bg-surface-recessed focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || (currentThreadId || detail.workstream.responsibleThreadId).length === 0}
          >
            {busy ? "Requesting…" : "Request confirmation"}
          </button>
        </form>

        {confirmation ? (
          <div className="space-y-2 rounded border border-attention p-3" aria-live="polite">
            <p className="text-sm font-medium">Review this action before confirming</p>
            <p className="text-xs text-subtle-foreground">{confirmation.preview}</p>
            <p className="break-all font-mono text-xs">Token: {confirmation.token}</p>
            <button
              type="button"
              className="min-h-9 rounded border border-attention px-3 text-sm hover:bg-surface-recessed focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
              onClick={() => void confirmAction()}
              disabled={busy}
            >
              {busy ? "Executing…" : `Confirm and ${confirmation.confirmation.intent.action}`}
            </button>
          </div>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive-text">{error}</p> : null}
        {message ? <p role="status" className="text-sm text-success-foreground">{message}</p> : null}
      </section>
    </section>
  );
}

function WorkstreamsPanel({
  subPath,
  threadFilter,
}: {
  subPath?: string;
  threadFilter?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [responsibleThreadId, setResponsibleThreadId] = useState(threadFilter ?? context.threadId ?? "");
  const [responsibleAgentId, setResponsibleAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const result = await rpc.call("list", {
      status: null,
      responsibleThreadId: threadFilter ?? null,
      limit: 50,
    });
    setSummaries(result.workstreams);
    if (selectedId !== null) {
      const detail = await rpc.call("get", { id: selectedId });
      setSelected(detail);
      if (detail === null) setSelectedId(null);
    }
  }, [rpc, selectedId, threadFilter]);

  useEffect(() => {
    void refresh().catch((loadError) => setError(errorText(loadError)));
  }, [refresh]);

  useRealtime("workstreams", () => {
    void refresh().catch((loadError) => setError(errorText(loadError)));
  });

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const threadId = responsibleThreadId.trim();
      const agentId = responsibleAgentId.trim();
      if (!threadId || !agentId) throw new Error("Responsible thread and agent are required.");
      await rpc.call("create", {
        title: title.trim(),
        description,
        responsibleThreadId: threadId,
        responsibleAgentId: agentId,
        status: "planned",
      });
      setTitle("");
      setDescription("");
      setMessage("Workstream created.");
      await refresh();
    } catch (createError) {
      setError(errorText(createError));
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (id: string) => {
    setError(null);
    try {
      const detail = await rpc.call("get", { id });
      setSelected(detail);
      setSelectedId(detail?.workstream.id ?? null);
    } catch (loadError) {
      setError(errorText(loadError));
    }
  };

  return (
    <main className="flex min-h-full flex-col gap-5 p-4 text-foreground">
      <header>
        <h1 className="text-lg font-semibold">Workstreams</h1>
        <p className="mt-1 text-sm text-subtle-foreground">
          Keep agent checklists, review blockers, and guarded delivery actions together.
        </p>
      </header>

      <section aria-labelledby="new-workstream-heading" className="space-y-3 rounded border border-border p-3">
        <h2 id="new-workstream-heading" className="text-sm font-medium">New workstream</h2>
        <form className="space-y-2" onSubmit={(event) => void create(event)}>
          <div>
            <label htmlFor="workstream-title" className="text-xs font-medium">Title</label>
            <input
              id="workstream-title"
              name="title"
              className="mt-1 h-9 w-full rounded border border-border bg-transparent px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="workstream-description" className="text-xs font-medium">Description</label>
            <textarea
              id="workstream-description"
              name="description"
              className="mt-1 min-h-16 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor="workstream-thread" className="text-xs font-medium">Responsible thread</label>
              <input
                id="workstream-thread"
                name="thread"
                className="mt-1 h-9 w-full rounded border border-border bg-transparent px-2 font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-2"
                value={responsibleThreadId}
                onChange={(event) => setResponsibleThreadId(event.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="workstream-agent" className="text-xs font-medium">Responsible agent</label>
              <input
                id="workstream-agent"
                name="agent"
                className="mt-1 h-9 w-full rounded border border-border bg-transparent px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
                value={responsibleAgentId}
                onChange={(event) => setResponsibleAgentId(event.target.value)}
                placeholder="agent name or id"
                required
              />
            </div>
          </div>
          <button
            type="submit"
            className="min-h-9 rounded border border-border px-3 text-sm hover:bg-surface-recessed focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
            disabled={busy}
          >
            {busy ? "Creating…" : "Create workstream"}
          </button>
        </form>
      </section>

      <section aria-labelledby="workstream-list-heading" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 id="workstream-list-heading" className="text-sm font-medium">
            {threadFilter ? `Workstreams for ${threadFilter}` : "All workstreams"}
          </h2>
          <button
            type="button"
            className="min-h-9 rounded border border-border px-3 text-sm hover:bg-surface-recessed focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() => void refresh().catch((loadError) => setError(errorText(loadError)))}
          >
            Refresh
          </button>
        </div>
        {summaries.length === 0 ? (
          <p className="text-sm text-subtle-foreground">No workstreams yet.</p>
        ) : (
          <ul className="space-y-2">
            {summaries.map((item) => (
              <li key={item.workstream.id} className={`rounded border p-3 ${statusClass(item.workstream.status)}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-medium">{item.workstream.title}</h3>
                    <p className="mt-1 text-xs text-subtle-foreground">
                      {STATUS_LABELS[item.workstream.status]} · {item.checklist.done}/{item.checklist.total} checklist items
                      {item.openReviewBlockers > 0 ? ` · ${item.openReviewBlockers} review blocker${item.openReviewBlockers === 1 ? "" : "s"}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="min-h-9 rounded border border-border px-3 text-sm hover:bg-surface-recessed focus-visible:outline-2 focus-visible:outline-offset-2"
                    onClick={() => void openDetail(item.workstream.id)}
                  >
                    {selected?.workstream.id === item.workstream.id ? "Selected" : "Open"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected ? (
        <DetailView
          detail={selected}
          rpc={rpc}
          onRefresh={refresh}
          currentThreadId={context.threadId ?? ""}
        />
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive-text">{error}</p> : null}
      {message ? <p role="status" className="text-sm text-success-foreground">{message}</p> : null}
      <p className="text-xs text-subtle-foreground">
        GitHub review sync requires an authenticated <code>gh</code> CLI on the BB server host. Mutating actions remain preview-only until you confirm them.
      </p>
    </main>
  );
}

function ThreadWorkstreamsPanel({ threadId }: { threadId: string }) {
  return <WorkstreamsPanel threadFilter={threadId} />;
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: "workstreams-action-confirmation",
    component: WorkstreamsActionConfirmation,
  });
  app.slots.navPanel({
    id: "workstreams",
    title: "Workstreams",
    icon: "ListTodo",
    path: "workstreams",
    component: ({ subPath }) => <WorkstreamsPanel subPath={subPath} />,
  });
  app.slots.threadPanelAction({
    id: "thread-workstreams",
    title: "Workstreams",
    icon: "ListTodo",
    component: ThreadWorkstreamsPanel,
  });
});
