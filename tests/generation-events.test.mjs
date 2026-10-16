import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync, zipSync } from "fflate";

const repo = fileURLToPath(new URL("../", import.meta.url));
const dataDir = mkdtempSync(path.join(tmpdir(), "voicepage-events-test-"));
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
const jobs = await import("../src/lib/store/jobs.ts");
const history = await import("../src/lib/store/generation-events.ts");
const backup = await import("../src/lib/store/backup.ts");
const { db } = await import("../src/lib/store/db.ts");
const realNow = Date.now;
let now;
beforeEach(() => { now = realNow(); Date.now = () => now; });
afterEach(() => {
  Date.now = realNow;
  for (const row of db().prepare("SELECT id FROM documents").all()) store.deleteDocument(row.id);
});
after(() => { globalThis.__readaloudDb?.close(); delete globalThis.__readaloudDb; rmSync(dataDir, { recursive: true, force: true }); });
const settings = { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: false, useStyle: true };
const blocks = [{ id: 0, kind: "text", markdown: "原文" }];
const segments = [{ id: 0, speech: "口述稿", tagged: "口述稿" }];
const transient = { category: "network", message: "网络连接中断", code: "ECONNRESET", requestId: "test-request",
  causes: [{ name: "TypeError", message: "fetch failed" }, { name: "Error", message: "socket reset", code: "ECONNRESET" }], retryable: true };
function create(useTags = false) {
  const doc = store.createDocument({ sourceText: "原文", settings: { ...settings, useTags }, scriptModel: "mock-script", blocks, segments });
  jobs.enqueueDocumentJobs(doc.id);
  return doc;
}
function claim(owner = "owner", phase = "tts") {
  const result = jobs.claimNextJob(owner);
  assert.ok(result);
  jobs.setJobPhase(result, phase);
  return result;
}
const events = (id) => history.listGenerationEvents(id, { limit: 100 }).events;
const row = (id) => ({ ...db().prepare("SELECT * FROM jobs WHERE doc_id = ? AND idx = 0").get(id) });
function saveAudio(doc, active) {
  const snapshot = store.getSegmentForTts(doc.id, 0);
  return store.saveSegmentAudio(doc.id, 0, Buffer.from("audio"), {
    hash: store.audioHash({ text: snapshot.tagged, modelId: settings.ttsModelId, ...settings }), modelId: settings.ttsModelId, voice: settings.voice,
  }, snapshot, active);
}

test("failure detail and bounded backoff persist atomically; claims cannot run before due", () => {
  const doc = create(true);
  const first = claim("first", "tags");
  const scheduled = jobs.failJobWithRetry(first, transient, "mock-script");
  assert.deepEqual(scheduled, { accepted: true, status: "queued", nextRetryAt: now + 5_000 });
  assert.equal(jobs.claimNextJob("too-early"), null);
  const segment = store.getDocument(doc.id).segments[0].generation;
  assert.equal(segment.autoRetryCount, 1);
  assert.equal(segment.error, undefined);
  assert.equal(segment.failurePhase, "tags");
  assert.deepEqual(segment.lastError, transient);
  const progress = jobs.getBackgroundProgress(doc.id);
  assert.equal(progress.retryingSegments, 1);
  assert.equal(progress.failurePhase, "tags");
  assert.equal(progress.nextRetryAt, now + 5_000);
  assert.deepEqual(events(doc.id).map((event) => event.type), ["retry_scheduled", "failed"]);
  assert.equal(events(doc.id)[0].modelId, "mock-script");
  assert.equal(jobs.failJobWithRetry(first, transient).accepted, false);
  assert.equal(events(doc.id).length, 2);
  now += 5_000;
  const retry = claim("retry", "tags");
  assert.equal(retry.attempt, 2);
  assert.equal(events(doc.id)[0].type, "retry_started");
  assert.equal(events(doc.id)[0].phase, "tags");
});

test("only two automatic retries are allowed; a manual retry resets budget but retains history and last error", () => {
  const doc = create();
  let active = claim();
  for (let retry = 1; retry <= 2; retry++) {
    const scheduled = jobs.failJobWithRetry(active, transient);
    assert.equal(scheduled.status, "queued");
    assert.equal(row(doc.id).auto_retry_count, retry);
    const beforeDuplicate = row(doc.id);
    jobs.enqueueDocumentJobs(doc.id, { force: true });
    assert.deepEqual(row(doc.id), beforeDuplicate);
    now = scheduled.nextRetryAt;
    active = claim(`retry-${retry}`);
  }
  assert.deepEqual(jobs.failJobWithRetry(active, transient), { accepted: true, status: "failed", nextRetryAt: undefined });
  assert.equal(jobs.claimNextJob("no-infinite-loop"), null);
  assert.equal(events(doc.id).filter((event) => event.type === "failed").length, 3);
  const count = events(doc.id).length;
  jobs.enqueueDocumentJobs(doc.id, { retryOnly: true });
  assert.equal(row(doc.id).auto_retry_count, 0);
  assert.deepEqual(store.getDocument(doc.id).segments[0].generation.lastError, transient);
  assert.equal(events(doc.id).length, count);
  const manual = claim("manual");
  assert.equal(events(doc.id)[0].retrySource, "manual");
  assert.equal(jobs.failJobWithRetry(manual, transient).status, "queued");
  assert.equal(row(doc.id).auto_retry_count, 1);
});

