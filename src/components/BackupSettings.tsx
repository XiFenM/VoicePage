"use client";

import { useRef, useState } from "react";
import { api } from "./api";

export function BackupSettings({ hasData, onChanged, onBusyChange }: {
  hasData: boolean;
  onChanged: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onImport(file: File) {
    setBusy(true);
    onBusyChange(true);
    setMessage("正在导入备份…");
    setError("");
    try {
      const result = await api.importBackup(file, overwrite ? "overwrite" : "skip");
      setMessage(`导入完成：新增记录 ${result.imported} 条${result.overwritten ? `，覆盖记录 ${result.overwritten} 条` : ""}${result.skipped ? `，跳过已有记录 ${result.skipped} 条` : ""}，音频 ${result.audioFiles} 个。备份中的 Group、Session 也已处理，不计入记录数量。`);
      onChanged();
    } catch (error) {
      setMessage("");
      setError(`导入失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
      onBusyChange(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold">数据与备份</h3>
        <p className="mt-1 text-sm text-zinc-500">导出记录与音频，或从备份迁移到当前应用。</p>
      </div>
      <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <h4 className="font-medium">导出全部数据</h4>
        <p className="mt-1 text-sm leading-6 text-zinc-500">备份包含 Group、Session、排列顺序、原文、口述稿和已生成的音频。</p>
        <a href="/api/backup" download aria-disabled={!hasData || busy} tabIndex={!hasData || busy ? -1 : 0}
          className={`mt-3 inline-flex rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900 ${!hasData || busy ? "pointer-events-none opacity-40" : ""}`}>导出备份</a>
        {!hasData && <p className="mt-2 text-xs text-zinc-400">创建记录或分组后即可导出。</p>}
      </div>
      <div className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <div>
          <h4 className="font-medium">导入备份</h4>
          <p className="mt-1 text-sm leading-6 text-zinc-500">选择应用导出的 ZIP 文件。默认保留已有记录和分组；未完成的任务导入后会暂停，可手动继续生成。</p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={overwrite} disabled={busy} onChange={(event) => setOverwrite(event.target.checked)} className="mt-1" />
          <span>覆盖已有记录及组织信息<span className="mt-1 block text-xs text-zinc-500">勾选后，会替换同一条记录的内容和音频，以及已有 Group、Session 的名称、层级和顺序。</span></span>
        </label>
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
          className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">{busy ? "正在导入…" : "选择备份文件"}</button>
        <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden" onChange={(event) => event.target.files?.[0] && void onImport(event.target.files[0])} />
      </div>
      {message && <p role="status" className="break-all text-sm text-green-700 dark:text-green-400">{message}</p>}
      {error && <p role="alert" className="break-all text-sm text-red-600">{error}</p>}
    </section>
  );
}
