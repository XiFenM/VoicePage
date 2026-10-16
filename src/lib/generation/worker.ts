import "server-only";
import { randomUUID } from "node:crypto";
import { getDocument, getSegmentForTags, getSegmentForTts, saveSegmentTags, saveSegmentAudio, audioHash } from "@/lib/store/documents";
import {
  claimNextJob, renewJobLease, isJobOwned, setJobPhase, completeJob, failJobWithRetry, completeScript, getPreparedBlocks,
} from "@/lib/store/jobs";
import type { JobClaim } from "@/lib/store/types";
import { addTags, runScriptPipeline } from "@/lib/script/pipeline";
import { synthesize } from "@/lib/tts/synthesize";
import { getRuntimeSettings } from "@/lib/store/runtime-settings";
import { tryAcquireModelPermit, releaseModelPermit, type ModelPermitKind } from "@/lib/store/model-permits";
import { describeJobError, ModelTimeoutError } from "./errors";
import { MODEL_REQUEST_TIMEOUT_MS } from "./timeouts";

// 进度和队列保存在 SQLite。此循环只负责执行，可以随 Node 服务重启。
// 与任何浏览器请求无关；构建/静态预渲染时绝不启动，也不支持无常驻进程的托管环境。
const WORKER_VERSION = 6;

function leaseDuration(): number {
  const configured = Number(process.env.BACKGROUND_LEASE_MS ?? 60_000);
  return Number.isFinite(configured) ? Math.max(3_000, configured) : 60_000;
}

class LeaseLostError extends Error {
  constructor(message: string) { super(message); this.name = "LeaseLostError"; }
}

interface RunningJob {
  claim: JobClaim;
  controller: AbortController;
}

interface WorkerState {
  version?: number;
  owner: string;
  active: Map<string, RunningJob>;
  stopped: boolean;
  pumping: boolean;
  timer?: ReturnType<typeof setInterval>;
  wake: () => void;
  stop: () => void;
}

declare global {
  var __readaloudBackgroundWorker: WorkerState | undefined;
}

function canRun(): boolean {
  return process.env.NEXT_PHASE !== "phase-production-build" && process.env.NEXT_PHASE !== "phase-export" && process.env.BACKGROUND_WORKER_DISABLED !== "1";
}

function assertOwned(claim: JobClaim, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!isJobOwned(claim)) throw new LeaseLostError("任务已停止或已由其他执行器接续");
}

function enterPhase(claim: JobClaim, phase: "spoken" | "tags" | "tts", signal: AbortSignal) {
  assertOwned(claim, signal);
  if (!setJobPhase(claim, phase)) throw new LeaseLostError("任务状态已改变");
}

function waitForSlot(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 250);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 文本和语音使用独立全局许可；等待阶段不持有另一种模型的许可。 */
async function withModelSlot<T>(
  kind: ModelPermitKind, phase: "spoken" | "tags" | "tts", claim: JobClaim,
  signal: AbortSignal, execute: (modelSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertOwned(claim, signal);
  if (!setJobPhase(claim, "queued")) throw new LeaseLostError("任务状态已改变");
  let token: string | null = null;
  while (!token) {
    assertOwned(claim, signal);
    token = tryAcquireModelPermit(kind, claim, leaseDuration());
    if (!token) await waitForSlot(signal);
  }
  // 排队不占模型超时时间；只有真正拿到许可、准备发送请求时开始计时。
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(new ModelTimeoutError()), MODEL_REQUEST_TIMEOUT_MS);
  timeout.unref();
  try {
    enterPhase(claim, phase, signal);
    const modelSignal = AbortSignal.any([signal, timeoutController.signal]);
    const result = await execute(modelSignal);
    modelSignal.throwIfAborted();
    return result;
  } catch (error) {
    if (timeoutController.signal.aborted) throw timeoutController.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    releaseModelPermit(token);
  }
}

