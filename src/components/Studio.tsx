"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PERSONAS, TTS_MODELS, getTtsModel, stripTags } from "@/lib/catalog";
import type { ScriptResult, ScriptSegment } from "@/lib/script/types";

type AudioState = { status: "idle" | "loading" | "ready" | "error"; url?: string; error?: string };

const TTS_CONCURRENCY = 2;

export function Studio() {
  const router = useRouter();
  // ---------- 设置 ----------
  const [text, setText] = useState("");
  const [personaId, setPersonaId] = useState(PERSONAS[0].id);
  const [modelId, setModelId] = useState(TTS_MODELS[0].id);
  const [voice, setVoice] = useState(TTS_MODELS[0].defaultVoice);
  const [useTags, setUseTags] = useState(true);
  const model = getTtsModel(modelId);

  // ---------- 结果 ----------
  const [script, setScript] = useState<ScriptResult | null>(null);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [error, setError] = useState("");
  const [audios, setAudios] = useState<AudioState[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [showScript, setShowScript] = useState(true);

  const audioRef = useRef<HTMLAudioElement>(null);
  const audiosRef = useRef<AudioState[]>([]);
  audiosRef.current = audios;
  const genIdRef = useRef(0); // 每次生成的代号，用于丢弃过期请求
  const blockRefs = useRef<(HTMLDivElement | null)[]>([]);

  function changeModel(id: string) {
    setModelId(id);
    setVoice(getTtsModel(id).defaultVoice);
  }

  const patchAudio = (i: number, s: AudioState) =>
    setAudios((prev) => {
      const next = [...prev];
      if (next[i]?.url && next[i].url !== s.url) URL.revokeObjectURL(next[i].url!);
      next[i] = s;
      return next;
    });

  const fetchAudio = useCallback(
    async (seg: ScriptSegment, genId: number) => {
      patchAudio(seg.id, { status: "loading" });
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: seg.tagged || seg.speech, modelId, voice, personaId }),
        });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
        const blob = await res.blob();
        if (genId !== genIdRef.current) return;
        patchAudio(seg.id, { status: "ready", url: URL.createObjectURL(blob) });
      } catch (e) {
        if (genId !== genIdRef.current) return;
        patchAudio(seg.id, { status: "error", error: (e as Error).message });
      }
    },
    [modelId, voice, personaId],
  );

  /** 按顺序、限并发地为所有段生成音频（前面的段优先，便于尽早开始播放） */
  const synthesizeAll = useCallback(
    async (segments: ScriptSegment[], genId: number) => {
      let next = 0;
      const worker = async () => {
        while (next < segments.length && genId === genIdRef.current) {
          const seg = segments[next++];
          if (seg.speech.trim()) await fetchAudio(seg, genId);
          else patchAudio(seg.id, { status: "error", error: "空口述稿" });
        }
      };
      await Promise.all(Array.from({ length: TTS_CONCURRENCY }, worker));
    },
    [fetchAudio],
  );

  async function generate() {
    const genId = ++genIdRef.current;
    audioRef.current?.pause();
    audiosRef.current.forEach((a) => a.url && URL.revokeObjectURL(a.url));
    setAudios([]);
    setScript(null);
    setCurrent(null);
    setError("");
    setScriptLoading(true);
    try {
      const res = await fetch("/api/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, personaId, ttsModelId: modelId, useTags }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      if (genId !== genIdRef.current) return;
      const result = data as ScriptResult;
      setScript(result);
      setAudios(result.segments.map(() => ({ status: "idle" })));
      setScriptLoading(false);
      setCurrent(0);
      void synthesizeAll(result.segments, genId);
    } catch (e) {
      setError((e as Error).message);
      setScriptLoading(false);
    }
  }

  // ---------- 播放控制 ----------
  // 当前段音频就绪且处于播放状态时自动播放
  const currentUrl = current !== null ? audios[current]?.url : undefined;
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !currentUrl) return;
    if (el.src !== currentUrl) el.src = currentUrl;
    if (playing) el.play().catch(() => setPlaying(false));
  }, [currentUrl, playing]);

  // 当前段出错时跳过
  useEffect(() => {
    if (playing && current !== null && audios[current]?.status === "error") goNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audios, current, playing]);

  // 高亮块滚动到视野中
  useEffect(() => {
    if (current !== null) blockRefs.current[current]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [current]);

  function goNext() {
    if (!script || current === null) return;
    if (current + 1 < script.segments.length) setCurrent(current + 1);
    else {
      setPlaying(false);
      setCurrent(0);
    }
  }

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      if (current === null) setCurrent(0);
      setPlaying(true);
    }
  }

  function jumpTo(i: number) {
    audioRef.current?.pause();
    setCurrent(i);
    setPlaying(true);
  }

  function editSegment(i: number, tagged: string) {
    if (!script) return;
    const segments = script.segments.map((s) => (s.id === i ? { ...s, tagged, speech: stripTags(tagged) } : s));
    setScript({ ...script, segments });
  }

  const readyCount = audios.filter((a) => a.status === "ready").length;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 md:p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">ReadAloud · 边听边读</h1>
        <button
          className="text-sm text-zinc-500 hover:underline"
          onClick={async () => {
            await fetch("/api/logout", { method: "POST" });
            router.replace("/login");
          }}
        >
          退出
        </button>
      </header>

      {/* 输入与设置 */}
      <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="粘贴 AI 的回复（支持 Markdown、代码块、表格、mermaid 等）"
          className="h-48 w-full resize-y rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-sm dark:border-zinc-700"
        />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Select label="讲述角色" value={personaId} onChange={setPersonaId} options={PERSONAS.map((p) => [p.id, p.label])} />
          <Select label="TTS 模型" value={modelId} onChange={changeModel} options={TTS_MODELS.map((m) => [m.id, m.label])} />
          <Select label="音色" value={voice} onChange={setVoice} options={model.voices.map((v) => [v.id, v.label])} />
          <label className={`flex items-center gap-1 ${model.tagStyle === "none" ? "opacity-40" : ""}`}>
            <input
              type="checkbox"
              checked={useTags && model.tagStyle !== "none"}
              disabled={model.tagStyle === "none"}
              onChange={(e) => setUseTags(e.target.checked)}
            />
            语气标签{model.tagStyle === "none" && "（该模型不支持）"}
          </label>
          <button
            onClick={generate}
            disabled={!text.trim() || scriptLoading}
            className="ml-auto rounded-lg bg-zinc-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {scriptLoading ? "正在生成口述稿…" : "生成语音"}
          </button>
        </div>
        {error && <p className="text-sm break-all text-red-500">{error}</p>}
      </section>

      {/* 阅读 + 播放 */}
      {script && (
        <section className="flex flex-col gap-3">
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white/90 p-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
            <button onClick={togglePlay} className="rounded-full bg-zinc-900 px-4 py-1.5 text-white dark:bg-zinc-100 dark:text-zinc-900">
              {playing ? "暂停" : "播放"}
            </button>
            <button onClick={goNext} className="text-sm text-zinc-500 hover:underline">
              下一段
            </button>
            <span className="text-sm text-zinc-500">
              第 {(current ?? 0) + 1}/{script.segments.length} 段 · 音频就绪 {readyCount}/{script.segments.length}
              {playing && current !== null && audios[current]?.status === "loading" && " · 缓冲中…"}
            </span>
            <label className="ml-auto flex items-center gap-1 text-sm">
              <input type="checkbox" checked={showScript} onChange={(e) => setShowScript(e.target.checked)} />
              显示口述稿
            </label>
            <audio ref={audioRef} onEnded={goNext} className="hidden" />
          </div>

          <div className="space-y-2">
            {script.blocks.map((b, i) => {
              const seg = script.segments[i];
              const a = audios[i];
              const active = current === i;
              return (
                <div
                  key={b.id}
                  ref={(el) => {
                    blockRefs.current[i] = el;
                  }}
                  className={`grid gap-3 rounded-xl border p-3 transition-colors ${showScript ? "md:grid-cols-[3fr_2fr]" : ""} ${
                    active
                      ? "border-amber-400 bg-amber-50 dark:border-amber-500/60 dark:bg-amber-500/10"
                      : "border-transparent hover:border-zinc-200 dark:hover:border-zinc-800"
                  }`}
                >
                  <div className="md min-w-0 cursor-pointer" onClick={() => jumpTo(i)} title="从这里开始播放">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{b.markdown}</ReactMarkdown>
                  </div>
                  {showScript && seg && (
                    <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="rounded bg-zinc-200 px-1.5 dark:bg-zinc-800">{b.kind}</span>
                        <AudioBadge state={a} />
                        {a?.status === "error" || a?.status === "ready" ? (
                          <button
                            className="text-blue-600 hover:underline"
                            onClick={() => void fetchAudio(script.segments[i], genIdRef.current)}
                          >
                            重新合成
                          </button>
                        ) : null}
                      </div>
                      <textarea
                        value={seg.tagged}
                        onChange={(e) => editSegment(i, e.target.value)}
                        className="min-h-20 w-full resize-y rounded-md border border-zinc-200 bg-transparent p-2 leading-6 dark:border-zinc-800"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function Select(props: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-zinc-500">{props.label}</span>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
      >
        {props.options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function AudioBadge({ state }: { state?: AudioState }) {
  if (!state || state.status === "idle") return <span className="text-zinc-400">等待合成</span>;
  if (state.status === "loading") return <span className="text-blue-500">合成中…</span>;
  if (state.status === "ready") return <span className="text-green-600">✓ 已就绪</span>;
  return (
    <span className="text-red-500" title={state.error}>
      合成失败
    </span>
  );
}
