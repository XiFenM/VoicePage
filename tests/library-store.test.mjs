import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zipSync, unzipSync } from "fflate";

const repo = fileURLToPath(new URL("../", import.meta.url));
const dataDir = mkdtempSync(path.join(tmpdir(), "voicepage-library-test-"));
process.env.DATA_DIR = dataDir;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
  let candidate;
  if (specifier.startsWith("@/")) candidate = path.join(repo, "src", specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) candidate = fileURLToPath(new URL(specifier, context.parentURL));
  if (candidate && !path.extname(candidate) && existsSync(candidate + ".ts")) return nextResolve(pathToFileURL(candidate + ".ts").href, context);
  return nextResolve(specifier, context);
} });
const store = await import("../src/lib/store/documents.ts");
const library = await import("../src/lib/store/collections.ts");
const jobs = await import("../src/lib/store/jobs.ts");
const backup = await import("../src/lib/store/backup.ts");
const { db } = await import("../src/lib/store/db.ts");
const settings = { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: false, useStyle: true };

// 模拟已有 v4 用户库；升级前既没有容器，也没有调度偏好表。
const legacy = new DatabaseSync(path.join(dataDir, "readaloud.db"));
legacy.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, source_text TEXT NOT NULL, persona_id TEXT NOT NULL,
    tts_model_id TEXT NOT NULL, voice TEXT NOT NULL, use_tags INTEGER NOT NULL, use_style INTEGER NOT NULL,
    script_model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, script_ready INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE segments (doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
    kind TEXT NOT NULL, lang TEXT, markdown TEXT NOT NULL, speech TEXT NOT NULL, tagged TEXT NOT NULL,
    audio_file TEXT, audio_hash TEXT, audio_bytes INTEGER, audio_model_id TEXT, audio_voice TEXT, updated_at INTEGER NOT NULL,
    tag_status TEXT NOT NULL DEFAULT 'ready', tag_model_id TEXT, tag_revision INTEGER NOT NULL DEFAULT 0, audio_version TEXT,
    PRIMARY KEY(doc_id,idx));
  CREATE TABLE jobs (doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, idx INTEGER NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0, owner TEXT,
    lease_until INTEGER, force INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    started_at INTEGER, finished_at INTEGER, error TEXT, PRIMARY KEY(doc_id,idx));
  PRAGMA user_version=4;
