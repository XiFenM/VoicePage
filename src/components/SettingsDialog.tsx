"use client";

import { useEffect, useId, useRef, useState } from "react";
import { RuntimeSettingsPanel } from "./RuntimeSettingsPanel";
import { BackupSettings } from "./BackupSettings";

const SECTIONS = [
  { id: "generation", label: "生成与并发", detail: "后台任务与模型请求" },
  { id: "data", label: "数据与备份", detail: "导出、导入与迁移" },
] as const;

/** 统一设置界面。阅读器保持挂载，分类切换也保留尚未保存的设置输入。 */
export function SettingsDialog({ hasData, onChanged, onClose }: {
  hasData: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<(typeof SECTIONS)[number]["id"]>("generation");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  function close() {
    if (busy) return;
    dialog.current?.close();
    onClose();
  }

  return (
    <dialog ref={dialog} aria-modal="true" aria-labelledby={`${id}-title`}
      onCancel={(event) => { event.preventDefault(); close(); }}
      className="m-auto h-dvh max-h-none w-screen max-w-none border-0 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-black/40 sm:h-[min(42rem,calc(100dvh-3rem))] sm:w-[min(58rem,calc(100vw-3rem))] sm:rounded-2xl sm:border sm:border-zinc-200 dark:bg-zinc-950 dark:text-zinc-100 dark:sm:border-zinc-800">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <h2 id={`${id}-title`} className="text-xl font-semibold">设置</h2>
          <button type="button" aria-label="关闭设置" title="关闭设置" disabled={busy} onClick={close}
            className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-900">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav aria-label="设置分类" className="flex shrink-0 gap-1 border-b border-zinc-200 bg-zinc-50 p-3 sm:w-48 sm:flex-col sm:border-r sm:border-b-0 dark:border-zinc-800 dark:bg-zinc-900/40">
            {SECTIONS.map((item) => <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined}
              aria-controls={`${id}-${item.id}`} disabled={busy} onClick={() => setSection(item.id)}
              className={`flex-1 rounded-lg px-3 py-2.5 text-left text-sm disabled:opacity-40 sm:flex-none ${section === item.id ? "bg-zinc-200/70 font-medium dark:bg-zinc-800" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800/60"}`}>
              <span className="block">{item.label}</span><span className="mt-1 hidden text-xs font-normal text-zinc-500 sm:block">{item.detail}</span>
            </button>)}
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-7">
            <div id={`${id}-generation`} hidden={section !== "generation"}><RuntimeSettingsPanel onBusyChange={setBusy} /></div>
            <div id={`${id}-data`} hidden={section !== "data"}><BackupSettings hasData={hasData} onChanged={onChanged} onBusyChange={setBusy} /></div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
