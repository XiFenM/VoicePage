import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { AUDIO_DIR, db, tx } from "./db";
import { listCollections, normalizeLibraryPositions } from "./collections";
import type { GenerationEvent, JobErrorDetail, JobPhase, LibraryCollection, RetrySource } from "./types";
import { nextDocumentPosition } from "./organization";
import { appendGenerationEvent, exportGenerationEvents, GenerationEventSchema, JobErrorSchema, parseJobError } from "./generation-events";
import { MAX_AUTO_RETRIES } from "@/lib/generation/retry-policy";

// 备份格式（.zip）：
//   manifest.json                 { format, version, exportedAt, documents: [...] }
//   audio/<docId>/<0000>.mp3      各段音频
// 设计为与数据库结构解耦：导入时按 manifest 逐条写入，方便以后升级表结构。

export const BACKUP_FORMAT = "readaloud-backup";
export const BACKUP_VERSION = 5;

interface BackupSegment {
  idx: number;
  kind: string;
  lang: string | null;
  markdown: string;
  speech: string;
  tagged: string;
  tagStatus?: "pending" | "ready" | "manual";
  tagModelId?: string | null;
  audio: string | null; // zip 内路径
  audioHash: string | null;
  audioVersion?: string | null;
  audioModelId: string | null;
  audioVoice: string | null;
  updatedAt: number;
}

interface BackupDocument {
  id: string;
  sessionId?: string | null;
  position?: number;
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
  scriptReady?: boolean;
  jobs?: BackupJob[];
  events?: GenerationEvent[];
  segments: BackupSegment[];
}

interface BackupJob {
  idx: number;
  kind: "script" | "segment";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: "queued" | "spoken" | "tags" | "tts";
  force: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  attempt?: number;
  autoRetryCount?: number;
  nextRetryAt?: number | null;
  lastError?: JobErrorDetail;
  failurePhase?: JobPhase | null;
  retrySource?: RetrySource | null;
}

interface Manifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  documents: BackupDocument[];
  collections?: LibraryCollection[];
}

type Row = Record<string, string | number | null>;

/** 导出全部或指定文档为 zip */
export function exportBackup(ids?: string[]): { zip: Uint8Array; count: number } {
  return tx(() => {
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
      sessionId: d.session_id as string | null,
      position: Number(d.position),
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
      scriptReady: !!d.script_ready,
      events: exportGenerationEvents(d.id as string),
      jobs: (db().prepare("SELECT * FROM jobs WHERE doc_id = ? ORDER BY idx").all(d.id) as Row[]).map((job) => ({
        idx: Number(job.idx), kind: job.kind as BackupJob["kind"], status: job.status as BackupJob["status"],
        phase: job.phase as BackupJob["phase"], force: !!job.force,
        createdAt: Number(job.created_at), updatedAt: Number(job.updated_at),
        startedAt: job.started_at === null ? null : Number(job.started_at),
        finishedAt: job.finished_at === null ? null : Number(job.finished_at), error: job.error as string | null,
        attempt: Number(job.attempt), autoRetryCount: Number(job.auto_retry_count),
        nextRetryAt: job.next_retry_at === null ? null : Number(job.next_retry_at),
        lastError: parseJobError(job.last_error_json), failurePhase: job.failure_phase as JobPhase | null,
        retrySource: job.retry_source as RetrySource | null,
      })),
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
          tagStatus: s.tag_status as BackupSegment["tagStatus"],
          tagModelId: (s.tag_model_id as string) ?? null,
          audio,
          audioHash: audio ? ((s.audio_hash as string) ?? null) : null,
          audioVersion: audio ? ((s.audio_version as string) ?? null) : null,
          audioModelId: audio ? ((s.audio_model_id as string) ?? null) : null,
          audioVoice: audio ? ((s.audio_voice as string) ?? null) : null,
          updatedAt: Number(s.updated_at),
        };
      }),
    };
  });

  const allCollections = listCollections();
  const ancestors = new Set<string>();
  for (const document of documents) {
    let id = document.sessionId;
    while (id && !ancestors.has(id)) {
      ancestors.add(id);
      id = allCollections.find((collection) => collection.id === id)?.parentId;
    }
  }
  const collections = ids?.length ? allCollections.filter((collection) => ancestors.has(collection.id)) : allCollections;
  const manifest: Manifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: Date.now(), documents, collections };
  files["manifest.json"] = [Buffer.from(JSON.stringify(manifest, null, 2)), { level: 6 }];
  return { zip: zipSync(files), count: documents.length };
  });
}

export type ImportMode = "skip" | "overwrite";

export interface ImportResult {
  imported: number;
  overwritten: number;
  skipped: number;
  audioFiles: number;
}