/** 一个持久作业：整篇口述稿，或一段标签与语音。保存结果时再次核验租约及文本快照。 */
export async function executeBackgroundJob(claim: JobClaim, signal: AbortSignal): Promise<void> {
  assertOwned(claim, signal);
  const doc = getDocument(claim.docId);
  if (!doc) throw new LeaseLostError("记录已删除");

  if (claim.kind === "script") {
    const preparedBlocks = getPreparedBlocks(claim.docId) ?? undefined;
    const script = await withModelSlot("text", "spoken", claim, signal, (modelSignal) => runScriptPipeline({
      text: doc.sourceText, personaId: doc.personaId, scriptModel: doc.scriptModel, signal: modelSignal, preparedBlocks,
    }));
    assertOwned(claim, signal);
    if (!script.blocks.length) throw new Error("原文没有可处理的内容");
    if (!completeScript(claim, script.blocks, script.segments)) throw new LeaseLostError("口述稿任务已停止");
    return;
  }

  let snapshot = getSegmentForTags(claim.docId, claim.idx);
  if (!snapshot) throw new LeaseLostError("段落已删除");
  if (snapshot.tagStatus === "pending") {
    const tagSnapshot = snapshot;
    const tagged = await withModelSlot("text", "tags", claim, signal, (modelSignal) => addTags(
      [{ id: claim.idx, speech: tagSnapshot.speech }], tagSnapshot.settings.ttsModelId,
      tagSnapshot.settings.personaId, modelSignal, doc.scriptModel,
    ));
    assertOwned(claim, signal);
    if (!saveSegmentTags(snapshot, tagged[0].tagged, claim)) throw new LeaseLostError("口述稿或任务状态已改变");
  }

  assertOwned(claim, signal);
  const segment = getDocument(claim.docId)?.segments.find((s) => s.idx === claim.idx);
  if (!segment) throw new LeaseLostError("段落已删除");
  if (!claim.force && segment.audioUrl && segment.audioFresh) {
    completeJob(claim);
    return;
  }

  snapshot = getSegmentForTts(claim.docId, claim.idx);
  if (!snapshot || snapshot.tagStatus === "pending") throw new LeaseLostError("段落内容已改变");
  if (!snapshot.tagged.trim()) {
    completeJob(claim);
    return;
  }
  const { settings } = snapshot;
  const speechInput = snapshot.tagged;
  const { audio, voice, mime } = await withModelSlot("tts", "tts", claim, signal, (modelSignal) => synthesize({
    text: speechInput, modelId: settings.ttsModelId, voice: settings.voice,
    personaId: settings.personaId, useStyle: settings.useStyle, signal: modelSignal,
  }));
  assertOwned(claim, signal);
  const saved = saveSegmentAudio(claim.docId, claim.idx, audio, {
    hash: audioHash({ text: snapshot.tagged, modelId: settings.ttsModelId, voice: settings.voice, useStyle: settings.useStyle, personaId: settings.personaId }),
    modelId: settings.ttsModelId, voice,
    ext: mime === "audio/mpeg" ? "mp3" : mime === "audio/wav" ? "wav" : "bin",
  }, snapshot, claim);
  if (!saved) throw new LeaseLostError("口述稿或任务状态已改变");
  // 音频保存与作业完成在存储事务中一起提交；这里兼容已完成的幂等调用。
  completeJob(claim);
}

