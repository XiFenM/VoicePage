"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { GenerationError } from "./GenerationError";
import { generationEventLabel, generationPhaseLabel, mergeGenerationEvents, type GenerationHistoryState } from "./generation-history";
import { ACTIVE_POLL_MS, createVisibilityPoller, IDLE_POLL_MS, type VisibilityPoller } from "./visibility-poller";

export type GenerationHistoryFilter = "all" | number | null;

export function GenerationHistory({ docId, generationActive, segmentIndices, filter, onFilterChange }: {
  docId: string;
  generationActive: boolean;
  segmentIndices: number[];
  filter: GenerationHistoryFilter;
  onFilterChange: (filter: GenerationHistoryFilter) => void;
}) {
  return <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
    <button type="button" aria-expanded={filter !== null} onClick={() => onFilterChange(filter === null ? "all" : null)} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm">
      <span className="font-medium">生成日志</span><span className="text-xs text-zinc-500">失败、自动重试与恢复记录 {filter === null ? "▸" : "▾"}</span>
    </button>
    {filter !== null && <HistoryEntries docId={docId} generationActive={generationActive} segmentIndices={segmentIndices} filter={filter} onFilterChange={onFilterChange} />}
  </section>;
}

function HistoryEntries({ docId, generationActive, segmentIndices, filter, onFilterChange }: {
  docId: string;
  generationActive: boolean;
  segmentIndices: number[];
  filter: Exclude<GenerationHistoryFilter, null>;
  onFilterChange: (filter: GenerationHistoryFilter) => void;
}) {
  const [history, setHistory] = useState<GenerationHistoryState>({ events: [], loaded: false });
  const historyRef = useRef(history);
  const activeRef = useRef(generationActive);
  const pollerRef = useRef<VisibilityPoller | null>(null);
  const readIntent = useRef<"latest" | "older" | null>(null);
  const requestSignal = useRef<AbortSignal | null>(null);
  const [loading, setLoading] = useState<"latest" | "older" | null>(null);
  const [error, setError] = useState<{ mode: "latest" | "older"; message: string } | null>(null);

  function load(mode: "latest" | "older") {
    if (mode === "older" && historyRef.current.nextCursor === undefined) return;
    readIntent.current = document.hidden ? "latest" : mode;
    pollerRef.current?.refresh();
  }

  // 最新页和更早分页共用一个可见性调度器，隐藏时不会遗留旁路 GET。
  useEffect(() => {
    let disposed = false;
    const clearHiddenIntent = () => { if (document.hidden) readIntent.current = null; };
    document.addEventListener("visibilitychange", clearHiddenIntent);
    const poller = createVisibilityPoller({
      visibility: document,
      getInterval: () => activeRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS,
      poll: async (signal) => {
        if (disposed || signal.aborted) return;
        const intent = readIntent.current;
        readIntent.current = null;
        const mode = intent ?? "latest";
        const before = mode === "older" ? historyRef.current.nextCursor : undefined;
        requestSignal.current = signal;
        setLoading(intent !== null || !historyRef.current.loaded ? mode : null);
        try {
          if (mode === "older" && before === undefined) return;
          const page = await api.generationEvents(docId, before, signal);
          if (disposed || signal.aborted || requestSignal.current !== signal) return;
          const next = mergeGenerationEvents(historyRef.current, page, mode);
          historyRef.current = next;
          setHistory(next);
          setError((current) => current?.mode === mode ? null : current);
        } catch (e) {
          if (!disposed && !signal.aborted && requestSignal.current === signal) {
            setError({ mode, message: `读取生成日志失败：${(e as Error).message}` });
          }
        } finally {
          if (!disposed && !signal.aborted && requestSignal.current === signal) {
            requestSignal.current = null;
            setLoading(null);
          }
        }
      },
    });
    pollerRef.current = poller;
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", clearHiddenIntent);
      poller.dispose();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [docId]);

  useEffect(() => {
    const changed = activeRef.current !== generationActive;
    activeRef.current = generationActive;
    // 状态切换时补读最终成功/新一轮开始事件；初次挂载由调度器自身读取。
    if (changed) pollerRef.current?.refresh();
    else pollerRef.current?.reschedule();
  }, [generationActive]);

  const visible = history.events.filter((event) => filter === "all" || event.idx === filter);
  return <div className="space-y-3 border-t border-zinc-200 p-4 text-sm dark:border-zinc-800">
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2"><span className="text-zinc-500">查看范围</span>
        <select value={String(filter)} onChange={(event) => onFilterChange(event.target.value === "all" ? "all" : Number(event.target.value))} className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
          <option value="all">整篇记录</option><option value="-1">口述稿生成</option>
          {segmentIndices.map((idx) => <option key={idx} value={idx}>第 {idx + 1} 段</option>)}
        </select>
      </label>
      <button type="button" disabled={loading !== null} onClick={() => void load("latest")} className="text-blue-600 hover:underline disabled:opacity-40">刷新日志</button>
      <span className="text-xs text-zinc-500">已加载 {history.events.length} 条{loading === "latest" ? " · 读取中…" : ""}</span>
    </div>
    <p className="text-xs text-zinc-500">日志保存在服务器，生成成功或重新打开记录后仍可查看。仅在展开且页面可见时自动更新。</p>
    {error && <div className="flex flex-wrap gap-2 text-xs text-red-600"><span className="break-all">{error.message}</span><button type="button" disabled={loading !== null} onClick={() => void load(error.mode)} className="underline disabled:opacity-40">重试读取</button></div>}
    {!history.loaded && !error && <p className="text-zinc-500">正在读取生成日志…</p>}
    {history.loaded && !visible.length && <p className="text-zinc-500">{filter === "all" ? "暂无生成日志。" : "当前已加载的日志中没有该段记录，可继续加载更早日志。"}</p>}
    <ol className="max-h-[28rem] space-y-3 overflow-y-auto">
      {visible.map((event) => <li key={event.id} className={`space-y-2 rounded-lg border p-3 ${event.type === "failed" ? "border-red-200 bg-red-50/50 text-red-900 dark:border-red-900 dark:bg-red-950/20 dark:text-red-200" : "border-zinc-200 dark:border-zinc-800"}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-1">
          <span className="font-medium">{event.idx === -1 ? "整篇口述稿" : `第 ${event.idx + 1} 段`} · {generationPhaseLabel(event.phase)} · {generationEventLabel(event)}</span>
          <time dateTime={new Date(event.createdAt).toISOString()} className="text-xs text-zinc-500">{new Date(event.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
        </div>
        <p className="break-all text-xs text-zinc-500">任务尝试 {event.attempt}{event.modelId ? ` · ${event.modelId}` : ""}</p>
        {event.nextRetryAt && <p className="text-xs">计划重试时间：{new Date(event.nextRetryAt).toLocaleString("zh-CN", { hour12: false })}</p>}
        {event.error && <GenerationError error={event.error} />}
      </li>)}
    </ol>
    {history.nextCursor !== undefined && <button type="button" disabled={loading !== null} onClick={() => void load("older")} className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700">{loading === "older" ? "正在加载…" : "加载更早日志"}</button>}
  </div>;
}
