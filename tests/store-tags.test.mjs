import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zipSync, unzipSync } from "fflate";

const repo = fileURLToPath(new URL("../", import.meta.url));
const dataDir = mkdtempSync(path.join(tmpdir(), "voicepage-store-tags-"));
process.env.DATA_DIR = dataDir;
// 仅测试进程：解析项目别名/TS扩展，并允许直接载入 server-only 存储模块。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    let candidate;
    if (specifier.startsWith("@/")) candidate = path.join(repo, "src", specifier.slice(2));
    else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (candidate && !path.extname(candidate) && existsSync(candidate + ".ts")) {
      return nextResolve(pathToFileURL(candidate + ".ts").href, context);
    }
    return nextResolve(specifier, context);
  },
});

const store = await import("../src/lib/store/documents.ts");
const { db } = await import("../src/lib/store/db.ts");
const backup = await import("../src/lib/store/backup.ts");
const settings = { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: true, useStyle: true };
const legacyText = "<short pause>旧口述稿";
const legacyHash = store.audioHash({ text: legacyText, modelId: settings.ttsModelId, ...settings });
const legacyDb = new DatabaseSync(path.join(dataDir, "readaloud.db"));
legacyDb.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, source_text TEXT NOT NULL, persona_id TEXT NOT NULL,
    tts_model_id TEXT NOT NULL, voice TEXT NOT NULL, use_tags INTEGER NOT NULL, use_style INTEGER NOT NULL,
    script_model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE segments (doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
    kind TEXT NOT NULL, lang TEXT, markdown TEXT NOT NULL, speech TEXT NOT NULL, tagged TEXT NOT NULL,
    audio_file TEXT, audio_hash TEXT, audio_bytes INTEGER, audio_model_id TEXT, audio_voice TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY(doc_id,idx));
  PRAGMA user_version=1;
