"use client";

import { useState } from "react";
import type { GenerationSettings } from "@/lib/generation-settings";
import { LibraryTree, type LibraryTreeProps } from "./LibraryTree";
import { SettingsDialog } from "./SettingsDialog";

type HistorySidebarProps = LibraryTreeProps & {
  historyLoaded: boolean;
  historyLoading: boolean;
  historyError: string;
  onRetryHistory: () => void;
  onGenerationSettingsChanged: (settings: GenerationSettings) => void;
};

export function HistorySidebar(props: HistorySidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <aside className="flex w-full shrink-0 flex-col gap-3 md:sticky md:top-4 md:h-[calc(100vh-2rem)] md:w-72">
      <button onClick={() => props.onNew()} className="rounded-lg border border-dashed border-zinc-300 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">+ 新建回复</button>
      {props.historyLoaded ? <>
        {props.historyError && <div className="space-y-1 rounded-lg border border-amber-200 p-2 text-xs text-amber-800 dark:border-amber-900 dark:text-amber-300">
          <p>记录暂时无法更新，仍显示上次加载的内容。</p>
          <p className="break-all">{props.historyError}</p>
          <button type="button" disabled={props.historyLoading} onClick={props.onRetryHistory} className="underline disabled:opacity-40">重试更新</button>
        </div>}
        <LibraryTree {...props} />
      </> : <div className="min-h-0 flex-1 space-y-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
        <h2 className="font-medium">历史记录</h2>
        {props.historyError ? <>
          <p className="text-red-600 dark:text-red-400">历史记录加载失败。</p>
          <p className="break-all text-xs text-zinc-500">{props.historyError}</p>
          <button type="button" disabled={props.historyLoading} onClick={props.onRetryHistory} className="text-blue-600 underline disabled:opacity-40">重试加载</button>
        </> : <p className="text-zinc-500">正在加载历史记录…</p>}
      </div>}
      <div className="mt-auto shrink-0 md:border-t md:border-zinc-200 md:pt-3 dark:md:border-zinc-800">
        <button type="button" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-30 inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600 shadow-md hover:bg-zinc-100 md:static md:border-transparent md:shadow-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:md:border-transparent">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9.5 3-.7 2.2-2 .9-2.1-.5-2.5 4.3 1.5 1.7v2.2l-1.5 1.7 2.5 4.3 2.1-.5 2 .9.7 2.2h5l.7-2.2 2-.9 2.1.5 2.5-4.3-1.5-1.7v-2.2l1.5-1.7-2.5-4.3-2.1.5-2-.9-.7-2.2z" />
            <circle cx="12" cy="12.7" r="3" />
          </svg>
          设置
        </button>
      </div>
      {settingsOpen && <SettingsDialog hasData={Boolean(props.library.documents.length || props.library.collections.length)} onChanged={props.onChanged}
        onGenerationSettingsChanged={props.onGenerationSettingsChanged} onClose={() => setSettingsOpen(false)} />}
    </aside>
  );
}
