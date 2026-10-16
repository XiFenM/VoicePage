"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_GENERATION_SETTINGS, type GenerationSettings } from "@/lib/generation-settings";
import { api } from "./api";

export function GenerationSettingsPanel({ onBusyChange, onSaved }: { onBusyChange: (busy: boolean) => void; onSaved: (settings: GenerationSettings) => void }) {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(DEFAULT_GENERATION_SETTINGS.previewBeforeGeneration);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    request.current = controller;
    void api.generationSettings(controller.signal).then((settings) => {
      if (!controller.signal.aborted) { setEnabled(settings.previewBeforeGeneration); setLoaded(true); }
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setError(`读取预览设置失败：${error.message}`);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; controller.abort(); request.current?.abort(); };
  }, []);

  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const settings = await api.generationSettings(controller.signal);
      if (!controller.signal.aborted) { setEnabled(settings.previewBeforeGeneration); setLoaded(true); }
    } catch (error) {
      if (!controller.signal.aborted) setError(`读取预览设置失败：${(error as Error).message}`);
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (loading || saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    onBusyChange(true);
    try {
      const settings = await api.saveGenerationSettings({ previewBeforeGeneration: enabled });
      if (alive.current) {
        setEnabled(settings.previewBeforeGeneration);
        setMessage("已保存到服务器，其他浏览器也会使用此设置。");
        onSaved(settings);
      }
    } catch (error) {
      if (alive.current) setError(`保存失败：${(error as Error).message}`);
    } finally {
      if (alive.current) { setSaving(false); onBusyChange(false); }
    }
  }

  return <section className="space-y-3 border-b border-zinc-200 pb-6 dark:border-zinc-800">
    <div>
      <h3 className="text-lg font-semibold">生成前预览</h3>
      <p className="mt-1 text-sm text-zinc-500">先检查分段和排版，确认后再生成语音。</p>
    </div>
    {loaded ? <form onSubmit={save} className="space-y-3">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={enabled} disabled={loading || saving} onChange={(event) => { setEnabled(event.target.checked); setMessage(""); }} className="mt-0.5" />
        <span>生成语音前先预览分段<span className="mt-1 block text-xs text-zinc-500">预览不会创建任务或调用模型；关闭后，点击生成会直接加入后台队列。</span></span>
      </label>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button type="submit" disabled={loading || saving} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">{saving ? "保存中…" : "保存预览设置"}</button>
        <button type="button" disabled={loading || saving} onClick={() => void load()} className="text-zinc-500 hover:underline disabled:opacity-40">{loading ? "正在读取…" : "重新读取"}</button>
      </div>
    </form> : <button type="button" disabled={loading} onClick={() => void load()} className="text-sm text-blue-600 underline disabled:opacity-50">{loading ? "正在读取预览设置…" : "重试读取"}</button>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {message && <p role="status" className="text-sm text-green-700 dark:text-green-400">{message}</p>}
  </section>;
}