test("permanent errors never auto-retry and legacy failJob keeps a real failure event", () => {
  const doc = create();
  const permanent = { ...transient, category: "configuration", retryable: false, httpStatus: 401 };
  assert.equal(jobs.failJobWithRetry(claim(), permanent).status, "failed");
  assert.equal(row(doc.id).next_retry_at, null);
  assert.deepEqual(events(doc.id).map((event) => event.type), ["failed"]);
  jobs.enqueueDocumentJobs(doc.id, { retryOnly: true });
  assert.equal(jobs.failJob(claim("manual"), "旧调用的错误"), true);
  assert.equal(events(doc.id)[0].error.category, "unknown");
  assert.equal(events(doc.id)[0].error.retryable, false);
});

test("restart preserves due and budget; lease recovery adds resumed rather than invented failure", () => {
  const doc = create();
  const scheduled = jobs.failJobWithRetry(claim(), transient);
  globalThis.__readaloudDb.close(); delete globalThis.__readaloudDb;
  assert.equal(row(doc.id).auto_retry_count, 1);
  assert.equal(row(doc.id).next_retry_at, scheduled.nextRetryAt);
  assert.equal(jobs.claimNextJob("still-too-early"), null);
  now = scheduled.nextRetryAt;
  const expired = claim("crashed");
  db().prepare("UPDATE jobs SET lease_until = ? WHERE doc_id = ?").run(now - 1, doc.id);
  const recovered = claim("recovered");
  assert.equal(recovered.attempt, expired.attempt + 1);
  assert.equal(row(doc.id).auto_retry_count, 1);
  assert.equal(events(doc.id)[0].type, "resumed");
  assert.equal(events(doc.id).filter((event) => event.type === "failed").length, 1);
  assert.equal(jobs.failJobWithRetry(expired, transient).accepted, false);
  assert.equal(jobs.failJobWithRetry(recovered, transient).status, "queued");
  assert.equal(row(doc.id).auto_retry_count, 2);
});

test("cancel, edit and settings changes stop delayed retries without erasing error history", () => {
  for (const action of ["cancel", "edit", "settings"]) {
    const doc = create();
    const active = claim(action);
    jobs.failJobWithRetry(active, transient);
    if (action === "cancel") jobs.cancelDocumentJobs(doc.id);
    if (action === "edit") store.updateSegmentText(doc.id, 0, "手工稿", "手工稿");
    if (action === "settings") store.updateDocument(doc.id, { voice: "Kore" });
    assert.equal(row(doc.id).status, "cancelled");
    assert.equal(row(doc.id).next_retry_at, null);
    assert.equal(events(doc.id)[0].type, "cancelled");
    assert.equal(events(doc.id).filter((event) => event.type === "failed").length, 1);
    assert.equal(jobs.failJobWithRetry(active, transient).accepted, false);
    now += 1_000_000;
    assert.equal(jobs.claimNextJob("must-stay-stopped"), null);
  }
});

test("retried audio success records one success in the same transaction and keeps failure detail", () => {
  const doc = create();
  const scheduled = jobs.failJobWithRetry(claim(), transient);
  now = scheduled.nextRetryAt;
  const retry = claim("retry");
  assert.equal(saveAudio(doc, retry), true);
  assert.equal(jobs.completeJob(retry), false);
  assert.equal(saveAudio(doc, retry), false);
  assert.equal(events(doc.id).filter((event) => event.type === "succeeded").length, 1);
  assert.equal(events(doc.id)[0].phase, "tts");
  assert.equal(events(doc.id)[0].retryNumber, 1);
  assert.equal(store.getDocument(doc.id).generation.status, "completed");
  assert.deepEqual(store.getDocument(doc.id).segments[0].generation.lastError, transient);
});

test("tagging success survives TTS retry and failurePhase follows the actual failed model stage", () => {
  const doc = create(true);
  const active = claim("tags", "tags");
  store.saveSegmentTags(store.getSegmentForTags(doc.id, 0), "<short pause>口述稿", active);
  jobs.setJobPhase(active, "tts");
  const scheduled = jobs.failJobWithRetry(active, transient, settings.ttsModelId);
  assert.equal(store.getDocument(doc.id).segments[0].tagStatus, "ready");
  assert.equal(row(doc.id).failure_phase, "tts");
  now = scheduled.nextRetryAt;
  claim("tts-retry");
  assert.equal(store.getSegmentForTags(doc.id, 0).tagStatus, "ready");
  assert.equal(events(doc.id)[0].phase, "tts");
});

