"use client";

import { useEffect, useState } from "react";
import { DEFAULT_RUNTIME_SETTINGS, RUNTIME_SETTING_LIMITS, validateRuntimeSettings, type RuntimeSettings } from "@/lib/runtime-settings";
import { api } from "./api";

const FIELDS: { key: keyof RuntimeSettings; label: string; detail: string }[] = [
  { key: "taskConcurrency", label: "同时推进的记录数", detail: "全站最多同时处理多少篇 AI 回复。" },
  { key: "textConcurrency", label: "文本模型请求数", detail: "口述稿改写和语气标签共用的全站上限，所有文本模型合计。" },
  { key: "ttsConcurrency", label: "语音模型请求数", detail: "所有 TTS 模型合计的全站请求上限。" },
  { key: "segmentConcurrency", label: "每篇同时处理的段数", detail: "单篇记录内可同时添加标签或生成语音的段数。" },
];
const toDraft = (settings: RuntimeSettings) => Object.fromEntries(FIELDS.map(({ key }) => [key, String(settings[key])])) as Record<keyof RuntimeSettings, string>;

export function RuntimeSettingsPanel({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(true);
  const [draft, setDraft] = useState(() => toDraft(DEFAULT_RUNTIME_SETTINGS));
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void api.runtimeSettings().then((settings) => {
      if (active) { setDraft(toDraft(settings)); setLoaded(true); }
    }).catch((error: Error) => {
      if (active) setError(`读取设置失败：${error.message}`);
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  async function load() {
    setBusy(true);
    setError("");
    setMessage("");
    try { setDraft(toDraft(await api.runtimeSettings())); setLoaded(true); }
    catch (e) { setError(`读取设置失败：${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    const settings = Object.fromEntries(FIELDS.map(({ key }) => [key, Number(draft[key])])) as unknown as RuntimeSettings;
    try { validateRuntimeSettings(settings); }
    catch (e) { setError((e as Error).message); return; }
    setBusy(true);
    onBusyChange(true);
    try {
      setDraft(toDraft(await api.saveRuntimeSettings(settings)));
      setMessage("已保存到服务器，对后续调度生效。");
    } catch (e) { setError(`保存失败：${(e as Error).message}`); }
    finally { setBusy(false); onBusyChange(false); }
  }

  return (
    <section className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold">生成与并发</h3>
        <p className="mt-1 text-sm text-zinc-500">管理后台任务和模型请求的处理数量。</p>
      </div>
      <div className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">这些数值都是上限，实际并行数量受各项共同约束。前三项适用于全站，所有 Session 和模型共享；最后一项适用于每篇记录。</p>
        {loaded ? <form onSubmit={save} className="space-y-4">
          <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2 disabled:opacity-60">
            {FIELDS.map(({ key, label, detail }) => <label key={key} className="space-y-1 text-sm">
              <span className="flex items-center justify-between gap-2"><span>{label}</span>
                <input type="number" required min={RUNTIME_SETTING_LIMITS[key].min} max={RUNTIME_SETTING_LIMITS[key].max} step={1} value={draft[key]}
                  onChange={(event) => { setDraft((current) => ({ ...current, [key]: event.target.value })); setMessage(""); }}
                  className="w-20 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700" />
              </span>
              <span className="block text-xs text-zinc-500">{detail} 范围 {RUNTIME_SETTING_LIMITS[key].min}–{RUNTIME_SETTING_LIMITS[key].max}。</span>
            </label>)}
          </fieldset>
          <p className="text-xs text-zinc-500">调小不会中断已经发出的请求，会等待数量自然回落；调大后立即用于新调度。设置保存在服务器，换浏览器后仍有效。</p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <button type="submit" disabled={busy} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">{busy ? "处理中…" : "保存设置"}</button>
            <button type="button" disabled={busy} onClick={() => { setDraft(toDraft(DEFAULT_RUNTIME_SETTINGS)); setMessage("默认值已填入，保存后生效。"); }} className="text-zinc-500 hover:underline disabled:opacity-40">填入默认值</button>
            <button type="button" disabled={busy} onClick={() => void load()} className="text-zinc-500 hover:underline disabled:opacity-40">重新读取</button>
          </div>
        </form> : <button disabled={busy} onClick={() => void load()} className="text-sm text-blue-600 underline disabled:opacity-50">{busy ? "正在读取设置…" : "重试读取"}</button>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {message && <p role="status" className="text-sm text-green-700 dark:text-green-400">{message}</p>}
      </div>
    </section>
  );
}
