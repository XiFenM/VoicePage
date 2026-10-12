import "server-only";
import { db } from "./db";
import { isAudioFresh } from "./audio-state";
import { getRuntimeSettings } from "./runtime-settings";
import { appendGenerationEvent, parseJobError } from "./generation-events";
import type { BackgroundProgress, BackgroundStatus, JobClaim, JobPhase, SegmentGeneration } from "./types";

type Row = Record<string, string | number | null>;

/** 也由存储写入事务调用，防止租约到期后的旧 worker 回写。 */
export function isJobOwned(claim: JobClaim, now = Date.now()): boolean {
  return !!db().prepare(`SELECT 1 FROM jobs WHERE doc_id = ? AND idx = ? AND status = 'running'
    AND owner = ? AND attempt = ? AND lease_until > ?`).get(claim.docId, claim.idx, claim.owner, claim.attempt, now);
}

/** 调用方持有事务时直接使用；取消即清除 owner，使在途写入立即失效。 */
export function cancelJobsInTransaction(id: string, indices?: number[], includeFinished = false): number {
  if (indices && !indices.length) return 0;
  const now = Date.now();
  const selected = indices ? ` AND idx IN (${indices.map(() => "?").join(",")})` : "";
  const active = includeFinished
    ? " AND status != 'cancelled' AND (kind = 'segment' OR status != 'completed')"
    : " AND status IN ('queued', 'running')";
  const cancelled = db().prepare(`SELECT idx, phase, attempt, auto_retry_count FROM jobs WHERE doc_id = ?${selected}${active}
    AND status IN ('queued', 'running')`).all(id, ...(indices ?? [])) as Row[];
  const result = db().prepare(`UPDATE jobs SET status = 'cancelled', owner = NULL, lease_until = NULL,
    error = NULL, next_retry_at = NULL, updated_at = ?, finished_at = ? WHERE doc_id = ?${selected}${active}`)
    .run(now, now, id, ...(indices ?? []));
  for (const job of cancelled) appendGenerationEvent(id, { idx: Number(job.idx), phase: job.phase as JobPhase,
    attempt: Number(job.attempt), type: "cancelled", createdAt: now, retryNumber: Number(job.auto_retry_count) || undefined });
  return Number(result.changes);
}

export function getSegmentGeneration(id: string, idx: number): SegmentGeneration | undefined {
  const row = db().prepare("SELECT * FROM jobs WHERE doc_id = ? AND idx = ?").get(id, idx) as Row | undefined;
  if (!row) return undefined;
  return {
    status: row.status as BackgroundStatus,
    phase: row.status === "completed" ? "done" : row.phase as JobPhase,
    error: row.error as string | undefined ?? undefined,
    attempt: Number(row.attempt), autoRetryCount: Number(row.auto_retry_count),
    nextRetryAt: row.next_retry_at === null ? undefined : Number(row.next_retry_at),
    lastError: parseJobError(row.last_error_json), failurePhase: row.failure_phase as JobPhase | undefined ?? undefined,
  };
}

