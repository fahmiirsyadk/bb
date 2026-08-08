import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  actionIntentSchema,
  bbThreadIdSchema,
  BLOCKER_ALLOWED_TRANSITIONS,
  blockerSchema,
  CHECKLIST_ALLOWED_TRANSITIONS,
  checklistItemSchema,
  canonicalizeJson,
  confirmationSchema,
  failure,
  type ActionIntent,
  type Blocker,
  type BlockerKind,
  type BlockerStatus,
  type ChecklistItem,
  type ChecklistStatus,
  type Confirmation,
  type ConfirmationStatus,
  type StoreMutation,
  type Workstream,
  type WorkstreamStatus,
  WORKSTREAM_ALLOWED_TRANSITIONS,
  workstreamSchema,
} from "./domain";

export type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

export const WORKSTREAM_MIGRATIONS = [
  "CREATE TABLE IF NOT EXISTS workstreams (" +
    "id TEXT PRIMARY KEY NOT NULL, " +
    "title TEXT NOT NULL, " +
    "description TEXT NOT NULL, " +
    "responsible_thread_id TEXT NOT NULL, " +
    "responsible_agent_id TEXT NOT NULL, " +
    "status TEXT NOT NULL CHECK (status IN " +
    "('planned', 'active', 'blocked', 'in_review', 'completed', 'canceled')), " +
    "created_at TEXT NOT NULL, " +
    "updated_at TEXT NOT NULL" +
    ")",
  "CREATE TABLE IF NOT EXISTS checklist_items (" +
    "id TEXT PRIMARY KEY NOT NULL, " +
    "workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE, " +
    "title TEXT NOT NULL, " +
    "position INTEGER NOT NULL CHECK (position >= 0), " +
    "status TEXT NOT NULL CHECK (status IN " +
    "('pending', 'in_progress', 'blocked', 'done', 'canceled')), " +
    "created_at TEXT NOT NULL, " +
    "updated_at TEXT NOT NULL" +
    ")",
  "CREATE TABLE IF NOT EXISTS blockers (" +
    "id TEXT PRIMARY KEY NOT NULL, " +
    "workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE, " +
    "kind TEXT NOT NULL CHECK (kind IN ('blocker', 'review_blocker')), " +
    "title TEXT NOT NULL, " +
    "description TEXT NOT NULL, " +
    "status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')), " +
    "created_at TEXT NOT NULL, " +
    "updated_at TEXT NOT NULL, " +
    "resolved_at TEXT" +
    ")",
  "CREATE TABLE IF NOT EXISTS confirmations (" +
    "id TEXT PRIMARY KEY NOT NULL, " +
    "workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE, " +
    "requested_by_thread_id TEXT NOT NULL, " +
    "action TEXT NOT NULL, " +
    "target_id TEXT NOT NULL, " +
    "intent_json TEXT NOT NULL, " +
    "token_hash TEXT NOT NULL UNIQUE, " +
    "status TEXT NOT NULL CHECK (status IN " +
    "('pending', 'confirmed', 'rejected', 'expired')), " +
    "created_at TEXT NOT NULL, " +
    "expires_at TEXT NOT NULL, " +
    "resolved_at TEXT, " +
    "resolved_by_thread_id TEXT" +
    ")",
  "CREATE INDEX IF NOT EXISTS checklist_items_workstream_position " +
    "ON checklist_items(workstream_id, position, id)",
  "CREATE INDEX IF NOT EXISTS blockers_workstream_status " +
    "ON blockers(workstream_id, status, kind, id)",
  "CREATE INDEX IF NOT EXISTS confirmations_workstream_status " +
    "ON confirmations(workstream_id, status, created_at, id)",
  "ALTER TABLE confirmations ADD COLUMN execution_started_at TEXT",
];

export interface WorkstreamsStore {
  createWorkstream(input: {
    title: string;
    description: string;
    responsibleThreadId: string;
    responsibleAgentId: string;
    status: WorkstreamStatus;
  }): Workstream;
  getWorkstream(id: string): Workstream | null;
  listWorkstreams(input: {
    status: WorkstreamStatus | null;
    responsibleThreadId: string | null;
    limit: number;
  }): Workstream[];
  assignWorkstream(
    id: string,
    responsibleThreadId: string,
    responsibleAgentId: string,
  ): StoreMutation<Workstream>;
  transitionWorkstream(
    id: string,
    nextStatus: WorkstreamStatus,
  ): StoreMutation<Workstream>;