test("script failures retry with idx=-1 and completion preserves diagnosis without backfilling first successes", () => {
  const doc = jobs.createQueuedDocument({ sourceText: "原文", settings, scriptModel: "mock-script" });
  const active = claim("script", "spoken");
  const scheduled = jobs.failJobWithRetry(active, transient, "mock-script");
  assert.equal(jobs.getBackgroundProgress(doc.id).failurePhase, "spoken");
  assert.equal(jobs.getBackgroundProgress(doc.id).nextRetryAt, scheduled.nextRetryAt);
  now = scheduled.nextRetryAt;
  const retry = claim("retry-script", "spoken");
  assert.ok(jobs.completeScript(retry, blocks, segments));
  assert.equal(events(doc.id)[0].type, "succeeded");
  assert.equal(events(doc.id)[0].idx, -1);
  assert.equal(events(doc.id)[0].modelId, "mock-script");
  const segment = claim("first-segment");
  saveAudio(doc, segment);
  assert.equal(events(doc.id).some((event) => event.idx === 0), false);
});

test("a delayed retry suppresses duration-based ETA even when another segment is actively generating", () => {
  const doc = store.createDocument({ sourceText: "三段原文", settings, scriptModel: "mock-script",
    blocks: [0, 1, 2].map((id) => ({ ...blocks[0], id })), segments: [0, 1, 2].map((id) => ({ ...segments[0], id })) });
  jobs.enqueueDocumentJobs(doc.id);
  const completed = claim("sample");
  now += 10_000;
  assert.equal(saveAudio(doc, completed), true);
  const limited = claim("rate-limited");
  claim("still-generating");
  assert.ok(jobs.getBackgroundProgress(doc.id).estimatedRemainingMs > 0);
  jobs.failJobWithRetry(limited, { ...transient, category: "rate_limit", httpStatus: 429, retryAfterMs: 300_000 });
  const progress = jobs.getBackgroundProgress(doc.id);
  assert.equal(progress.speakingSegments, 1);
  assert.equal(progress.retryingSegments, 1);
  assert.equal(progress.nextRetryAt, now + 300_000);
  assert.equal(progress.estimatedRemainingMs, undefined);
});

test("pagination is ordered, exclusive and isolated per document", () => {
  const doc = create();
  jobs.failJobWithRetry(claim(), transient);
  jobs.cancelDocumentJobs(doc.id);
  jobs.enqueueDocumentJobs(doc.id);
  const manual = claim("manual");
  jobs.failJob(manual, "permanent");
  const all = events(doc.id);
  const first = history.listGenerationEvents(doc.id, { limit: 2 });
  const second = history.listGenerationEvents(doc.id, { limit: 2, before: first.nextCursor });
  const third = history.listGenerationEvents(doc.id, { limit: 2, before: second.nextCursor });
  assert.deepEqual([...first.events, ...second.events, ...third.events].map((event) => event.id), all.map((event) => event.id));
  assert.equal(third.nextCursor, undefined);
  assert.deepEqual(history.listGenerationEvents("other-document").events, []);
});

test("current backup preserves history and retry metadata but imports pending retries paused", () => {
  const doc = create();
  const scheduled = jobs.failJobWithRetry(claim(), { ...transient, retryAfterMs: 60_000 });
  const oldEvents = events(doc.id).map((event) => ({ ...event, id: 0 }));
  const zip = backup.exportBackup([doc.id]).zip;
  assert.equal(JSON.parse(Buffer.from(unzipSync(zip)["manifest.json"]).toString()).version, 6);
  backup.importBackup(zip, "overwrite");
  assert.equal(row(doc.id).status, "cancelled");
  assert.equal(row(doc.id).attempt, 1);
  assert.equal(row(doc.id).auto_retry_count, 1);
  assert.equal(row(doc.id).next_retry_at, null);
  assert.deepEqual(events(doc.id).map((event) => ({ ...event, id: 0 })), oldEvents);
  assert.equal(events(doc.id)[0].nextRetryAt, scheduled.nextRetryAt);
  assert.equal(jobs.claimNextJob("no-auto-charge"), null);
  jobs.enqueueDocumentJobs(doc.id);
  assert.equal(row(doc.id).auto_retry_count, 0);
  assert.equal(events(doc.id).length, oldEvents.length);
  assert.equal(claim("after-import").attempt, 2);
});

test("invalid backed-up events rollback while v4 backups import without fictional diagnostics", () => {
  const doc = create();
  jobs.failJobWithRetry(claim(), transient);
  const original = events(doc.id);
  const entries = unzipSync(backup.exportBackup([doc.id]).zip);
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString());
  manifest.documents[0].events[0].phase = "invalid";
  entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  assert.throws(() => backup.importBackup(zipSync(entries), "overwrite"), /事件历史无效/);
  assert.deepEqual(events(doc.id), original);
  manifest.version = 4;
  entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  backup.importBackup(zipSync(entries), "overwrite");
  assert.deepEqual(events(doc.id), []);
  assert.equal(row(doc.id).auto_retry_count, 0);
  assert.equal(row(doc.id).last_error_json, null);
});
