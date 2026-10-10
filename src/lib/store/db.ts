import "server-only";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// 持久化：
//   data/readaloud.db      SQLite（Node 内置 node:sqlite，无需额外依赖）
//   data/audio/<docId>/    每段一个 MP3
// 数据目录可用 DATA_DIR 覆盖。整个目录可直接拷贝备份，也可用应用内的导出/导入。

// turbopackIgnore：数据目录是运行时路径，不应被打包工具追踪
export const DATA_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR ?? "data");
export const AUDIO_DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "audio");

const SCHEMA_VERSION = 4;

declare global {
  var __readaloudDb: DatabaseSync | undefined;
}

export function db(): DatabaseSync {
  // 开发模式下热更新会重复加载模块，挂到 globalThis 上避免重复打开
  if (globalThis.__readaloudDb) {
    // 热更新后连接仍存在，但新代码可能需要升级旧 schema。
    migrate(globalThis.__readaloudDb);
    return globalThis.__readaloudDb;
  }
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const d = new DatabaseSync(path.join(/*turbopackIgnore: true*/ DATA_DIR, "readaloud.db"));
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(d);
  globalThis.__readaloudDb = d;
  return d;
}

function migrate(d: DatabaseSync) {
  const { user_version } = d.prepare("PRAGMA user_version").get() as { user_version: number };
  if (user_version >= SCHEMA_VERSION) return;
  d.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(d.prepare("PRAGMA user_version").get()!.user_version);
    if (version < 1) d.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      source_text  TEXT NOT NULL,
      persona_id   TEXT NOT NULL,
      tts_model_id TEXT NOT NULL,
      voice        TEXT NOT NULL,
      use_tags     INTEGER NOT NULL,
      use_style    INTEGER NOT NULL,
      script_model TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS segments (
      doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      idx            INTEGER NOT NULL,
      kind           TEXT NOT NULL,
      lang           TEXT,
      markdown       TEXT NOT NULL,
      speech         TEXT NOT NULL,
      tagged         TEXT NOT NULL,
      audio_file     TEXT,           -- 相对 AUDIO_DIR 的路径
      audio_hash     TEXT,           -- 生成该音频时的 文本+模型+音色+风格 指纹，用于判断音频是否过期
      audio_bytes    INTEGER,
      audio_model_id TEXT,
      audio_voice    TEXT,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (doc_id, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);
  `);
    if (version < 2) d.exec(`
      ALTER TABLE segments ADD COLUMN tag_status TEXT NOT NULL DEFAULT 'ready';
      ALTER TABLE segments ADD COLUMN tag_model_id TEXT;
      ALTER TABLE segments ADD COLUMN tag_revision INTEGER NOT NULL DEFAULT 0;
      UPDATE segments SET tag_model_id = (SELECT tts_model_id FROM documents WHERE id = segments.doc_id);
    `);
    if (version < 3) d.exec(`
      ALTER TABLE documents ADD COLUMN script_ready INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE jobs (
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('script', 'segment')),
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        phase TEXT NOT NULL DEFAULT 'queued',
        attempt INTEGER NOT NULL DEFAULT 0,
        owner TEXT,
        lease_until INTEGER,
        force INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        error TEXT,
        PRIMARY KEY(doc_id, idx)
      );
      CREATE INDEX idx_jobs_claim ON jobs(status, created_at, doc_id, idx);
      CREATE INDEX idx_jobs_lease ON jobs(status, lease_until);
    `);
    if (version < 4) d.exec("ALTER TABLE segments ADD COLUMN audio_version TEXT;");
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
  } catch (error) {
    d.exec("ROLLBACK");
    throw error;
  }
}

/** 在事务中执行 */
export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
