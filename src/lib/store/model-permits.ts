import "server-only";
import { randomUUID } from "node:crypto";
import { db, tx } from "./db";
import { isJobOwned } from "./job-state";
import { getRuntimeSettings } from "./runtime-settings";
import type { JobClaim } from "./types";

export type ModelPermitKind = "text" | "tts";

/** 租约过期时可回收；取消任务不提前删除在途许可，等实际请求结束释放。 */
export function expireModelPermits(now = Date.now()): void {
  db().prepare("DELETE FROM model_permits WHERE lease_until <= ?").run(now);
}

export function activeModelCounts(now = Date.now()): Record<ModelPermitKind, number> {
  const rows = db().prepare("SELECT kind, COUNT(*) AS count FROM model_permits WHERE lease_until > ? GROUP BY kind").all(now);
  const result = { text: 0, tts: 0 };
  for (const row of rows) result[row.kind as ModelPermitKind] = Number(row.count);
  return result;
}

/** BEGIN IMMEDIATE 覆盖计数与领取，多个 Node 进程也不能各自用一套上限。 */
export function tryAcquireModelPermit(kind: ModelPermitKind, claim: JobClaim, leaseMs: number): string | null {
  return tx(() => {
    const now = Date.now();
    expireModelPermits(now);
    if (!isJobOwned(claim, now)) return null;
    const existing = db().prepare(`SELECT token FROM model_permits WHERE doc_id = ? AND job_idx = ?
      AND job_owner = ? AND job_attempt = ? AND kind = ?`).get(claim.docId, claim.idx, claim.owner, claim.attempt, kind);
    if (existing) return existing.token as string;
    const settings = getRuntimeSettings();
    const limit = kind === "text" ? settings.textConcurrency : settings.ttsConcurrency;
    if (activeModelCounts(now)[kind] >= limit) return null;
    const token = randomUUID();
    db().prepare(`INSERT INTO model_permits(token, kind, doc_id, job_idx, job_owner, job_attempt, lease_until, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(token, kind, claim.docId, claim.idx, claim.owner, claim.attempt, now + leaseMs, now);
    return token;
  });
}

export function releaseModelPermit(token: string): void {
  db().prepare("DELETE FROM model_permits WHERE token = ?").run(token);
}
