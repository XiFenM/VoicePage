"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PERSONAS, TTS_MODELS } from "@/lib/catalog";
import type { DocSettings, LibrarySnapshot, StoredDocument } from "@/lib/store/types";
import { api } from "./api";
import { HistorySidebar } from "./HistorySidebar";
import { Reader } from "./Reader";
import { SettingsBar } from "./SettingsBar";
import { LibraryDialog } from "./LibraryDialog";
import { sessionLabels } from "./library-tree";

const DEFAULT_SETTINGS: DocSettings = {
  personaId: PERSONAS[0].id, ttsModelId: TTS_MODELS[0].id,
  voice: TTS_MODELS[0].defaultVoice, useTags: true, useStyle: true,
};
const SETTINGS_KEY = "readaloud:lastSettings";

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
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const listBusy = useRef(false);
  const submitting = useRef(false);
  const viewVersion = useRef(0);
  const libraryVersion = useRef(0);
  const treeInteracting = useRef(false);
  const pendingLibrary = useRef<LibrarySnapshot | null>(null);
  const activeId = active?.id;
  const docs = library.documents;

  const applyLibrary = useCallback((snapshot: LibrarySnapshot) => {
    libraryVersion.current++;
    if (treeInteracting.current) { pendingLibrary.current = snapshot; return; }
    setLibrary(snapshot);
    setLibraryLoaded(true);
    setLibraryError("");
    setSelectedSessionId((id) => id && !snapshot.collections.some((item) => item.kind === "session" && item.id === id) ? null : id);
  }, []);

  const refreshList = useCallback(async () => {
    if (listBusy.current || treeInteracting.current) return;
    listBusy.current = true;
    setLibraryLoading(true);
    const version = libraryVersion.current;
    try {
      const snapshot = await api.library();
      if (alive.current && !treeInteracting.current && version === libraryVersion.current) {
        applyLibrary(snapshot);
      }
    } catch (e) {
      if (alive.current && version === libraryVersion.current) setLibraryError((e as Error).message);
    } finally {
      listBusy.current = false;
      if (alive.current) setLibraryLoading(false);
    }
  }, [applyLibrary]);

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
    void refreshList();
    const timer = setInterval(() => void refreshList(), 2_000);
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
      if (saved) setSettings({ ...DEFAULT_SETTINGS, ...saved });
    } catch {}
    const id = window.location.hash.slice(1);
    if (id) void open(id);
    return () => { alive.current = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

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

  async function open(id: string) {
    if (active?.id === id) return;
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
    if (sessionId !== undefined) setSelectedSessionId(sessionId);
    setActive(null);
    setLoadingDoc(false);
    setError("");
    setNotice("");
    history.replaceState(null, "", location.pathname);
  }

  async function create() {
    if (submitting.current) return;
    submitting.current = true;
    const version = viewVersion.current;
    const sourceText = text;
    setCreating(true);
    setError("");
    try {
      const doc = await api.create({ text: sourceText, ...settings, sessionId: selectedSessionId });
      if (!alive.current) return;
      setText((current) => current === sourceText ? "" : current);
      if (version === viewVersion.current) {
        setActive(doc);
        history.replaceState(null, "", `#${doc.id}`);
      } else setNotice(`「${doc.title}」已加入后台队列，可在历史记录中查看进度。`);
      void refreshList();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      submitting.current = false;
      if (alive.current) setCreating(false);
    }
  }

  async function createSession(name: string) {
    const session = await api.createCollection({ kind: "session", name, parentId: null });
    const snapshot = await api.library();
    applyLibrary(snapshot);
    setSelectedSessionId(session.id);
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-4 pb-24 md:flex-row md:p-6">
      {creatingSession && <LibraryDialog title="新建 Session" nameLabel="Session 名称" submitLabel="创建" onSubmit={createSession} onClose={() => setCreatingSession(false)} />}
      <HistorySidebar library={library} selectedSessionId={selectedSessionId} activeId={active?.id ?? null}
        historyLoaded={libraryLoaded} historyLoading={libraryLoading} historyError={libraryError} onRetryHistory={() => void refreshList()}
        onSelect={(id) => void open(id)} onSelectSession={setSelectedSessionId} onNew={startNew}
        onChanged={libraryChanged} onInteracting={treeInteraction}
        onDeleted={(id) => { if (active?.id === id) startNew(); void refreshList(); }} />
      <main ref={mainRef} className="flex min-w-0 flex-1 scroll-mt-4 flex-col gap-4">
        <header className="flex items-center justify-between">
          <h1 className="truncate text-lg font-semibold">{active ? docs.find((doc) => doc.id === active.id)?.title ?? active.title : "ReadAloud · 边听边读"}</h1>
          <button className="shrink-0 text-sm text-zinc-500 hover:underline" onClick={async () => { await fetch("/api/logout", { method: "POST" }); router.replace("/login"); }}>退出</button>
        </header>
        {error && <p className="text-sm break-all text-red-500">{error}</p>}
        {notice && <p role="status" className="text-sm text-blue-600">{notice}</p>}
        {loadingDoc && <p className="text-sm text-zinc-500">加载记录中…</p>}
        {active ? (
          <Reader key={active.id} doc={active} onDocChanged={refreshList} />
        ) : (
          <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-zinc-500">所属 Session</span>
                <select value={selectedSessionId ?? ""} disabled={creating} onChange={(event) => setSelectedSessionId(event.target.value || null)} className="min-w-0 max-w-sm rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
                  <option value="">未归档</option>
                  {sessionLabels(library).map((session) => <option key={session.id} value={session.id}>{session.label}</option>)}
                </select>
              </label>
              <button type="button" disabled={creating} onClick={() => setCreatingSession(true)} className="text-xs text-blue-600 hover:underline disabled:opacity-40">+ 新建 Session</button>
            </div>
            <textarea value={text} disabled={creating} onChange={(e) => setText(e.target.value)}
              placeholder="粘贴 AI 的回复（支持 Markdown、代码块、表格、mermaid 等）"
              className="h-64 w-full resize-y rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-sm dark:border-zinc-700" />
            <div className="flex flex-wrap items-center gap-3">
              <fieldset disabled={creating} className="min-w-0 disabled:opacity-60"><SettingsBar value={settings} onChange={changeSettings} /></fieldset>
              <button onClick={create} disabled={!text.trim() || creating}
                className="ml-auto rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
                {creating ? "正在加入队列…" : "生成语音"}
              </button>
            </div>
            <p className="text-xs text-zinc-500">连续新建默认归入当前 Session。加入队列后可继续添加回复或收听其他记录，关闭页面也不影响后台生成。</p>
          </section>
        )}
      </main>
    </div>
  );
}
