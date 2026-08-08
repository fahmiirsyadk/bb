import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSTREAM_MIGRATIONS } from "./store";
import { createWorkstreamsStore } from "./store";

const harnesses: Array<{ dispose(): Promise<void> }> = [];

function setup() {
  const host = createFakePluginHost({ pluginId: "workstreams" });
  harnesses.push(host.harness);
  const database = host.bb.storage.database();
  host.bb.storage.migrate(database, WORKSTREAM_MIGRATIONS);
  return createWorkstreamsStore(database);
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("workstreams store", () => {
  it("tracks checklist progress and review blockers with legal transitions", () => {
    const store = setup();
    const workstream = store.createWorkstream({
      title: "Review worker",
      description: "Keep the agent unblocked.",
      responsibleThreadId: "thr_worker",
      responsibleAgentId: "agent-1",
      status: "planned",
    });

    const first = store.createChecklistItem({
      workstreamId: workstream.id,
      title: "Run checks",
      position: null,
      status: "pending",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(store.transitionChecklistItem(first.value.id, "done").ok).toBe(true);

    const blocker = store.createBlocker({
      workstreamId: workstream.id,
      kind: "review_blocker",
      title: "Changes requested",
      description: "Fix the failing assertion.",
    });
    expect(blocker.ok).toBe(true);
    if (!blocker.ok) return;
    expect(store.transitionBlocker(blocker.value.id, "resolved").ok).toBe(true);
    expect(store.transitionBlocker(blocker.value.id, "open").ok).toBe(true);
    expect(store.transitionWorkstream(workstream.id, "active").ok).toBe(true);
    expect(store.transitionWorkstream(workstream.id, "completed").ok).toBe(true);
    expect(store.transitionWorkstream(workstream.id, "active").ok).toBe(false);
    expect(store.getWorkstream(workstream.id)?.status).toBe("completed");
  });

  it("requires the exact intent and one-time token for confirmation", () => {
    const store = setup();
    const workstream = store.createWorkstream({
      title: "Guarded delivery",
      description: "No implicit merge.",
      responsibleThreadId: "thr_worker",
      responsibleAgentId: "agent-1",
      status: "active",
    });
    const intent = {
      action: "merge",
      targetId: "env_1",
      parameters: { method: "squash" },
    } as const;
    const requested = store.requestConfirmation({
      workstreamId: workstream.id,
      requestedByThreadId: "thr_owner",
      intent,
      expiresInSeconds: 600,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const mismatched = store.beginConfirmation({
      id: requested.value.confirmation.id,
      token: requested.value.token,
      intent: { ...intent, parameters: { method: "merge" } },
    });
    expect(mismatched).toEqual({
      ok: false,
      error: {
        code: "confirmation_intent_mismatch",
        message: "confirmation intent does not match the requested action",
      },
    });

    const started = store.beginConfirmation({
      id: requested.value.confirmation.id,
      token: requested.value.token,
      intent,
    });
    expect(started.ok).toBe(true);
    const completed = store.completeConfirmation({
      id: requested.value.confirmation.id,
      resolvedByThreadId: "thr_owner",
    });
    expect(completed.ok).toBe(true);
    const replay = store.beginConfirmation({
      id: requested.value.confirmation.id,
      token: requested.value.token,
      intent,
    });
    expect(replay.ok).toBe(false);
  });

  it("releases a claimed confirmation so a failed action can be retried", () => {
    const store = setup();
    const workstream = store.createWorkstream({
      title: "Retryable delivery",
      description: "A provider failure must not consume approval.",
      responsibleThreadId: "thr_worker",
      responsibleAgentId: "agent-1",
      status: "active",
    });
    const intent = {
      action: "commit",
      targetId: "env_1",
      parameters: {},
    } as const;
    const requested = store.requestConfirmation({
      workstreamId: workstream.id,
      requestedByThreadId: "thr_owner",
      intent,
      expiresInSeconds: 600,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    expect(
      store.beginConfirmation({
        id: requested.value.confirmation.id,
        token: requested.value.token,
        intent,
      }).ok,
    ).toBe(true);
    store.releaseConfirmation(requested.value.confirmation.id);
    expect(
      store.beginConfirmation({
        id: requested.value.confirmation.id,
        token: requested.value.token,
        intent,
      }).ok,
    ).toBe(true);
  });
});
