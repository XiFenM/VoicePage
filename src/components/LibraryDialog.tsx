"use client";

import { useEffect, useId, useRef, useState } from "react";

/** 页面内对话框：使用 HTML dialog，不依赖嵌入浏览器可能禁用的 prompt/confirm。 */
export function LibraryDialog({ title, description, nameLabel, initialName = "", submitLabel, destructive = false, onSubmit, onClose }: {
  title: string;
  description?: string;
  nameLabel?: string;
  initialName?: string;
  submitLabel: string;
  destructive?: boolean;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    const value = name.trim();
    if (nameLabel && (!value || value.length > 200)) {
      setError("请输入 1–200 个字符的名称。");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try { await onSubmit(value); onClose(); }
    catch (e) { setError((e as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  }

  return (
    <dialog ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined}
      onCancel={(event) => { event.preventDefault(); if (!submitting.current) onClose(); }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
      <form onSubmit={submit} className="space-y-4 p-5">
        <h2 id={`${id}-title`} className="text-lg font-semibold">{title}</h2>
        {description && <p id={`${id}-description`} className="break-words text-sm leading-6 text-zinc-600 dark:text-zinc-400">{description}</p>}
        {nameLabel && <label htmlFor={`${id}-name`} className="block space-y-2 text-sm">
          <span>{nameLabel}</span>
          <input id={`${id}-name`} type="text" autoFocus required maxLength={200} value={name} disabled={busy}
            onChange={(event) => { setName(event.target.value); setError(""); }}
            className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 disabled:opacity-50 dark:border-zinc-700" />
          <span className="block text-xs text-zinc-500">最多 200 个字符，首尾空格会自动去除。</span>
        </label>}
        {error && <p role="alert" className="break-all text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-3 text-sm">
          <button type="button" autoFocus={!nameLabel} disabled={busy} onClick={onClose} className="rounded-lg border border-zinc-300 px-3 py-2 disabled:opacity-40 dark:border-zinc-700">取消</button>
          <button type="submit" disabled={busy || (!!nameLabel && !name.trim())}
            className={`rounded-lg px-3 py-2 text-white disabled:opacity-40 ${destructive ? "bg-red-600" : "bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900"}`}>
            {busy ? "处理中…" : submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
