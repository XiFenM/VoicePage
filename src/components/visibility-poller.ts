export const ACTIVE_POLL_MS = 2_000;
export const IDLE_POLL_MS = 30_000;

type VisibilitySource = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/** 只管理客户端读取；绝不发送生成/取消指令，也不触碰播放器。 */
export function createVisibilityPoller({ poll, getInterval, visibility, onError, shouldPollWhenHidden }: {
  poll: (signal: AbortSignal) => Promise<void>;
  getInterval: () => number;
  visibility: VisibilitySource;
  onError?: (error: unknown) => void;
  /** 仅供正在听读且尚未生成完的当前任务，保证隐藏时也能接续新段。 */
  shouldPollWhenHidden?: () => boolean;
}) {
  let disposed = false;
  let hidden = visibility.hidden;
  const mayPoll = () => !visibility.hidden || !!shouldPollWhenHidden?.();
  let paused = !mayPoll();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: AbortController | undefined;
  let refreshAgain = false;

  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    clearTimer();
    if (disposed || !mayPoll() || current) return;
    const interval = getInterval();
    timer = setTimeout(() => { timer = undefined; void read(); }, Number.isFinite(interval) && interval > 0 ? interval : IDLE_POLL_MS);
  }

  async function read() {
    if (disposed || !mayPoll()) return;
    clearTimer();
    if (current) { refreshAgain = true; return; }
    const controller = new AbortController();
    current = controller;
    try {
      await poll(controller.signal);
    } catch (error) {
      if (!disposed && current === controller && !controller.signal.aborted) onError?.(error);
    } finally {
      // 已取消的旧读取即使迟到，也不能改变新读取的计时器或状态。
      if (current === controller) {
        current = undefined;
        if (!disposed && mayPoll()) {
          const again = refreshAgain;
          refreshAgain = false;
          if (again) void read();
          else schedule();
        }
      }
    }
  }

  function pause() {
    clearTimer();
    refreshAgain = false;
    const previous = current;
    current = undefined;
    previous?.abort();
  }

  function onVisibilityChange() {
    const nextHidden = visibility.hidden;
    const nextPaused = !mayPoll();
    const resume = paused && !nextPaused;
    const returned = hidden && !nextHidden;
    if (hidden === nextHidden && paused === nextPaused) return;
    hidden = nextHidden;
    paused = nextPaused;
    if (paused) pause();
    else if (resume || returned) void read();
  }

  function reschedule() {
    if (disposed) return;
    const nextPaused = !mayPoll();
    if (paused !== nextPaused) {
      paused = nextPaused;
      if (paused) pause();
      else void read();
    } else schedule();
  }

  visibility.addEventListener("visibilitychange", onVisibilityChange);
  void read();
  return {
    refresh: () => { void read(); },
    reschedule,
    dispose() {
      disposed = true;
      visibility.removeEventListener("visibilitychange", onVisibilityChange);
      pause();
    },
  };
}

export type VisibilityPoller = ReturnType<typeof createVisibilityPoller>;
