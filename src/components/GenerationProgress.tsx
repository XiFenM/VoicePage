"use client";

import { useEffect, useState } from "react";
import type { BackgroundProgress } from "@/lib/store/types";
import { backgroundPercent, backgroundStatusText, formatBackgroundElapsed, isBackgroundActive } from "./background-progress";

function remainingTime(progress: BackgroundProgress): string {
  const value = "estimatedRemainingMs" in progress ? progress.estimatedRemainingMs : undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return "剩余时间暂无法准确估计，完成更多段落后会更新。";
  const low = Math.max(10, Math.floor(value * 0.7 / 10_000) * 10);
  const high = Math.max(low + 10, Math.ceil(value * 1.5 / 10_000) * 10);
  return high >= 120
    ? `预计还需约 ${Math.max(1, Math.floor(low / 60))}–${Math.max(2, Math.ceil(high / 60))} 分钟，随实际进度更新。`
    : `预计还需约 ${low}–${high} 秒，随实际进度更新。`;
}

export function GenerationProgress({ progress, busy, onStart, onRetry, onCancel }: {
  progress: BackgroundProgress;
  busy: boolean;
  onStart: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const active = isBackgroundActive(progress);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  const startedAt = progress.startedAt ?? progress.updatedAt;
  const elapsed = (active ? now : progress.finishedAt ?? progress.updatedAt) - startedAt;
  const unfinished = !progress.scriptReady || progress.completedSegments < progress.totalSegments;
  const failed = progress.status === "failed";

  return (
    <section aria-label="后台生成进度" className={`space-y-3 rounded-xl border p-4 text-sm ${failed ? "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200" : "border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium" role="status">{backgroundStatusText(progress)}</p>
        <div className="flex items-center gap-3">
          {active && <button disabled={busy} onClick={onCancel} className="underline underline-offset-2 disabled:opacity-40">停止生成</button>}
          {!active && failed && <button disabled={busy} onClick={onRetry} className="font-medium underline underline-offset-2 disabled:opacity-40">重试失败任务</button>}
          {!active && !failed && unfinished && <button disabled={busy} onClick={onStart} className="font-medium underline underline-offset-2 disabled:opacity-40">继续生成</button>}
        </div>
      </div>
      {progress.scriptReady ? <>
        <div className="flex flex-wrap justify-between gap-2">
          <span>语音已完成 {progress.completedSegments}/{progress.totalSegments} 段</span>
          <span>标签处理中 {progress.taggingSegments} · 语音生成中 {progress.speakingSegments} · 排队 {progress.queuedSegments}</span>
        </div>
        <div role="progressbar" aria-label="语音生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={backgroundPercent(progress)} className="h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950">
          <div className="h-full bg-blue-600 transition-[width]" style={{ width: `${backgroundPercent(progress)}%` }} />
        </div>
      </> : <p>{!active
        ? "原文已保存，点击继续或重试后会在后台生成口述稿。"
        : progress.phase === "spoken"
          ? "正在把原文改写为口述稿。完成后会逐段添加语气标签并生成语音，首段完成即可收听。"
          : "原文已保存，正在等待后台处理。"}</p>}
      {progress.status !== "idle" && <p>{progress.startedAt ? "已用" : "已等待"} {formatBackgroundElapsed(elapsed)}</p>}
      {active && <>
        <p>{remainingTime(progress)}</p>
        <p className="text-xs opacity-80">可以切换记录、另建任务或关闭页面，后台会继续生成；所有记录合计最多同时处理 2 个任务。已完成的语音可以先听。</p>
      </>}
      {progress.status === "cancelled" && <p>任务已停止，已保存的口述稿和语音仍可使用。需要时点击继续生成。</p>}
      {progress.error && <p role="alert" className="break-all">{progress.error}</p>}
    </section>
  );
}
