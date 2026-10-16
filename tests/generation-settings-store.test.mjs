import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { createQaWorkspace } from "../scripts/qa-workspace.mjs";

const workspace = createQaWorkspace("generation-settings-store");
const repo = fileURLToPath(new URL("../", import.meta.url));
process.env.DATA_DIR = path.join(workspace.dir, "data");
const failures = [];
let setupComplete = false;
globalThis.__preparedBlockCalls = [];
after(() => {
  try { globalThis.__readaloudDb?.close(); } catch (error) { failures.push(error); }
  delete globalThis.__readaloudDb;
  delete globalThis.__preparedBlockCalls;
  workspace.finish({ success: setupComplete && !failures.length, error: failures[0] ?? (setupComplete ? undefined : new Error("Test setup incomplete")),
    logs: failures.length ? { "failures.log": failures.map((error) => error.stack ?? String(error)).join("\n") } : {} });
});
const mockZenmux = "data:text/javascript," + encodeURIComponent(`
  export class UpstreamError extends Error {}
  export async function chatCompletion(options) {
    const content = options.messages.find(message => message.role === 'user').content;
    globalThis.__preparedBlockCalls.push({ model: options.model, content });
    options.onResponse?.({ requestId: 'local-prepared-blocks', httpStatus: 200 });
    const ids = [...content.matchAll(/<block id="(\\d+)"/g)].map(match => Number(match[1]));
    return JSON.stringify({ segments: ids.map(id => ({ id, speech: '模拟口述稿' + id })) });
  }
  export async function createSpeech() { throw new Error('Unexpected TTS request in script-only test'); }
`);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
  if (specifier === "next/server") return { url: "data:text/javascript,export async function connection(){}", shortCircuit: true };
  let candidate;
  if (specifier.startsWith("@/")) candidate = path.join(repo, "src", specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) candidate = fileURLToPath(new URL(specifier, context.parentURL));
  if (candidate === path.join(repo, "src/lib/zenmux") || candidate === path.join(repo, "src/lib/zenmux.ts")) return { url: mockZenmux, shortCircuit: true };
  if (candidate && !path.extname(candidate) && existsSync(candidate + ".ts")) return nextResolve(pathToFileURL(candidate + ".ts").href, context);
  return nextResolve(specifier, context);
} });
const { db } = await import("../src/lib/store/db.ts");
const store = await import("../src/lib/store/documents.ts");
const jobs = await import("../src/lib/store/jobs.ts");
const backup = await import("../src/lib/store/backup.ts");
const preferences = await import("../src/lib/store/generation-settings.ts");
const { getRuntimeSettings } = await import("../src/lib/store/runtime-settings.ts");
const settingsRoute = await import("../src/app/api/settings/generation/route.ts");
const { executeBackgroundJob } = await import("../src/lib/generation/worker.ts");
const { splitMarkdown } = await import("../src/lib/script/segment.ts");
const settings = { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: false, useStyle: true };
const confirmed = [
  { id: 0, kind: "text", markdown: "## 确认时的第一块\n\n保留 **原始 Markdown**。" },
  { id: 1, kind: "diagram", lang: "mermaid", markdown: "```mermaid\ngraph LR\n A-->B\n```" },
];
function draft(preparedBlocks = confirmed) {
  return jobs.createQueuedDocument({ sourceText: "这段原文按当前算法只会切成一个块。", settings, scriptModel: "local/mock", ...(preparedBlocks === null ? {} : { preparedBlocks }) });
}
function check(name, fn) {
  test(name, async () => { try { await fn(); } catch (error) { failures.push(error); throw error; } });
}
function reopen() { globalThis.__readaloudDb.close(); delete globalThis.__readaloudDb; }
afterEach(() => {
  for (const row of db().prepare("SELECT id FROM documents").all()) store.deleteDocument(row.id);
  preferences.updateGenerationSettings({ previewBeforeGeneration: true });
  globalThis.__preparedBlockCalls.length = 0;
});

