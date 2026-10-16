"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PERSONAS, TTS_MODELS } from "@/lib/catalog";
import { DEFAULT_GENERATION_SETTINGS, type GenerationSettings } from "@/lib/generation-settings";
import type { DocSettings, LibrarySnapshot, StoredDocument } from "@/lib/store/types";
import type { SourceBlock } from "@/lib/script/segment";
import type { SourcePreviewAction } from "@/lib/script/types";
import { api, PreviewRequiredError, type SourcePreviewResult } from "./api";
import { HistorySidebar } from "./HistorySidebar";
import { Reader } from "./Reader";
import { SettingsBar } from "./SettingsBar";
import { LibraryDialog } from "./LibraryDialog";
import { SourcePreview } from "./SourcePreview";
import { sessionLabels } from "./library-tree";
import { documentProgress, isBackgroundActive } from "./background-progress";
import { ACTIVE_POLL_MS, IDLE_POLL_MS, createVisibilityPoller, type VisibilityPoller } from "./visibility-poller";

const DEFAULT_SETTINGS: DocSettings = {
  personaId: PERSONAS[0].id, ttsModelId: TTS_MODELS[0].id,
  voice: TTS_MODELS[0].defaultVoice, useTags: true, useStyle: true,
};
const SETTINGS_KEY = "readaloud:lastSettings";
type SubmitStage = "idle" | "checking" | "previewing" | "updating-preview" | "creating";
type SourceOperation = { controller: AbortController; view: number; revision: number; committing: boolean };

