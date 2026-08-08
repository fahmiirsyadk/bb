import type { JsonValue } from "@bb/plugin-sdk";
import { z } from "zod";

type JsonObject = { [key: string]: JsonValue };

export const WORKSTREAM_STATUSES = [
  "planned",
  "active",
  "blocked",
  "in_review",
  "completed",
  "canceled",
] as const;

export const CHECKLIST_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "canceled",
] as const;

export const BLOCKER_KINDS = ["blocker", "review_blocker"] as const;
export const BLOCKER_STATUSES = ["open", "resolved", "dismissed"] as const;
export const CONFIRMATION_STATUSES = [
  "pending",
  "confirmed",
  "rejected",
  "expired",
] as const;

export type WorkstreamStatus = (typeof WORKSTREAM_STATUSES)[number];
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];
export type BlockerKind = (typeof BLOCKER_KINDS)[number];
export type BlockerStatus = (typeof BLOCKER_STATUSES)[number];
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

export const workstreamStatusSchema = z.enum(WORKSTREAM_STATUSES);
export const checklistStatusSchema = z.enum(CHECKLIST_STATUSES);
export const blockerKindSchema = z.enum(BLOCKER_KINDS);
export const blockerStatusSchema = z.enum(BLOCKER_STATUSES);
export const confirmationStatusSchema = z.enum(CONFIRMATION_STATUSES);

export const workstreamIdSchema = z
  .string()
  .regex(/^ws_[A-Za-z0-9_-]+$/, "must be a workstream id");
export const checklistItemIdSchema = z
  .string()
  .regex(/^chk_[A-Za-z0-9_-]+$/, "must be a checklist item id");
export const blockerIdSchema = z
  .string()
  .regex(/^blk_[A-Za-z0-9_-]+$/, "must be a blocker id");
export const confirmationIdSchema = z
  .string()
  .regex(/^cnf_[A-Za-z0-9_-]+$/, "must be a confirmation id");
export const bbThreadIdSchema = z
  .string()
  .regex(/^thr_[A-Za-z0-9_-]+$/, "must be a BB thread id");

export const nonBlankTextSchema = z.string().trim().min(1).max(1000);
export const descriptionSchema = z.string().max(20_000);
export const responsibleAgentIdSchema = z.string().trim().min(1).max(200);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);

export const actionIntentSchema = z
  .object({
    action: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(
        /^[a-z0-9][a-z0-9._:-]*$/,
        "must use lowercase action characters",
      ),
    targetId: z.string().trim().min(1).max(240),
    parameters: jsonObjectSchema.default({}),
  })
  .strict();

export type ActionIntent = z.infer<typeof actionIntentSchema>;

export const workstreamSchema = z
  .object({
    id: workstreamIdSchema,
    title: z.string(),
    description: z.string(),
    responsibleThreadId: bbThreadIdSchema,
    responsibleAgentId: responsibleAgentIdSchema,
    status: workstreamStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type Workstream = z.infer<typeof workstreamSchema>;

export const checklistItemSchema = z
  .object({
    id: checklistItemIdSchema,
    workstreamId: workstreamIdSchema,
    title: z.string(),
    position: z.number().int().nonnegative(),
    status: checklistStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const blockerSchema = z
  .object({
    id: blockerIdSchema,
    workstreamId: workstreamIdSchema,
    kind: blockerKindSchema,
    title: z.string(),
    description: z.string(),
    status: blockerStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
  })
  .strict();

export type Blocker = z.infer<typeof blockerSchema>;

export const confirmationSchema = z
  .object({
    id: confirmationIdSchema,
    workstreamId: workstreamIdSchema,
    requestedByThreadId: bbThreadIdSchema,
    intent: actionIntentSchema,
    status: confirmationStatusSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
    resolvedByThreadId: bbThreadIdSchema.nullable(),
  })
  .strict();

export type Confirmation = z.infer<typeof confirmationSchema>;

export const DOMAIN_ERROR_CODES = [
  "workstream_not_found",
  "checklist_item_not_found",
  "blocker_not_found",
  "confirmation_not_found",
  "invalid_transition",
  "status_unchanged",
  "confirmation_token_invalid",
  "confirmation_intent_mismatch",
  "confirmation_not_pending",
  "confirmation_expired",
] as const;

export const domainErrorSchema = z
  .object({
    code: z.enum(DOMAIN_ERROR_CODES),
    message: z.string(),
  })
  .strict();

export type DomainError = z.infer<typeof domainErrorSchema>;

export type StoreMutation<T> =
  | { ok: true; value: T }
  | { ok: false; error: DomainError };

export const WORKSTREAM_ALLOWED_TRANSITIONS: Readonly<
  Record<WorkstreamStatus, readonly WorkstreamStatus[]>
> = {
  planned: ["active", "canceled"],
  active: ["blocked", "in_review", "completed", "canceled"],
  blocked: ["active", "canceled"],
  in_review: ["active", "blocked", "completed", "canceled"],
  completed: [],
  canceled: [],
};

export const CHECKLIST_ALLOWED_TRANSITIONS: Readonly<
  Record<ChecklistStatus, readonly ChecklistStatus[]>
> = {
  pending: ["in_progress", "blocked", "done", "canceled"],
  in_progress: ["pending", "blocked", "done", "canceled"],
  blocked: ["pending", "in_progress", "canceled"],
  done: ["pending"],
  canceled: ["pending"],
};

export const BLOCKER_ALLOWED_TRANSITIONS: Readonly<
  Record<BlockerStatus, readonly BlockerStatus[]>
> = {
  open: ["resolved", "dismissed"],
  resolved: ["open"],
  dismissed: ["open"],
};

export function canonicalizeJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalizeJson(item)).join(",") + "]";
  }

  if (isJsonObject(value)) {
    const object = value;
    const entries = Object.keys(object)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) + ":" + canonicalizeJson(object[key]),
      );
    return "{" + entries.join(",") + "}";
  }

  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("value is not JSON-serializable");
  }
  return encoded;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function failure(
  code: DomainError["code"],
  message: string,
): StoreMutation<never> {
  return { ok: false, error: { code, message } };
}