  createChecklistItem(input: {
    workstreamId: string;
    title: string;
    position: number | null;
    status: ChecklistStatus;
  }): StoreMutation<ChecklistItem>;
  listChecklistItems(workstreamId: string): ChecklistItem[];
  transitionChecklistItem(
    id: string,
    nextStatus: ChecklistStatus,
  ): StoreMutation<ChecklistItem>;

  createBlocker(input: {
    workstreamId: string;
    kind: BlockerKind;
    title: string;
    description: string;
  }): StoreMutation<Blocker>;
  listBlockers(workstreamId: string): Blocker[];
  transitionBlocker(
    id: string,
    nextStatus: BlockerStatus,
  ): StoreMutation<Blocker>;

  requestConfirmation(input: {
    workstreamId: string;
    requestedByThreadId: string;
    intent: ActionIntent;
    expiresInSeconds: number;
  }): StoreMutation<{ confirmation: Confirmation; token: string }>;
  getConfirmation(id: string): Confirmation | null;
  listConfirmations(
    workstreamId: string,
    status: ConfirmationStatus | null,
  ): Confirmation[];
  beginConfirmation(input: {
    id: string;
    token: string;
    intent: ActionIntent;
  }): StoreMutation<Confirmation>;
  completeConfirmation(input: {
    id: string;
    resolvedByThreadId: string;
  }): StoreMutation<Confirmation>;
  releaseConfirmation(id: string): void;
  rejectConfirmation(input: {
    id: string;
    token: string;
    intent: ActionIntent;
    resolvedByThreadId: string;
  }): StoreMutation<Confirmation>;
}

