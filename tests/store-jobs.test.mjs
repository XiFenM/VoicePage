import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { unzipSync, zipSync } from "fflate";

const repo = fileURLToPath(new URL("../", import.meta.url));
const dataDir = mkdtempSync(path.join(tmpdir(), "voicepage-store-jobs-"));
process.env.DATA_DIR = dataDir;
function resolveStore(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
  let candidate;
  if (specifier.startsWith("@/")) candidate = path.join(repo, "src", specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) candidate = fileURLToPath(new URL(specifier, context.parentURL));
  if (candidate && !path.extname(candidate) && existsSync(candidate + ".ts")) return nextResolve(pathToFileURL(candidate + ".ts").href, context);
  return nextResolve(specifier, context);
}
registerHooks({ resolve: resolveStore });
const store = await import("../src/lib/store/documents.ts");
const jobs = await import("../src/lib/store/jobs.ts");
const backup = await import("../src/lib/store/backup.ts");
const { db } = await import("../src/lib/store/db.ts");
const { updateRuntimeSettings } = await import("../src/lib/store/runtime-settings.ts");
const settings = { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: false, useStyle: true };
const blocks = [{ id: 0, kind: "text", markdown: "原文第一段" }, { id: 1, kind: "text", markdown: "原文第二段" }];
const segments = [{ id: 0, speech: "口述第一段", tagged: "口述第一段" }, { id: 1, speech: "口述第二段", tagged: "口述第二段" }];
function draft(overrides = {}) {
  return jobs.createQueuedDocument({ sourceText: "完整原文", settings: { ...settings, ...overrides }, scriptModel: "test-model" });
}
function ready(count = 2, overrides = {}) {
  return store.createDocument({ sourceText: "完整原文", settings: { ...settings, ...overrides }, scriptModel: "test-model", blocks: blocks.slice(0, count), segments: segments.slice(0, count) });
}
function audioMeta(snapshot) {
  return { hash: store.audioHash({ text: snapshot.tagged, modelId: snapshot.settings.ttsModelId, ...snapshot.settings }), modelId: snapshot.settings.ttsModelId, voice: snapshot.settings.voice };
}
afterEach(() => {
  for (const row of db().prepare("SELECT id FROM documents").all()) store.deleteDocument(row.id);
});
after(() => {
  globalThis.__readaloudDb?.close();
  delete globalThis.__readaloudDb;
  rmSync(dataDir, { recursive: true, force: true });
});

test("creation persists a draft and one script job; existing documents remain idle without automatic jobs", () => {
  const doc = draft();
  assert.equal(doc.sourceText, "完整原文");
  assert.equal(doc.generation.scriptReady, false);
  assert.equal(doc.generation.status, "queued");
  assert.equal(doc.segments.length, 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
  const old = ready();
  assert.equal(old.generation.status, "idle");
  assert.equal(old.generation.scriptReady, true);
  assert.equal(old.segments[0].generation, undefined);
  assert.equal(store.listDocuments().find((entry) => entry.id === doc.id).generation.status, "queued");
});

test("legacy progress only counts audio matching the current script and settings", () => {
  const doc = ready(1);
  const snapshot = store.getSegmentForTts(doc.id, 0);
  store.saveSegmentAudio(doc.id, 0, Buffer.from("legacy"), audioMeta(snapshot), snapshot);
  assert.equal(store.getDocument(doc.id).generation.completedSegments, 1);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);

  store.updateSegmentText(doc.id, 0, "修改后的口述稿", "修改后的口述稿");
  const edited = store.getDocument(doc.id);
  assert.equal(edited.segments[0].audioFresh, false);
  assert.equal(edited.generation.completedSegments, 0);
  assert.equal(store.listDocuments()[0].generation.completedSegments, 0);
  assert.equal(jobs.claimNextJob("not-authorized"), null);

  const newSnapshot = store.getSegmentForTts(doc.id, 0);
  store.saveSegmentAudio(doc.id, 0, Buffer.from("updated"), audioMeta(newSnapshot), newSnapshot);
  assert.equal(store.getDocument(doc.id).generation.completedSegments, 1);
  store.updateDocument(doc.id, { ttsModelId: "x-ai/grok-voice-tts-1.0", voice: "eve" });
  const changed = store.getDocument(doc.id);
  assert.equal(changed.segments[0].audioFresh, false);
  assert.equal(changed.generation.completedSegments, 0);
  assert.equal(changed.generation.status, "idle");
});