function importCollections(manifest: Manifest, mode: ImportMode): void {
  const incoming = manifest.version >= 4 ? manifest.collections ?? [] : [];
  if (!Array.isArray(incoming) || !Array.isArray(manifest.documents)) throw new BackupError("备份中的归档结构无效");
  const merged = new Map(listCollections().map((collection) => [collection.id, collection]));
  const seen = new Set<string>();
  for (const collection of incoming) {
    if (!collection || !/^[\w-]+$/.test(collection.id) || seen.has(collection.id) ||
      (collection.kind !== "group" && collection.kind !== "session") ||
      typeof collection.name !== "string" || !collection.name.trim() || collection.name.length > 200 ||
      (collection.parentId !== null && typeof collection.parentId !== "string") ||
      !Number.isSafeInteger(collection.position) || collection.position < 0 ||
      !Number.isFinite(collection.createdAt) || !Number.isFinite(collection.updatedAt)) throw new BackupError("备份中的容器无效");
    seen.add(collection.id);
    const existing = merged.get(collection.id);
    if (existing && existing.kind !== collection.kind) throw new BackupError(`容器 ${collection.id} 的类型与现有容器冲突`);
    if (!existing || mode === "overwrite") merged.set(collection.id, collection);
  }
  for (const collection of merged.values()) {
    if (collection.kind === "group" && collection.parentId !== null) throw new BackupError("备份中的 Group 只能在根目录");
    if (collection.parentId !== null && merged.get(collection.parentId)?.kind !== "group") throw new BackupError("备份中的 Session 缺少有效 Group");
  }
  const documentIds = new Set<string>();
  for (const document of manifest.documents) {
    if (!document || !/^[\w-]+$/.test(document.id) || documentIds.has(document.id) || !Array.isArray(document.segments)) throw new BackupError("备份中的文档无效或重复");
    documentIds.add(document.id);
    if (manifest.version >= 4) {
      if (!Number.isSafeInteger(document.position) || document.position! < 0) throw new BackupError("备份中的任务顺序无效");
      if (document.sessionId != null && merged.get(document.sessionId)?.kind !== "session") throw new BackupError("备份中的任务缺少有效 Session");
    }
  }
  const insert = db().prepare(`INSERT INTO collections (id, kind, name, parent_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id, position = excluded.position,
      created_at = excluded.created_at, updated_at = excluded.updated_at`);
  for (const collection of [...incoming].sort((a, b) => Number(a.kind === "session") - Number(b.kind === "session"))) {
    if (mode === "skip" && db().prepare("SELECT 1 FROM collections WHERE id = ?").get(collection.id)) continue;
    insert.run(collection.id, collection.kind, collection.name.trim(), collection.parentId, collection.position, collection.createdAt, collection.updatedAt);
  }
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
  const stagingDirs: string[] = [];
  const swaps: { target: string; previous: string; hadPrevious: boolean; installed: boolean }[] = [];
  try {
    tx(() => {
      importCollections(manifest, mode);
      const exists = db().prepare("SELECT 1 FROM documents WHERE id = ?");
      for (const doc of manifest.documents) {
        const already = !!exists.get(doc.id);
        if (already && mode === "skip") {
          result.skipped++;
          continue;
        }
        const docAudioDir = path.join(/*turbopackIgnore: true*/ AUDIO_DIR, doc.id);
        const stagingDir = `${docAudioDir}.importing-${crypto.randomUUID()}`;
        stagingDirs.push(stagingDir);
        fs.mkdirSync(stagingDir, { recursive: true });
        const audioRel = new Map<number, string>();
        for (const s of doc.segments) {
          if (!s.audio) continue;
          const bytes = entries[s.audio];
          if (!bytes) continue;
          const name = path.basename(/*turbopackIgnore: true*/ s.audio);
          if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") throw new BackupError(`非法的音频文件名：${s.audio}`);
          fs.writeFileSync(path.join(/*turbopackIgnore: true*/ stagingDir, name), bytes);
          audioRel.set(s.idx, path.join(/*turbopackIgnore: true*/ doc.id, name));
          result.audioFiles++;
        }
        const sessionId = manifest.version >= 4 ? doc.sessionId ?? null : null;
        const position = manifest.version >= 4 ? doc.position! : nextDocumentPosition(null);
        db().prepare("DELETE FROM documents WHERE id = ?").run(doc.id);
        db()
          .prepare(
            `INSERT INTO documents (id, title, source_text, persona_id, tts_model_id, voice, use_tags, use_style, script_model, created_at, updated_at, script_ready, session_id, position)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(doc.id, doc.title, doc.sourceText, doc.personaId, doc.ttsModelId, doc.voice, +doc.useTags, +doc.useStyle, doc.scriptModel, doc.createdAt, doc.updatedAt, manifest.version < 3 || doc.scriptReady !== false ? 1 : 0, sessionId, position);
        const ins = db().prepare(
          `INSERT INTO segments (doc_id, idx, kind, lang, markdown, speech, tagged, tag_status, tag_model_id, audio_file, audio_hash, audio_version, audio_bytes, audio_model_id, audio_voice, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const s of doc.segments) {
          const rel = audioRel.get(s.idx) ?? null;
          const tagStatus = manifest.version < 2 ? "ready" : s.tagStatus;
          if (tagStatus !== "pending" && tagStatus !== "ready" && tagStatus !== "manual") throw new BackupError("备份中的标签状态无效");
          ins.run(
            doc.id, s.idx, s.kind, s.lang, s.markdown, s.speech, s.tagged,
            tagStatus, manifest.version < 2 ? doc.ttsModelId : s.tagModelId ?? null,
            rel, rel ? s.audioHash : null, rel ? crypto.randomUUID() : null, rel ? entries[s.audio!].length : null,
            rel ? s.audioModelId : null, rel ? s.audioVoice : null, s.updatedAt,
          );
        }
        if (manifest.version >= 3) {
          const jobs = doc.jobs ?? [];
          const insertJob = db().prepare(`INSERT INTO jobs (doc_id, idx, kind, status, phase, force, created_at, updated_at, started_at, finished_at, error,
            attempt, auto_retry_count, last_error_json, failure_phase, retry_source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          const now = Date.now();
          for (const job of jobs) {
            if (!Number.isInteger(job.idx) || job.idx < -1 || (job.idx === -1) !== (job.kind === "script") ||
              !["queued", "spoken", "tags", "tts"].includes(job.phase) ||
              !["queued", "running", "completed", "failed", "cancelled"].includes(job.status)) throw new BackupError("备份中的后台任务无效");
            if (manifest.version >= 5 && (!Number.isSafeInteger(job.attempt) || job.attempt! < 0 ||
              !Number.isSafeInteger(job.autoRetryCount) || job.autoRetryCount! < 0 || job.autoRetryCount! > MAX_AUTO_RETRIES ||
              (job.failurePhase != null && !["queued", "spoken", "tags", "tts"].includes(job.failurePhase)) ||
              (job.retrySource != null && !["automatic", "manual", "recovery"].includes(job.retrySource)) ||
              (job.nextRetryAt != null && (!Number.isFinite(job.nextRetryAt) || job.nextRetryAt < 0)))) throw new BackupError("备份中的重试状态无效");
            if (manifest.version >= 5 && job.lastError && !JobErrorSchema.safeParse(job.lastError).success) throw new BackupError("备份中的诊断信息无效");
            if (job.idx >= 0 && !doc.segments.some((s) => s.idx === job.idx)) throw new BackupError("备份中的后台任务缺少对应段落");
            const hasOutput = job.idx === -1 ? doc.scriptReady !== false : audioRel.has(job.idx) || !doc.segments.find((s) => s.idx === job.idx)!.tagged.trim();
            const completed = job.status === "completed" && hasOutput;
            // 恢复时保留成果，但绝不自动恢复收费请求，也不携带旧 owner/租约。
            insertJob.run(doc.id, job.idx, job.kind, completed ? "completed" : "cancelled", job.phase, +job.force,
              job.createdAt, now, completed ? job.startedAt : null, completed ? job.finishedAt : now, completed ? job.error : null,
              manifest.version >= 5 ? job.attempt! : 0, manifest.version >= 5 ? job.autoRetryCount! : 0,
              manifest.version >= 5 && job.lastError ? JSON.stringify(JobErrorSchema.parse(job.lastError)) : null,
              manifest.version >= 5 ? job.failurePhase ?? null : null, manifest.version >= 5 ? job.retrySource ?? null : null);
          }
          if (doc.scriptReady === false && !jobs.some((job) => job.idx === -1)) {
            insertJob.run(doc.id, -1, "script", "cancelled", "queued", 0, now, now, null, now, null, 0, 0, null, null, null);
          }
        }
        if (manifest.version >= 5) {
          if (doc.events !== undefined && !Array.isArray(doc.events)) throw new BackupError("备份中的事件历史无效");
          const ids = new Set<number>();
          const events = (doc.events ?? []).map((raw) => {
            const parsed = GenerationEventSchema.safeParse(raw);
            if (!parsed.success || ids.has(parsed.data.id) || (parsed.data.idx >= 0 && !doc.segments.some((segment) => segment.idx === parsed.data.idx))) {
              throw new BackupError("备份中的事件历史无效");
            }
            ids.add(parsed.data.id);
            return parsed.data;
          });
          for (const event of events.sort((a, b) => a.id - b.id)) appendGenerationEvent(doc.id, event);
        }
        // 在数据库提交前替换音频，保留旧目录以便任意后续文档导入失败时一并回滚。
        const swap = { target: docAudioDir, previous: `${docAudioDir}.previous-${crypto.randomUUID()}`, hadPrevious: fs.existsSync(docAudioDir), installed: false };
        if (swap.hadPrevious) fs.renameSync(swap.target, swap.previous);
        swaps.push(swap);
        fs.renameSync(stagingDir, docAudioDir);
        swap.installed = true;
        if (already) result.overwritten++;
        else result.imported++;
      }
      normalizeLibraryPositions();
    });
  } catch (error) {
    for (const swap of swaps.reverse()) {
      if (swap.installed) fs.rmSync(swap.target, { recursive: true, force: true });
      if (swap.hadPrevious) fs.renameSync(swap.previous, swap.target);
    }
    throw error;
  } finally {
    for (const stagingDir of stagingDirs) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  for (const swap of swaps) {
    if (swap.hadPrevious) fs.rmSync(swap.previous, { recursive: true, force: true });
  }
  return result;
}

export class BackupError extends Error {}
