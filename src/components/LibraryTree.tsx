"use client";

import { useRef, useState, type DragEvent } from "react";
import type { DocSummary, LibrarySnapshot } from "@/lib/store/types";
import { api } from "./api";
import { LibraryDialog } from "./LibraryDialog";
import { backgroundPercent, backgroundStatusText, documentProgress, isBackgroundActive } from "./background-progress";
import { childNodes, libraryDropMove, libraryNodes, libraryStepMove, sessionLabels, type DropTarget, type LibraryMove, type LibraryNode } from "./library-tree";

export interface LibraryTreeProps {
  library: LibrarySnapshot;
  activeId: string | null;
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onSelectSession: (id: string | null) => void;
  onNew: (sessionId?: string | null) => void;
  onChanged: (snapshot?: LibrarySnapshot) => void;
  onDeleted: (id: string) => void;
  onInteracting: (value: boolean) => void;
}

type DialogAction =
  | { type: "create"; kind: "group" | "session"; parentId: string | null }
  | { type: "rename" | "remove"; node: LibraryNode };

export function LibraryTree(props: LibraryTreeProps) {
  const nodes = libraryNodes(props.library);
  const documents = new Map(props.library.documents.map((doc) => [doc.id, doc]));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState<LibraryNode | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [dialogAction, setDialogAction] = useState<DialogAction | null>(null);
  const dragged = useRef<LibraryNode | null>(null);
  const mutating = useRef(false);

  function publishInteraction() { props.onInteracting(!!dragged.current || mutating.current); }
  function endDrag() { dragged.current = null; setDragging(null); setDropKey(null); setMenu(null); publishInteraction(); }
  function toggle(id: string) { setCollapsed((state) => ({ ...state, [id]: !state[id] })); }

  async function mutate(work: () => Promise<LibrarySnapshot | void>, success: string, rethrow = false) {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    publishInteraction();
    try {
      const snapshot = await work();
      props.onChanged(snapshot ?? await api.library());
      setMessage(success);
      setMenu(null);
    } catch (e) { setError((e as Error).message); if (rethrow) throw e; }
    finally {
      mutating.current = false;
      setBusy(false);
      publishInteraction();
      props.onChanged();
    }
  }

  function move(request: LibraryMove | null) {
    if (!request) return;
    void mutate(async () => {
      const snapshot = await api.moveLibraryItem(request);
      if (request.parentId) setCollapsed((state) => ({ ...state, [request.parentId!]: false }));
      return snapshot;
    }, "位置已保存。");
  }

  function create(kind: "group" | "session", parentId: string | null = null) {
    setDialogAction({ type: "create", kind, parentId });
  }

  function rename(node: LibraryNode) {
    setDialogAction({ type: "rename", node });
  }

  function remove(node: LibraryNode) {
    setDialogAction({ type: "remove", node });
  }

  async function submitDialog(name: string) {
    if (!dialogAction) return;
    if (dialogAction.type === "create") {
      const { kind, parentId } = dialogAction;
      await mutate(async () => {
        const collection = await api.createCollection({ kind, name, parentId });
        const snapshot = await api.library();
        if (parentId) setCollapsed((state) => ({ ...state, [parentId]: false }));
        if (kind === "session") props.onSelectSession(collection.id);
        return snapshot;
      }, `${kind === "group" ? "Group" : "Session"} 已创建。`, true);
    } else if (dialogAction.type === "rename") {
      const { node } = dialogAction;
      if (name === node.name) return;
      await mutate(async () => {
        if (node.kind === "document") await api.update(node.id, { title: name });
        else await api.updateCollection(node.id, { name });
      }, "名称已保存。", true);
    } else {
      const { node } = dialogAction;
      await mutate(async () => {
        if (node.kind === "document") { await api.remove(node.id); props.onDeleted(node.id); }
        else await api.removeCollection(node.id);
      }, node.kind === "document" ? "记录已删除。" : "已解散，记录和语音已保留。", true);
    }
  }

  // 工厂仅组装事件回调；ref 只在浏览器触发拖拽事件后读取，不在渲染期间执行。
  /* eslint-disable react-hooks/refs */
  function dropZone(target: DropTarget, key: string) {
    const getMove = () => dragged.current ? libraryDropMove(nodes, dragged.current, target) : null;
    return {
      onDragEnter(event: DragEvent<HTMLElement>) {
        if (!getMove() || mutating.current) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropKey(key);
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!getMove() || mutating.current) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropKey(key);
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDropKey((current) => current === key ? null : current);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        const request = getMove();
        if (!request || mutating.current) return;
        event.preventDefault(); event.stopPropagation();
        move(request);
        endDrag();
      },
    };
  }
  /* eslint-enable react-hooks/refs */

  function edge(node: LibraryNode, position: "before" | "after") {
    const key = `${node.kind}:${node.id}:${position}`;
    const target: DropTarget = { type: "edge", node, edge: position };
    const allowed = dragging && libraryDropMove(nodes, dragging, target);
    return <div key={key} {...dropZone(target, key)} className="flex h-2 items-center">
      <div className={`h-0.5 w-full rounded ${dropKey === key ? "bg-blue-600" : allowed ? "bg-blue-200/70 dark:bg-blue-900" : "bg-transparent"}`} />
    </div>;
  }

  function renderNode(node: LibraryNode) {
    const key = `${node.kind}:${node.id}`;
    const expanded = !collapsed[node.id];
    const children = node.kind === "document" ? [] : childNodes(nodes, node.kind, node.id);
    const selected = node.kind === "document" ? props.activeId === node.id : node.kind === "session" && props.selectedSessionId === node.id;
    const insideKey = `inside:${key}`;
    const inside = node.kind !== "document" ? dropZone({ type: "inside", kind: node.kind, id: node.id }, insideKey) : {};
    const doc = documents.get(node.id);
    return <li key={key} className="min-w-0">
      {edge(node, "before")}
      <div {...inside} className={`rounded-lg border px-2 py-1.5 ${dropKey === insideKey ? "border-blue-500 bg-blue-100 dark:bg-blue-950" : selected ? "border-transparent bg-zinc-200 dark:bg-zinc-800" : "border-transparent hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}>
        <div className="flex min-w-0 items-start gap-1">
          <button type="button" draggable={!busy} disabled={busy} aria-label={`拖动 ${node.name}`} title="拖动以排序或移动" className="cursor-grab touch-none px-0.5 text-zinc-400 active:cursor-grabbing disabled:opacity-30"
            onDragStart={(event) => {
              if (mutating.current) { event.preventDefault(); return; }
              // 保持行高和提示区域不变，抓起条目时放置目标不会突然移动。
              dragged.current = node; setDragging(node);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-readaloud-node", JSON.stringify({ kind: node.kind, id: node.id }));
              publishInteraction();
            }} onDragEnd={endDrag}>⠿</button>
          {node.kind !== "document" && <button type="button" aria-label={`${expanded ? "收起" : "展开"} ${node.name}`} aria-expanded={expanded} onClick={() => toggle(node.id)} className="w-4 shrink-0 text-zinc-500">{expanded ? "▾" : "▸"}</button>}
          <button type="button" title={node.name} aria-label={node.kind === "document" ? `打开记录 ${node.name}` : `${node.kind === "session" ? "选择 Session" : "展开 Group"} ${node.name}`}
            onClick={() => node.kind === "document" ? props.onSelect(node.id) : node.kind === "session" ? props.onSelectSession(node.id) : toggle(node.id)}
            className="min-w-0 flex-1 text-left text-sm">
            <span className="block truncate font-medium">{node.name}</span>
            {node.kind !== "document" && <span className="text-[11px] text-zinc-500">{node.kind === "group" ? "Group" : "Session"} · {children.length} {node.kind === "group" ? "个会话" : "条记录"}</span>}
          </button>
          <button type="button" aria-label={`${node.name}的操作`} aria-expanded={menu === key} onClick={() => setMenu(menu === key ? null : key)} className="shrink-0 rounded px-1 text-xs text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700">•••</button>
        </div>
        {doc && <HistoryProgress doc={doc} />}
        {menu === key && <NodeActions node={node} nodes={nodes} library={props.library} busy={busy}
          onRename={() => rename(node)} onRemove={() => remove(node)} onMove={move}
          onCreateSession={() => create("session", node.id)} onNew={() => props.onNew(node.id)} />}
      </div>
      {node.kind !== "document" && expanded && <ul className="ml-3 border-l border-zinc-200 pl-1.5 dark:border-zinc-800">
        {children.map(renderNode)}
        {!children.length && <li {...dropZone({ type: "inside", kind: node.kind, id: node.id }, `empty:${key}`)} className={`rounded px-2 py-3 text-xs ${dropKey === `empty:${key}` ? "bg-blue-100 text-blue-700 dark:bg-blue-950" : "text-zinc-400"}`}>
          {node.kind === "group" ? "暂无 Session，可从操作菜单创建或拖入。" : "暂无记录，可在此 Session 新建或拖入。"}
        </li>}
      </ul>}
      {edge(node, "after")}
    </li>;
  }

  const root = childNodes(nodes, "root", null);
  const unfiled = childNodes(nodes, "unfiled", null);
  const dialogKind = dialogAction?.type === "create" ? dialogAction.kind : dialogAction?.node.kind;
  const dialogLabel = dialogKind === "group" ? "Group" : dialogKind === "session" ? "Session" : "记录";
  return <nav aria-label="听读记录组织" className="min-h-0 flex-1 space-y-2 overflow-y-auto">
    {dialogAction && <LibraryDialog
      title={dialogAction.type === "create" ? `新建 ${dialogLabel}` : dialogAction.type === "rename" ? `重命名 ${dialogLabel}` : dialogKind === "document" ? "永久删除记录" : `解散 ${dialogLabel}`}
      nameLabel={dialogAction.type === "remove" ? undefined : `${dialogLabel} 名称`}
      initialName={dialogAction.type === "rename" ? dialogAction.node.name : ""}
      description={dialogAction.type !== "remove" ? undefined : dialogKind === "group"
        ? `解散 Group「${dialogAction.node.name}」后，其中的 Session 会移到顶层，记录和语音都会保留。`
        : dialogKind === "session"
          ? `解散 Session「${dialogAction.node.name}」后，其中的记录会移到“未归档”，口述稿和语音都会保留。`
          : `将永久删除「${dialogAction.node.name}」及其口述稿和音频，此操作无法撤销。`}
      submitLabel={dialogAction.type === "create" ? "创建" : dialogAction.type === "rename" ? "保存" : dialogKind === "document" ? "永久删除" : "确认解散"}
      destructive={dialogAction.type === "remove"} onSubmit={submitDialog} onClose={() => setDialogAction(null)} />}
    <div className="flex flex-wrap gap-2 text-xs">
      <button disabled={busy} onClick={() => create("group")} className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900">+ Group</button>
      <button disabled={busy} onClick={() => create("session")} className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900">+ Session</button>
    </div>
    <p className="text-[11px] text-zinc-400">拖动 ⠿ 排序或移入容器；也可在 ••• 中移动。</p>
    {error && <p role="alert" className="break-all text-xs text-red-600">{error}</p>}
    {message && <p role="status" className="text-xs text-zinc-500">{message}</p>}
    {root.length > 0 && <ul>{root.map(renderNode)}</ul>}
    <div {...dropZone({ type: "inside", kind: "root", id: null }, "root")} className={`rounded-lg border border-dashed px-2 py-2 text-xs ${dropKey === "root" ? "border-blue-500 bg-blue-100 text-blue-800 dark:bg-blue-950" : "border-zinc-200 text-zinc-400 dark:border-zinc-800"}`}>
      {dragging ? "拖到这里移至顶层（Group / Session）" : "顶层可放 Group 或独立 Session"}
    </div>
    <div {...dropZone({ type: "inside", kind: "unfiled", id: null }, "unfiled")} className={`rounded-lg border px-2 py-2 ${dropKey === "unfiled" ? "border-blue-500 bg-blue-100 dark:bg-blue-950" : "border-zinc-200 dark:border-zinc-800"}`}>
      <div className="flex items-center gap-1">
        <button aria-expanded={!collapsed.unfiled} aria-label={`${collapsed.unfiled ? "展开" : "收起"}未归档`} onClick={() => toggle("unfiled")} className="w-4 text-zinc-500">{collapsed.unfiled ? "▸" : "▾"}</button>
        <button onClick={() => props.onSelectSession(null)} className={`flex-1 text-left text-sm ${props.selectedSessionId === null ? "font-semibold" : ""}`}>未归档 <span className="text-xs text-zinc-500">{unfiled.length}</span></button>
        <button onClick={() => props.onNew(null)} className="text-xs text-blue-600 hover:underline">新建</button>
      </div>
      {!collapsed.unfiled && <ul className="mt-1">{unfiled.map(renderNode)}{!unfiled.length && <li className="py-2 text-xs text-zinc-400">还没有未归档记录，可拖到这里移出 Session。</li>}</ul>}
    </div>
  </nav>;
}

function NodeActions({ node, nodes, library, busy, onRename, onRemove, onMove, onCreateSession, onNew }: {
  node: LibraryNode; nodes: LibraryNode[]; library: LibrarySnapshot; busy: boolean;
  onRename: () => void; onRemove: () => void; onMove: (move: LibraryMove | null) => void;
  onCreateSession: () => void; onNew: () => void;
}) {
  const [destination, setDestination] = useState(node.parentId ?? "");
  const choices = node.kind === "document" ? sessionLabels(library) : library.collections.filter((item) => item.kind === "group").map((item) => ({ id: item.id, label: item.name }));
  const up = libraryStepMove(nodes, node, -1);
  const down = libraryStepMove(nodes, node, 1);
  return <div className="mt-2 space-y-2 rounded-md border border-zinc-200 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-950">
    <div className="flex flex-wrap gap-x-3 gap-y-2">
      <button disabled={busy} onClick={onRename} className="hover:underline disabled:opacity-40">改名</button>
      <button disabled={busy || !up} onClick={() => onMove(up)} className="hover:underline disabled:opacity-30">上移</button>
      <button disabled={busy || !down} onClick={() => onMove(down)} className="hover:underline disabled:opacity-30">下移</button>
      <button disabled={busy} onClick={onRemove} className="text-red-600 hover:underline disabled:opacity-40">{node.kind === "document" ? "删除记录" : `解散 ${node.kind === "group" ? "Group" : "Session"}`}</button>
    </div>
    {node.kind === "group" && <button disabled={busy} onClick={onCreateSession} className="text-blue-600 hover:underline disabled:opacity-40">在此 Group 新建 Session</button>}
    {node.kind === "session" && <button disabled={busy} onClick={onNew} className="text-blue-600 hover:underline disabled:opacity-40">在此 Session 新建回复</button>}
    {node.kind !== "group" && <div className="flex items-center gap-1">
      <select aria-label={`${node.name}移动到`} value={destination} disabled={busy} onChange={(event) => setDestination(event.target.value)} className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-1 py-1 dark:border-zinc-700">
        <option value="">{node.kind === "document" ? "未归档" : "顶层（无 Group）"}</option>
        {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
      <button disabled={busy} onClick={() => onMove({ kind: node.kind, id: node.id, parentId: destination || null, beforeId: null })} className="shrink-0 text-blue-600 hover:underline disabled:opacity-40">移动到末尾</button>
    </div>}
  </div>;
}

function HistoryProgress({ doc }: { doc: DocSummary }) {
  const progress = documentProgress(doc);
  const active = isBackgroundActive(progress);
  const failed = progress.status === "failed";
  return <div className={`mt-1.5 space-y-1 pl-4 text-[11px] ${failed ? "text-red-600 dark:text-red-400" : active ? "text-blue-600 dark:text-blue-400" : "text-zinc-500"}`}>
    <div className="flex justify-between gap-1"><span>{backgroundStatusText(progress)}</span>{progress.scriptReady && progress.status !== "running" && <span>{progress.completedSegments}/{progress.totalSegments}</span>}</div>
    <div role="progressbar" aria-label={`${doc.title}生成进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={backgroundPercent(progress)} className="h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
      <div className={`h-full transition-[width] ${failed ? "bg-red-500" : "bg-blue-500"}`} style={{ width: `${backgroundPercent(progress)}%` }} />
    </div>
  </div>;
}
