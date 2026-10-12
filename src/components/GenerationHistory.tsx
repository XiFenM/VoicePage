"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { GenerationError } from "./GenerationError";
import { generationEventLabel, generationPhaseLabel, mergeGenerationEvents, type GenerationHistoryState } from "./generation-history";

export type GenerationHistoryFilter = "all" | number | null;

export function GenerationHistory({ docId, segmentIndices, filter, onFilterChange }: {
  docId: string;
  segmentIndices: number[];
  filter: GenerationHistoryFilter;
  onFilterChange: (filter: GenerationHistoryFilter) => void;
}) {
  return <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
    <button type="button" aria-expanded={filter !== null} onClick={() => onFilterChange(filter === null ? "all" : null)} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm">
      <span className="font-medium">生成日志</span><span className="text-xs text-zinc-500">失败、自动重试与恢复记录 {filter === null ? "▸" : "▾"}</span>
    </button>
    {filter !== null && <HistoryEntries docId={docId} segmentIndices={segmentIndices} filter={filter} onFilterChange={onFilterChange} />}
  </section>;
}

function HistoryEntries({ docId, segmentIndices, filter, onFilterChange }: {
  docId: string;
  segmentIndices: number[];
  filter: Exclude<GenerationHistoryFilter, null>;
  onFilterChange: (filter: GenerationHistoryFilter) => void;
}) {
  const [history, setHistory] = useState<GenerationHistoryState>({ events: [], loaded: false });
  const historyRef = useRef(history);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState<"latest" | "older" | null>(null);
  const [error, setError] = useState<{ mode: "latest" | "older"; message: string } | null>(null);

  const load = useCallback(async (mode: "latest" | "older", quiet = false) => {
    if (!alive.current || request.current) return;
    const before = mode === "older" ? historyRef.current.nextCursor : undefined;
    if (mode === "older" && before === undefined) return;
    const controller = new AbortController();
    request.current = controller;
    if (!quiet) setLoading(mode);
    try {
      const page = await api.generationEvents(docId, before, controller.signal);
      if (!alive.current || request.current !== controller) return;
      const next = mergeGenerationEvents(historyRef.current, page, mode);
      historyRef.current = next;
      setHistory(next);
      setError((current) => current?.mode === mode ? null : current);
    } catch (e) {
      if (alive.current && request.current === controller && !controller.signal.aborted) {
        setError({ mode, message: `读取生成日志失败：${(e as Error).message}` });
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (alive.current) setLoading(null);
      }
    }
  }, [docId]);

  // 日志展开后才订阅读请求；关闭只取消读取，不会影响服务端生成。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    alive.current = true;
    void load("latest");
    const timer = setInterval(() => void load("latest", true), 4_000);
    return () => {
      alive.current = false;
      clearInterval(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
    <p className="text-xs text-zinc-500">日志保存在服务器，生成成功或重新打开记录后仍可查看。仅在展开时自动更新。</p>
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
