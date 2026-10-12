import type { GenerationEvent, GenerationEventsPage, JobErrorDetail, JobPhase, SegmentGeneration } from "@/lib/store/types";
import { MAX_AUTO_RETRIES as MAX_AUTOMATIC_RETRIES } from "@/lib/generation/retry-policy";

export { MAX_AUTOMATIC_RETRIES };

export function generationPhaseLabel(phase?: JobPhase | "done"): string {
  return phase === "spoken" ? "口述稿生成" : phase === "tags" ? "语气标签生成" : phase === "tts" ? "语音合成" : phase === "done" ? "生成完成" : "任务准备";
}

export function jobErrorLabel(category: JobErrorDetail["category"]): string {
  return {
    network: "网络连接失败", timeout: "请求超时", rate_limit: "请求受到限流",
    upstream: "模型服务错误", response: "返回内容异常", configuration: "配置错误", unknown: "生成错误",
  }[category];
}

export function retryCountdown(nextRetryAt: number, now: number): string {
  const seconds = Math.ceil((nextRetryAt - now) / 1_000);
  if (seconds <= 0) return "等待后台开始重试";
  if (seconds >= 60) return `约 ${Math.ceil(seconds / 60)} 分钟后自动重试`;
  return `${seconds} 秒后自动重试`;
}

export function automaticRetryLabel(generation: SegmentGeneration | undefined, now: number): string | null {
  if (!generation || (generation.status !== "queued" && generation.status !== "running")) return null;
  const count = generation.autoRetryCount ?? 0;
  if (count <= 0) return null;
  const attempt = `自动重试 ${count}/${MAX_AUTOMATIC_RETRIES}`;
  if (generation.status === "queued") return `${attempt} · ${generation.nextRetryAt ? retryCountdown(generation.nextRetryAt, now) : "等待调度"}`;
  return `${attempt} · 正在${generationPhaseLabel(generation.phase)}`;
}

export function generationEventLabel(event: GenerationEvent): string {
  const retry = event.retrySource === "automatic"
    ? `自动重试${event.retryNumber ? ` ${event.retryNumber}/${MAX_AUTOMATIC_RETRIES}` : ""}`
    : event.retrySource === "manual" ? "手动重试" : event.retrySource === "recovery" ? "恢复执行" : "重试";
  switch (event.type) {
    case "failed": return "失败";
    case "retry_scheduled": return `已安排${retry}`;
    case "retry_started": return `开始${retry}`;
    case "succeeded": return "成功";
    case "cancelled": return "已停止";
    case "resumed": return event.retrySource === "recovery" ? "服务恢复后继续执行" : "已继续生成";
  }
}

export interface GenerationHistoryState {
  events: GenerationEvent[];
  nextCursor?: number;
  loaded: boolean;
}

/** 保留已展开的旧日志；新页超过一屏时先补中间缺口，避免永久跳过事件。 */
export function mergeGenerationEvents(state: GenerationHistoryState, page: GenerationEventsPage, mode: "latest" | "older"): GenerationHistoryState {
  if (mode === "latest" && page.nextCursor === undefined) {
    return { events: [...new Map(page.events.map((event) => [event.id, event])).values()].sort((a, b) => b.id - a.id), loaded: true };
  }
  const known = new Set(state.events.map((event) => event.id));
  const hasOverlap = page.events.some((event) => known.has(event.id));
  const events = new Map(state.events.map((event) => [event.id, event]));
  for (const event of page.events) events.set(event.id, event);
  const nextCursor = !state.loaded || mode === "older"
    ? page.nextCursor
    : !hasOverlap && page.nextCursor !== undefined ? page.nextCursor : state.nextCursor;
  return { events: [...events.values()].sort((a, b) => b.id - a.id), nextCursor, loaded: true };
}
