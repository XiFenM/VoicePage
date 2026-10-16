import "server-only";
import { db, tx } from "./db";
import { getDocument, getSegmentForTags, makeTitle, needsAutomaticTags, newId } from "./documents";
import { cancelJobsInTransaction, isJobOwned } from "./job-state";
import { assertSession, nextDocumentPosition } from "./organization";
import type { DocSettings, JobClaim, JobErrorDetail, JobPhase, RetrySource, StoredDocument } from "./types";
import type { SourceBlock } from "@/lib/script/segment";
import type { ScriptSegment } from "@/lib/script/types";
import { getRuntimeSettings } from "./runtime-settings";
import { activeModelCounts, expireModelPermits } from "./model-permits";
import { appendGenerationEvent, JobErrorSchema, recordJobSuccess } from "./generation-events";
import { MAX_AUTO_RETRIES, retryDelayMs } from "@/lib/generation/retry-policy";
import { parsePreparedBlocks } from "@/lib/script/source-blocks";

export { parsePreparedBlocks } from "@/lib/script/source-blocks";

export { getBackgroundProgress, isJobOwned } from "./job-state";
export type { JobClaim, JobPhase } from "./types";

type Row = Record<string, string | number | null>;

export function getPreparedBlocks(docId: string): SourceBlock[] | null {
  const row = db().prepare("SELECT prepared_blocks_json FROM documents WHERE id = ?").get(docId) as Row | undefined;
  if (!row?.prepared_blocks_json) return null;
  return parsePreparedBlocks(JSON.parse(row.prepared_blocks_json as string));
}

function queueJob(id: string, idx: number, force: boolean, now: number): boolean {
  const row = db().prepare("SELECT status FROM jobs WHERE doc_id = ? AND idx = ?").get(id, idx) as Row | undefined;
  if (row?.status === "queued" || row?.status === "running") return false;
  db().prepare(`INSERT INTO jobs (doc_id, idx, kind, status, phase, force, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', 'queued', ?, ?, ?)
    ON CONFLICT(doc_id, idx) DO UPDATE SET status = 'queued', phase = 'queued', force = excluded.force,
      owner = NULL, lease_until = NULL, started_at = NULL, finished_at = NULL, error = NULL, updated_at = excluded.updated_at,
      auto_retry_count = 0, next_retry_at = NULL, retry_source = 'manual'`)
    .run(id, idx, idx === -1 ? "script" : "segment", +force, now, now);
  return true;
}