/** 在常驻 Node 服务启动时调用；重复调用不会启动第二个进程内调度器。 */
export function startBackgroundWorker(): void {
  if (!canRun()) return;
  const existing = globalThis.__readaloudBackgroundWorker;
  if (existing && !existing.stopped) {
    if (existing.version !== WORKER_VERSION) {
      // 开发热更新时让旧请求自然结束，再切换调度器；避免旧的固定并发闭包常驻。
      existing.wake = () => {
        if (existing.active.size) return;
        existing.stop();
        if (globalThis.__readaloudBackgroundWorker === existing) delete globalThis.__readaloudBackgroundWorker;
        startBackgroundWorker();
      };
    }
    existing.wake();
    return;
  }

  const leaseMs = leaseDuration();
  const state: WorkerState = {
    version: WORKER_VERSION, owner: `${process.pid}:${randomUUID()}`, active: new Map(), stopped: false, pumping: false,
    wake: () => {}, stop: () => {},
  };
  globalThis.__readaloudBackgroundWorker = state;

  const run = async (claim: JobClaim) => {
    const key = `${claim.docId}:${claim.idx}:${claim.owner}:${claim.attempt}`;
    const controller = new AbortController();
    state.active.set(key, { claim, controller });
    const heartbeat = setInterval(() => {
      try {
        if (!renewJobLease(claim, leaseMs)) controller.abort(new LeaseLostError("任务已停止"));
      } catch {
        // 无法确认租约时停止当前请求，留给恢复机制重新领取。
        controller.abort(new LeaseLostError("执行器暂时无法续约"));
      }
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    try {
      await executeBackgroundJob(claim, controller.signal);
    } catch (error) {
      if (!state.stopped && isJobOwned(claim)) {
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        if (!(reason instanceof LeaseLostError)) {
          const detail = describeJobError(reason);
          const document = getDocument(claim.docId);
          const modelId = claim.phase === "tts" ? document?.ttsModelId
            : claim.phase === "tags" || claim.phase === "spoken" ? document?.scriptModel : undefined;
          const result = failJobWithRetry(claim, detail, modelId);
          if (result.accepted) console.warn("[generation-failure]", JSON.stringify({
            docId: claim.docId, idx: claim.idx, phase: claim.phase, attempt: claim.attempt,
            modelId, error: detail, status: result.status, nextRetryAt: result.nextRetryAt,
          }));
        }
      }
    } finally {
      clearInterval(heartbeat);
      state.active.delete(key);
      if (!state.stopped) queueMicrotask(() => state.wake());
    }
  };

  state.wake = () => {
    if (state.stopped || state.pumping) return;
    state.pumping = true;
    try {
      const settings = getRuntimeSettings();
      while (state.active.size < settings.taskConcurrency * settings.segmentConcurrency) {
        // SQLite 内同时检查所有执行器的在途任务，不能按浏览器/文档放大并发。
        // 每次领取独立令牌，备份覆盖即使重建了同 id/attempt 也不能复活旧请求。
        const claim = claimNextJob(`${state.owner}:${randomUUID()}`, leaseMs);
        if (!claim) break;
        void run(claim).catch((error: unknown) => console.error("后台执行器异常", error));
      }
    } catch (error) {
      console.error("后台任务调度暂时失败，将稍后重试", error);
    } finally {
      state.pumping = false;
    }
  };
  state.stop = () => {
    if (state.stopped) return;
    state.stopped = true;
    clearInterval(state.timer);
    for (const job of state.active.values()) job.controller.abort(new LeaseLostError("服务端正在停止"));
    process.off("SIGTERM", state.stop);
    process.off("SIGINT", state.stop);
    // 不把关机标成失败；重启后，未完成租约到期即可重新领取。
  };
  process.once("SIGTERM", state.stop);
  process.once("SIGINT", state.stop);
  state.timer = setInterval(() => state.wake(), 1_000);
  state.timer.unref();
  state.wake();
}

/** 用户显式取消或改稿时尽快终止本进程请求；其他执行器会在续约时发现租约失效。 */
export function abortBackgroundJobs(docId: string, indices?: number[]): void {
  const state = globalThis.__readaloudBackgroundWorker;
  if (!state) return;
  for (const job of state.active.values()) {
    if (job.claim.docId === docId && (!indices || indices.includes(job.claim.idx))) {
      job.controller.abort(new LeaseLostError("任务已停止"));
    }
  }
}