test("claiming is globally bounded and repeated start does not reset an in-flight lease or force it", () => {
  const doc = ready();
  jobs.enqueueDocumentJobs(doc.id);
  const a = jobs.claimNextJob("a");
  const b = jobs.claimNextJob("b");
  assert.ok(a && b);
  assert.equal(jobs.claimNextJob("c"), null);
  jobs.enqueueDocumentJobs(doc.id, { force: true });
  assert.equal(jobs.isJobOwned(a), true);
  assert.equal(jobs.isJobOwned(b), true);
  const row = db().prepare("SELECT attempt, owner, force FROM jobs WHERE doc_id = ? AND idx = ?").get(a.docId, a.idx);
  assert.deepEqual({ ...row }, { attempt: 1, owner: "a", force: 0 });
});

test("independent processes share the configured two-document concurrency cap", async () => {
  updateRuntimeSettings({ taskConcurrency: 2 });
  draft(); draft(); draft();
  const runtime = `import {registerHooks} from 'node:module'; import {existsSync} from 'node:fs'; import path from 'node:path'; import {fileURLToPath,pathToFileURL} from 'node:url'; const repo=${JSON.stringify(repo)}; registerHooks({resolve:${resolveStore.toString()}}); const {claimNextJob}=await import(${JSON.stringify(pathToFileURL(path.join(repo, "src/lib/store/jobs.ts")).href)});`;
  const claimInProcess = (owner) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `${runtime} process.stdout.write(JSON.stringify(claimNextJob(${JSON.stringify(owner)})));`]);
    let output = "";
    let error = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { error += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  });
  const claims = await Promise.all([claimInProcess("process-a"), claimInProcess("process-b"), claimInProcess("process-c")]);
  assert.equal(claims.filter(Boolean).length, 2);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='running'").get().n, 2);
  updateRuntimeSettings({ taskConcurrency: 4 });
});

test("expired running jobs resume their phase and stale owner/attempt cannot mutate or renew them", () => {
  const doc = ready(1, { useTags: true });
  jobs.enqueueDocumentJobs(doc.id);
  const old = jobs.claimNextJob("same-owner");
  jobs.setJobPhase(old, "tags");
  const snapshot = store.getSegmentForTags(doc.id, 0);
  db().prepare("UPDATE jobs SET lease_until = ?").run(Date.now() - 1);
  assert.equal(jobs.renewJobLease(old), false);
  const recovered = jobs.claimNextJob("same-owner");
  assert.equal(recovered.phase, "tags");
  assert.equal(recovered.attempt, old.attempt + 1);
  assert.equal(jobs.isJobOwned(old), false);
  assert.equal(jobs.setJobPhase(old, "tts"), false);
  assert.equal(jobs.failJob(old, "旧错误"), false);
  assert.equal(store.saveSegmentTags(snapshot, "<short pause>口述第一段", old), null);
  assert.equal(store.saveSegmentTags(snapshot, "<short pause>口述第一段", recovered).tagStatus, "ready");
});

test("completeScript commits segments plus queued jobs atomically and cancellation blocks stale completion", () => {
  const doc = draft({ useTags: true });
  const first = jobs.claimNextJob("first");
  jobs.cancelDocumentJobs(doc.id);
  assert.equal(jobs.completeScript(first, blocks, segments), null);
  assert.equal(store.getDocument(doc.id).segments.length, 0);
  jobs.enqueueDocumentJobs(doc.id);
  const second = jobs.claimNextJob("second");
  const completed = jobs.completeScript(second, blocks, segments);
  assert.equal(completed.generation.scriptReady, true);
  assert.equal(completed.generation.queuedSegments, 2);
  assert.deepEqual(completed.segments.map((segment) => segment.tagStatus), ["pending", "pending"]);
  assert.equal(jobs.completeScript(second, blocks, segments), null);
});