export function Studio() {
  const router = useRouter();
  const [library, setLibrary] = useState<LibrarySnapshot>({ collections: [], documents: [] });
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [active, setActive] = useState<StoredDocument | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [text, setText] = useState("");
  const [settings, setSettings] = useState<DocSettings>(DEFAULT_SETTINGS);
  const [submitStage, setSubmitStage] = useState<SubmitStage>("idle");
  const [preview, setPreview] = useState<SourcePreviewResult | null>(null);
  const [previewUndo, setPreviewUndo] = useState<SourcePreviewResult | null>(null);
  const [editingPreview, setEditingPreview] = useState(false);
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [previewInvalidated, setPreviewInvalidated] = useState(false);
  const [generationSettings, setGenerationSettings] = useState(DEFAULT_GENERATION_SETTINGS);
  const [generationSettingsLoading, setGenerationSettingsLoading] = useState(true);
  const [generationSettingsError, setGenerationSettingsError] = useState("");
  const [retryConfirm, setRetryConfirm] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const previewAnchor = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const libraryPoller = useRef<VisibilityPoller | null>(null);
  const libraryActive = useRef(true);
  const sourceOperation = useRef<SourceOperation | null>(null);
  const previewEditing = useRef(false);
  const draftRevision = useRef(0);
  const generationSettingsVersion = useRef(0);
  const viewVersion = useRef(0);
  const libraryVersion = useRef(0);
  const treeInteracting = useRef(false);
  const pendingLibrary = useRef<LibrarySnapshot | null>(null);
  const activeId = active?.id;
  const docs = library.documents;
  const creating = submitStage === "creating";
  const sourceBusy = submitStage !== "idle";

  const readGenerationSettings = useCallback(async (signal?: AbortSignal) => {
    const version = ++generationSettingsVersion.current;
    setGenerationSettingsLoading(true);
    try {
      const next = await api.generationSettings(signal);
      if (!signal?.aborted && alive.current && version === generationSettingsVersion.current) {
        setGenerationSettings(next);
        setGenerationSettingsError("");
      }
      return next;
    } catch (error) {
      if (!signal?.aborted && alive.current && version === generationSettingsVersion.current) setGenerationSettingsError(`读取预览设置失败：${(error as Error).message}`);
      throw error;
    } finally {
      if (!signal?.aborted && alive.current && version === generationSettingsVersion.current) setGenerationSettingsLoading(false);
    }
  }, []);

  const applyLibrary = useCallback((snapshot: LibrarySnapshot) => {
    libraryVersion.current++;
    if (treeInteracting.current) { pendingLibrary.current = snapshot; return; }
    libraryActive.current = snapshot.documents.some((document) => isBackgroundActive(documentProgress(document)));
    setLibrary(snapshot);
    setLibraryLoaded(true);
    setLibraryError("");
    setSelectedSessionId((id) => id && !snapshot.collections.some((item) => item.kind === "session" && item.id === id) ? null : id);
    libraryPoller.current?.reschedule();
  }, []);

  const pollLibrary = useCallback(async (signal: AbortSignal) => {
    if (signal.aborted || treeInteracting.current) return;
    setLibraryLoading(true);
    const version = libraryVersion.current;
    try {
      const snapshot = await api.library(signal);
      if (!signal.aborted && alive.current && !treeInteracting.current && version === libraryVersion.current) {
        applyLibrary(snapshot);
      }
    } catch (e) {
      if (!signal.aborted && alive.current && version === libraryVersion.current) setLibraryError((e as Error).message);
    } finally {
      if (!signal.aborted && alive.current) setLibraryLoading(false);
    }
  }, [applyLibrary]);

  const refreshList = useCallback(() => libraryPoller.current?.refresh(), []);

  function libraryChanged(snapshot?: LibrarySnapshot) {
    if (snapshot) applyLibrary(snapshot);
    else void refreshList();
  }

  function treeInteraction(value: boolean) {
    if (treeInteracting.current !== value) libraryVersion.current++;
    treeInteracting.current = value;
    if (!value) {
      const pending = pendingLibrary.current;
      pendingLibrary.current = null;
      if (pending) applyLibrary(pending);
      void refreshList();
    }
  }

  // 首次挂载同步浏览器偏好与地址栏；随后列表轮询只更新列表，不切换阅读页。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    alive.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
      if (saved) setSettings({ ...DEFAULT_SETTINGS, ...saved });
    } catch {}
    const id = window.location.hash.slice(1);
    if (id) void open(id);
    return () => {
      alive.current = false;
      // Only local preview/settings reads can be aborted. Creation keeps running on the server.
      sourceOperation.current?.controller.abort();
      sourceOperation.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Start an independent settings read on mount.
    void readGenerationSettings(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [readGenerationSettings]);

  useEffect(() => {
    const poller = createVisibilityPoller({
      poll: pollLibrary,
      getInterval: () => libraryActive.current ? ACTIVE_POLL_MS : IDLE_POLL_MS,
      visibility: document,
    });
    libraryPoller.current = poller;
    return () => {
      poller.dispose();
      if (libraryPoller.current === poller) libraryPoller.current = null;
    };
  }, [pollLibrary]);

  useEffect(() => {
    if (activeId) mainRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeId]);

  function changeSettings(patch: Partial<DocSettings>) {
    setSettings((s) => {
      const next = { ...s, ...patch };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function discardPreview() {
    const operation = sourceOperation.current;
    if (operation && !operation.committing) {
      operation.controller.abort();
      sourceOperation.current = null;
      setSubmitStage("idle");
      setGenerationSettingsLoading(false);
    }
    setPreview(null);
    setPreviewUndo(null);
    previewEditing.current = false;
    setEditingPreview(false);
    setRetryConfirm(null);
  }

  function changeText(value: string) {
    draftRevision.current++;
    if (preview) setPreviewInvalidated(true);
    discardPreview();
    setText(value);
    setError("");
  }

  function generationSettingsChanged(next: GenerationSettings) {
    // A saved server preference wins over any older read already in flight.
    generationSettingsVersion.current++;
    discardPreview();
    setPreviewInvalidated(false);
    setGenerationSettings(next);
    setGenerationSettingsLoading(false);
    setGenerationSettingsError("");
    if (!active) setError("");
  }

  function selectSession(id: string | null) {
    if (id === selectedSessionId) return;
    viewVersion.current++;
    discardPreview();
    setPreviewInvalidated(false);
    setSelectedSessionId(id);
    setLoadingDoc(false);
    setError("");
  }

  async function open(id: string) {
    if (active?.id === id) return;
    discardPreview();
    setPreviewInvalidated(false);
    const version = ++viewVersion.current;
    setLoadingDoc(true);
    setError("");
    try {
      const doc = await api.get(id);
      if (!alive.current || version !== viewVersion.current) return;
      setActive(doc);
      setSelectedSessionId(doc.sessionId ?? null);
      history.replaceState(null, "", `#${id}`);
    } catch (e) {
      if (alive.current && version === viewVersion.current) setError((e as Error).message);
    } finally {
      if (alive.current && version === viewVersion.current) setLoadingDoc(false);
    }
  }

  function startNew(sessionId?: string | null) {
    viewVersion.current++;
    discardPreview();
    setPreviewInvalidated(false);
    if (sessionId !== undefined) setSelectedSessionId(sessionId);
    setActive(null);
    setLoadingDoc(false);
    setError("");
    setNotice("");
    history.replaceState(null, "", location.pathname);
  }

  async function create(confirmPreview = false) {
    if (sourceOperation.current || previewEditing.current || !text.trim()) return;
    const operation: SourceOperation = { controller: new AbortController(), view: viewVersion.current, revision: draftRevision.current, committing: false };
    sourceOperation.current = operation;
    const sourceText = text;
    // A button labelled "preview" must never start paid work if another browser
    // disables the setting between the last read and this click.
    const requestedPreview = !confirmPreview && generationSettings.previewBeforeGeneration;
    const matchingPreview = preview?.sourceText === sourceText ? preview : null;
    const confirmedPreview = confirmPreview ? matchingPreview : null;
    const destination = selectedSessionId;
    const chosenSettings = settings;
    let phase: "settings" | "preview" | "create" = "settings";
    const isCurrent = () => alive.current && sourceOperation.current === operation && operation.view === viewVersion.current && operation.revision === draftRevision.current && !operation.controller.signal.aborted;
    setSubmitStage("checking");
    setError("");
    setRetryConfirm(null);
    try {
      const latest = await readGenerationSettings(operation.controller.signal);
      if (!isCurrent()) return;
      if (requestedPreview || (latest.previewBeforeGeneration && !confirmedPreview)) {
        phase = "preview";
        setSubmitStage("previewing");
        const result = matchingPreview?.edited
          ? await api.previewBlocks(matchingPreview.blocks, operation.controller.signal)
          : await api.previewSource(sourceText, operation.controller.signal);
        if (!isCurrent()) return;
        setText(result.sourceText);
        setPreview(result);
        setSourceExpanded(false);
        setPreviewInvalidated(false);
        requestAnimationFrame(() => {
          if (alive.current && operation.view === viewVersion.current && operation.revision === draftRevision.current) previewAnchor.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        return;
      }
      phase = "create";
      operation.committing = true;
      setSubmitStage("creating");
      const doc = await api.create({ text: sourceText, ...chosenSettings, sessionId: destination,
        ...(confirmedPreview ? { previewToken: confirmedPreview.previewToken, ...(confirmedPreview.edited ? { previewBlocks: confirmedPreview.blocks } : {}) } : {}) });
      if (!alive.current) return;
      if (isCurrent()) {
        setText("");
        setPreview(null);
        setPreviewUndo(null);
        setPreviewInvalidated(false);
        setActive(doc);
        history.replaceState(null, "", `#${doc.id}`);
      } else setNotice(`「${doc.title}」已加入后台队列，可在历史记录中查看进度。`);
      void refreshList();
    } catch (e) {
      if (!isCurrent()) return;
      if (e instanceof PreviewRequiredError) {
        draftRevision.current++;
        setText(e.preview.sourceText);
        setPreview(e.preview);
        setSourceExpanded(false);
        setPreviewInvalidated(false);
        setGenerationSettings({ previewBeforeGeneration: true });
        setError(e.message);
      } else if (phase !== "settings") {
        setError((e as Error).message);
        setRetryConfirm(confirmPreview);
      }
    } finally {
      if (sourceOperation.current === operation) {
        sourceOperation.current = null;
        if (alive.current) setSubmitStage("idle");
      }
    }
  }

  function previewEditingChanged(value: boolean) {
    previewEditing.current = value;
    setEditingPreview(value);
  }

  async function updatePreviewBlocks(blocks: SourceBlock[], action?: SourcePreviewAction): Promise<boolean> {
    if (!preview || sourceOperation.current) return false;
    const previous = preview;
    const operation: SourceOperation = { controller: new AbortController(), view: viewVersion.current, revision: draftRevision.current, committing: false };
    sourceOperation.current = operation;
    const isCurrent = () => alive.current && sourceOperation.current === operation && operation.view === viewVersion.current && operation.revision === draftRevision.current && !operation.controller.signal.aborted;
    setSubmitStage("updating-preview");
    setError("");
    try {
      const result = await api.previewBlocks(blocks, operation.controller.signal, action);
      if (!isCurrent()) return false;
      draftRevision.current++;
      setText(result.sourceText);
      setPreview(result);
      setPreviewUndo(previous);
      setPreviewInvalidated(false);
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      throw error;
    } finally {
      if (sourceOperation.current === operation) {
        sourceOperation.current = null;
        if (alive.current) setSubmitStage("idle");
      }
    }
  }

  async function savePreviewBlock(id: number, markdown: string): Promise<boolean> {
    if (!preview || !previewEditing.current || !preview.blocks.some((block) => block.id === id)) return false;
    return updatePreviewBlocks(preview.blocks.map((block) => block.id === id ? { ...block, markdown } : block));
  }

  async function adjustPreview(action: SourcePreviewAction): Promise<boolean> {
    if (!preview || (previewEditing.current && action.type !== "insert")) return false;
    return updatePreviewBlocks(preview.blocks, action);
  }

  function undoPreviewAdjustment() {
    if (!previewUndo || sourceOperation.current || previewEditing.current) return;
    draftRevision.current++;
    setText(previewUndo.sourceText);
    setPreview(previewUndo);
    setPreviewUndo(null);
    setPreviewInvalidated(false);
    setError("");
  }

  function closePreview() {
    discardPreview();
    setPreviewInvalidated(false);
    setError("");
  }

  async function createSession(name: string) {
    const session = await api.createCollection({ kind: "session", name, parentId: null });
    const snapshot = await api.library();
    applyLibrary(snapshot);
    selectSession(session.id);
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-4 pb-24 md:flex-row md:p-6">
      {creatingSession && <LibraryDialog title="新建 Session" nameLabel="Session 名称" submitLabel="创建" onSubmit={createSession} onClose={() => setCreatingSession(false)} />}
      <HistorySidebar library={library} selectedSessionId={selectedSessionId} activeId={active?.id ?? null}
        historyLoaded={libraryLoaded} historyLoading={libraryLoading} historyError={libraryError} onRetryHistory={() => void refreshList()}
        onGenerationSettingsChanged={generationSettingsChanged}
        onSelect={(id) => void open(id)} onSelectSession={selectSession} onNew={startNew}
        onChanged={libraryChanged} onInteracting={treeInteraction}
        onDeleted={(id) => { if (active?.id === id) startNew(); void refreshList(); }} />
      <main ref={mainRef} className="flex min-w-0 flex-1 scroll-mt-4 flex-col gap-4">
        <header className="flex items-center justify-between">
          <h1 className="truncate text-lg font-semibold">{active ? docs.find((doc) => doc.id === active.id)?.title ?? active.title : "ReadAloud · 边听边读"}</h1>
          <button className="shrink-0 text-sm text-zinc-500 hover:underline" onClick={async () => { await fetch("/api/logout", { method: "POST" }); router.replace("/login"); }}>退出</button>
        </header>
        {error && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm break-all text-red-500"><span>{error}</span>
          {!active && retryConfirm !== null && <button type="button" disabled={sourceBusy || editingPreview} onClick={() => void create(retryConfirm)} className="underline disabled:opacity-40">重试</button>}
        </div>}
        {notice && <p role="status" className="text-sm text-blue-600">{notice}</p>}
        {loadingDoc && <p className="text-sm text-zinc-500">加载记录中…</p>}
        {active ? (
          <Reader key={active.id} doc={active} onDocChanged={refreshList} />
        ) : (
          <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-zinc-500">所属 Session</span>
                <select value={selectedSessionId ?? ""} disabled={creating} onChange={(event) => selectSession(event.target.value || null)} className="min-w-0 max-w-sm rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
                  <option value="">未归档</option>
                  {sessionLabels(library).map((session) => <option key={session.id} value={session.id}>{session.label}</option>)}
                </select>
              </label>
              <button type="button" disabled={creating} onClick={() => setCreatingSession(true)} className="text-xs text-blue-600 hover:underline disabled:opacity-40">+ 新建 Session</button>
            </div>
            <details open={!preview || sourceExpanded} onToggle={(event) => { if (preview) setSourceExpanded(event.currentTarget.open); }}>
              <summary className={preview ? "cursor-pointer text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300" : "hidden"}>整篇原文（可选）</summary>
              {preview && <p className="my-2 text-xs text-zinc-500">本段修改会同步到这里。编辑整篇原文将重新预览分段；正在编辑模块时，请先保存或取消修改。</p>}
              <textarea ref={sourceInput} aria-label="AI 回复原文" value={text} disabled={creating || editingPreview} onChange={(e) => changeText(e.target.value)}
                placeholder="粘贴 AI 的回复（支持 Markdown、代码块、表格、mermaid 等）"
                className="h-64 w-full resize-y rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-sm dark:border-zinc-700" />
            </details>
            <div className="flex flex-wrap items-center gap-3">
              <fieldset disabled={sourceBusy || editingPreview} className="min-w-0 disabled:opacity-60"><SettingsBar value={settings} onChange={changeSettings} /></fieldset>
              <button type="button" onClick={() => void create(false)} disabled={!text.trim() || sourceBusy || editingPreview}
                className="ml-auto rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
                {creating ? "正在加入队列…" : submitStage === "checking" ? "正在读取生成设置…" : submitStage === "previewing" ? "正在整理预览…" : submitStage === "updating-preview" ? "正在保存模块…" : generationSettings.previewBeforeGeneration ? preview || previewInvalidated ? "更新预览" : "预览分段" : "生成语音"}
              </button>
              {(submitStage === "checking" || submitStage === "previewing") && <button type="button" onClick={closePreview} className="text-sm text-zinc-500 hover:underline">取消</button>}
            </div>
            {generationSettingsError && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-600"><span>{generationSettingsError}</span>
              <button type="button" disabled={sourceBusy || generationSettingsLoading} onClick={() => void readGenerationSettings().catch(() => {})} className="underline disabled:opacity-40">重试读取设置</button>
            </div>}
            {previewInvalidated && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">原文已修改，请更新预览后再确认生成。</p>}
            <p className="text-xs text-zinc-500">{generationSettings.previewBeforeGeneration ? "预览仅整理原文，不会创建任务或调用模型。" : "已关闭生成前预览，点击生成会直接加入后台队列。"} 连续新建默认归入当前 Session。</p>
            {preview && <div ref={previewAnchor} className="scroll-mt-4"><SourcePreview blocks={preview.blocks} busy={sourceBusy} canCancel={!creating} canUndo={Boolean(previewUndo)}
              onConfirm={() => void create(true)} onCancel={closePreview} onEditingChange={previewEditingChanged} onSaveBlock={savePreviewBlock}
              onAdjust={adjustPreview} onUndo={undoPreviewAdjustment} /></div>}
          </section>
        )}
      </main>
    </div>
  );
}
