"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripTags } from "@/lib/catalog";
import type { DocSettings, StoredDocument, StoredSegment } from "@/lib/store/types";
import { api } from "./api";
import { SettingsBar } from "./SettingsBar";
import { GenerationProgress } from "./GenerationProgress";
import { GenerationError } from "./GenerationError";
import { GenerationHistory, type GenerationHistoryFilter } from "./GenerationHistory";
import { automaticRetryLabel, generationPhaseLabel, MAX_AUTOMATIC_RETRIES } from "./generation-history";
import { documentProgress, editedSinceSnapshot, mergeDocumentSnapshot } from "./background-progress";

const SAVE_DEBOUNCE_MS = 800;
const segmentBusy = (segment: StoredSegment) => segment.generation?.status === "queued" || segment.generation?.status === "running";

/** 浏览器只读取持久进度和发送明确的控制指令，后台生成与本组件的生命周期无关。 */
export function Reader({ doc: initialDoc, onDocChanged }: { doc: StoredDocument; onDocChanged: () => void }) {
  const docId = initialDoc.id;
  const [doc, setDoc] = useState(initialDoc);
  const docRef = useRef(initialDoc);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showScript, setShowScript] = useState(true);
  const [rate, setRate] = useState(1);
  const [saving, setSaving] = useState<"saved" | "saving" | "error">("saved");
  const [saveError, setSaveError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  const [playbackMessage, setPlaybackMessage] = useState("");
  const [historyFilter, setHistoryFilter] = useState<GenerationHistoryFilter>(null);
  const historyAnchor = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const blockRefs = useRef<(HTMLDivElement | null)[]>([]);
  const alive = useRef(true);
  const mutationLock = useRef(false);
  const snapshotEpoch = useRef(0);
  const saveTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const saveRequests = useRef<Record<number, Promise<void>>>({});
  const unsaved = useRef<Record<number, string>>({});
  const editRevisions = useRef<Record<number, number>>({});

  const updateDoc = useCallback((update: (currentDoc: StoredDocument) => StoredDocument) => {
    const next = update(docRef.current);
    docRef.current = next;
    if (alive.current) setDoc(next);
  }, []);

  const applySnapshot = useCallback((incoming: StoredDocument, editsAtRequest?: Readonly<Record<number, number>>) => {
    const protectedIndices = new Set([...Object.keys(unsaved.current), ...Object.keys(saveRequests.current)].map(Number));
    if (editsAtRequest) for (const idx of editedSinceSnapshot(editRevisions.current, editsAtRequest)) protectedIndices.add(idx);
    updateDoc((currentDoc) => mergeDocumentSnapshot(currentDoc, incoming, protectedIndices));
  }, [updateDoc]);

  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let reading = false;
    const timers = saveTimers.current;
    const drafts = unsaved.current;
    const poll = async () => {
      if (reading || stopped || mutationLock.current) return;
      reading = true;
      const epoch = snapshotEpoch.current;
      try {
        const incoming = await api.get(docId);
        if (!stopped && epoch === snapshotEpoch.current && !mutationLock.current) {
          applySnapshot(incoming);
          setPollError("");
        }
      } catch (e) {
        if (!stopped) setPollError(`暂时无法更新进度，正在自动重连。${(e as Error).message}`);
      } finally { reading = false; }
    };
    const flushOnLeave = () => {
      for (const [idx, tagged] of Object.entries(drafts)) {
        clearTimeout(timers[Number(idx)]);
        void fetch(`/api/documents/${docId}/segments/${idx}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tagged }), keepalive: true,
        }).catch(() => {});
        delete drafts[Number(idx)];
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2_000);
    window.addEventListener("pagehide", flushOnLeave);
    return () => {
      stopped = true;
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener("pagehide", flushOnLeave);
      flushOnLeave();
      // 不取消服务端任务；离开、刷新和关闭页面都不影响后台生成。
    };
  }, [docId, applySnapshot]);

  const flushSave = useCallback(async (idx: number) => {
    try {
      while (unsaved.current[idx] !== undefined || saveRequests.current[idx]) {
        clearTimeout(saveTimers.current[idx]);
        delete saveTimers.current[idx];
        const running = saveRequests.current[idx];
        if (running) { await running; continue; }
        const tagged = unsaved.current[idx];
        if (tagged === undefined) break;
        snapshotEpoch.current++;
        if (alive.current) setSaving("saving");
        const request = api.saveSegment(docId, idx, tagged).then(() => {
          if (unsaved.current[idx] === tagged) delete unsaved.current[idx];
        }).finally(() => {
          snapshotEpoch.current++;
          if (saveRequests.current[idx] === request) delete saveRequests.current[idx];
        });
        saveRequests.current[idx] = request;
        await request;
      }
      if (alive.current && !Object.keys(unsaved.current).length) {
        setSaving("saved");
        setSaveError("");
        onDocChanged();
      }
    } catch (e) {
      if (alive.current) {
        setSaving("error");
        setSaveError(`第 ${idx + 1} 段口述稿保存失败：${(e as Error).message}`);
      }
      throw e;
    }
  }, [docId, onDocChanged]);

  async function flushAll() {
    await Promise.all([...new Set([...Object.keys(unsaved.current), ...Object.keys(saveRequests.current)])].map((idx) => flushSave(Number(idx))));
  }

  async function generationAction(action: "start" | "retry" | "cancel", indices?: number[], force?: boolean) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    snapshotEpoch.current++;
    setBusy(true);
    setActionError("");
    try {
      if (action !== "cancel") await flushAll();
      if (!alive.current) return;
      const editsAtRequest = { ...editRevisions.current };
      const incoming = await api.generation(docId, { action, ...(indices ? { indices } : {}), ...(force ? { force } : {}) });
      if (!alive.current) return;
      applySnapshot(incoming, editsAtRequest);
      onDocChanged();
    } catch (e) {
      if (alive.current) setActionError(`操作未完成：${(e as Error).message}`);
    } finally {
      snapshotEpoch.current++;
      mutationLock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function changeSettings(patch: Partial<DocSettings>) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    snapshotEpoch.current++;
    setBusy(true);
    setActionError("");
    try {
      await flushAll();
      if (!alive.current) return;
      const editsAtRequest = { ...editRevisions.current };
      const incoming = await api.update(docId, patch);
      if (!alive.current) return;
      applySnapshot(incoming, editsAtRequest);
      setPlaying(false);
      onDocChanged();
    } catch (e) {
      if (alive.current) setActionError(`声音设置保存失败：${(e as Error).message}`);
    } finally {
      snapshotEpoch.current++;
      mutationLock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function editSegment(idx: number, tagged: string) {
    snapshotEpoch.current++;
    editRevisions.current[idx] = (editRevisions.current[idx] ?? 0) + 1;
    unsaved.current[idx] = tagged;
    updateDoc((currentDoc) => ({ ...currentDoc, segments: currentDoc.segments.map((segment) => segment.idx === idx
      ? { ...segment, tagged, speech: stripTags(tagged), tagStatus: "manual", tagModelId: undefined, audioFresh: false }
      : segment) }));
    setSaving("saving");
    clearTimeout(saveTimers.current[idx]);
    saveTimers.current[idx] = setTimeout(() => void flushSave(idx).catch(() => {}), SAVE_DEBOUNCE_MS);
  }

  const progress = documentProgress(doc);
  const segs = doc.segments;
  const cur = segs[current];
  const curUrl = cur?.audioUrl;
  const curText = cur?.tagged;
  const curStatus = cur?.generation?.status;
  const effectiveSegs = segs.filter((segment) => segment.tagged.trim());
  const staleSegs = effectiveSegs.filter((segment) => segment.audioUrl && !segment.audioFresh && !segmentBusy(segment) && segment.generation?.status !== "failed");
  const failedSegs = effectiveSegs.filter((segment) => segment.generation?.status === "failed");
  const readyCount = segs.filter((segment) => segment.audioUrl).length;

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    if (!playing || !curUrl) { element.pause(); return; }
    if (!element.src.endsWith(curUrl)) element.src = curUrl;
    element.playbackRate = rate;
    void element.play().catch(() => setPlaying(false));
  }, [curUrl, playing, rate]);

  // 后台状态到达时跳过空稿/失败段，或暂停等待用户明确提交生成。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!playing || curText === undefined) return;
    if (!curText.trim() || curStatus === "failed") {
      audioRef.current?.pause();
      if (current + 1 < segs.length) setCurrent(current + 1);
      else { setPlaying(false); setCurrent(0); }
    } else if (!curUrl && curStatus !== "queued" && curStatus !== "running") {
      setPlaying(false);
      setPlaybackMessage("这一段还没有语音，可以先继续生成，或点击已有语音的段落收听。");
    }
  }, [playing, current, curUrl, curText, curStatus, segs.length]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (playing) blockRefs.current[current]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [current, playing]);

  function goNext() {
    audioRef.current?.pause();
    if (current + 1 < segs.length) setCurrent(current + 1);
    else { setPlaying(false); setCurrent(0); }
  }

  function togglePlay() {
    setPlaybackMessage("");
    if (playing) audioRef.current?.pause();
    setPlaying(!playing);
  }

  function jumpTo(i: number) {
    audioRef.current?.pause();
    setPlaybackMessage("");
    if (i === current && curUrl && audioRef.current) {
      audioRef.current.currentTime = 0;
      if (playing) void audioRef.current.play().catch(() => setPlaying(false));
    }
    setCurrent(i);
    setPlaying(true);
  }

  function openHistory(idx: number) {
    setHistoryFilter(idx);
    requestAnimationFrame(() => historyAnchor.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <section className="flex flex-col gap-3">
      <GenerationProgress progress={progress} busy={busy}
        onStart={() => void generationAction("start")} onRetry={() => void generationAction("retry")} onCancel={() => void generationAction("cancel")} />
      <div ref={historyAnchor} className="scroll-mt-20"><GenerationHistory docId={docId} segmentIndices={segs.map((segment) => segment.idx)} filter={historyFilter} onFilterChange={setHistoryFilter} /></div>
      {pollError && <p role="status" className="text-xs text-zinc-500">{pollError}</p>}
      {actionError && <p role="alert" className="text-sm break-all text-red-600">{actionError}</p>}
      {saveError && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 p-3 text-sm text-red-700 dark:border-red-900 dark:text-red-300">
        <span className="break-all">{saveError}</span>
        <button className="underline" onClick={() => void flushAll().catch(() => {})}>重试保存</button>
      </div>}

      {!progress.scriptReady ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="mb-3 font-medium">原文</h2>
          <div className="md min-w-0"><ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.sourceText}</ReactMarkdown></div>
        </div>
      ) : <>
        <div className="space-y-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
          <fieldset disabled={busy} className="disabled:opacity-60"><SettingsBar value={doc} onChange={changeSettings} tagsLocked /></fieldset>
          <p className="text-xs text-zinc-500">修改口述稿会暂停该段生成；更换声音设置会暂停本篇任务。保存后可重新生成。</p>
        </div>
        {staleSegs.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <span>{staleSegs.length} 段内容或声音设置已修改，需要重新合成。</span>
          <button disabled={busy} className="font-medium underline underline-offset-2 disabled:opacity-40" onClick={() => void generationAction("start", staleSegs.map((segment) => segment.idx))}>重新合成这些段</button>
        </div>}
        {failedSegs.length > 0 && <div role="alert" className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          <div className="flex flex-wrap items-center gap-2"><span>{failedSegs.length} 段生成失败，其他段落可以照常播放。</span>
            <button disabled={busy} className="underline disabled:opacity-40" onClick={() => void generationAction("retry", failedSegs.map((segment) => segment.idx))}>重试失败的段落</button>
          </div>
          <ul className="space-y-1 break-all text-xs">{failedSegs.map((segment) => <li key={segment.idx}>第 {segment.idx + 1} 段 · {generationPhaseLabel(segment.generation?.failurePhase ?? segment.generation?.phase)}：{segment.generation?.lastError?.message || segment.generation?.error}
            <button type="button" onClick={() => openHistory(segment.idx)} className="ml-2 underline">查看该段日志</button>
          </li>)}</ul>
        </div>}
        {!effectiveSegs.length && <p className="rounded-xl border border-zinc-200 p-3 text-sm text-zinc-500 dark:border-zinc-800">口述稿为空，填写至少一段后即可生成语音。</p>}
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white/90 p-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
          <button onClick={togglePlay} disabled={!effectiveSegs.length} className="rounded-full bg-zinc-900 px-4 py-1.5 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">{playing ? "暂停" : "播放"}</button>
          <button onClick={goNext} disabled={!segs.length} className="text-sm text-zinc-500 hover:underline disabled:opacity-40">下一段</button>
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))} className="rounded-md border border-zinc-300 bg-transparent px-1 py-0.5 text-sm dark:border-zinc-700" title="播放速度">
            {[0.8, 1, 1.25, 1.5, 1.75, 2].map((value) => <option key={value} value={value}>{value}x</option>)}
          </select>
          <span className="text-sm text-zinc-500">第 {segs.length ? current + 1 : 0}/{segs.length} 段 · 音频 {readyCount}/{segs.length}{playing && cur && !cur.audioUrl && " · 等待语音…"}</span>
          <span className="text-xs text-zinc-400">{saving === "saving" ? "保存中…" : saving === "error" ? <span className="text-red-500">保存失败</span> : "已保存"}</span>
          <label className="ml-auto flex items-center gap-1 text-sm"><input type="checkbox" checked={showScript} onChange={(e) => setShowScript(e.target.checked)} />显示口述稿</label>
          <audio ref={audioRef} onEnded={goNext} className="hidden" />
        </div>
        {playbackMessage && <p className="text-sm text-zinc-500">{playbackMessage}</p>}
        <div className="space-y-2">
          {segs.map((segment, i) => <div key={segment.idx} ref={(element) => { blockRefs.current[i] = element; }}
            className={`grid gap-3 rounded-xl border p-3 transition-colors ${showScript ? "md:grid-cols-[3fr_2fr]" : ""} ${current === i ? "border-amber-400 bg-amber-50 dark:border-amber-500/60 dark:bg-amber-500/10" : "border-transparent hover:border-zinc-200 dark:hover:border-zinc-800"}`}>
            <div className="md min-w-0 cursor-pointer" onClick={() => jumpTo(i)} title="从这里开始播放"><ReactMarkdown remarkPlugins={[remarkGfm]}>{segment.markdown}</ReactMarkdown></div>
            {showScript && <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
              <div className="flex items-center gap-2 text-xs">
                <span className="rounded bg-zinc-200 px-1.5 dark:bg-zinc-800">{segment.kind}</span>
                <AudioBadge segment={segment} />
                {!segmentBusy(segment) && segment.tagged.trim() && <button disabled={busy} className="text-blue-600 hover:underline disabled:opacity-40"
                  onClick={() => void generationAction(segment.generation?.status === "failed" ? "retry" : "start", [segment.idx], segment.generation?.status === "failed" ? undefined : !!segment.audioUrl)}>
                  {segment.generation?.status === "failed" ? "重试" : segment.audioUrl ? "重新合成" : "生成"}
                </button>}
              </div>
              <textarea value={segment.tagged} onChange={(e) => editSegment(segment.idx, e.target.value)} className="min-h-20 w-full resize-y rounded-md border border-zinc-200 bg-transparent p-2 leading-6 dark:border-zinc-800" />
            </div>}
            {(segment.generation?.status === "failed" || (segmentBusy(segment) && (segment.generation?.autoRetryCount ?? 0) > 0)) &&
              <SegmentFailure segment={segment} busy={busy} onHistory={() => openHistory(segment.idx)} onCancel={() => void generationAction("cancel", [segment.idx])} />}
          </div>)}
        </div>
      </>}
    </section>
  );
}

function AudioBadge({ segment }: { segment: StoredSegment }) {
  if (!segment.tagged.trim()) return <span className="text-zinc-400">口述稿为空</span>;
  const generation = segment.generation;
  if (generation?.status === "queued") return <span className="text-blue-500">{(generation.autoRetryCount ?? 0) > 0 ? `等待自动重试 ${generation.autoRetryCount}/${MAX_AUTOMATIC_RETRIES}` : "排队中"}</span>;
  if (generation?.status === "running") return <span className="text-blue-500">{(generation.autoRetryCount ?? 0) > 0 ? `自动重试 ${generation.autoRetryCount}/${MAX_AUTOMATIC_RETRIES} · ` : ""}{generation.phase === "tags" ? "添加语气标签…" : "生成语音…"}</span>;
  if (generation?.status === "failed") return <span className="text-red-500">{generationPhaseLabel(generation.failurePhase ?? generation.phase)}失败</span>;
  if (!segment.audioUrl) return <span className="text-zinc-400">{generation?.status === "cancelled" ? "已暂停" : "待生成"}</span>;
  if (!segment.audioFresh) return <span className="text-amber-600" title="口述稿或声音设置已修改，当前音频是旧版本">需要重新合成</span>;
  return <span className="text-green-600">✓ 语音已就绪</span>;
}

function SegmentFailure({ segment, busy, onHistory, onCancel }: { segment: StoredSegment; busy: boolean; onHistory: () => void; onCancel: () => void }) {
  const generation = segment.generation;
  const [now, setNow] = useState(() => Date.now());
  const waiting = generation?.status === "queued" && generation.nextRetryAt !== undefined;
  useEffect(() => {
    if (!waiting) return;
    const update = () => setNow(Date.now());
    const immediate = setTimeout(update, 0);
    const timer = setInterval(update, 1_000);
    return () => { clearTimeout(immediate); clearInterval(timer); };
  }, [waiting, generation?.nextRetryAt]);
  if (!generation) return null;
  const failed = generation.status === "failed";
  const retry = automaticRetryLabel(generation, now);
  return <div className={`col-span-full space-y-2 rounded-lg border p-3 text-sm ${failed ? "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200" : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-medium">{failed ? `${generationPhaseLabel(generation.failurePhase ?? generation.phase)}失败` : retry}</p>
      <div className="flex gap-3 text-xs">
        <button type="button" onClick={onHistory} className="underline">该段生成日志</button>
        {!failed && <button type="button" disabled={busy} onClick={onCancel} className="underline disabled:opacity-40">停止此段</button>}
      </div>
    </div>
    {!failed && <p className="text-xs">上次在{generationPhaseLabel(generation.failurePhase ?? generation.phase)}阶段失败，后台正在自动处理，无需重复点击重试。</p>}
    <GenerationError error={generation.lastError} message={generation.error} />
    {failed && generation.lastError && <p className="text-xs opacity-80">{!generation.lastError.retryable
      ? "此错误不会自动重试，请根据原因检查后再手动重试。"
      : (generation.autoRetryCount ?? 0) >= MAX_AUTOMATIC_RETRIES
        ? `已用完 ${MAX_AUTOMATIC_RETRIES} 次自动重试，可以手动重试。`
        : "可以手动重试这一段。"}</p>}
  </div>;
}
