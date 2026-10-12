import type { LibrarySnapshot } from "@/lib/store/types";

export type LibraryNodeKind = "group" | "session" | "document";
export interface LibraryNode {
  kind: LibraryNodeKind;
  id: string;
  name: string;
  parentId: string | null;
  position: number;
}
export interface LibraryMove {
  kind: LibraryNodeKind;
  id: string;
  parentId: string | null;
  beforeId: string | null;
}
export type DropTarget =
  | { type: "inside"; kind: "root" | "unfiled" | "group" | "session"; id: string | null }
  | { type: "edge"; node: LibraryNode; edge: "before" | "after" };

const byPosition = (a: LibraryNode, b: LibraryNode) => a.position - b.position || a.id.localeCompare(b.id);

export function libraryNodes(library: LibrarySnapshot): LibraryNode[] {
  return [
    ...library.collections.map((item) => ({ kind: item.kind, id: item.id, name: item.name, parentId: item.parentId, position: item.position })),
    ...library.documents.map((item) => ({ kind: "document" as const, id: item.id, name: item.title, parentId: item.sessionId, position: item.position })),
  ];
}

export function siblingNodes(nodes: LibraryNode[], node: Pick<LibraryNode, "kind" | "parentId">): LibraryNode[] {
  return nodes.filter((item) => item.parentId === node.parentId && (node.kind === "document" ? item.kind === "document" : item.kind !== "document")).sort(byPosition);
}

export function childNodes(nodes: LibraryNode[], kind: "root" | "group" | "session" | "unfiled", id: string | null): LibraryNode[] {
  return nodes.filter((item) => {
    if (kind === "root") return item.kind !== "document" && item.parentId === null;
    if (kind === "unfiled") return item.kind === "document" && item.parentId === null;
    return item.parentId === id && item.kind === (kind === "group" ? "session" : "document");
  }).sort(byPosition);
}

/** 拖到行边缘会插在前后；拖进容器只接受合法的父子层级。 */
export function libraryDropMove(nodes: LibraryNode[], source: LibraryNode, target: DropTarget): LibraryMove | null {
  if (target.type === "inside") {
    const allowed = source.kind === "group" ? target.kind === "root"
      : source.kind === "session" ? target.kind === "root" || target.kind === "group"
        : target.kind === "session" || target.kind === "unfiled";
    if (!allowed || source.id === target.id) return null;
    return { kind: source.kind, id: source.id, parentId: target.kind === "root" || target.kind === "unfiled" ? null : target.id, beforeId: null };
  }
  if (source.id === target.node.id) return null;
  const destination = target.node;
  if ((source.kind === "document") !== (destination.kind === "document")) return null;
  if (source.kind === "group" && destination.parentId !== null) return null;
  const siblings = siblingNodes(nodes, destination).filter((item) => item.id !== source.id);
  const at = siblings.findIndex((item) => item.id === destination.id);
  if (at < 0) return null;
  return {
    kind: source.kind, id: source.id, parentId: destination.parentId,
    beforeId: target.edge === "before" ? destination.id : siblings[at + 1]?.id ?? null,
  };
}

/** 键盘和触屏通过同一套 beforeId 语义完成上下移动。 */
export function libraryStepMove(nodes: LibraryNode[], node: LibraryNode, direction: -1 | 1): LibraryMove | null {
  const siblings = siblingNodes(nodes, node);
  const at = siblings.findIndex((item) => item.id === node.id);
  if (at < 0 || at + direction < 0 || at + direction >= siblings.length) return null;
  return {
    kind: node.kind, id: node.id, parentId: node.parentId,
    beforeId: direction === -1 ? siblings[at - 1].id : siblings[at + 2]?.id ?? null,
  };
}

export function sessionLabels(library: LibrarySnapshot): { id: string; label: string }[] {
  const groups = new Map(library.collections.filter((item) => item.kind === "group").map((item) => [item.id, item.name]));
  return library.collections.filter((item) => item.kind === "session").map((item) => ({
    id: item.id, label: item.parentId ? `${groups.get(item.parentId) ?? "Group"} / ${item.name}` : item.name,
  }));
}
