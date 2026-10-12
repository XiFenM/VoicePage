import "server-only";
import { db, tx } from "./db";
import { listDocuments, newId } from "./documents";
import { assertSession, LibraryError } from "./organization";
import type { CollectionKind, LibraryCollection, LibraryMove, LibrarySnapshot } from "./types";

export { LibraryError } from "./organization";
type Row = Record<string, string | number | null>;

function toCollection(row: Row): LibraryCollection {
  return { id: row.id as string, kind: row.kind as CollectionKind, name: row.name as string,
    parentId: row.parent_id as string | null, position: Number(row.position), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

export function getCollection(id: string): LibraryCollection | null {
  const row = db().prepare("SELECT * FROM collections WHERE id = ?").get(id) as Row | undefined;
  return row ? toCollection(row) : null;
}

export function listCollections(): LibraryCollection[] {
  return (db().prepare("SELECT * FROM collections ORDER BY position, created_at, id").all() as Row[]).map(toCollection);
}

export function getLibrary(): LibrarySnapshot {
  return tx(() => ({ collections: listCollections(), documents: listDocuments() }));
}

function validateParent(kind: CollectionKind, parentId: string | null) {
  if (kind === "group" && parentId !== null) throw new LibraryError("Group 只能放在根目录");
  if (parentId !== null && getCollection(parentId)?.kind !== "group") throw new LibraryError("Session 只能放入 Group 或根目录");
}

function cleanName(name: string): string {
  const result = name.trim();
  if (!result || result.length > 200) throw new LibraryError("名称需要包含 1 至 200 个字符");
  return result;
}

function siblingIds(kind: "collection" | "document", parentId: string | null): string[] {
  const table = kind === "collection" ? "collections" : "documents";
  const parent = kind === "collection" ? "parent_id" : "session_id";
  return (db().prepare(`SELECT id FROM ${table} WHERE ${parent} IS ? ORDER BY position, created_at, id`).all(parentId) as { id: string }[]).map((row) => row.id);
}

function writeOrder(kind: "collection" | "document", parentId: string | null, ids: string[]) {
  const table = kind === "collection" ? "collections" : "documents";
  const parent = kind === "collection" ? "parent_id" : "session_id";
  const statement = db().prepare(`UPDATE ${table} SET ${parent} = ?, position = ? WHERE id = ?`);
  ids.forEach((id, position) => statement.run(parentId, position, id));
}

function place(kind: "collection" | "document", id: string, previousParent: string | null, parentId: string | null, beforeId?: string | null) {
  const siblings = siblingIds(kind, parentId);
  if (beforeId === id && parentId === previousParent) return;
  if (beforeId && !siblings.includes(beforeId)) throw new LibraryError("目标位置不在同一个父节点中");
  const next = siblings.filter((item) => item !== id);
  next.splice(beforeId ? next.indexOf(beforeId) : next.length, 0, id);
  writeOrder(kind, parentId, next);
  if (parentId !== previousParent) writeOrder(kind, previousParent, siblingIds(kind, previousParent));
}

export function createCollection(input: { kind: CollectionKind; name: string; parentId?: string | null; beforeId?: string | null }): LibraryCollection {
  const id = newId();
  const parentId = input.parentId ?? null;
  tx(() => {
    validateParent(input.kind, parentId);
    const now = Date.now();
    db().prepare("INSERT INTO collections (id, kind, name, parent_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.kind, cleanName(input.name), parentId, siblingIds("collection", parentId).length, now, now);
    place("collection", id, parentId, parentId, input.beforeId);
  });
  return getCollection(id)!;
}

export function updateCollection(id: string, patch: { name?: string; parentId?: string | null; beforeId?: string | null }): LibraryCollection {
  tx(() => {
    const current = getCollection(id);
    if (!current) throw new LibraryError("容器不存在", 404);
    if (patch.name !== undefined) db().prepare("UPDATE collections SET name = ?, updated_at = ? WHERE id = ?").run(cleanName(patch.name), Date.now(), id);
    if (patch.parentId !== undefined || patch.beforeId !== undefined) {
      const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
      validateParent(current.kind, parentId);
      place("collection", id, current.parentId, parentId, patch.beforeId);
    }
  });
  return getCollection(id)!;
}

export function moveLibraryItem(input: LibraryMove): LibrarySnapshot {
  tx(() => {
    if (input.kind === "document") {
      const current = db().prepare("SELECT session_id FROM documents WHERE id = ?").get(input.id) as { session_id: string | null } | undefined;
      if (!current) throw new LibraryError("任务不存在", 404);
      assertSession(input.parentId);
      place("document", input.id, current.session_id, input.parentId, input.beforeId);
    } else {
      const current = getCollection(input.id);
      if (!current) throw new LibraryError("容器不存在", 404);
      if (current.kind !== input.kind) throw new LibraryError("容器类型不匹配");
      validateParent(current.kind, input.parentId);
      place("collection", input.id, current.parentId, input.parentId, input.beforeId);
    }
  });
  return getLibrary();
}

/** 只解散组织容器；音频、正文、后台任务及其 updated_at 均不受影响。 */
export function deleteCollection(id: string): boolean {
  return tx(() => {
    const current = getCollection(id);
    if (!current) return false;
    if (current.kind === "group") {
      const roots = siblingIds("collection", null);
      const children = siblingIds("collection", id);
      roots.splice(roots.indexOf(id), 1, ...children);
      writeOrder("collection", null, roots);
    } else {
      writeOrder("document", null, [...siblingIds("document", null), ...siblingIds("document", id)]);
    }
    db().prepare("DELETE FROM collections WHERE id = ?").run(id);
    writeOrder("collection", current.parentId, siblingIds("collection", current.parentId));
    return true;
  });
}

/** 导入备份后把各同级序号压紧；不改变同级相对顺序或业务更新时间。 */
export function normalizeLibraryPositions(): void {
  const parents = db().prepare("SELECT DISTINCT parent_id FROM collections").all() as { parent_id: string | null }[];
  for (const { parent_id } of parents) writeOrder("collection", parent_id, siblingIds("collection", parent_id));
  const sessions = db().prepare("SELECT DISTINCT session_id FROM documents").all() as { session_id: string | null }[];
  for (const { session_id } of sessions) writeOrder("document", session_id, siblingIds("document", session_id));
}