check("v7 upgrade enables preview by default without altering existing blocks, audio or concurrency settings", () => {
  const old = store.createDocument({ sourceText: "旧原文", settings, scriptModel: "local/mock",
    blocks: [{ id: 0, kind: "text", markdown: "旧的固定分块" }], segments: [{ id: 0, speech: "旧口述稿", tagged: "旧口述稿" }] });
  const snapshot = store.getSegmentForTts(old.id, 0);
  store.saveSegmentAudio(old.id, 0, Buffer.from("old-audio"), { hash: store.audioHash({ text: snapshot.tagged, modelId: settings.ttsModelId, ...settings }), modelId: settings.ttsModelId, voice: settings.voice }, snapshot);
  const before = store.getDocument(old.id);
  const limits = getRuntimeSettings();
  const connection = db();
  connection.exec("DROP TABLE generation_settings; ALTER TABLE documents DROP COLUMN prepared_blocks_json; PRAGMA user_version = 7;");
  assert.deepEqual(preferences.getGenerationSettings(), { previewBeforeGeneration: true });
  assert.equal(db().prepare("PRAGMA user_version").get().user_version, 8);
  assert.deepEqual(store.getDocument(old.id), before);
  assert.equal(readFileSync(store.getSegmentAudioPath(old.id, 0), "utf8"), "old-audio");
  assert.equal(jobs.getPreparedBlocks(old.id), null);
  preferences.updateGenerationSettings({ previewBeforeGeneration: false });
  assert.deepEqual(store.getDocument(old.id), before);
  assert.deepEqual(getRuntimeSettings(), limits);
  assert.equal(Object.keys(getRuntimeSettings()).length, 4);
});

check("generation settings reject coercion and persist independently across database reopen", async () => {
  for (const value of [0, 1, "true", "false", null, [], {}]) {
    assert.throws(() => preferences.updateGenerationSettings({ previewBeforeGeneration: value }));
    const response = await settingsRoute.PATCH(new Request("http://local/api/settings/generation", { method: "PATCH", body: JSON.stringify({ previewBeforeGeneration: value }) }));
    assert.equal(response.status, 400);
  }
  const unknown = await settingsRoute.PATCH(new Request("http://local/api/settings/generation", { method: "PATCH", body: JSON.stringify({ other: true }) }));
  assert.equal(unknown.status, 400);
  const updated = await settingsRoute.PATCH(new Request("http://local/api/settings/generation", { method: "PATCH", body: JSON.stringify({ previewBeforeGeneration: false }) }));
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { previewBeforeGeneration: false });
  reopen();
  const response = await settingsRoute.GET();
  assert.deepEqual(await response.json(), { previewBeforeGeneration: false });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM documents").get().count, 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
  assert.equal(globalThis.__preparedBlockCalls.length, 0);
});

check("a queued preview is an immutable persisted copy that survives database reopen", () => {
  const input = structuredClone(confirmed);
  const doc = draft(input);
  input[0].markdown = "caller changed its array";
  assert.deepEqual(jobs.getPreparedBlocks(doc.id), confirmed);
  reopen();
  assert.deepEqual(jobs.getPreparedBlocks(doc.id), confirmed);
  assert.deepEqual(store.getDocument(doc.id).segments, []);
  assert.equal(store.getDocument(doc.id).generation.status, "queued");
  assert.equal(globalThis.__preparedBlockCalls.length, 0);
});

check("invalid prepared snapshots never leave a document or job behind", () => {
  for (const blocks of [[], [{ ...confirmed[0], id: 1 }], [{ ...confirmed[0], kind: "unknown" }], [{ ...confirmed[0], markdown: "  " }], [{ ...confirmed[0], extra: true }]]) {
    assert.throws(() => draft(blocks));
  }
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM documents").get().count, 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
});

