import "server-only";
import { z } from "zod";
import { db } from "./db";
import type { GenerationEvent, GenerationEventsPage, JobClaim, JobErrorDetail, JobPhase, RetrySource } from "./types";

export const JobErrorSchema = z.object({
  category: z.enum(["network", "timeout", "rate_limit", "upstream", "response", "configuration", "unknown"]),
  message: z.string(), code: z.string().optional(), httpStatus: z.number().int().optional(), requestId: z.string().optional(),
  causes: z.array(z.object({ name: z.string(), message: z.string(), code: z.string().optional() })),
  retryable: z.boolean(), retryAfterMs: z.number().finite().nonnegative().optional(),
});

export const GenerationEventSchema = z.object({
  id: z.number().int().positive(), idx: z.number().int().min(-1),
  phase: z.enum(["queued", "spoken", "tags", "tts"]), attempt: z.number().int().nonnegative(),
  type: z.enum(["failed", "retry_scheduled", "retry_started", "succeeded", "cancelled", "resumed"]),
  createdAt: z.number().finite().nonnegative(), error: JobErrorSchema.optional(),
  retrySource: z.enum(["automatic", "manual", "recovery"]).optional(),
  retryNumber: z.number().int().nonnegative().optional(), nextRetryAt: z.number().finite().nonnegative().optional(), modelId: z.string().optional(),
});

type Row = Record<string, string | number | null>;

export function parseJobError(value: unknown): JobErrorDetail | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return JobErrorSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return undefined;
  }
}

function toEvent(row: Row): GenerationEvent {
  return {
    id: Number(row.id), idx: Number(row.idx), phase: row.phase as JobPhase, attempt: Number(row.attempt),
    type: row.type as GenerationEvent["type"], createdAt: Number(row.created_at), error: parseJobError(row.error_json),
    retrySource: row.retry_source as RetrySource | undefined ?? undefined,
    retryNumber: row.retry_number === null ? undefined : Number(row.retry_number),
    nextRetryAt: row.next_retry_at === null ? undefined : Number(row.next_retry_at),
    modelId: row.model_id as string | undefined ?? undefined,
  };
}

/** 由状态变更事务调用；历史属于文档，不随 job 重试覆盖。 */
export function appendGenerationEvent(docId: string, event: Omit<GenerationEvent, "id">): void {
  db().prepare(`INSERT INTO generation_events (doc_id, idx, phase, attempt, type, created_at, error_json, retry_source, retry_number, next_retry_at, model_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(docId, event.idx, event.phase, event.attempt, event.type, event.createdAt,
      event.error ? JSON.stringify(JobErrorSchema.parse(event.error)) : null, event.retrySource ?? null,
      event.retryNumber ?? null, event.nextRetryAt ?? null, event.modelId ?? null);
}

/** 完成前在同一事务内记录恢复成功；第一次成功无需制造日志噪声。 */
export function recordJobSuccess(claim: JobClaim, phase: JobPhase = claim.phase, modelId?: string): void {
  const row = db().prepare("SELECT attempt, auto_retry_count, retry_source FROM jobs WHERE doc_id = ? AND idx = ?").get(claim.docId, claim.idx) as Row | undefined;
  if (!row || (Number(row.attempt) <= 1 && !row.retry_source)) return;
  appendGenerationEvent(claim.docId, { idx: claim.idx, phase, attempt: claim.attempt, type: "succeeded", createdAt: Date.now(),
    retrySource: row.retry_source as RetrySource | undefined ?? undefined,
    retryNumber: row.retry_source === "automatic" ? Number(row.auto_retry_count) : undefined, modelId });
}

export function listGenerationEvents(docId: string, options: { before?: number; limit?: number } = {}): GenerationEventsPage {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const rows = (options.before === undefined
    ? db().prepare("SELECT * FROM generation_events WHERE doc_id = ? ORDER BY id DESC LIMIT ?").all(docId, limit + 1)
    : db().prepare("SELECT * FROM generation_events WHERE doc_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(docId, options.before, limit + 1)) as Row[];
  const events = rows.slice(0, limit).map(toEvent);
  return { events, nextCursor: rows.length > limit ? events[events.length - 1].id : undefined };
}

/** 备份使用完整历史；普通 UI 使用游标分页。 */
export function exportGenerationEvents(docId: string): GenerationEvent[] {
  return (db().prepare("SELECT * FROM generation_events WHERE doc_id = ? ORDER BY id").all(docId) as Row[]).map(toEvent);
}