`);
for (const [id, updated] of [["old-a", 10], ["old-b", 20]]) {
  legacy.prepare("INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(id, id, "旧原文", settings.personaId, settings.ttsModelId, settings.voice, 0, 1, "mock", 1, updated, 1);
}
globalThis.__readaloudDb = legacy;

afterEach(() => {
  for (const row of db().prepare("SELECT id FROM documents").all()) store.deleteDocument(row.id);
  db().exec("DELETE FROM collections");
});
after(() => {
  globalThis.__readaloudDb?.close();
  delete globalThis.__readaloudDb;
  rmSync(dataDir, { recursive: true, force: true });
});

const group = (name = "Group") => library.createCollection({ kind: "group", name });
const session = (parentId = null, name = "Session") => library.createCollection({ kind: "session", name, parentId });
function document(sessionId = null, text = "原文") {
  return store.createDocument({ sourceText: text, sessionId, settings, scriptModel: "mock",
    blocks: [{ id: 0, kind: "text", markdown: text }], segments: [{ id: 0, speech: text, tagged: text }] });
}
function attachAudio(doc, contents = "audio") {
  const snapshot = store.getSegmentForTts(doc.id, 0);
  store.saveSegmentAudio(doc.id, 0, Buffer.from(contents), { hash: store.audioHash({ text: snapshot.tagged, modelId: settings.ttsModelId, ...settings }), modelId: settings.ttsModelId, voice: settings.voice }, snapshot);
  return store.getDocument(doc.id);
}
const collectionsAt = (parentId) => library.getLibrary().collections.filter((item) => item.parentId === parentId).sort((a, b) => a.position - b.position).map((item) => item.id);
const documentsAt = (sessionId) => library.getLibrary().documents.filter((item) => item.sessionId === sessionId).sort((a, b) => a.position - b.position).map((item) => item.id);
const unpack = (zip) => JSON.parse(Buffer.from(unzipSync(zip)["manifest.json"]).toString());
function changeManifest(zip, change) {
  const entries = unzipSync(zip);
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString());
  change(manifest, entries);
  entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  return zipSync(entries);
}

test("v4 migration leaves old records unarchived in their existing recency order", () => {
  const tree = library.getLibrary();
  assert.equal(db().prepare("PRAGMA user_version").get().user_version, 7);
  assert.deepEqual(tree.collections, []);
  assert.deepEqual(documentsAt(null), ["old-b", "old-a"]);
  assert.deepEqual(tree.documents.map((doc) => doc.sessionId), [null, null]);
  assert.equal(store.getDocument("old-a").updatedAt, 10);
  assert.deepEqual({ ...db().prepare("SELECT * FROM runtime_settings").get() }, { id: 1, task_concurrency: 4, text_concurrency: 4, tts_concurrency: 4, segment_concurrency: 2, updated_at: 0 });
  assert.deepEqual(db().prepare("PRAGMA foreign_key_list(model_permits)").all(), []);
  assert.equal(jobs.claimNextJob("no-new-work"), null);
});

test("new documents and queued drafts accept only Session parents and append in order", () => {
  const g = group();
  const s = session(g.id);
  const first = document(s.id);
  const second = jobs.createQueuedDocument({ sourceText: "待生成", settings, scriptModel: "mock", sessionId: s.id });
  assert.equal(second.sessionId, s.id);
  assert.equal(second.position, 1);
  assert.deepEqual(documentsAt(s.id), [first.id, second.id]);
  assert.throws(() => document(g.id), /Session/);
  assert.throws(() => jobs.createQueuedDocument({ sourceText: "不能保存", settings, scriptModel: "mock", sessionId: "missing" }), /Session/);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
  assert.equal(document().sessionId, null);
});

test("root groups and sessions can mix and relative moves preserve unrelated new siblings", () => {
  const a = group("a"), b = session(null, "b"), c = group("c");
  const added = session(null, "added");
  library.moveLibraryItem({ kind: "group", id: c.id, parentId: null, beforeId: a.id });
  assert.deepEqual(collectionsAt(null), [c.id, a.id, b.id, added.id]);
  library.updateCollection(b.id, { beforeId: c.id, name: "renamed" });
  assert.deepEqual(collectionsAt(null), [b.id, c.id, a.id, added.id]);
  assert.equal(library.getCollection(b.id).name, "renamed");
});

test("omitted parent retains its container while explicit null moves to root; null beforeId appends", () => {
  const g = group(), root = session(null, "root"), a = session(g.id, "a"), b = session(g.id, "b");
  library.updateCollection(a.id, { name: "renamed" });
  assert.equal(library.getCollection(a.id).parentId, g.id);
  assert.deepEqual(collectionsAt(g.id), [a.id, b.id]);
  library.updateCollection(a.id, { beforeId: null });
  assert.deepEqual(collectionsAt(g.id), [b.id, a.id]);
  library.updateCollection(a.id, { beforeId: b.id });
  assert.deepEqual(collectionsAt(g.id), [a.id, b.id]);
  library.updateCollection(a.id, { parentId: null, beforeId: root.id });
  assert.deepEqual(collectionsAt(null), [g.id, a.id, root.id]);
  const first = document(), second = document(b.id);
  library.moveLibraryItem({ kind: "document", id: second.id, parentId: null, beforeId: null });
  assert.deepEqual(documentsAt(null), [first.id, second.id]);
  assert.deepEqual(documentsAt(b.id), []);
});

test("cross-parent moves reorder Sessions and documents without resetting tasks or audio", () => {
  const ga = group("a"), gb = group("b");
  const sa = session(ga.id), sb = session(gb.id);
  const a = attachAudio(document(sa.id), "preserved");
  const b = document(sb.id);
  jobs.enqueueDocumentJobs(a.id, { force: true });
  const claim = jobs.claimNextJob("running");
  const previous = { ...db().prepare("SELECT * FROM jobs WHERE doc_id = ?").get(a.id) };
  const timestamp = store.getDocument(a.id).updatedAt;
  library.moveLibraryItem({ kind: "document", id: a.id, parentId: sb.id, beforeId: b.id });
  library.moveLibraryItem({ kind: "session", id: sb.id, parentId: ga.id, beforeId: sa.id });
  assert.deepEqual(documentsAt(sb.id), [a.id, b.id]);
  assert.deepEqual(documentsAt(sa.id), []);
  assert.deepEqual(collectionsAt(ga.id), [sb.id, sa.id]);
  const moved = store.getDocument(a.id);
  assert.equal(moved.updatedAt, timestamp);
  assert.equal(moved.segments[0].audioUrl, a.segments[0].audioUrl);
  assert.equal(readFileSync(store.getSegmentAudioPath(a.id, 0), "utf8"), "preserved");
  assert.deepEqual({ ...db().prepare("SELECT * FROM jobs WHERE doc_id = ?").get(a.id) }, previous);
  assert.equal(jobs.isJobOwned(claim), true);
});

test("invalid types, cycles and beforeIds are rejected atomically", () => {
  const a = group("original"), b = group(), sa = session(a.id), sb = session(b.id), doc = document(sa.id);
  for (const move of [
    { kind: "group", id: a.id, parentId: b.id },
    { kind: "session", id: sa.id, parentId: sa.id },
    { kind: "session", id: sa.id, parentId: sb.id },
    { kind: "document", id: doc.id, parentId: a.id },
    { kind: "document", id: doc.id, parentId: sb.id, beforeId: sa.id },
    { kind: "session", id: sa.id, parentId: a.id, beforeId: sb.id },
    { kind: "group", id: sa.id, parentId: null },
  ]) assert.throws(() => library.moveLibraryItem(move));
  assert.throws(() => library.updateCollection(a.id, { name: "must rollback", parentId: b.id }));
  assert.equal(library.getCollection(a.id).name, "original");
  assert.equal(store.getDocument(doc.id).sessionId, sa.id);
});

test("deleting Group lifts its Sessions into its root position without changing documents", () => {
  const before = session(null, "before"), g = group(), after = group("after");
  const a = session(g.id, "a"), b = session(g.id, "b"), doc = attachAudio(document(a.id));
  assert.equal(library.deleteCollection(g.id), true);
  assert.deepEqual(collectionsAt(null), [before.id, a.id, b.id, after.id]);
  const preserved = store.getDocument(doc.id);
  assert.equal(preserved.sessionId, a.id);
  assert.equal(preserved.updatedAt, doc.updatedAt);
  assert.equal(preserved.segments[0].audioUrl, doc.segments[0].audioUrl);
});

test("deleting Session appends documents to unarchived and keeps live jobs/audio intact", () => {
  const existing = document();
  const s = session();
  const a = attachAudio(document(s.id)), b = document(s.id);
  jobs.enqueueDocumentJobs(b.id);
  const claim = jobs.claimNextJob("keep-running");
  const oldTimes = [store.getDocument(a.id).updatedAt, store.getDocument(b.id).updatedAt];
  library.deleteCollection(s.id);
  assert.deepEqual(documentsAt(null), [existing.id, a.id, b.id]);
  assert.equal(jobs.isJobOwned(claim), true);
  assert.deepEqual([store.getDocument(a.id).updatedAt, store.getDocument(b.id).updatedAt], oldTimes);
  assert.equal(readFileSync(store.getSegmentAudioPath(a.id, 0), "utf8"), "audio");
});

test("partial backup includes only ancestor containers; full backup preserves empty containers and order", () => {
  const g = group(), s = session(g.id), empty = group("empty"), rootSession = session(null, "root");
  const a = document(s.id), b = document(s.id);
  library.moveLibraryItem({ kind: "document", id: b.id, parentId: s.id, beforeId: a.id });
  const partial = unpack(backup.exportBackup([a.id]).zip);
  assert.equal(partial.version, 5);
  assert.deepEqual(new Set(partial.collections.map((item) => item.id)), new Set([g.id, s.id]));
  assert.equal(partial.documents[0].sessionId, s.id);
  const zip = backup.exportBackup().zip;
  for (const doc of store.listDocuments()) store.deleteDocument(doc.id);
  db().exec("DELETE FROM collections");
  backup.importBackup(zip);
  assert.deepEqual(documentsAt(s.id), [b.id, a.id]);
  assert.deepEqual(collectionsAt(null), [g.id, empty.id, rootSession.id]);
});

test("skip preserves existing container metadata; overwrite restores it without deleting extra children", () => {
  const g = group("saved-name"), s = session(g.id), doc = document(s.id);
  const zip = backup.exportBackup([doc.id]).zip;
  library.updateCollection(g.id, { name: "local-name" });
  library.updateCollection(s.id, { parentId: null });
  const extraSession = session(g.id, "local-extra"), extraDocument = document(s.id, "local-extra-doc");
  const skipped = backup.importBackup(zip, "skip");
  assert.equal(skipped.skipped, 1);
  assert.equal(library.getCollection(g.id).name, "local-name");
  assert.equal(library.getCollection(s.id).parentId, null);
  backup.importBackup(zip, "overwrite");
  assert.equal(library.getCollection(g.id).name, "saved-name");
  assert.equal(library.getCollection(s.id).parentId, g.id);
  assert.equal(library.getCollection(extraSession.id).parentId, g.id);
  assert.equal(store.getDocument(extraDocument.id).sessionId, s.id);
});

test("container ID kind conflicts and dangling parents reject import without partial hierarchy changes", () => {
  const g = group("original"), s = session(g.id), doc = document(s.id);
  const zip = backup.exportBackup([doc.id]).zip;
  const conflicting = changeManifest(zip, (manifest) => {
    manifest.collections.find((item) => item.id === g.id).name = "must rollback";
    const item = manifest.collections.find((item) => item.id === s.id);
    item.kind = "group"; item.parentId = null;
  });
  assert.throws(() => backup.importBackup(conflicting, "overwrite"), /类型.*冲突/);
  assert.equal(library.getCollection(g.id).name, "original");
  const orphan = changeManifest(zip, (manifest) => { manifest.collections.find((item) => item.id === s.id).parentId = "missing-group"; });
  assert.throws(() => backup.importBackup(orphan, "overwrite"), /Group/);
  assert.equal(store.getDocument(doc.id).sessionId, s.id);
});

test("a late invalid document rolls back all database and previously swapped audio changes", () => {
  const g = group("original"), s = session(g.id);
  const a = attachAudio(document(s.id, "a"), "original-a"), b = attachAudio(document(s.id, "b"), "original-b");
  const zip = backup.exportBackup([a.id, b.id]).zip;
  const invalid = changeManifest(zip, (manifest, entries) => {
    manifest.collections.find((item) => item.id === g.id).name = "must rollback";
    const first = manifest.documents[0];
    first.title = "must rollback";
    entries[first.segments[0].audio] = Buffer.from("replacement");
    manifest.documents[1].segments[0].tagStatus = "invalid";
  });
  assert.throws(() => backup.importBackup(invalid, "overwrite"), /标签状态无效/);
  assert.equal(library.getCollection(g.id).name, "original");
  assert.equal(store.getDocument(a.id).title, a.title);
  assert.equal(readFileSync(store.getSegmentAudioPath(a.id, 0), "utf8"), "original-a");
  assert.equal(readFileSync(store.getSegmentAudioPath(b.id, 0), "utf8"), "original-b");
});

test("legacy v3 backup imports into unarchived without overwriting runtime preferences", () => {
  const s = session(), doc = document(s.id);
  const zip = changeManifest(backup.exportBackup([doc.id]).zip, (manifest) => {
    manifest.version = 3; delete manifest.collections;
    for (const item of manifest.documents) { delete item.sessionId; delete item.position; }
  });
  store.deleteDocument(doc.id);
  db().prepare("UPDATE runtime_settings SET task_concurrency = 7").run();
  backup.importBackup(zip);
  assert.equal(store.getDocument(doc.id).sessionId, null);
  assert.equal(db().prepare("SELECT task_concurrency FROM runtime_settings").get().task_concurrency, 7);
});
