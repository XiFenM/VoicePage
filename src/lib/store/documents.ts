import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUDIO_DIR, db, tx } from "./db";
import type { DocSettings, DocSummary, StoredDocument, StoredSegment } from "./types";
import type { SourceBlock } from "@/lib/script/segment";
import type { ScriptSegment } from "@/lib/script/types";

type Row = Record<string, string | number | null>;

export function newId(): string {
  // 时间前缀便于排序和人工查看，后缀随机
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/** 音频指纹：文本 + 模型 + 音色 + 是否加角色语气前缀 + 角色。任何一项变了，旧音频就过期 */
export function audioHash(p: { text: string; modelId: string; voice: string; useStyle: boolean; personaId: string }) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify([p.text, p.modelId, p.voice, p.useStyle, p.useStyle ? p.personaId : ""]))
    .digest("hex")
    .slice(0, 16);
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
  };
  if (s.audio_file) {
    seg.audioUrl = `/api/documents/${docId}/audio/${seg.idx}?v=${s.audio_hash}`;
    seg.audioFresh =
      s.audio_hash ===
      audioHash({
        text: seg.tagged,
        modelId: settings.ttsModelId,
        voice: settings.voice,
        useStyle: settings.useStyle,
        personaId: settings.personaId,
      });
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
  tx(() => {
    db()
      .prepare(
        `INSERT INTO documents (id, title, source_text, persona_id, tts_model_id, voice, use_tags, use_style, script_model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, makeTitle(input.sourceText), input.sourceText, s.personaId, s.ttsModelId, s.voice, +s.useTags, +s.useStyle, input.scriptModel, now, now);
    const ins = db().prepare(
      `INSERT INTO segments (doc_id, idx, kind, lang, markdown, speech, tagged, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    input.blocks.forEach((b, i) => {
      const seg = input.segments[i];
      ins.run(id, i, b.kind, b.lang ?? null, b.markdown, seg?.speech ?? "", seg?.tagged ?? seg?.speech ?? "", now);
    });
  });
  return getDocument(id)!;
}

export function updateDocument(id: string, patch: Partial<DocSettings> & { title?: string }): StoredDocument | null {
  const cur = db().prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
  if (!cur) return null;
  const s = { ...rowSettings(cur), ...patch };
  db()
    .prepare(
      `UPDATE documents SET title = ?, persona_id = ?, tts_model_id = ?, voice = ?, use_tags = ?, use_style = ?, updated_at = ? WHERE id = ?`,
    )
    .run(patch.title?.trim() || (cur.title as string), s.personaId, s.ttsModelId, s.voice, +s.useTags, +s.useStyle, Date.now(), id);
  return getDocument(id);
}

export function updateSegmentText(id: string, idx: number, tagged: string, speech: string): boolean {
  const now = Date.now();
  const r = db()
    .prepare("UPDATE segments SET tagged = ?, speech = ?, updated_at = ? WHERE doc_id = ? AND idx = ?")
    .run(tagged, speech, now, id, idx);
  if (r.changes) touch(id, now);
  return r.changes > 0;
}

/** 保存一段音频（覆盖旧文件） */
export function saveSegmentAudio(
  id: string,
  idx: number,
  audio: Buffer,
  meta: { hash: string; modelId: string; voice: string; ext?: string },
) {
  const rel = path.join(/*turbopackIgnore: true*/ id, `${String(idx).padStart(4, "0")}.${meta.ext ?? "mp3"}`);
  const abs = path.join(/*turbopackIgnore: true*/ AUDIO_DIR, rel);
  fs.mkdirSync(path.dirname(/*turbopackIgnore: true*/ abs), { recursive: true });
  // 先写临时文件再改名，避免中途崩溃留下半个文件
  fs.writeFileSync(abs + ".tmp", audio);
  fs.renameSync(abs + ".tmp", abs);
  const now = Date.now();
  db()
    .prepare(
      `UPDATE segments SET audio_file = ?, audio_hash = ?, audio_bytes = ?, audio_model_id = ?, audio_voice = ?, updated_at = ?
        WHERE doc_id = ? AND idx = ?`,
    )
    .run(rel, meta.hash, audio.length, meta.modelId, meta.voice, now, id, idx);
  touch(id, now);
}

export function getSegmentAudioPath(id: string, idx: number): string | null {
  const r = db().prepare("SELECT audio_file FROM segments WHERE doc_id = ? AND idx = ?").get(id, idx) as Row | undefined;
  if (!r?.audio_file) return null;
  const abs = path.join(/*turbopackIgnore: true*/ AUDIO_DIR, r.audio_file as string);
  return fs.existsSync(abs) ? abs : null;
}

export function getSegmentForTts(id: string, idx: number) {
  const d = db().prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
  const s = db().prepare("SELECT tagged FROM segments WHERE doc_id = ? AND idx = ?").get(id, idx) as Row | undefined;
  if (!d || !s) return null;
  return { settings: rowSettings(d), tagged: s.tagged as string };
}

export function deleteDocument(id: string): boolean {
  const r = db().prepare("DELETE FROM documents WHERE id = ?").run(id);
  fs.rmSync(path.join(/*turbopackIgnore: true*/ AUDIO_DIR, id), { recursive: true, force: true });
  return r.changes > 0;
}

function touch(id: string, now = Date.now()) {
  db().prepare("UPDATE documents SET updated_at = ? WHERE id = ?").run(now, id);
}
