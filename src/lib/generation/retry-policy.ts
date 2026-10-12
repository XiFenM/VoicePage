/** 每轮手动发起的任务最多自动重试两次；退避期间不占任务或模型名额。 */
export const MAX_AUTO_RETRIES = 2;
export const MAX_RETRY_DELAY_MS = 5 * 60_000;

export function retryDelayMs(retryNumber: number, retryAfterMs?: number): number {
  const base = retryNumber <= 1 ? 5_000 : 15_000;
  const requested = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs!) : 0;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(base, requested));
}

/** Retry-After 既可以是秒数，也可以是 HTTP 日期。 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  const milliseconds = /^\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) * 1_000 : Date.parse(trimmed) - now;
  return Number.isFinite(milliseconds) ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, milliseconds)) : undefined;
}
