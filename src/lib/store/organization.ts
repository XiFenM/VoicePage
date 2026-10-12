import "server-only";
import { db } from "./db";

export class LibraryError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 创建文档事务内调用，避免校验后 Session 被另一个进程删除。 */
export function assertSession(sessionId: string | null): void {
  if (sessionId === null) return;
  const collection = db().prepare("SELECT kind FROM collections WHERE id = ?").get(sessionId);
  if (!collection || collection.kind !== "session") throw new LibraryError("任务只能放入已有 Session，或移到未归档");
}

export function nextDocumentPosition(sessionId: string | null): number {
  return Number(db().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM documents WHERE session_id IS ?").get(sessionId)!.position);
}
