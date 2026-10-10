"use client";

import { useRef, useState } from "react";
import { getTtsModel } from "@/lib/catalog";
import type { DocSummary } from "@/lib/store/types";
import { api } from "./api";
import { backgroundPercent, backgroundStatusText, documentProgress, isBackgroundActive } from "./background-progress";

export function HistorySidebar(props: {
  docs: DocSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onChanged: () => void; // 列表需要刷新
  onDeleted: (id: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function onImport(file: File) {
    setBusy(true);
    setMsg("导入中…");
    try {
      const r = await api.importBackup(file, overwrite ? "overwrite" : "skip");
      setMsg(
        `导入完成：新增 ${r.imported} 条` +
          (r.overwritten ? `，覆盖 ${r.overwritten} 条` : "") +
          (r.skipped ? `，跳过已存在 ${r.skipped} 条` : "") +
          `，音频 ${r.audioFiles} 个`,
      );
      props.onChanged();
    } catch (e) {
      setMsg(`导入失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function rename(d: DocSummary) {
    const title = prompt("重命名", d.title)?.trim();
    if (!title || title === d.title) return;
    try {
      await api.update(d.id, { title });
      props.onChanged();
    } catch (e) { setMsg(`改名失败：${(e as Error).message}`); }
  }

  async function remove(d: DocSummary) {
    if (!confirm(`删除「${d.title}」？口述稿和音频都会被删除。`)) return;
    try {
      await api.remove(d.id);
      props.onDeleted(d.id);
    } catch (e) { setMsg(`删除失败：${(e as Error).message}`); }
  }

  return (
    <aside className="flex w-full shrink-0 flex-col gap-3 md:sticky md:top-4 md:h-[calc(100vh-2rem)] md:w-64">
      <button
        onClick={props.onNew}
        className="rounded-lg border border-dashed border-zinc-300 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        + 新建
      </button>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {props.docs.length === 0 && <p className="px-2 text-sm text-zinc-400">还没有记录</p>}
        {props.docs.map((d) => (
          <div
            key={d.id}
            onClick={() => props.onSelect(d.id)}
            className={`group cursor-pointer rounded-lg px-2 py-1.5 text-sm ${
              props.activeId === d.id ? "bg-zinc-200 dark:bg-zinc-800" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
            }`}
          >
            <div className="truncate font-medium" title={d.title}>
              {d.title}
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span>{fmtTime(d.updatedAt)}</span>
              <span title={`${getTtsModel(d.ttsModelId).label} · ${d.voice}`}>
                🔊 {d.audioCount}/{d.segmentCount}
              </span>
              <span className="ml-auto hidden gap-2 group-hover:flex">
                <button
                  className="hover:text-zinc-900 dark:hover:text-zinc-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    void rename(d);
                  }}
                >
                  改名
                </button>
                <button
                  className="hover:text-red-500"
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(d);
                  }}
                >
                  删除
                </button>
              </span>
            </div>
            <HistoryProgress doc={d} />
          </div>
        ))}
      </div>

      {/* 备份 */}
      <div className="space-y-2 rounded-lg border border-zinc-200 p-2 text-sm dark:border-zinc-800">
        <div className="font-medium">备份与迁移</div>
        <div className="flex gap-2">
          <a
            href="/api/backup"
            download
            className={`flex-1 rounded-md bg-zinc-100 py-1 text-center hover:bg-zinc-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 ${
              props.docs.length ? "" : "pointer-events-none opacity-40"
            }`}
          >
            导出全部
          </a>
          <button
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="flex-1 rounded-md bg-zinc-100 py-1 hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            导入
          </button>
        </div>
        <label className="flex items-center gap-1 text-xs text-zinc-500" title="默认跳过已存在的记录；勾选后用备份中的版本覆盖">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          导入时覆盖已存在的记录
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && void onImport(e.target.files[0])}
        />
        {msg && <p className="text-xs break-all text-zinc-500">{msg}</p>}
      </div>
    </aside>
  );
}

function HistoryProgress({ doc }: { doc: DocSummary }) {
  const progress = documentProgress(doc);
  const active = isBackgroundActive(progress);
  const failed = progress.status === "failed";
  const percent = backgroundPercent(progress);
  return (
    <div className={`mt-1.5 space-y-1 text-xs ${failed ? "text-red-600 dark:text-red-400" : active ? "text-blue-600 dark:text-blue-400" : "text-zinc-500"}`}>
      <div className="flex items-center justify-between gap-1">
        <span>{backgroundStatusText(progress)}</span>
        {progress.scriptReady && progress.status !== "running" && <span>{progress.completedSegments}/{progress.totalSegments}</span>}
      </div>
      <div role="progressbar" aria-label={`${doc.title}生成进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div className={`h-full transition-[width] ${failed ? "bg-red-500" : "bg-blue-500"}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