interface WorkstreamRow {
  id: string;
  title: string;
  description: string;
  responsible_thread_id: string;
  responsible_agent_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ChecklistItemRow {
  id: string;
  workstream_id: string;
  title: string;
  position: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface BlockerRow {
  id: string;
  workstream_id: string;
  kind: string;
  title: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface ConfirmationRow {
  id: string;
  workstream_id: string;
  requested_by_thread_id: string;
  action: string;
  target_id: string;
  intent_json: string;
  token_hash: string;
  status: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolved_by_thread_id: string | null;
  execution_started_at: string | null;
}

interface PositionRow {
  next_position: number;
}

interface StoreOptions {
  now?: () => Date;
}

function newId(prefix: string): string {
  return prefix + "_" + randomUUID().replaceAll("-", "");
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenMatches(token: string, storedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return (
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

function isExpired(expiresAt: string, now: Date): boolean {
  return Date.parse(expiresAt) <= now.getTime();
}

function workstreamFromRow(row: WorkstreamRow): Workstream {
  return workstreamSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    responsibleThreadId: row.responsible_thread_id,
    responsibleAgentId: row.responsible_agent_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function checklistItemFromRow(row: ChecklistItemRow): ChecklistItem {
  return checklistItemSchema.parse({
    id: row.id,
    workstreamId: row.workstream_id,
    title: row.title,
    position: row.position,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function blockerFromRow(row: BlockerRow): Blocker {
  return blockerSchema.parse({
    id: row.id,
    workstreamId: row.workstream_id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  });
}

function confirmationFromRow(row: ConfirmationRow): Confirmation {
  return confirmationSchema.parse({
    id: row.id,
    workstreamId: row.workstream_id,
    requestedByThreadId: row.requested_by_thread_id,
    intent: actionIntentSchema.parse(JSON.parse(row.intent_json)),
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedByThreadId: row.resolved_by_thread_id,
  });
}

function workstreamExists(database: PluginDatabase, id: string): boolean {
  return (
    database
      .prepare<[string], { found: number }>(
        "SELECT 1 AS found FROM workstreams WHERE id = ? LIMIT 1",
      )
      .get(id) !== undefined
  );
}

function transitionFailure(
  entity: string,
  id: string,
  current: string,
  next: string,
): StoreMutation<never> {
  return failure(
    "invalid_transition",
    entity +
      " " +
      id +
      " cannot transition from " +
      current +
      " to " +
      next,
  );
}

export function createWorkstreamsStore(
  database: PluginDatabase,
  options: StoreOptions = {},
): WorkstreamsStore {
  const now = options.now ?? (() => new Date());
  database.pragma("foreign_keys = ON");

  function getWorkstream(id: string): Workstream | null {
    const row = database
      .prepare<[string], WorkstreamRow>(
        "SELECT id, title, description, responsible_thread_id, " +
          "responsible_agent_id, status, created_at, updated_at " +
          "FROM workstreams WHERE id = ?",
      )
      .get(id);
    return row === undefined ? null : workstreamFromRow(row);
  }

  function getChecklistItem(id: string): ChecklistItem | null {
    const row = database
      .prepare<[string], ChecklistItemRow>(
        "SELECT id, workstream_id, title, position, status, created_at, " +
          "updated_at FROM checklist_items WHERE id = ?",
      )
      .get(id);
    return row === undefined ? null : checklistItemFromRow(row);
  }

  function getBlocker(id: string): Blocker | null {
    const row = database
      .prepare<[string], BlockerRow>(
        "SELECT id, workstream_id, kind, title, description, status, " +
          "created_at, updated_at, resolved_at FROM blockers WHERE id = ?",
      )
      .get(id);
    return row === undefined ? null : blockerFromRow(row);
  }

  function getConfirmationRow(id: string): ConfirmationRow | null {
    const row = database
      .prepare<[string], ConfirmationRow>(
        "SELECT id, workstream_id, requested_by_thread_id, action, target_id, " +
          "intent_json, token_hash, status, created_at, expires_at, " +
          "resolved_at, resolved_by_thread_id, execution_started_at " +
          "FROM confirmations WHERE id = ?",
      )
      .get(id);
    return row === undefined ? null : row;
  }

  function expireConfirmationIfNeeded(
    row: ConfirmationRow,
    at: Date,
  ): ConfirmationRow {
    if (
      row.status !== "pending" ||
      row.execution_started_at !== null ||
      !isExpired(row.expires_at, at)
    ) {
      return row;
    }
    database
      .prepare<[string]>(
        "UPDATE confirmations SET status = 'expired' " +
          "WHERE id = ? AND status = 'pending'",
      )
      .run(row.id);
    const updated = getConfirmationRow(row.id);
    if (updated === null) {
      throw new Error("confirmation disappeared while expiring");
    }
    return updated;
  }

  type ConfirmationMutationInput = {
    id: string;
    token: string;
    intent: ActionIntent;
  };

  function validateConfirmation(
    input: ConfirmationMutationInput,
    at: Date,
  ): StoreMutation<{ row: ConfirmationRow; intent: ActionIntent }> {
    const initial = getConfirmationRow(input.id);
    if (initial === null) {
      return failure(
        "confirmation_not_found",
        "confirmation " + input.id + " was not found",
      );
    }

    if (!tokenMatches(input.token, initial.token_hash)) {
      return failure(
        "confirmation_token_invalid",
        "confirmation token is invalid",
      );
    }

    const current = expireConfirmationIfNeeded(initial, at);
    if (current.status === "expired") {
      return failure(
        "confirmation_expired",
        "confirmation " + input.id + " has expired",
      );
    }
    if (current.status !== "pending") {
      return failure(
        "confirmation_not_pending",
        "confirmation " + input.id + " is already " + current.status,
      );
    }
    if (current.execution_started_at !== null) {
      return failure(
        "confirmation_not_pending",
        "confirmation " + input.id + " is already executing",
      );
    }

    const expectedIntent = actionIntentSchema.parse(
      JSON.parse(current.intent_json),
    );
    if (
      canonicalizeJson(expectedIntent) !==
      canonicalizeJson(actionIntentSchema.parse(input.intent))
    ) {
      return failure(
        "confirmation_intent_mismatch",
        "confirmation intent does not match the requested action",
      );
    }

    return { ok: true, value: { row: current, intent: expectedIntent } };
  }

  function resolveConfirmation(
    input: {
      id: string;
      token: string;
      intent: ActionIntent;
      resolvedByThreadId: string;
    },
    status: "confirmed" | "rejected",
  ): StoreMutation<Confirmation> {
    const at = now();
    return database.transaction(() => {
      const validated = validateConfirmation(input, at);
      if (!validated.ok) return validated;

      database
        .prepare<[string, string, string, string]>(
          "UPDATE confirmations SET status = ?, resolved_at = ?, " +
            "resolved_by_thread_id = ?, execution_started_at = NULL " +
            "WHERE id = ? AND status = 'pending' " +
            "AND execution_started_at IS NULL",
        )
        .run(status, at.toISOString(), input.resolvedByThreadId, input.id);

      const updated = getConfirmationRow(input.id);
      if (updated === null) {
        throw new Error("confirmation disappeared while resolving");
      }
      return { ok: true as const, value: confirmationFromRow(updated) };
    })();
  }

  return {
    createWorkstream(input) {
      const id = newId("ws");
      const timestamp = nowIso(now);
      database
        .prepare<
          [
            string,
            string,
            string,
            string,
            string,
            WorkstreamStatus,
            string,
            string,
          ]
        >(
          "INSERT INTO workstreams " +
            "(id, title, description, responsible_thread_id, " +
            "responsible_agent_id, status, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          input.title,
          input.description,
          input.responsibleThreadId,
          input.responsibleAgentId,
          input.status,
          timestamp,
          timestamp,
        );
      const workstream = getWorkstream(id);
      if (workstream === null) {
        throw new Error("workstream was not created");
      }
      return workstream;
    },

    getWorkstream,

    listWorkstreams(input) {
      const rows = database
        .prepare<
          [WorkstreamStatus | null, WorkstreamStatus | null, string | null, string | null, number],
          WorkstreamRow
        >(
          "SELECT id, title, description, responsible_thread_id, " +
            "responsible_agent_id, status, created_at, updated_at " +
            "FROM workstreams " +
            "WHERE (? IS NULL OR status = ?) " +
            "AND (? IS NULL OR responsible_thread_id = ?) " +
            "ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .all(
          input.status,
          input.status,
          input.responsibleThreadId,
          input.responsibleThreadId,
          input.limit,
        );
      return rows.map(workstreamFromRow);
    },

    assignWorkstream(id, responsibleThreadId, responsibleAgentId) {
      const current = getWorkstream(id);
      if (current === null) {
        return failure(
          "workstream_not_found",
          "workstream " + id + " was not found",
        );
      }
      const timestamp = nowIso(now);
      database
        .prepare<[string, string, string, string]>(
          "UPDATE workstreams SET responsible_thread_id = ?, " +
            "responsible_agent_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(responsibleThreadId, responsibleAgentId, timestamp, id);
      const updated = getWorkstream(id);
      if (updated === null) {
        throw new Error("workstream disappeared while assigning");
      }
      return { ok: true, value: updated };
    },

    transitionWorkstream(id, nextStatus) {
      const current = getWorkstream(id);
      if (current === null) {
        return failure(
          "workstream_not_found",
          "workstream " + id + " was not found",
        );
      }
      if (current.status === nextStatus) {
        return failure(
          "status_unchanged",
          "workstream " + id + " is already " + nextStatus,
        );
      }
      if (!WORKSTREAM_ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
        return transitionFailure(
          "workstream",
          id,
          current.status,
          nextStatus,
        );
      }
      const timestamp = nowIso(now);
      database
        .prepare<[WorkstreamStatus, string, string]>(
          "UPDATE workstreams SET status = ?, updated_at = ? WHERE id = ?",
        )
        .run(nextStatus, timestamp, id);
      const updated = getWorkstream(id);
      if (updated === null) {
        throw new Error("workstream disappeared while transitioning");
      }
      return { ok: true, value: updated };
    },

    createChecklistItem(input) {
      if (!workstreamExists(database, input.workstreamId)) {
        return failure(
          "workstream_not_found",
          "workstream " + input.workstreamId + " was not found",
        );
      }
      const position =
        input.position ??
        (database
          .prepare<[string], PositionRow>(
            "SELECT COALESCE(MAX(position), -1) + 1 AS next_position " +
              "FROM checklist_items WHERE workstream_id = ?",
          )
          .get(input.workstreamId)?.next_position ?? 0);
      const id = newId("chk");
      const timestamp = nowIso(now);
      database
        .prepare<
          [string, string, string, number, ChecklistStatus, string, string]
        >(
          "INSERT INTO checklist_items " +
            "(id, workstream_id, title, position, status, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          input.workstreamId,
          input.title,
          position,
          input.status,
          timestamp,
          timestamp,
        );
      const item = getChecklistItem(id);
      if (item === null) {
        throw new Error("checklist item was not created");
      }
      return { ok: true, value: item };
    },

    listChecklistItems(workstreamId) {
      const rows = database
        .prepare<[string], ChecklistItemRow>(
          "SELECT id, workstream_id, title, position, status, created_at, " +
            "updated_at FROM checklist_items WHERE workstream_id = ? " +
            "ORDER BY position, id",
        )
        .all(workstreamId);
      return rows.map(checklistItemFromRow);
    },

    transitionChecklistItem(id, nextStatus) {
      const current = getChecklistItem(id);
      if (current === null) {
        return failure(
          "checklist_item_not_found",
          "checklist item " + id + " was not found",
        );
      }
      if (current.status === nextStatus) {
        return failure(
          "status_unchanged",
          "checklist item " + id + " is already " + nextStatus,
        );
      }
      if (!CHECKLIST_ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
        return transitionFailure(
          "checklist item",
          id,
          current.status,
          nextStatus,
        );
      }
      const timestamp = nowIso(now);
      database
        .prepare<[ChecklistStatus, string, string]>(
          "UPDATE checklist_items SET status = ?, updated_at = ? WHERE id = ?",
        )
        .run(nextStatus, timestamp, id);
      const updated = getChecklistItem(id);
      if (updated === null) {
        throw new Error("checklist item disappeared while transitioning");
      }
      return { ok: true, value: updated };
    },

    createBlocker(input) {
      if (!workstreamExists(database, input.workstreamId)) {
        return failure(
          "workstream_not_found",
          "workstream " + input.workstreamId + " was not found",
        );
      }
      const id = newId("blk");
      const timestamp = nowIso(now);
      database
        .prepare<
          [string, string, BlockerKind, string, string, string, string]
        >(
          "INSERT INTO blockers " +
            "(id, workstream_id, kind, title, description, status, " +
            "created_at, updated_at, resolved_at) " +
            "VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL)",
        )
        .run(
          id,
          input.workstreamId,
          input.kind,
          input.title,
          input.description,
          timestamp,
          timestamp,
        );
      const blocker = getBlocker(id);
      if (blocker === null) {
        throw new Error("blocker was not created");
      }
      return { ok: true, value: blocker };
    },

    listBlockers(workstreamId) {
      const rows = database
        .prepare<[string], BlockerRow>(
          "SELECT id, workstream_id, kind, title, description, status, " +
            "created_at, updated_at, resolved_at FROM blockers " +
            "WHERE workstream_id = ? ORDER BY created_at, id",
        )
        .all(workstreamId);
      return rows.map(blockerFromRow);
    },

    transitionBlocker(id, nextStatus) {
      const current = getBlocker(id);
      if (current === null) {
        return failure(
          "blocker_not_found",
          "blocker " + id + " was not found",
        );
      }
      if (current.status === nextStatus) {
        return failure(
          "status_unchanged",
          "blocker " + id + " is already " + nextStatus,
        );
      }
      if (!BLOCKER_ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
        return transitionFailure("blocker", id, current.status, nextStatus);
      }
      const timestamp = nowIso(now);
      const resolvedAt = nextStatus === "open" ? null : timestamp;
      database
        .prepare<[BlockerStatus, string, string | null, string]>(
          "UPDATE blockers SET status = ?, updated_at = ?, resolved_at = ? " +
            "WHERE id = ?",
        )
        .run(nextStatus, timestamp, resolvedAt, id);
      const updated = getBlocker(id);
      if (updated === null) {
        throw new Error("blocker disappeared while transitioning");
      }
      return { ok: true, value: updated };
    },

    requestConfirmation(input) {
      if (!workstreamExists(database, input.workstreamId)) {
        return failure(
          "workstream_not_found",
          "workstream " + input.workstreamId + " was not found",
        );
      }
      const token = newToken();
      const id = newId("cnf");
      const createdAt = now();
      const createdAtIso = createdAt.toISOString();
      const expiresAt = new Date(
        createdAt.getTime() + input.expiresInSeconds * 1000,
      ).toISOString();
      const intentJson = canonicalizeJson(input.intent);
      database
        .prepare<
          [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ]
        >(
          "INSERT INTO confirmations " +
            "(id, workstream_id, requested_by_thread_id, action, target_id, " +
            "intent_json, token_hash, status, created_at, expires_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        )
        .run(
          id,
          input.workstreamId,
          input.requestedByThreadId,
          input.intent.action,
          input.intent.targetId,
          intentJson,
          hashToken(token),
          createdAtIso,
          expiresAt,
        );
      const row = getConfirmationRow(id);
      if (row === null) {
        throw new Error("confirmation was not created");
      }
      return {
        ok: true,
        value: { confirmation: confirmationFromRow(row), token },
      };
    },

    getConfirmation(id) {
      const row = getConfirmationRow(id);
      if (row === null) return null;
      return confirmationFromRow(expireConfirmationIfNeeded(row, now()));
    },

    listConfirmations(workstreamId, status) {
      const rows = database
        .prepare<
          [string, ConfirmationStatus | null, ConfirmationStatus | null],
          ConfirmationRow
        >(
          "SELECT id, workstream_id, requested_by_thread_id, action, target_id, " +
            "intent_json, token_hash, status, created_at, expires_at, " +
            "resolved_at, resolved_by_thread_id, execution_started_at " +
            "FROM confirmations " +
            "WHERE workstream_id = ? AND (? IS NULL OR status = ?) " +
            "ORDER BY created_at DESC, id DESC",
        )
        .all(workstreamId, status, status);
      return rows.map((row) => confirmationFromRow(expireConfirmationIfNeeded(row, now())));
    },

    beginConfirmation(input) {
      const at = now();
      return database.transaction(() => {
        const validated = validateConfirmation(input, at);
        if (!validated.ok) return validated;

        database
          .prepare<[string, string]>(
            "UPDATE confirmations SET execution_started_at = ? " +
              "WHERE id = ? AND status = 'pending' " +
              "AND execution_started_at IS NULL",
          )
          .run(at.toISOString(), input.id);

        const updated = getConfirmationRow(input.id);
        if (updated === null) {
          throw new Error("confirmation disappeared while starting");
        }
        return { ok: true as const, value: confirmationFromRow(updated) };
      })();
    },

    completeConfirmation(input) {
      const at = now();
      return database.transaction(() => {
        const current = getConfirmationRow(input.id);
        if (current === null) {
          return failure(
            "confirmation_not_found",
            "confirmation " + input.id + " was not found",
          );
        }
        if (
          current.status !== "pending" ||
          current.execution_started_at === null
        ) {
          return failure(
            "confirmation_not_pending",
            "confirmation " + input.id + " is not executing",
          );
        }

        database
          .prepare<[string, string, string]>(
            "UPDATE confirmations SET status = 'confirmed', " +
              "resolved_at = ?, resolved_by_thread_id = ?, " +
              "execution_started_at = NULL WHERE id = ? " +
              "AND status = 'pending' AND execution_started_at IS NOT NULL",
          )
          .run(at.toISOString(), input.resolvedByThreadId, input.id);

        const updated = getConfirmationRow(input.id);
        if (updated === null) {
          throw new Error("confirmation disappeared while completing");
        }
        return { ok: true as const, value: confirmationFromRow(updated) };
      })();
    },

    releaseConfirmation(id) {
      database
        .prepare<[string]>(
          "UPDATE confirmations SET execution_started_at = NULL " +
            "WHERE id = ? AND status = 'pending'",
        )
        .run(id);
    },

    rejectConfirmation(input) {
      return resolveConfirmation(input, "rejected");
    },
  };
}
