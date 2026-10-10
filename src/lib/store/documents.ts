import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUDIO_DIR, db, tx } from "./db";
import type { DocSettings, DocSummary, StoredDocument, StoredSegment, JobClaim } from "./types";
import { cancelJobsInTransaction, getBackgroundProgress, getSegmentGeneration, isJobOwned } from "./job-state";
import type { SourceBlock } from "@/lib/script/segment";
import type { ScriptSegment } from "@/lib/script/types";
import { stripTags } from "@/lib/catalog";
import { effectiveTagStatus, isAudioFresh, needsAutomaticTags } from "./audio-state";

export { audioHash, needsAutomaticTags } from "./audio-state";

type Row = Record<string, string | number | null>;

function tagStatus(s: Row, settings: DocSettings): StoredSegment["tagStatus"] {
  return effectiveTagStatus(s.tag_status, s.tag_model_id, settings);
}

export function newId(): string {
  // 时间前缀便于排序和人工查看，后缀随机
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

export function makeTitle(source: string): string {
  const firstLine =
    source
      .split("\n")
      .map((l) => l.replace(/^#+\s*|[*_`>|]/g, "").trim())
      .find((l) => l && !l.startsWith("```")) ?? "未命名";
  return firstLine.length > 40 ? firstLine.slice(0, 40) + "…" : firstLine;
}

// ---------------- 查询 ----------------

export function listDocuments(): DocSummary[] {
  const rows = db()
    .prepare(
      `SELECT d.id, d.title, d.tts_model_id, d.voice, d.created_at, d.updated_at,
              COUNT(s.idx) AS seg_count, COUNT(s.audio_file) AS audio_count
         FROM documents d LEFT JOIN segments s ON s.doc_id = d.id
        GROUP BY d.id ORDER BY d.updated_at DESC`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    ttsModelId: r.tts_model_id as string,
    voice: r.voice as string,
    segmentCount: Number(r.seg_count),
    audioCount: Number(r.audio_count),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    generation: getBackgroundProgress(r.id as string),
  }));
}

export function getDocument(id: string): StoredDocument | null {
  const d = db().prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
  if (!d) return null;
  const settings = rowSettings(d);
  const segs = db().prepare("SELECT * FROM segments WHERE doc_id = ? ORDER BY idx").all(id) as Row[];
  return {
    id,
    title: d.title as string,
    sourceText: d.source_text as string,
    scriptModel: (d.script_model as string) ?? undefined,
    createdAt: Number(d.created_at),
    updatedAt: Number(d.updated_at),
    generation: getBackgroundProgress(id),
    ...settings,
    segments: segs.map((s) => toStoredSegment(id, s, settings)),
  };
}

function rowSettings(d: Row): DocSettings {
  return {
    personaId: d.persona_id as string,
    ttsModelId: d.tts_model_id as string,
    voice: d.voice as string,
    useTags: !!d.use_tags,
    useStyle: !!d.use_style,
  };
}

function toStoredSegment(docId: string, s: Row, settings: DocSettings): StoredSegment {
  const seg: StoredSegment = {
    idx: Number(s.idx),
    kind: s.kind as StoredSegment["kind"],
    lang: (s.lang as string) ?? undefined,
    markdown: s.markdown as string,
    speech: s.speech as string,
    tagged: s.tagged as string,
    tagStatus: tagStatus(s, settings),
    tagModelId: (s.tag_model_id as string) ?? undefined,
    generation: getSegmentGeneration(docId, Number(s.idx)),
  };
  if (s.audio_file) {
    seg.audioUrl = `/api/documents/${docId}/audio/${seg.idx}?v=${s.audio_hash}${s.audio_version ? `-${s.audio_version}` : ""}`;
    seg.audioFresh = isAudioFresh({ audioFile: s.audio_file, storedHash: s.audio_hash, tagged: seg.tagged, tagStatus: s.tag_status, tagModelId: s.tag_model_id }, settings);
  }
  return seg;
}

// ---------------- 写入 ----------------

export function createDocument(input: {
  sourceText: string;
  settings: DocSettings;
  scriptModel: string;
  blocks: SourceBlock[];
  segments: ScriptSegment[];
}): StoredDocument {
  const id = newId();
  const now = Date.now();
  const s = input.settings;
  const pending = needsAutomaticTags(s);
  tx(() => {
    db()
      .prepare(
        `INSERT INTO documents (id, title, source_text, persona_id, tts_model_id, voice, use_tags, use_style, script_model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, makeTitle(input.sourceText), input.sourceText, s.personaId, s.ttsModelId, s.voice, +s.useTags, +s.useStyle, input.scriptModel, now, now);
    const ins = db().prepare(
      `INSERT INTO segments (doc_id, idx, kind, lang, markdown, speech, tagged, tag_status, tag_model_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    input.blocks.forEach((b, i) => {
      const seg = input.segments[i];
      const speech = seg?.speech ?? "";
      ins.run(id, i, b.kind, b.lang ?? null, b.markdown, speech, speech, pending ? "pending" : "ready", pending ? null : s.ttsModelId, now);
    });
  });
  return getDocument(id)!;
}

export function updateDocument(id: string, patch: Partial<DocSettings> & { title?: string }): StoredDocument | null {
  tx(() => {
    const cur = db().prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
    if (!cur) return;
    const previous = rowSettings(cur);
    const s = { ...previous, ...patch };
    const now = Date.now();
    if (JSON.stringify(previous) !== JSON.stringify({ personaId: s.personaId, ttsModelId: s.ttsModelId, voice: s.voice, useTags: s.useTags, useStyle: s.useStyle })) {
      cancelJobsInTransaction(id, undefined, true);
    }
    db()
      .prepare(
        `UPDATE documents SET title = ?, persona_id = ?, tts_model_id = ?, voice = ?, use_tags = ?, use_style = ?, updated_at = ? WHERE id = ?`,
      )
      .run(patch.title?.trim() || (cur.title as string), s.personaId, s.ttsModelId, s.voice, +s.useTags, +s.useStyle, now, id);
    if (s.ttsModelId !== previous.ttsModelId || s.personaId !== previous.personaId || s.useTags !== previous.useTags) {
      const pending = needsAutomaticTags(s);
      db().prepare(`UPDATE segments SET tagged = speech, tag_status = ?, tag_model_id = ?, tag_revision = tag_revision + 1, updated_at = ?
        WHERE doc_id = ? AND tag_status != 'manual'`).run(pending ? "pending" : "ready", pending ? null : s.ttsModelId, now, id);
    }
    if (s.voice !== previous.voice || s.useStyle !== previous.useStyle) {
      db().prepare("UPDATE segments SET tag_revision = tag_revision + 1 WHERE doc_id = ?").run(id);
    }
  });
  return getDocument(id);
}

export function updateSegmentText(id: string, idx: number, tagged: string, speech: string): boolean {
  return tx(() => {
    const now = Date.now();
    const r = db()
      .prepare("UPDATE segments SET tagged = ?, speech = ?, tag_status = 'manual', tag_model_id = NULL, tag_revision = tag_revision + 1, updated_at = ? WHERE doc_id = ? AND idx = ?")
      .run(tagged, speech, now, id, idx);
    if (r.changes) {
      cancelJobsInTransaction(id, [idx], true);
      touch(id, now);
    }
    return r.changes > 0;
  });
}

/** 标签和 TTS 请求开始时的快照；revision 也能识别先改走、再改回的情况。 */
export interface SegmentSnapshot {
  id: string;
  idx: number;
  revision: number;
  settings: DocSettings;
  speech: string;
  tagged: string;
  tagStatus: StoredSegment["tagStatus"];
  tagModelId?: string;
}

export function getSegmentForTags(id: string, idx: number): SegmentSnapshot | null {
  const d = db().prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
  const s = db().prepare("SELECT * FROM segments WHERE doc_id = ? AND idx = ?").get(id, idx) as Row | undefined;
  if (!d || !s) return null;
  const settings = rowSettings(d);
  return {
    id, idx, settings, revision: Number(s.tag_revision), speech: s.speech as string, tagged: s.tagged as string,
    tagStatus: tagStatus(s, settings), tagModelId: (s.tag_model_id as string) ?? undefined,
  };
}

function sameSnapshot(current: SegmentSnapshot | null, expected: SegmentSnapshot): boolean {
  return !!current && current.revision === expected.revision && current.speech === expected.speech &&
    current.tagged === expected.tagged && current.tagStatus === expected.tagStatus &&
    JSON.stringify(current.settings) === JSON.stringify(expected.settings);
}

/** 事务内核对后保存，绝不把异步生成结果写到用户刚编辑过的稿件上。 */
export function saveSegmentTags(expected: SegmentSnapshot, tagged: string, claim?: JobClaim): StoredSegment | null {
  return tx(() => {
    if (claim && (!isJobOwned(claim) || claim.docId !== expected.id || claim.idx !== expected.idx)) return null;
    const current = getSegmentForTags(expected.id, expected.idx);
    if (!sameSnapshot(current, expected) || current?.tagStatus === "manual") return null;
    const now = Date.now();
    db().prepare(`UPDATE segments SET tagged = ?, tag_status = 'ready', tag_model_id = ?, tag_revision = tag_revision + 1, updated_at = ?
      WHERE doc_id = ? AND idx = ?`).run(tagged, expected.settings.ttsModelId, now, expected.id, expected.idx);
    touch(expected.id, now);
    return getDocument(expected.id)!.segments.find((s) => s.idx === expected.idx)!;
  });
}

/** 保存一段音频（覆盖旧文件） */
export function saveSegmentAudio(
  id: string,
  idx: number,
  audio: Buffer,
  meta: { hash: string; modelId: string; voice: string; ext?: string },
  expected?: SegmentSnapshot,
  claim?: JobClaim,
): boolean {
  return tx(() => {
    if (claim && (!isJobOwned(claim) || claim.docId !== id || claim.idx !== idx)) return false;
    if (expected && (expected.tagStatus === "pending" || !sameSnapshot(getSegmentForTts(id, idx), expected))) return false;
    const rel = path.join(/*turbopackIgnore: true*/ id, `${String(idx).padStart(4, "0")}.${meta.ext ?? "mp3"}`);
    const abs = path.join(/*turbopackIgnore: true*/ AUDIO_DIR, rel);
    fs.mkdirSync(path.dirname(/*turbopackIgnore: true*/ abs), { recursive: true });
    // 先写临时文件再改名，避免中途崩溃留下半个文件
    fs.writeFileSync(abs + ".tmp", audio);
    fs.renameSync(abs + ".tmp", abs);
    const now = Date.now();
    db()
      .prepare(
        `UPDATE segments SET audio_file = ?, audio_hash = ?, audio_version = ?, audio_bytes = ?, audio_model_id = ?, audio_voice = ?, updated_at = ?
          WHERE doc_id = ? AND idx = ?`,
      )
      .run(rel, meta.hash, crypto.randomUUID(), audio.length, meta.modelId, meta.voice, now, id, idx);
    if (claim) {
      // 已在事务开头验证 owner；持锁期间不会被其他进程重新领取。
      db().prepare(`UPDATE jobs SET status = 'completed', phase = 'tts', owner = NULL, lease_until = NULL,
        error = NULL, finished_at = ?, updated_at = ? WHERE doc_id = ? AND idx = ? AND owner = ? AND attempt = ?`)
        .run(now, now, id, idx, claim.owner, claim.attempt);
    }
    touch(id, now);
    return true;
  });
}

export function getSegmentAudioPath(id: string, idx: number): string | null {
  const r = db().prepare("SELECT audio_file FROM segments WHERE doc_id = ? AND idx = ?").get(id, idx) as Row | undefined;
  if (!r?.audio_file) return null;
  const abs = path.join(/*turbopackIgnore: true*/ AUDIO_DIR, r.audio_file as string);
  return fs.existsSync(abs) ? abs : null;
}

export function getSegmentForTts(id: string, idx: number) {
  const snapshot = getSegmentForTags(id, idx);
  if (!snapshot) return null;
  return { ...snapshot, tagged: snapshot.settings.useTags ? snapshot.tagged : stripTags(snapshot.tagged) };
}

export function deleteDocument(id: string): boolean {
  const r = db().prepare("DELETE FROM documents WHERE id = ?").run(id);
  fs.rmSync(path.join(/*turbopackIgnore: true*/ AUDIO_DIR, id), { recursive: true, force: true });
  return r.changes > 0;
}

function touch(id: string, now = Date.now()) {
  db().prepare("UPDATE documents SET updated_at = ? WHERE id = ?").run(now, id);
}
