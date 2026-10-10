"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DocSettings, StoredDocument, StoredSegment } from "@/lib/store/types";
import { api } from "./api";
import { SettingsBar } from "./SettingsBar";

type SegStatus = "idle" | "loading" | "error";

const TTS_CONCURRENCY = 2;
const SAVE_DEBOUNCE_MS = 800;

/** 打开一条记录：边听边读、编辑口述稿、合成/重新合成音频。所有改动都会保存到服务端 */
export function Reader(props: { doc: StoredDocument; onDocChanged: () => void }) {
  const docId = props.doc.id;
  const [doc, setDoc] = useState(props.doc);
  const [status, setStatus] = useState<Record<number, { s: SegStatus; error?: string }>>({});
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showScript, setShowScript] = useState(true);
  const [rate, setRate] = useState(1);
  const [saving, setSaving] = useState<"saved" | "saving" | "error">("saved");

  const audioRef = useRef<HTMLAudioElement>(null);
  const blockRefs = useRef<(HTMLDivElement | null)[]>([]);
  const queueRef = useRef<{ idxs: number[]; running: number; force: boolean }>({ idxs: [], running: 0, force: false });
  const saveTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  /** 尚未写入服务端的修改：idx -> tagged */
  const unsaved = useRef<Record<number, string>>({});
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const timers = saveTimers.current;
    const pending = unsaved.current;
    // 切换记录 / 关闭页面时，把未保存的修改立即写出（keepalive 保证页面关闭时请求也能发出）
    const flushAll = () => {
      for (const [idx, tagged] of Object.entries(pending)) {
        clearTimeout(timers[Number(idx)]);
        void fetch(`/api/documents/${docId}/segments/${idx}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tagged }),
          keepalive: true,
        });
        delete pending[Number(idx)];
      }
    };
    window.addEventListener("pagehide", flushAll);
    return () => {
      aliveRef.current = false;
      window.removeEventListener("pagehide", flushAll);
      flushAll();
    };
  }, [docId]);

  const segs = doc.segments;
  const setSeg = (idx: number, patch: Partial<StoredSegment>) =>
    setDoc((d) => ({ ...d, segments: d.segments.map((s) => (s.idx === idx ? { ...s, ...patch } : s)) }));
  const setSegStatus = (idx: number, s: SegStatus, error?: string) =>
    setStatus((m) => ({ ...m, [idx]: { s, error } }));

  // ---------------- 合成队列 ----------------
  const pump = useCallback(() => {
    const q = queueRef.current;
    while (q.running < TTS_CONCURRENCY && q.idxs.length) {
      const idx = q.idxs.shift()!;
      q.running++;
      setSegStatus(idx, "loading");
      api
        .synthesize(docId, idx, q.force)
        .then((seg) => {
          if (!aliveRef.current) return;
          setSeg(idx, { audioUrl: seg.audioUrl, audioFresh: seg.audioFresh });
          setSegStatus(idx, "idle");
        })
        .catch((e: Error) => aliveRef.current && setSegStatus(idx, "error", e.message))
        .finally(() => {
          q.running--;
          if (aliveRef.current) {
            if (!q.idxs.length && !q.running) props.onDocChanged();
            pump();
          }
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const enqueue = useCallback(
    (idxs: number[], force = false) => {
      const q = queueRef.current;
      q.force = force;
      for (const i of idxs) if (!q.idxs.includes(i)) q.idxs.push(i);
      pump();
    },
    [pump],
  );

  /** 需要（重新）合成的段：无音频或音频已过期 */
  const pendingIdxs = segs.filter((s) => s.tagged.trim() && (!s.audioUrl || !s.audioFresh)).map((s) => s.idx);

  // 首次打开：自动补齐缺失/过期的音频（例如新建后、或上次中途关掉）
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    const missing = segs.filter((s) => s.tagged.trim() && !s.audioUrl).map((s) => s.idx);
    if (missing.length) enqueue(missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- 设置变更 ----------------
  async function changeSettings(patch: Partial<DocSettings>) {
    setDoc((d) => ({ ...d, ...patch }));
    try {
      const updated = await api.update(docId, patch);
      setDoc((d) => ({ ...updated, segments: updated.segments.map((s, i) => ({ ...s, tagged: d.segments[i]?.tagged ?? s.tagged })) }));
      props.onDocChanged();
    } catch (e) {
      alert(`保存设置失败：${(e as Error).message}`);
    }
  }

  // ---------------- 编辑口述稿（自动保存） ----------------
  function editSegment(idx: number, tagged: string) {
    setSeg(idx, { tagged, audioFresh: false });
    setSaving("saving");
    unsaved.current[idx] = tagged;
    clearTimeout(saveTimers.current[idx]);
    saveTimers.current[idx] = setTimeout(async () => {
      try {
        await api.saveSegment(docId, idx, tagged);
        if (unsaved.current[idx] === tagged) delete unsaved.current[idx];
        delete saveTimers.current[idx];
        if (!Object.keys(saveTimers.current).length) setSaving("saved");
      } catch {
        setSaving("error");
      }
    }, SAVE_DEBOUNCE_MS);
  }

  /** 合成前确保该段的修改已写入服务端 */
  async function flushSave(idx: number) {
    if (unsaved.current[idx] === undefined) return;
    clearTimeout(saveTimers.current[idx]);
    delete saveTimers.current[idx];
    const tagged = unsaved.current[idx];
    await api.saveSegment(docId, idx, tagged);
    if (unsaved.current[idx] === tagged) delete unsaved.current[idx];
    if (!Object.keys(saveTimers.current).length) setSaving("saved");
  }

  async function resynth(idxs: number[], force = false) {
    await Promise.all(idxs.map(flushSave));
    enqueue(idxs, force);
  }

  // ---------------- 播放 ----------------
  const cur = segs[current];
  const curUrl = cur?.audioUrl;
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !curUrl) return;
    if (!el.src.endsWith(curUrl)) el.src = curUrl;
    el.playbackRate = rate;
    if (playing) el.play().catch(() => setPlaying(false));
  }, [curUrl, playing, rate]);

  // 播放到没有音频的段：若该段合成失败或口述稿为空则跳过，否则等待合成
  useEffect(() => {
    if (!playing || !cur) return;
    if (!cur.tagged.trim() || status[cur.idx]?.s === "error") goNext();
    else if (!cur.audioUrl && status[cur.idx]?.s !== "loading") enqueue([cur.idx]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, current, cur?.audioUrl, status[cur?.idx ?? -1]?.s]);

  useEffect(() => {
    blockRefs.current[current]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [current]);

  function goNext() {
    if (current + 1 < segs.length) setCurrent(current + 1);
    else {
      setPlaying(false);
      setCurrent(0);
    }
  }

  function togglePlay() {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
    } else setPlaying(true);
  }

  function jumpTo(i: number) {
    audioRef.current?.pause();
    setCurrent(i);
    setPlaying(true);
  }

  const readyCount = segs.filter((s) => s.audioUrl).length;
  const loadingCount = Object.values(status).filter((x) => x.s === "loading").length;

  return (
    <section className="flex flex-col gap-3">
      <div className="space-y-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <SettingsBar value={doc} onChange={changeSettings} tagsLocked />
        {pendingIdxs.length > 0 && (
          <div className="flex items-center gap-2 text-sm text-amber-600">
            <span>
              {pendingIdxs.length} 段音频缺失或与当前口述稿/设置不一致
              {loadingCount > 0 && `（合成中 ${loadingCount}）`}
            </span>
            <button className="text-blue-600 hover:underline" onClick={() => void resynth(pendingIdxs)}>
              合成这些段
            </button>
          </div>
        )}
      </div>

      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white/90 p-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <button onClick={togglePlay} className="rounded-full bg-zinc-900 px-4 py-1.5 text-white dark:bg-zinc-100 dark:text-zinc-900">
          {playing ? "暂停" : "播放"}
        </button>
        <button onClick={goNext} className="text-sm text-zinc-500 hover:underline">
          下一段
        </button>
        <select
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
          className="rounded-md border border-zinc-300 bg-transparent px-1 py-0.5 text-sm dark:border-zinc-700"
          title="播放速度"
        >
          {[0.8, 1, 1.25, 1.5, 1.75, 2].map((r) => (
            <option key={r} value={r}>
              {r}x
            </option>
          ))}
        </select>
        <span className="text-sm text-zinc-500">
          第 {current + 1}/{segs.length} 段 · 音频 {readyCount}/{segs.length}
          {playing && cur && !cur.audioUrl && " · 缓冲中…"}
        </span>
        <span className="text-xs text-zinc-400">
          {saving === "saving" ? "保存中…" : saving === "error" ? <span className="text-red-500">保存失败</span> : "已保存"}
        </span>
        <label className="ml-auto flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showScript} onChange={(e) => setShowScript(e.target.checked)} />
          显示口述稿
        </label>
        <audio ref={audioRef} onEnded={goNext} className="hidden" />
      </div>

      <div className="space-y-2">
        {segs.map((seg, i) => {
          const st = status[seg.idx];
          const active = current === i;
          return (
            <div
              key={seg.idx}
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
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.markdown}</ReactMarkdown>
              </div>
              {showScript && (
                <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded bg-zinc-200 px-1.5 dark:bg-zinc-800">{seg.kind}</span>
                    <AudioBadge seg={seg} st={st} />
                    {st?.s !== "loading" && seg.tagged.trim() && (
                      <button className="text-blue-600 hover:underline" onClick={() => void resynth([seg.idx], true)}>
                        {seg.audioUrl ? "重新合成" : "合成"}
                      </button>
                    )}
                  </div>
                  <textarea
                    value={seg.tagged}
                    onChange={(e) => editSegment(seg.idx, e.target.value)}
                    className="min-h-20 w-full resize-y rounded-md border border-zinc-200 bg-transparent p-2 leading-6 dark:border-zinc-800"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AudioBadge({ seg, st }: { seg: StoredSegment; st?: { s: SegStatus; error?: string } }) {
  if (st?.s === "loading") return <span className="text-blue-500">合成中…</span>;
  if (st?.s === "error")
    return (
      <span className="text-red-500" title={st.error}>
        合成失败（悬停查看原因）
      </span>
    );
  if (!seg.audioUrl) return <span className="text-zinc-400">无音频</span>;
  if (!seg.audioFresh)
    return (
      <span className="text-amber-600" title="口述稿或 TTS 设置已修改，当前音频是旧版本">
        ⚠ 音频已过期
      </span>
    );
  return <span className="text-green-600">✓ 已保存</span>;
}
