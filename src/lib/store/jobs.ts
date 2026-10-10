import "server-only";
import { db, tx } from "./db";
import { getDocument, makeTitle, needsAutomaticTags, newId } from "./documents";
import { cancelJobsInTransaction, isJobOwned } from "./job-state";
import type { DocSettings, JobClaim, JobPhase, StoredDocument } from "./types";
import type { SourceBlock } from "@/lib/script/segment";
import type { ScriptSegment } from "@/lib/script/types";

export { getBackgroundProgress, isJobOwned } from "./job-state";
export type { JobClaim, JobPhase } from "./types";

type Row = Record<string, string | number | null>;

function queueJob(id: string, idx: number, force: boolean, now: number): boolean {
  const row = db().prepare("SELECT status FROM jobs WHERE doc_id = ? AND idx = ?").get(id, idx) as Row | undefined;
  if (row?.status === "queued" || row?.status === "running") return false;
  db().prepare(`INSERT INTO jobs (doc_id, idx, kind, status, phase, force, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', 'queued', ?, ?, ?)
    ON CONFLICT(doc_id, idx) DO UPDATE SET status = 'queued', phase = 'queued', force = excluded.force,
      owner = NULL, lease_until = NULL, started_at = NULL, finished_at = NULL, error = NULL, updated_at = excluded.updated_at`)
    .run(id, idx, idx === -1 ? "script" : "segment", +force, now, now);
  return true;
}

/** 先可靠保存原文与任务，再让服务端 worker 独立于请求处理生成。 */
export function createQueuedDocument(input: { sourceText: string; settings: DocSettings; scriptModel: string }): StoredDocument {
  const id = newId();
  const now = Date.now();
  const s = input.settings;
  tx(() => {
    db().prepare(`INSERT INTO documents (id, title, source_text, persona_id, tts_model_id, voice, use_tags, use_style, script_model, created_at, updated_at, script_ready)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(id, makeTitle(input.sourceText), input.sourceText, s.personaId, s.ttsModelId, s.voice, +s.useTags, +s.useStyle, input.scriptModel, now, now);
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
    db().prepare(`UPDATE jobs SET status = 'completed', phase = 'spoken', owner = NULL, lease_until = NULL,
      updated_at = ?, finished_at = ?, error = NULL WHERE doc_id = ? AND idx = -1`).run(now, now, claim.docId);
    return true;
  });
  return saved ? getDocument(claim.docId) : null;
}

/** BEGIN IMMEDIATE 使跨进程领取与全局并发计数不可分割；过期租约可在重启后恢复。 */
export function claimNextJob(owner: string, leaseMs = 60_000, maxRunning = 2): JobClaim | null {
  if (!owner || leaseMs <= 0) throw new Error("后台任务租约参数无效");
  return tx(() => {
    const now = Date.now();
    db().prepare(`UPDATE jobs SET status = 'queued', owner = NULL, lease_until = NULL, updated_at = ?
      WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ?)`).run(now, now);
    const active = Number(db().prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'").get()!.count);
    if (active >= Math.max(1, Math.min(2, maxRunning))) return null;
    const row = db().prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, doc_id, idx LIMIT 1").get() as Row | undefined;
    if (!row) return null;
    const attempt = Number(row.attempt) + 1;
    const leaseUntil = now + leaseMs;
    db().prepare(`UPDATE jobs SET status = 'running', owner = ?, attempt = ?, lease_until = ?,
      started_at = ?, finished_at = NULL, updated_at = ? WHERE doc_id = ? AND idx = ?`)
      .run(owner, attempt, leaseUntil, now, now, row.doc_id, row.idx);
    return {
      docId: row.doc_id as string, idx: Number(row.idx), kind: row.kind as JobClaim["kind"], owner, attempt,
      phase: row.phase as JobPhase, force: !!row.force, leaseUntil, createdAt: Number(row.created_at), startedAt: now,
    };
  });
}

export function renewJobLease(claim: JobClaim, leaseMs = 60_000): boolean {
  if (leaseMs <= 0) return false;
  const now = Date.now();
  const changed = db().prepare(`UPDATE jobs SET lease_until = ?, updated_at = ? WHERE doc_id = ? AND idx = ?
    AND status = 'running' AND owner = ? AND attempt = ? AND lease_until > ?`)
    .run(now + leaseMs, now, claim.docId, claim.idx, claim.owner, claim.attempt, now);
  if (changed.changes) claim.leaseUntil = now + leaseMs;
  return changed.changes > 0;
}

export function setJobPhase(claim: JobClaim, phase: JobPhase): boolean {
  const now = Date.now();
  const changed = db().prepare(`UPDATE jobs SET phase = ?, updated_at = ? WHERE doc_id = ? AND idx = ?
    AND status = 'running' AND owner = ? AND attempt = ? AND lease_until > ?`)
    .run(phase, now, claim.docId, claim.idx, claim.owner, claim.attempt, now);
  if (changed.changes) claim.phase = phase;
  return changed.changes > 0;
}

function finishJob(claim: JobClaim, status: "completed" | "failed", error?: string): boolean {
  const now = Date.now();
  return db().prepare(`UPDATE jobs SET status = ?, error = ?, owner = NULL, lease_until = NULL, finished_at = ?, updated_at = ?
    WHERE doc_id = ? AND idx = ? AND status = 'running' AND owner = ? AND attempt = ? AND lease_until > ?`)
    .run(status, error ?? null, now, now, claim.docId, claim.idx, claim.owner, claim.attempt, now).changes > 0;
}

export function completeJob(claim: JobClaim): boolean {
  return finishJob(claim, "completed");
}

export function failJob(claim: JobClaim, error: string): boolean {
  return finishJob(claim, "failed", error);
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