`);
legacyDb.prepare("INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("legacy", "旧记录", "原文", settings.personaId, settings.ttsModelId, settings.voice, 1, 1, "mock", 1, 1);
legacyDb.prepare("INSERT INTO segments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run("legacy", 0, "text", null, "原文", "旧口述稿", legacyText, "legacy/0000.mp3", legacyHash, 3, settings.ttsModelId, settings.voice, 1);
mkdirSync(path.join(dataDir, "audio/legacy"), { recursive: true });
writeFileSync(path.join(dataDir, "audio/legacy/0000.mp3"), "old");
globalThis.__readaloudDb = legacyDb; // 模拟热更新时仍持有 v1 数据库连接。

after(() => {
  globalThis.__readaloudDb?.close();
  delete globalThis.__readaloudDb;
  rmSync(dataDir, { recursive: true, force: true });
});

function create(overrides = {}) {
  return store.createDocument({
    sourceText: "测试原文", settings: { ...settings, ...overrides }, scriptModel: "mock",
    blocks: [{ id: 0, kind: "text", markdown: "测试原文" }],
    segments: [{ id: 0, speech: "测试口述稿", tagged: "不应在创建阶段保存的标签" }],
  });
}

test("v1 cached database migrates atomically to ready tags without invalidating existing audio", () => {
  const doc = store.getDocument("legacy");
  assert.equal(db().prepare("PRAGMA user_version").get().user_version, 8);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM generation_events").get().n, 0);
  assert.equal(doc.segments[0].tagStatus, "ready");
  assert.equal(doc.segments[0].tagModelId, settings.ttsModelId);
  assert.equal(doc.segments[0].tagged, legacyText);
  assert.equal(doc.segments[0].audioFresh, true);
  assert.equal(readFileSync(store.getSegmentAudioPath("legacy", 0), "utf8"), "old");
});

test("new documents persist plain speech with pending tags; disabled tags start ready", () => {
  const tagged = create();
  assert.equal(tagged.segments[0].tagged, "测试口述稿");
  assert.equal(tagged.segments[0].tagStatus, "pending");
  assert.equal(store.getDocument(tagged.id).segments[0].tagStatus, "pending");
  assert.equal(create({ useTags: false }).segments[0].tagStatus, "ready");
});

test("prepared tags persist across reads and stale duplicate completions cannot overwrite them", () => {
  const doc = create();
  const snapshot = store.getSegmentForTags(doc.id, 0);
  const result = store.saveSegmentTags(snapshot, "<short pause>测试口述稿");
  assert.equal(result.tagStatus, "ready");
  assert.equal(result.tagModelId, settings.ttsModelId);
  assert.equal(store.getSegmentForTags(doc.id, 0).tagStatus, "ready");
  assert.equal(store.saveSegmentTags(snapshot, "过时响应"), null);
  assert.equal(store.getDocument(doc.id).segments[0].tagged, result.tagged);
});

test("manual editing permanently prevents an in-flight or later automatic rewrite", () => {
  const doc = create();
  const snapshot = store.getSegmentForTags(doc.id, 0);
  store.updateSegmentText(doc.id, 0, "手工口述稿", "手工口述稿");
  assert.equal(store.saveSegmentTags(snapshot, "<short pause>测试口述稿"), null);
  assert.equal(store.saveSegmentTags(store.getSegmentForTags(doc.id, 0), "另一个自动稿"), null);
  store.updateDocument(doc.id, { ttsModelId: "x-ai/grok-voice-tts-1.0", personaId: "friend" });
  const manual = store.getDocument(doc.id).segments[0];
  assert.equal(manual.tagStatus, "manual");
  assert.equal(manual.tagged, "手工口述稿");
});

test("model changes reset only automatic tags, retain old audio, and detect settings changed back", () => {
  const doc = create();
  store.saveSegmentTags(store.getSegmentForTags(doc.id, 0), "<short pause>测试口述稿");
  const snapshot = store.getSegmentForTts(doc.id, 0);
  const meta = { hash: store.audioHash({ text: snapshot.tagged, modelId: settings.ttsModelId, ...settings }), modelId: settings.ttsModelId, voice: settings.voice };
  assert.equal(store.saveSegmentAudio(doc.id, 0, Buffer.from("old-audio"), meta, snapshot), true);
  const beforeSwitch = store.getSegmentForTags(doc.id, 0);
  const changed = store.updateDocument(doc.id, { ttsModelId: "x-ai/grok-voice-tts-1.0" }).segments[0];
  assert.equal(changed.tagStatus, "pending");
  assert.equal(changed.tagged, changed.speech);
  assert.equal(changed.audioFresh, false);
  assert.equal(readFileSync(store.getSegmentAudioPath(doc.id, 0), "utf8"), "old-audio");
  store.updateDocument(doc.id, { ttsModelId: settings.ttsModelId });
  assert.equal(store.saveSegmentTags(beforeSwitch, "过时响应"), null);
  assert.equal(store.saveSegmentAudio(doc.id, 0, Buffer.from("stale-audio"), meta, snapshot), false);
  assert.equal(readFileSync(store.getSegmentAudioPath(doc.id, 0), "utf8"), "old-audio");
});

test("disabling tags needs no preparation and removes tags only from effective manual TTS input", () => {
  const doc = create();
  store.updateSegmentText(doc.id, 0, "<short pause>手工稿", "手工稿");
  store.updateDocument(doc.id, { useTags: false });
  assert.equal(store.getDocument(doc.id).segments[0].tagged, "<short pause>手工稿");
  const snapshot = store.getSegmentForTts(doc.id, 0);
  assert.equal(snapshot.tagged, "手工稿");
  const meta = { hash: store.audioHash({ text: snapshot.tagged, modelId: settings.ttsModelId, ...snapshot.settings }), modelId: settings.ttsModelId, voice: settings.voice };
  assert.equal(store.saveSegmentAudio(doc.id, 0, Buffer.from("manual-no-tags"), meta, snapshot), true);
  assert.equal(store.getDocument(doc.id).segments[0].audioFresh, true);
  const automatic = create();
  assert.equal(store.updateDocument(automatic.id, { useTags: false }).segments[0].tagStatus, "ready");
});

test("current backup preserves pending/manual state and v1 import remains ready with its original model", () => {
  const pending = create();
  const manual = create();
  store.updateSegmentText(manual.id, 0, "手工稿", "手工稿");
  const { zip } = backup.exportBackup([pending.id, manual.id]);
  const entries = unzipSync(zip);
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString());
  assert.equal(manifest.version, 6);
  store.deleteDocument(pending.id);
  store.deleteDocument(manual.id);
  assert.equal(backup.importBackup(zip).imported, 2);
  assert.equal(store.getDocument(pending.id).segments[0].tagStatus, "pending");
  assert.equal(store.getDocument(manual.id).segments[0].tagStatus, "manual");
  const old = manifest.documents[0];
  old.id = "imported-v1";
  for (const segment of old.segments) { delete segment.tagStatus; delete segment.tagModelId; }
  const v1 = zipSync({ "manifest.json": Buffer.from(JSON.stringify({ ...manifest, version: 1, documents: [old] })) });
  backup.importBackup(v1);
  const imported = store.getDocument(old.id).segments[0];
  assert.equal(imported.tagStatus, "ready");
  assert.equal(imported.tagModelId, old.ttsModelId);
});

test("invalid v2 tag metadata rolls back overwrite instead of deleting an existing document", () => {
  const doc = create();
  const entries = unzipSync(backup.exportBackup([doc.id]).zip);
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString());
  manifest.documents[0].segments[0].tagStatus = "invalid";
  entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  assert.throws(() => backup.importBackup(zipSync(entries), "overwrite"), /标签状态无效/);
  assert.equal(store.getDocument(doc.id).segments[0].tagStatus, "pending");
});

test("a pending snapshot cannot be synthesized and deleting a document invalidates pending tag work", () => {
  const doc = create();
  const snapshot = store.getSegmentForTts(doc.id, 0);
  assert.equal(store.saveSegmentAudio(doc.id, 0, Buffer.from("unprepared"), { hash: "x", modelId: settings.ttsModelId, voice: settings.voice }, snapshot), false);
  store.deleteDocument(doc.id);
  assert.equal(store.saveSegmentTags(snapshot, "过时标签"), null);
  assert.equal(existsSync(path.join(dataDir, "audio", doc.id)), false);
});
