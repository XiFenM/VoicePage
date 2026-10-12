import "server-only";
import { db, tx } from "./db";
import { DEFAULT_RUNTIME_SETTINGS, validateRuntimeSettings, type RuntimeSettings } from "@/lib/runtime-settings";

export function getRuntimeSettings(): RuntimeSettings {
  const row = db().prepare("SELECT * FROM runtime_settings WHERE id = 1").get();
  if (!row) return { ...DEFAULT_RUNTIME_SETTINGS };
  return {
    taskConcurrency: Number(row.task_concurrency),
    textConcurrency: Number(row.text_concurrency),
    ttsConcurrency: Number(row.tts_concurrency),
    segmentConcurrency: Number(row.segment_concurrency),
  };
}

/** 所有进程共用数据库配置；减小上限仅影响后续领取，不取消已经发出的请求。 */
export function updateRuntimeSettings(patch: Partial<RuntimeSettings>): RuntimeSettings {
  validateRuntimeSettings(patch);
  return tx(() => {
    const next = { ...getRuntimeSettings(), ...patch };
    db().prepare(`UPDATE runtime_settings SET task_concurrency = ?, text_concurrency = ?,
      tts_concurrency = ?, segment_concurrency = ?, updated_at = ? WHERE id = 1`)
      .run(next.taskConcurrency, next.textConcurrency, next.ttsConcurrency, next.segmentConcurrency, Date.now());
    return next;
  });
}