export function getBackgroundProgress(id: string): BackgroundProgress {
  const doc = db().prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
  const jobs = db().prepare("SELECT * FROM jobs WHERE doc_id = ? ORDER BY idx").all(id) as Row[];
  const segments = db().prepare("SELECT idx, tagged, audio_file, audio_hash, tag_status, tag_model_id FROM segments WHERE doc_id = ?").all(id) as Row[];
  const segmentJobs = jobs.filter((job) => job.kind === "segment");
  const active = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const running = active.filter((job) => job.status === "running");
  const scriptReady = !!doc?.script_ready;
  const relevant = jobs.filter((job) => job.kind === "segment" || !scriptReady);
  const failed = relevant.filter((job) => job.status === "failed");
  const retrying = active.filter((job) => Number(job.auto_retry_count) > 0);
  const retryDue = active.map((job) => Number(job.next_retry_at)).filter((time) => time > 0);
  const failure = failed[0] ?? retrying.find((job) => job.failure_phase);
  let status: BackgroundStatus = active.length ? (running.length ? "running" : "queued")
    : failed.length ? "failed"
      : relevant.some((job) => job.status === "cancelled") ? "cancelled"
        : jobs.length ? "completed" : "idle";
  const times = jobs.map((job) => Number(job.started_at)).filter((value) => value > 0);
  const finishes = jobs.map((job) => Number(job.finished_at)).filter((value) => value > 0);
  const completedSegments = segments.filter((segment) => {
    const job = segmentJobs.find((entry) => entry.idx === segment.idx);
    if (job && job.status !== "completed") return false;
    // 旧记录也验证真实输入指纹；已有文件不代表仍对应当前稿件/声音设置。
    return !(segment.tagged as string).trim() || !!doc && isAudioFresh({
      audioFile: segment.audio_file, storedHash: segment.audio_hash, tagged: segment.tagged as string,
      tagStatus: segment.tag_status, tagModelId: segment.tag_model_id,
    }, { personaId: doc.persona_id as string, ttsModelId: doc.tts_model_id as string, voice: doc.voice as string, useTags: !!doc.use_tags, useStyle: !!doc.use_style });
  }).length;
  if (status === "completed" && completedSegments < segments.length) status = "idle";
  const result: BackgroundProgress = {
    status,
    phase: !scriptReady ? (running.length ? "spoken" : "queued") : active.length || status !== "completed" ? "segments" : "done",
    scriptReady,
    totalSegments: segments.length,
    completedSegments,
    queuedSegments: segmentJobs.filter((job) => job.status === "queued" || (job.status === "running" && job.phase === "queued")).length,
    taggingSegments: segmentJobs.filter((job) => job.status === "running" && job.phase === "tags").length,
    speakingSegments: segmentJobs.filter((job) => job.status === "running" && job.phase === "tts").length,
    failedSegments: segmentJobs.filter((job) => job.status === "failed").length,
    startedAt: times.length ? Math.min(...times) : undefined,
    finishedAt: !active.length && finishes.length ? Math.max(...finishes) : undefined,
    updatedAt: Math.max(Number(doc?.updated_at ?? 0), ...jobs.map((job) => Number(job.updated_at))),
    error: failed[0]?.error as string | undefined ?? undefined,
    retryingSegments: retrying.filter((job) => job.kind === "segment").length,
    nextRetryAt: retryDue.length ? Math.min(...retryDue) : undefined,
    failurePhase: failure?.failure_phase as JobPhase | undefined ?? undefined,
  };
  const samples = segmentJobs.filter((job) => job.status === "completed" && Number(job.finished_at) > Number(job.started_at) && Number(job.started_at) > 0);
  const segmentRunning = running.filter((job) => job.kind === "segment");
  // 全部在排队时还取决于其他文档占用的槽位，不能仅凭本篇样本承诺等待时间。
  if (scriptReady && !retryDue.length && segmentRunning.length && samples.length && segmentRunning.every((job) => job.phase !== "queued")) {
    const average = samples.reduce((sum, job) => sum + Number(job.finished_at) - Number(job.started_at), 0) / samples.length;
    const now = Date.now();
    if (segmentRunning.every((job) => now - Number(job.started_at) <= average * 2)) {
      const slots = segmentRunning.map((job) => Math.max(1_000, average * 0.25, average - (now - Number(job.started_at))));
      const limits = getRuntimeSettings();
      const slotsForDocument = Math.min(limits.segmentConcurrency, limits.textConcurrency + limits.ttsConcurrency);
      while (slots.length < slotsForDocument) slots.push(0);
      for (let i = 0; i < result.queuedSegments; i++) slots[slots.indexOf(Math.min(...slots))] += average;
      result.estimatedRemainingMs = Math.max(1_000, Math.max(...slots));
    }
  }
  return result;
}
