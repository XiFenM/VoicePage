"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PERSONAS, TTS_MODELS } from "@/lib/catalog";
import type { DocSettings, DocSummary, StoredDocument } from "@/lib/store/types";
import { api } from "./api";
import { HistorySidebar } from "./HistorySidebar";
import { Reader } from "./Reader";
import { SettingsBar } from "./SettingsBar";

const DEFAULT_SETTINGS: DocSettings = {
  personaId: PERSONAS[0].id,
  ttsModelId: TTS_MODELS[0].id,
  voice: TTS_MODELS[0].defaultVoice,
  useTags: true,
  useStyle: true,
};
const SETTINGS_KEY = "readaloud:lastSettings";

export function Studio() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [active, setActive] = useState<StoredDocument | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);

  // 新建表单
  const [text, setText] = useState("");
  const [settings, setSettings] = useState<DocSettings>(DEFAULT_SETTINGS);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const refreshList = useCallback(() => {
    api.list().then(setDocs).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    refreshList();
    // 记住上次用的设置（只是偏好，不是数据，放 localStorage 即可）
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setSettings({ ...DEFAULT_SETTINGS, ...saved });
    } catch {}
    // 地址栏 #id 用于刷新后回到同一条记录
    const id = window.location.hash.slice(1);
    if (id) void open(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeSettings(patch: Partial<DocSettings>) {
    setSettings((s) => {
      const next = { ...s, ...patch };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function open(id: string) {
    setLoadingDoc(true);
    setError("");
    try {
      const doc = await api.get(id);
      setActive(doc);
      history.replaceState(null, "", `#${id}`);
    } catch (e) {
      setError((e as Error).message);
      history.replaceState(null, "", location.pathname);
    } finally {
      setLoadingDoc(false);
    }
  }

  function startNew() {
    setActive(null);
    setError("");
    history.replaceState(null, "", location.pathname);
  }

  async function create() {
    setCreating(true);
    setError("");
    try {
      const doc = await api.create({ text, ...settings });
      setActive(doc);
      setText("");
      history.replaceState(null, "", `#${doc.id}`);
      refreshList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-4 md:flex-row md:p-6">
      <HistorySidebar
        docs={docs}
        activeId={active?.id ?? null}
        onSelect={(id) => void open(id)}
        onNew={startNew}
        onChanged={() => {
          refreshList();
          if (active) void open(active.id);
        }}
        onDeleted={(id) => {
          if (active?.id === id) startNew();
          refreshList();
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col gap-4">
        <header className="flex items-center justify-between">
          <h1 className="truncate text-lg font-semibold">{active ? active.title : "ReadAloud · 边听边读"}</h1>
          <button
            className="shrink-0 text-sm text-zinc-500 hover:underline"
            onClick={async () => {
              await fetch("/api/logout", { method: "POST" });
              router.replace("/login");
            }}
          >
            退出
          </button>
        </header>

        {error && <p className="text-sm break-all text-red-500">{error}</p>}

        {loadingDoc ? (
          <p className="text-sm text-zinc-500">加载中…</p>
        ) : active ? (
          // key 保证切换记录时 Reader 完全重置（播放状态、合成队列等）
          <Reader key={active.id} doc={active} onDocChanged={refreshList} />
        ) : (
          <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="粘贴 AI 的回复（支持 Markdown、代码块、表格、mermaid 等）"
              className="h-64 w-full resize-y rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-sm dark:border-zinc-700"
            />
            <div className="flex flex-wrap items-center gap-3">
              <SettingsBar value={settings} onChange={changeSettings} />
              <button
                onClick={create}
                disabled={!text.trim() || creating}
                className="ml-auto rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {creating ? "正在生成口述稿…" : "生成语音"}
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