test("failed jobs stay failed while other segments continue, until an explicit retry", () => {
  const doc = ready();
  jobs.enqueueDocumentJobs(doc.id);
  const first = jobs.claimNextJob("first");
  assert.equal(jobs.failJob(first, "模拟上游错误"), true);
  const second = jobs.claimNextJob("second");
  assert.notEqual(second.idx, first.idx);
  assert.equal(jobs.claimNextJob("third"), null);
  jobs.enqueueDocumentJobs(doc.id, { retryOnly: true });
  assert.equal(jobs.claimNextJob("retry").idx, first.idx);
  assert.equal(jobs.isJobOwned(second), true);
});

test("editing and settings changes invalidate leases; title-only rename does not", () => {
  const doc = ready(1);
  jobs.enqueueDocumentJobs(doc.id);
  const claim = jobs.claimNextJob("first");
  const snapshot = store.getSegmentForTts(doc.id, 0);
  store.updateDocument(doc.id, { title: "新标题" });
  assert.equal(jobs.isJobOwned(claim), true);
  store.updateSegmentText(doc.id, 0, "手工修改", "手工修改");
  assert.equal(jobs.isJobOwned(claim), false);
  assert.equal(store.saveSegmentAudio(doc.id, 0, Buffer.from("stale"), audioMeta(snapshot), snapshot, claim), false);
  assert.equal(store.getDocument(doc.id).segments[0].generation.status, "cancelled");
  jobs.enqueueDocumentJobs(doc.id);
  const fresh = jobs.claimNextJob("next");
  store.updateDocument(doc.id, { voice: "Kore" });
  assert.equal(jobs.isJobOwned(fresh), false);
  assert.equal(store.getDocument(doc.id).generation.status, "cancelled");
});

test("saving audio completes its job in the same transaction; forced same-input audio has a new URL", () => {
  const doc = ready(1);
  jobs.enqueueDocumentJobs(doc.id);
  const claim = jobs.claimNextJob("first");
  const snapshot = store.getSegmentForTts(doc.id, 0);
  assert.equal(store.saveSegmentAudio(doc.id, 0, Buffer.from("first"), audioMeta(snapshot), snapshot, claim), true);
  const before = store.getDocument(doc.id);
  assert.equal(before.generation.status, "completed");
  assert.equal(before.generation.completedSegments, 1);
  assert.equal(jobs.completeJob(claim), false);
  assert.equal(jobs.claimNextJob("unneeded"), null);
  jobs.enqueueDocumentJobs(doc.id, { force: true });
  const forced = jobs.claimNextJob("force");
  assert.equal(forced.force, true);
  assert.equal(store.saveSegmentAudio(doc.id, 0, Buffer.from("second"), audioMeta(snapshot), snapshot, forced), true);
  const afterDoc = store.getDocument(doc.id);
  assert.notEqual(afterDoc.segments[0].audioUrl, before.segments[0].audioUrl);
  assert.equal(afterDoc.segments[0].audioFresh, true);
  assert.equal(readFileSync(store.getSegmentAudioPath(doc.id, 0), "utf8"), "second");
});

test("backup preserves draft/results but pauses every incomplete job until explicit resume", () => {
  const incomplete = draft();
  const content = draft();
  const scriptA = jobs.claimNextJob("a");
  const scriptB = jobs.claimNextJob("b");
  const contentClaim = scriptA.docId === content.id ? scriptA : scriptB;
  jobs.completeScript(contentClaim, blocks, segments);
  const segmentClaim = jobs.claimNextJob("segment");
  const snapshot = store.getSegmentForTts(content.id, segmentClaim.idx);
  store.saveSegmentAudio(content.id, segmentClaim.idx, Buffer.from("kept"), audioMeta(snapshot), snapshot, segmentClaim);
  const zip = backup.exportBackup([incomplete.id, content.id]).zip;
  store.deleteDocument(incomplete.id); store.deleteDocument(content.id);
  backup.importBackup(zip);
  const paused = store.getDocument(incomplete.id);
  const partial = store.getDocument(content.id);
  assert.equal(paused.generation.scriptReady, false);
  assert.equal(paused.generation.status, "cancelled");
  assert.equal(partial.generation.scriptReady, true);
  assert.equal(partial.generation.completedSegments, 1);
  assert.equal(partial.generation.status, "cancelled");
  assert.equal(jobs.claimNextJob("must-not-charge"), null);
  jobs.enqueueDocumentJobs(incomplete.id);
  assert.equal(jobs.claimNextJob("explicit").kind, "script");
});