check("worker uses the exact confirmed blocks after restart instead of re-splitting source text", async () => {
  const doc = draft();
  assert.equal(splitMarkdown(doc.sourceText).length, 1);
  reopen();
  const claim = jobs.claimNextJob("prepared-worker");
  await executeBackgroundJob(claim, new AbortController().signal);
  const stored = store.getDocument(doc.id);
  assert.equal(stored.generation.scriptReady, true);
  assert.deepEqual(stored.segments.map((segment) => ({ id: segment.idx, kind: segment.kind, markdown: segment.markdown, ...(segment.lang ? { lang: segment.lang } : {}) })), confirmed);
  assert.equal(globalThis.__preparedBlockCalls.length, 1);
  assert.match(globalThis.__preparedBlockCalls[0].content, /确认时的第一块/);
  assert.match(globalThis.__preparedBlockCalls[0].content, /graph LR/);
  assert.doesNotMatch(globalThis.__preparedBlockCalls[0].content, /按当前算法只会切成一个块/);
});

check("legacy drafts without a snapshot keep the old split-on-execution behavior", async () => {
  const doc = draft(null);
  const expected = splitMarkdown(doc.sourceText);
  assert.equal(jobs.getPreparedBlocks(doc.id), null);
  await executeBackgroundJob(jobs.claimNextJob("legacy-worker"), new AbortController().signal);
  assert.deepEqual(store.getDocument(doc.id).segments.map((segment) => segment.markdown), expected.map((block) => block.markdown));
  assert.equal(jobs.getPreparedBlocks(doc.id), null);
});

check("completeScript rejects a different segmentation and cannot overwrite confirmed or finished blocks", () => {
  const doc = draft();
  const claim = jobs.claimNextJob("snapshot-guard");
  const wrong = [{ id: 0, kind: "text", markdown: "重新切过的另一份结果" }];
  assert.equal(jobs.completeScript(claim, wrong, [{ id: 0, speech: "wrong", tagged: "wrong" }]), null);
  assert.equal(store.getDocument(doc.id).segments.length, 0);
  assert.deepEqual(jobs.getPreparedBlocks(doc.id), confirmed);
  const result = jobs.completeScript(claim, confirmed, confirmed.map((block) => ({ id: block.id, speech: "口述", tagged: "口述" })));
  assert.ok(result);
  assert.equal(jobs.completeScript(claim, wrong, []), null);
  assert.deepEqual(store.getDocument(doc.id).segments.map((segment) => segment.markdown), confirmed.map((block) => block.markdown));
});

check("backup v6 preserves pending snapshots and restores them paused without changing preview preference", async () => {
  const doc = draft();
  const zip = backup.exportBackup([doc.id]).zip;
  const manifest = JSON.parse(Buffer.from(unzipSync(zip)["manifest.json"]).toString());
  assert.equal(manifest.version, 6);
  assert.deepEqual(manifest.documents[0].preparedBlocks, confirmed);
  preferences.updateGenerationSettings({ previewBeforeGeneration: false });
  backup.importBackup(zip, "overwrite");
  assert.deepEqual(jobs.getPreparedBlocks(doc.id), confirmed);
  assert.equal(store.getDocument(doc.id).generation.status, "cancelled");
  assert.equal(jobs.claimNextJob("must-not-start"), null);
  assert.deepEqual(preferences.getGenerationSettings(), { previewBeforeGeneration: false });
  jobs.enqueueDocumentJobs(doc.id);
  await executeBackgroundJob(jobs.claimNextJob("restored-worker"), new AbortController().signal);
  assert.deepEqual(store.getDocument(doc.id).segments.map((segment) => segment.markdown), confirmed.map((block) => block.markdown));
});

check("legacy backup has no snapshot and a malformed v6 snapshot rolls back overwrite", () => {
  const doc = draft();
  const entries = unzipSync(backup.exportBackup([doc.id]).zip);
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString());
  manifest.documents[0].preparedBlocks[0].id = 9;
  entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  assert.throws(() => backup.importBackup(zipSync(entries), "overwrite"), /预览分块无效/);
  assert.deepEqual(jobs.getPreparedBlocks(doc.id), confirmed);
  manifest.version = 5;
  delete manifest.documents[0].preparedBlocks;
  entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  backup.importBackup(zipSync(entries), "overwrite");
  assert.equal(jobs.getPreparedBlocks(doc.id), null);
  assert.equal(store.getDocument(doc.id).generation.status, "cancelled");
});

setupComplete = true;
