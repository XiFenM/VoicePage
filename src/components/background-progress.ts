import type { BackgroundProgress, DocSummary, StoredDocument } from "@/lib/store/types";

export function isBackgroundActive(progress: BackgroundProgress): boolean {
  return progress.status === "queued" || progress.status === "running";
}

/** 兼容旧响应；没有后台任务的记录只展示状态，绝不自动提交生成请求。 */
export function documentProgress(doc: StoredDocument | DocSummary): BackgroundProgress {
  if (doc.generation) return doc.generation;
  const segments = "segments" in doc ? doc.segments : null;
  const total = segments ? segments.filter((s) => s.tagged.trim()).length : (doc as DocSummary).segmentCount;
  const completed = segments ? segments.filter((s) => s.tagged.trim() && s.audioUrl && s.audioFresh).length : (doc as DocSummary).audioCount;
  return {
    status: "idle", phase: "done", scriptReady: total > 0,
    totalSegments: total, completedSegments: completed, queuedSegments: 0,
    taggingSegments: 0, speakingSegments: 0, failedSegments: 0, updatedAt: doc.updatedAt,
  };
}

export function backgroundStatusText(progress: BackgroundProgress): string {
  if (progress.status === "queued" && progress.nextRetryAt) return "等待自动重试";
  if (progress.status === "queued") return "排队中";
  if (progress.status === "running") return progress.phase === "spoken" ? "口述稿生成中" : `语音 ${progress.completedSegments}/${progress.totalSegments}`;
  if (progress.status === "failed") return progress.scriptReady ? `生成失败${progress.failedSegments ? ` · ${progress.failedSegments} 段` : ""}` : "口述稿生成失败";
  if (progress.status === "cancelled") return "已停止";
  if (progress.status === "completed" || (progress.totalSegments > 0 && progress.completedSegments === progress.totalSegments)) return "已完成";
  return "待生成";
}

export function backgroundPercent(progress: BackgroundProgress): number {
  if (!progress.scriptReady || progress.totalSegments <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor(progress.completedSegments / progress.totalSegments * 100)));
}

export function formatBackgroundElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`;
}

/** 已经保存完的编辑也要保护：写请求的响应可能比用户的新一版稿件更早。 */
export function editedSinceSnapshot(current: Readonly<Record<number, number>>, snapshot: Readonly<Record<number, number>>): Set<number> {
  return new Set(Object.entries(current).filter(([idx, version]) => version !== (snapshot[Number(idx)] ?? 0)).map(([idx]) => Number(idx)));
}

/** 轮询只合并服务端数据；本地未保存稿和播放器状态分别留在 Reader。 */
export function mergeDocumentSnapshot(
  current: StoredDocument,
  incoming: StoredDocument,
  protectedIndices: ReadonlySet<number>,
): StoredDocument {
  if (current.id !== incoming.id) return current;
  const localByIdx = new Map(current.segments.map((segment) => [segment.idx, segment]));
  const incomingProgress = documentProgress(incoming);
  const currentProgress = documentProgress(current);
  if (incomingProgress.updatedAt < currentProgress.updatedAt) return current;
  return {
    ...incoming,
    generation: incomingProgress,
    segments: incoming.segments.map((segment) => {
      const local = localByIdx.get(segment.idx);
      if (!local || !protectedIndices.has(segment.idx)) return segment;
      return {
        ...segment,
        tagged: local.tagged,
        speech: local.speech,
        tagStatus: "manual",
        tagModelId: undefined,
        audioFresh: false,
      };
    }),
  };
}