/** 先可靠保存原文与任务，再让服务端 worker 独立于请求处理生成。 */
export function createQueuedDocument(input: { sourceText: string; settings: DocSettings; scriptModel: string; sessionId?: string | null; preparedBlocks?: SourceBlock[] }): StoredDocument {
  const id = newId();
  const now = Date.now();
  const s = input.settings;
  const preparedBlocks = input.preparedBlocks === undefined ? null : parsePreparedBlocks(input.preparedBlocks);
  tx(() => {
    const sessionId = input.sessionId ?? null;
    assertSession(sessionId);
    db().prepare(`INSERT INTO documents (id, title, source_text, persona_id, tts_model_id, voice, use_tags, use_style, script_model, created_at, updated_at, script_ready, session_id, position, prepared_blocks_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
      .run(id, makeTitle(input.sourceText), input.sourceText, s.personaId, s.ttsModelId, s.voice, +s.useTags, +s.useStyle, input.scriptModel, now, now, sessionId, nextDocumentPosition(sessionId), preparedBlocks === null ? null : JSON.stringify(preparedBlocks));
    queueJob(id, -1, false, now);
  });
  return getDocument(id)!;
}

/** 草稿转为完整口述稿、完成 script job、创建各段任务在同一事务中提交。 */
export function completeScript(claim: JobClaim, blocks: SourceBlock[], segments: ScriptSegment[]): StoredDocument | null {
  const saved = tx(() => {
    if (claim.idx !== -1 || claim.kind !== "script" || !isJobOwned(claim)) return false;
    const document = getDocument(claim.docId);
    if (!document || document.generation.scriptReady) return false;
    const prepared = getPreparedBlocks(claim.docId);
    if (prepared && JSON.stringify(prepared) !== JSON.stringify(parsePreparedBlocks(blocks))) return false;
    const pending = needsAutomaticTags(document);
    const now = Date.now();
    const insert = db().prepare(`INSERT INTO segments (doc_id, idx, kind, lang, markdown, speech, tagged, tag_status, tag_model_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    blocks.forEach((block, idx) => {
      const speech = segments[idx]?.speech ?? "";
      insert.run(claim.docId, idx, block.kind, block.lang ?? null, block.markdown, speech, speech, pending ? "pending" : "ready", pending ? null : document.ttsModelId, now);
      queueJob(claim.docId, idx, false, now);
      if (!speech.trim()) db().prepare("UPDATE jobs SET status = 'completed', finished_at = ? WHERE doc_id = ? AND idx = ?").run(now, claim.docId, idx);
    });
    db().prepare("UPDATE documents SET script_ready = 1, updated_at = ? WHERE id = ?").run(now, claim.docId);
    recordJobSuccess(claim, "spoken", document.scriptModel);
    db().prepare(`UPDATE jobs SET status = 'completed', phase = 'spoken', owner = NULL, lease_until = NULL,
      updated_at = ?, finished_at = ?, error = NULL, next_retry_at = NULL WHERE doc_id = ? AND idx = -1`).run(now, now, claim.docId);
    return true;
  });
  return saved ? getDocument(claim.docId) : null;
}

/** BEGIN IMMEDIATE 使跨进程领取与全局并发计数不可分割；过期租约可在重启后恢复。 */
export function claimNextJob(owner: string, leaseMs = 60_000, maxRunning?: number): JobClaim | null {
  if (!owner || leaseMs <= 0) throw new Error("后台任务租约参数无效");
  return tx(() => {
    const now = Date.now();
    db().prepare(`UPDATE jobs SET status = 'queued', owner = NULL, lease_until = NULL, retry_source = 'recovery', next_retry_at = NULL, updated_at = ?
      WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ?)`).run(now, now);
    expireModelPermits(now);
    const settings = getRuntimeSettings();
    const running = db().prepare("SELECT doc_id, kind FROM jobs WHERE status = 'running'").all() as Row[];
    // 可选总 job 上限用于调用方/隔离测试；正常执行器使用下方独立的持久配置。
    if (maxRunning !== undefined && running.length >= Math.max(1, maxRunning)) return null;
    const documentCounts = new Map<string, number>();
    for (const active of running) documentCounts.set(active.doc_id as string, (documentCounts.get(active.doc_id as string) ?? 0) + 1);
    if (documentCounts.size > settings.taskConcurrency) return null;
    const modelCounts = activeModelCounts(now);
    if (modelCounts.text >= settings.textConcurrency && modelCounts.tts >= settings.ttsConcurrency) return null;
    const queued = db().prepare("SELECT * FROM jobs WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at, doc_id, idx").all(now) as Row[];
    const candidates = queued.filter((candidate) => {
      const count = documentCounts.get(candidate.doc_id as string) ?? 0;
      if (!count && documentCounts.size >= settings.taskConcurrency) return false;
      if (count >= settings.segmentConcurrency) return false;
      const snapshot = candidate.kind === "segment" ? getSegmentForTags(candidate.doc_id as string, Number(candidate.idx)) : null;
      const kind = candidate.kind === "script" || snapshot?.tagStatus === "pending" ? "text" : "tts";
      // 先找能立刻使用空闲模型的任务，避免前排文本队列把空闲 TTS 挡住。
      return modelCounts[kind] < (kind === "text" ? settings.textConcurrency : settings.ttsConcurrency);
    });
    candidates.sort((a, b) => {
      const countA = documentCounts.get(a.doc_id as string) ?? 0;
      const countB = documentCounts.get(b.doc_id as string) ?? 0;
      // 先分配给占用较少的文档；同占用下优先推进已有稿件，让前面的段落尽早可听。
      return countA - countB || Number(a.kind === "script") - Number(b.kind === "script") ||
        Number(a.created_at) - Number(b.created_at) || String(a.doc_id).localeCompare(String(b.doc_id)) || Number(a.idx) - Number(b.idx);
    });
    const row = candidates[0];
    if (!row) return null;
    const attempt = Number(row.attempt) + 1;
    const leaseUntil = now + leaseMs;
    db().prepare(`UPDATE jobs SET status = 'running', owner = ?, attempt = ?, lease_until = ?,
      started_at = ?, finished_at = NULL, next_retry_at = NULL, updated_at = ? WHERE doc_id = ? AND idx = ?`)
      .run(owner, attempt, leaseUntil, now, now, row.doc_id, row.idx);
    if (row.retry_source) {
      appendGenerationEvent(row.doc_id as string, { idx: Number(row.idx), phase: (row.retry_source === "automatic" ? row.failure_phase ?? row.phase : row.phase) as JobPhase, attempt,
        type: row.retry_source === "recovery" ? "resumed" : "retry_started", createdAt: now,
        retrySource: row.retry_source as RetrySource,
        retryNumber: row.retry_source === "automatic" ? Number(row.auto_retry_count) : undefined });
    }
    return {
      docId: row.doc_id as string, idx: Number(row.idx), kind: row.kind as JobClaim["kind"], owner, attempt,
      phase: row.phase as JobPhase, force: !!row.force, leaseUntil, createdAt: Number(row.created_at), startedAt: now,
    };
  });
}

export function renewJobLease(claim: JobClaim, leaseMs = 60_000): boolean {
  if (leaseMs <= 0) return false;
  return tx(() => {
    const now = Date.now();
    const changed = db().prepare(`UPDATE jobs SET lease_until = ?, updated_at = ? WHERE doc_id = ? AND idx = ?
      AND status = 'running' AND owner = ? AND attempt = ? AND lease_until > ?`)
      .run(now + leaseMs, now, claim.docId, claim.idx, claim.owner, claim.attempt, now);
    if (!changed.changes) return false;
    // 两种租约一起提交，其他进程不能在 job 续约和模型许可续约之间抢走槽位。
    db().prepare(`UPDATE model_permits SET lease_until = ? WHERE doc_id = ? AND job_idx = ?
      AND job_owner = ? AND job_attempt = ?`).run(now + leaseMs, claim.docId, claim.idx, claim.owner, claim.attempt);
    claim.leaseUntil = now + leaseMs;
    return true;
  });
}

export function setJobPhase(claim: JobClaim, phase: JobPhase): boolean {
  const now = Date.now();
  const changed = db().prepare(`UPDATE jobs SET phase = ?, updated_at = ? WHERE doc_id = ? AND idx = ?
    AND status = 'running' AND owner = ? AND attempt = ? AND lease_until > ?`)
    .run(phase, now, claim.docId, claim.idx, claim.owner, claim.attempt, now);
  if (changed.changes) claim.phase = phase;
  return changed.changes > 0;
}

export function completeJob(claim: JobClaim): boolean {
  return tx(() => {
    if (!isJobOwned(claim)) return false;
    recordJobSuccess(claim);
    const now = Date.now();
    db().prepare(`UPDATE jobs SET status = 'completed', error = NULL, owner = NULL, lease_until = NULL,
      next_retry_at = NULL, finished_at = ?, updated_at = ? WHERE doc_id = ? AND idx = ?`)
      .run(now, now, claim.docId, claim.idx);
    return true;
  });
}

export function failJob(claim: JobClaim, error: string): boolean {
  return failJobWithRetry(claim, { category: "unknown", message: error, causes: [{ name: "Error", message: error }], retryable: false }).accepted;
}

/** 失败与退避计划一起落库；领取只看持久 due 时间，服务重启不会重置自动重试预算。 */
export function failJobWithRetry(claim: JobClaim, detail: JobErrorDetail, modelId?: string): {
  accepted: boolean; status?: "queued" | "failed"; nextRetryAt?: number;
} {
  return tx(() => {
    if (!isJobOwned(claim)) return { accepted: false };
    const error = JobErrorSchema.parse(detail);
    const row = db().prepare("SELECT * FROM jobs WHERE doc_id = ? AND idx = ?").get(claim.docId, claim.idx) as Row;
    const now = Date.now();
    const phase = row.phase as JobPhase;
    const retries = Number(row.auto_retry_count);
    appendGenerationEvent(claim.docId, { idx: claim.idx, phase, attempt: claim.attempt, type: "failed", createdAt: now, error,
      retrySource: row.retry_source as RetrySource | undefined ?? undefined, retryNumber: retries || undefined, modelId });
    const automatic = error.retryable && retries < MAX_AUTO_RETRIES;
    const nextRetryAt = automatic ? now + retryDelayMs(retries + 1, error.retryAfterMs) : undefined;
    db().prepare(`UPDATE jobs SET status = ?, phase = ?, error = ?, last_error_json = ?, failure_phase = ?,
      owner = NULL, lease_until = NULL, auto_retry_count = ?, next_retry_at = ?, retry_source = ?,
      finished_at = ?, updated_at = ? WHERE doc_id = ? AND idx = ?`)
      .run(automatic ? "queued" : "failed", automatic ? "queued" : phase, automatic ? null : error.message,
        JSON.stringify(error), phase, automatic ? retries + 1 : retries, nextRetryAt ?? null,
        automatic ? "automatic" : row.retry_source, automatic ? null : now, now, claim.docId, claim.idx);
    if (automatic) appendGenerationEvent(claim.docId, { idx: claim.idx, phase, attempt: claim.attempt,
      type: "retry_scheduled", createdAt: now, error, retrySource: "automatic", retryNumber: retries + 1, nextRetryAt, modelId });
    return { accepted: true, status: automatic ? "queued" : "failed", nextRetryAt };
  });
}

export function enqueueDocumentJobs(id: string, options: { indices?: number[]; force?: boolean; retryOnly?: boolean } = {}): StoredDocument | null {
  tx(() => {
    const document = getDocument(id);
    if (!document) return;
    const now = Date.now();
    if (!document.generation.scriptReady) {
      const job = db().prepare("SELECT status FROM jobs WHERE doc_id = ? AND idx = -1").get(id) as Row | undefined;
      if (!options.retryOnly || job?.status === "failed") queueJob(id, -1, false, now);
    } else {
      for (const segment of document.segments) {
        if (options.indices && !options.indices.includes(segment.idx)) continue;
        if (!segment.tagged.trim()) continue;
        const job = db().prepare("SELECT status, force FROM jobs WHERE doc_id = ? AND idx = ?").get(id, segment.idx) as Row | undefined;
        if (options.retryOnly && job?.status !== "failed") continue;
        const force = !!options.force || ((job?.status === "failed" || job?.status === "cancelled") && !!job.force);
        if (force || !segment.audioFresh || options.retryOnly) queueJob(id, segment.idx, force, now);
      }
    }
    db().prepare("UPDATE documents SET updated_at = ? WHERE id = ?").run(now, id);
  });
  return getDocument(id);
}

export function cancelDocumentJobs(id: string, indices?: number[]): StoredDocument | null {
  tx(() => {
    if (cancelJobsInTransaction(id, indices)) db().prepare("UPDATE documents SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  });
  return getDocument(id);
}
