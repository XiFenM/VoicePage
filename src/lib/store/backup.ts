import "server-only";
import fs from "node:fs";
import path from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { AUDIO_DIR, db, tx } from "./db";

// 备份格式（.zip）：
//   manifest.json                 { format, version, exportedAt, documents: [...] }
//   audio/<docId>/<0000>.mp3      各段音频
// 设计为与数据库结构解耦：导入时按 manifest 逐条写入，方便以后升级表结构。

export const BACKUP_FORMAT = "readaloud-backup";
export const BACKUP_VERSION = 1;

interface BackupSegment {
  idx: number;
  kind: string;
  lang: string | null;
  markdown: string;
  speech: string;
  tagged: string;
  audio: string | null; // zip 内路径
  audioHash: string | null;
  audioModelId: string | null;
  audioVoice: string | null;
  updatedAt: number;
}

interface BackupDocument {
  id: string;
  title: string;
  sourceText: string;
  personaId: string;
  ttsModelId: string;
  voice: string;
  useTags: boolean;
  useStyle: boolean;
  scriptModel: string | null;
  createdAt: number;
  updatedAt: number;
  segments: BackupSegment[];
}

interface Manifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  documents: BackupDocument[];
}

type Row = Record<string, string | number | null>;

/** 导出全部或指定文档为 zip */
export function exportBackup(ids?: string[]): { zip: Uint8Array; count: number } {
  const docs = (
    ids?.length
      ? db().prepare(`SELECT * FROM documents WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids)
      : db().prepare("SELECT * FROM documents ORDER BY created_at").all()
  ) as Row[];

  const files: Zippable = {};
  const documents: BackupDocument[] = docs.map((d) => {
    const segs = db().prepare("SELECT * FROM segments WHERE doc_id = ? ORDER BY idx").all(d.id) as Row[];
    return {
      id: d.id as string,
      title: d.title as string,
      sourceText: d.source_text as string,
      personaId: d.persona_id as string,
      ttsModelId: d.tts_model_id as string,
      voice: d.voice as string,
      useTags: !!d.use_tags,
      useStyle: !!d.use_style,
      scriptModel: (d.script_model as string) ?? null,
      createdAt: Number(d.created_at),
      updatedAt: Number(d.updated_at),
      segments: segs.map((s) => {
        let audio: string | null = null;
        if (s.audio_file) {
          const abs = path.join(/*turbopackIgnore: true*/ AUDIO_DIR, s.audio_file as string);
          if (fs.existsSync(abs)) {
            audio = `audio/${(s.audio_file as string).split(path.sep).join("/")}`;
            // mp3 已压缩，store 模式（level 0）即可，省 CPU
            files[audio] = [fs.readFileSync(abs), { level: 0 }];
          }
        }
        return {
          idx: Number(s.idx),
          kind: s.kind as string,
          lang: (s.lang as string) ?? null,
          markdown: s.markdown as string,
          speech: s.speech as string,
          tagged: s.tagged as string,
          audio,
          audioHash: audio ? ((s.audio_hash as string) ?? null) : null,
          audioModelId: audio ? ((s.audio_model_id as string) ?? null) : null,
          audioVoice: audio ? ((s.audio_voice as string) ?? null) : null,
          updatedAt: Number(s.updated_at),
        };
      }),
    };
  });

  const manifest: Manifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: Date.now(), documents };
  files["manifest.json"] = [Buffer.from(JSON.stringify(manifest, null, 2)), { level: 6 }];
  return { zip: zipSync(files), count: documents.length };
}

export type ImportMode = "skip" | "overwrite";

export interface ImportResult {
  imported: number;
  overwritten: number;
  skipped: number;
  audioFiles: number;
}

/**
 * 导入 zip 备份。
 * - skip：已存在同 id 的文档则跳过（默认，重复导入同一个备份是安全的）
 * - overwrite：已存在则用备份覆盖
 */
export function importBackup(zipBytes: Uint8Array, mode: ImportMode = "skip"): ImportResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    throw new BackupError("不是有效的 zip 文件");
  }
  const raw = entries["manifest.json"];
  if (!raw) throw new BackupError("备份中缺少 manifest.json");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new BackupError("manifest.json 解析失败");
  }
  if (manifest.format !== BACKUP_FORMAT) throw new BackupError("不是 ReadAloud 的备份文件");
  if (manifest.version > BACKUP_VERSION) {
    throw new BackupError(`备份版本 ${manifest.version} 比当前程序支持的 ${BACKUP_VERSION} 新，请先升级程序`);
  }

  const result: ImportResult = { imported: 0, overwritten: 0, skipped: 0, audioFiles: 0 };
  const exists = db().prepare("SELECT 1 FROM documents WHERE id = ?");

  for (const doc of manifest.documents) {
    if (!/^[\w-]+$/.test(doc.id)) throw new BackupError(`非法的文档 id：${doc.id}`);
    const already = !!exists.get(doc.id);
    if (already && mode === "skip") {
      result.skipped++;
      continue;
    }

    // 先把音频写到临时目录，数据库事务成功后再换上，避免导入失败时留下不一致的数据
    const docAudioDir = path.join(/*turbopackIgnore: true*/ AUDIO_DIR, doc.id);
    const stagingDir = `${docAudioDir}.importing`;
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    const audioRel = new Map<number, string>();
    for (const s of doc.segments) {
      if (!s.audio) continue;
      const bytes = entries[s.audio];
      if (!bytes) continue; // 备份里缺文件就当没有音频
      const name = path.basename(/*turbopackIgnore: true*/ s.audio);
      if (!/^[\w.-]+$/.test(name)) throw new BackupError(`非法的音频文件名：${s.audio}`);
      fs.writeFileSync(path.join(/*turbopackIgnore: true*/ stagingDir, name), bytes);
      audioRel.set(s.idx, path.join(/*turbopackIgnore: true*/ doc.id, name));
      result.audioFiles++;
    }

    try {
      tx(() => {
        db().prepare("DELETE FROM documents WHERE id = ?").run(doc.id);
        db()
          .prepare(
            `INSERT INTO documents (id, title, source_text, persona_id, tts_model_id, voice, use_tags, use_style, script_model, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(doc.id, doc.title, doc.sourceText, doc.personaId, doc.ttsModelId, doc.voice, +doc.useTags, +doc.useStyle, doc.scriptModel, doc.createdAt, doc.updatedAt);
        const ins = db().prepare(
          `INSERT INTO segments (doc_id, idx, kind, lang, markdown, speech, tagged, audio_file, audio_hash, audio_bytes, audio_model_id, audio_voice, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const s of doc.segments) {
          const rel = audioRel.get(s.idx) ?? null;
          ins.run(
            doc.id, s.idx, s.kind, s.lang, s.markdown, s.speech, s.tagged,
            rel, rel ? s.audioHash : null, rel ? entries[s.audio!].length : null,
            rel ? s.audioModelId : null, rel ? s.audioVoice : null, s.updatedAt,
          );
        }
      });
    } catch (e) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw e;
    }
    fs.rmSync(docAudioDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, docAudioDir);

    if (already) result.overwritten++;
    else result.imported++;
  }
  return result;
}

export class BackupError extends Error {}
