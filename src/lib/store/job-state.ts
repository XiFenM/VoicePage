import "server-only";
import { db } from "./db";
import { isAudioFresh } from "./audio-state";
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
  const result = db().prepare(`UPDATE jobs SET status = 'cancelled', owner = NULL, lease_until = NULL,
    error = NULL, updated_at = ?, finished_at = ? WHERE doc_id = ?${selected}${active}`)
    .run(now, now, id, ...(indices ?? []));
  return Number(result.changes);
}

export function getSegmentGeneration(id: string, idx: number): SegmentGeneration | undefined {
  const row = db().prepare("SELECT status, phase, error FROM jobs WHERE doc_id = ? AND idx = ?").get(id, idx) as Row | undefined;
  if (!row) return undefined;
  return {
    status: row.status as BackgroundStatus,
    phase: row.status === "completed" ? "done" : row.phase as JobPhase,
    error: row.error as string | undefined ?? undefined,
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
    queuedSegments: segmentJobs.filter((job) => job.status === "queued").length,
    taggingSegments: segmentJobs.filter((job) => job.status === "running" && job.phase === "tags").length,
    speakingSegments: segmentJobs.filter((job) => job.status === "running" && job.phase === "tts").length,
    failedSegments: segmentJobs.filter((job) => job.status === "failed").length,
    startedAt: times.length ? Math.min(...times) : undefined,
    finishedAt: !active.length && finishes.length ? Math.max(...finishes) : undefined,
    updatedAt: Math.max(Number(doc?.updated_at ?? 0), ...jobs.map((job) => Number(job.updated_at))),
    error: failed[0]?.error as string | undefined ?? undefined,
  };
  const samples = segmentJobs.filter((job) => job.status === "completed" && Number(job.finished_at) > Number(job.started_at) && Number(job.started_at) > 0);
  const segmentRunning = running.filter((job) => job.kind === "segment");
  // 全部在排队时还取决于其他文档占用的槽位，不能仅凭本篇样本承诺等待时间。
  if (scriptReady && segmentRunning.length && samples.length) {
    const average = samples.reduce((sum, job) => sum + Number(job.finished_at) - Number(job.started_at), 0) / samples.length;
    const now = Date.now();
    if (segmentRunning.every((job) => now - Number(job.started_at) <= average * 2)) {
      const slots = segmentRunning.map((job) => Math.max(1_000, average * 0.25, average - (now - Number(job.started_at))));
      while (slots.length < 2) slots.push(0);
      for (let i = 0; i < result.queuedSegments; i++) slots[slots.indexOf(Math.min(...slots))] += average;
      result.estimatedRemainingMs = Math.max(1_000, Math.max(...slots));
    }
  }
  return result;
}