test("legacy backup overwrite may reset attempt, but a new claim owner fences the pre-import worker", () => {
  const doc = ready(1);
  jobs.enqueueDocumentJobs(doc.id);
  const oldClaim = jobs.claimNextJob("executor:old-unique-owner");
  const oldSnapshot = store.getSegmentForTts(doc.id, 0);
  const entries = unzipSync(backup.exportBackup([doc.id]).zip);
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString());
  manifest.version = 4; // 旧备份没有持久 attempt；当前 v5 会保留它。
  entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  backup.importBackup(zipSync(entries), "overwrite");
  assert.equal(jobs.isJobOwned(oldClaim), false);
  assert.equal(store.getDocument(doc.id).generation.status, "cancelled");
  jobs.enqueueDocumentJobs(doc.id);
  const newClaim = jobs.claimNextJob("executor:new-unique-owner");
  assert.equal(newClaim.attempt, oldClaim.attempt);
  assert.notEqual(newClaim.owner, oldClaim.owner);
  assert.equal(jobs.isJobOwned(newClaim), true);

  assert.equal(jobs.setJobPhase(oldClaim, "tts"), false);
  assert.equal(jobs.completeJob(oldClaim), false);
  assert.equal(jobs.failJob(oldClaim, "过期执行器错误"), false);
  assert.equal(store.saveSegmentAudio(doc.id, 0, Buffer.from("stale"), audioMeta(oldSnapshot), oldSnapshot, oldClaim), false);
  assert.equal(store.getSegmentAudioPath(doc.id, 0), null);

  const current = store.getSegmentForTts(doc.id, 0);
  assert.equal(store.saveSegmentAudio(doc.id, 0, Buffer.from("current"), audioMeta(current), current, newClaim), true);
  assert.equal(readFileSync(store.getSegmentAudioPath(doc.id, 0), "utf8"), "current");
  assert.equal(store.getDocument(doc.id).generation.status, "completed");
});

test("legacy v2 backup imports as an idle finished script without creating a paid job", () => {
  const doc = ready(1, { useTags: true });
  const entries = unzipSync(backup.exportBackup([doc.id]).zip);
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString());
  manifest.version = 2;
  delete manifest.documents[0].jobs;
  delete manifest.documents[0].scriptReady;
  entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  store.deleteDocument(doc.id);
  backup.importBackup(zipSync(entries));
  const imported = store.getDocument(doc.id);
  assert.equal(imported.generation.scriptReady, true);
  assert.equal(imported.generation.status, "idle");
  assert.equal(imported.segments[0].tagStatus, "pending");
  assert.equal(jobs.claimNextJob("unused"), null);
});

test("ETA is based on completed segment durations and disappears when running exceeds its evidence", () => {
  const doc = ready();
  jobs.enqueueDocumentJobs(doc.id);
  const first = jobs.claimNextJob("first");
  jobs.completeJob(first);
  const now = Date.now();
  db().prepare("UPDATE jobs SET started_at=?, finished_at=? WHERE doc_id=? AND idx=?").run(now - 11_000, now - 1_000, doc.id, first.idx);
  assert.equal(jobs.getBackgroundProgress(doc.id).estimatedRemainingMs, undefined);
  const next = jobs.claimNextJob("next");
  jobs.setJobPhase(next, "tts");
  assert.ok(jobs.getBackgroundProgress(doc.id).estimatedRemainingMs > 0);
  db().prepare("UPDATE jobs SET started_at=? WHERE doc_id=? AND idx=?").run(now - 30_000, doc.id, next.idx);
  assert.equal(jobs.getBackgroundProgress(doc.id).estimatedRemainingMs, undefined);
});
