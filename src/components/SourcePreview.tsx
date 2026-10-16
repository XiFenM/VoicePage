import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { SourceBlock } from "@/lib/script/segment";
import type { SourcePreviewAction } from "@/lib/script/types";
import { MarkdownContent } from "./MarkdownContent";

const KIND_LABELS: Record<SourceBlock["kind"], string> = {
  text: "正文", code: "代码", table: "表格", diagram: "图表语言", math: "公式",
};

type Editor = { type: "edit"; id: number } | { type: "insert"; index: number };

export function SourcePreview({ blocks, busy, canCancel, canUndo, onConfirm, onCancel, onEditingChange, onSaveBlock, onAdjust, onUndo }: {
  blocks: SourceBlock[];
  busy: boolean;
  canCancel: boolean;
  canUndo: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onEditingChange: (editing: boolean) => void;
  onSaveBlock: (id: number, markdown: string) => Promise<boolean>;
  onAdjust: (action: SourcePreviewAction) => Promise<boolean>;
  onUndo: () => void;
}) {
  const id = useId();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [failedAction, setFailedAction] = useState<SourcePreviewAction | null>(null);
  const [actionError, setActionError] = useState("");
  const alive = useRef(true);
  const saveLock = useRef(false);
  const editing = editor !== null;
  const locked = busy || saving || editing;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  function beginEdit(next: Editor, markdown: string) {
    if (busy || editing || saveLock.current) return;
    setEditor(next);
    setDraft(markdown);
    setError("");
    setFailedAction(null);
    setActionError("");
    onEditingChange(true);
  }

  function cancelEdit() {
    if (saveLock.current) return;
    setEditor(null);
    setDraft("");
    setError("");
    onEditingChange(false);
  }

  async function save() {
    if (!editor || saveLock.current || !draft.trim()) return;
    saveLock.current = true;
    setSaving(true);
    setError("");
    try {
      const applied = editor.type === "edit" ? await onSaveBlock(editor.id, draft)
        : await onAdjust({ type: "insert", index: editor.index, markdown: draft });
      if (alive.current && applied) {
        setEditor(null);
        setDraft("");
        onEditingChange(false);
      }
    } catch (error) {
      if (alive.current) setError(`保存模块失败：${(error as Error).message}`);
    } finally {
      saveLock.current = false;
      if (alive.current) setSaving(false);
    }
  }

  async function adjust(action: SourcePreviewAction) {
    if (locked || saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    setFailedAction(null);
    setActionError("");
    try {
      await onAdjust(action);
    } catch (error) {
      if (alive.current) { setFailedAction(action); setActionError(`调整失败：${(error as Error).message}`); }
    } finally {
      saveLock.current = false;
      if (alive.current) setSaving(false);
    }
  }

  function actionFailure(type: "delete" | "merge", index: number) {
    if (!failedAction || failedAction.type !== type || failedAction.index !== index) return null;
    return <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-600">
      <span className="break-all">{actionError} 原模块未改变。</span>
      <button type="button" disabled={locked} onClick={() => void adjust(failedAction)} className="underline disabled:opacity-40">重试调整</button>
    </div>;
  }

  const editorArea = editor && <div className="space-y-3">
    <label className="block space-y-1 text-sm" htmlFor={`${id}-editor`}>
      <span className="text-zinc-600 dark:text-zinc-400">{editor.type === "edit" ? `第 ${editor.id + 1} 段 Markdown` : "新模块 Markdown"}</span>
      <textarea id={`${id}-editor`} value={draft} disabled={saving} onChange={(event) => setDraft(event.target.value)} autoFocus
        className="min-h-44 w-full resize-y rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-sm leading-6 disabled:opacity-60 dark:border-zinc-700" />
    </label>
    <div className="space-y-1">
      <p className="text-xs text-zinc-500">实时预览</p>
      <div className="md min-w-0 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900/50"><MarkdownContent>{draft}</MarkdownContent></div>
    </div>
    <p className="text-xs text-zinc-500">手动保存的内容会保持为一个模块，不会再次自动拆分。</p>
    {error && <p role="alert" className="break-all text-sm text-red-600">{error}</p>}
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <button type="button" disabled={saving || !draft.trim()} onClick={() => void save()} className="rounded-lg bg-blue-600 px-3 py-1.5 text-white disabled:opacity-40">{saving ? "正在保存模块…" : error ? "重试保存模块" : editor.type === "insert" ? "保存新模块" : "保存本段修改"}</button>
      <button type="button" disabled={saving} onClick={cancelEdit} className="text-zinc-500 hover:underline disabled:opacity-40">{editor.type === "insert" ? "取消插入" : "取消修改"}</button>
    </div>
  </div>;

  return <section aria-label="分段预览" className="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-semibold">分段预览 · 共 {blocks.length} 段</h2>
        <p className="mt-1 text-sm text-zinc-500">可编辑、插入、删除或合并相邻模块。确认后才会生成口述稿和语音。</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button type="button" disabled={locked || !blocks.length} onClick={onConfirm} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-40">{busy ? "处理中…" : "确认并生成语音"}</button>
        <button type="button" disabled={locked || !canUndo} onClick={() => { setFailedAction(null); setActionError(""); onUndo(); }} className="text-blue-600 hover:underline disabled:opacity-40">撤销上次调整</button>
        <button type="button" disabled={!canCancel} onClick={onCancel} className="text-zinc-500 hover:underline disabled:opacity-40">取消预览</button>
      </div>
    </div>
    {editing && <p className="text-sm text-blue-700 dark:text-blue-300">请先保存或取消当前修改，再进行其他调整或确认生成。取消预览会保留已保存的修改。</p>}
    {!blocks.length && <p className="text-sm text-amber-700 dark:text-amber-300">预览中暂无模块。请从下方插入模块，或撤销上次调整后再生成。</p>}
    <div className="space-y-3">
      {Array.from({ length: blocks.length + 1 }, (_, index) => {
        const block = blocks[index];
        return <Fragment key={index}>
          <div className="space-y-2">
            {editor?.type === "insert" && editor.index === index ? <div className="rounded-xl border border-blue-300 p-3 dark:border-blue-800">{editorArea}</div> :
              <div className="flex flex-wrap items-center justify-center gap-3 border-y border-dashed border-zinc-200 py-2 text-xs dark:border-zinc-800">
                <button type="button" disabled={locked} onClick={() => beginEdit({ type: "insert", index }, "")} title={index === 0 ? "在开头插入" : index === blocks.length ? "在末尾插入" : `在第 ${index} 段之后插入`} className="text-blue-600 hover:underline disabled:opacity-40">插入模块</button>
                {index > 0 && index < blocks.length && <button type="button" disabled={locked} onClick={() => void adjust({ type: "merge", index: index - 1 })} className="text-zinc-500 hover:underline disabled:opacity-40">合并上下两段</button>}
              </div>}
            {index > 0 && actionFailure("merge", index - 1)}
          </div>
          {block && <article className="min-w-0 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>第 {block.id + 1} 段</span><span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">{KIND_LABELS[block.kind]}</span>
              <div className="ml-auto flex items-center gap-3">
                {!(editor?.type === "edit" && editor.id === block.id) && <button type="button" disabled={locked} onClick={() => beginEdit({ type: "edit", id: block.id }, block.markdown)} className="text-blue-600 hover:underline disabled:opacity-40">编辑本段</button>}
                <button type="button" disabled={locked} onClick={() => void adjust({ type: "delete", index })} className="text-red-600 hover:underline disabled:opacity-40">删除本段</button>
              </div>
            </div>
            {editor?.type === "edit" && editor.id === block.id ? editorArea : <div className="md min-w-0"><MarkdownContent>{block.markdown}</MarkdownContent></div>}
            {actionFailure("delete", index)}
          </article>}
        </Fragment>;
      })}
    </div>
    {blocks.length > 3 && <button type="button" disabled={locked} onClick={onConfirm} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-40">{busy ? "处理中…" : "确认并生成语音"}</button>}
  </section>;
}
