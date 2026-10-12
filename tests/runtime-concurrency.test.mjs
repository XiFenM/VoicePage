import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const repo = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), "voicepage-concurrency-"));
process.env.DATA_DIR = directory;
function resolveStore(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
  let candidate;
  if (specifier.startsWith("@/")) candidate = path.join(repo, "src", specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) candidate = fileURLToPath(new URL(specifier, context.parentURL));
  if (candidate && !path.extname(candidate) && existsSync(candidate + ".ts")) return nextResolve(pathToFileURL(candidate + ".ts").href, context);
  return nextResolve(specifier, context);
}
registerHooks({ resolve: resolveStore });
const { db } = await import("../src/lib/store/db.ts");
const store = await import("../src/lib/store/documents.ts");
const jobs = await import("../src/lib/store/jobs.ts");
const permits = await import("../src/lib/store/model-permits.ts");
const preferences = await import("../src/lib/store/runtime-settings.ts");
const { DEFAULT_RUNTIME_SETTINGS } = await import("../src/lib/runtime-settings.ts");
const settings = { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: true, useStyle: true };

beforeEach(() => {
  db().exec("DELETE FROM model_permits; DELETE FROM documents;");
  preferences.updateRuntimeSettings(DEFAULT_RUNTIME_SETTINGS);
});
after(() => { db().close(); delete globalThis.__readaloudDb; rmSync(directory, { recursive: true, force: true }); });
const draft = () => jobs.createQueuedDocument({ sourceText: "测试原文", settings, scriptModel: "local/mock" });
function ready(count = 3) {
  const blocks = Array.from({ length: count }, (_, id) => ({ id, kind: "text", markdown: `第${id}段` }));
  const doc = store.createDocument({ sourceText: "测试", settings, scriptModel: "local/mock", blocks,
    segments: blocks.map(({ id }) => ({ id, speech: `口述${id}`, tagged: `口述${id}` })) });
  jobs.enqueueDocumentJobs(doc.id);
  return doc;
}

test("runtime settings are persisted, independently bounded integers and reject invalid input atomically", () => {
  assert.deepEqual(preferences.getRuntimeSettings(), DEFAULT_RUNTIME_SETTINGS);
  preferences.updateRuntimeSettings({ taskConcurrency: 6, ttsConcurrency: 9 });
  assert.deepEqual(preferences.getRuntimeSettings(), { ...DEFAULT_RUNTIME_SETTINGS, taskConcurrency: 6, ttsConcurrency: 9 });
  for (const invalid of [{ textConcurrency: 0 }, { ttsConcurrency: 33 }, { taskConcurrency: 2.5 }, { segmentConcurrency: 17 }, { mystery: 2 }]) {
    assert.throws(() => preferences.updateRuntimeSettings(invalid));
  }
  assert.equal(preferences.getRuntimeSettings().ttsConcurrency, 9);
});

test("document slots and per-document segment slots are distinct limits", () => {
  preferences.updateRuntimeSettings({ taskConcurrency: 2, segmentConcurrency: 1 });
  const a = ready(); const b = ready(); ready();
  const first = jobs.claimNextJob("first");
  const second = jobs.claimNextJob("second");
  assert.deepEqual(new Set([first.docId, second.docId]), new Set([a.id, b.id]));
  assert.equal(jobs.claimNextJob("third"), null);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='running'").get().n, 2);
  preferences.updateRuntimeSettings({ taskConcurrency: 3 });
  assert.ok(jobs.claimNextJob("third"));
});

test("a full text pool cannot block a ready TTS segment behind waiting tag jobs", () => {
  preferences.updateRuntimeSettings({ taskConcurrency: 1, textConcurrency: 1, ttsConcurrency: 2, segmentConcurrency: 2 });
  const doc = ready(3);
  store.updateSegmentText(doc.id, 2, "可以直接发声", "可以直接发声");
  jobs.enqueueDocumentJobs(doc.id, { indices: [2] });
  const tag = jobs.claimNextJob("tags");
  assert.equal(tag.idx, 0);
  assert.ok(permits.tryAcquireModelPermit("text", tag, 60_000));
  const voice = jobs.claimNextJob("voice");
  assert.equal(voice.idx, 2);
  assert.ok(permits.tryAcquireModelPermit("tts", voice, 60_000));
  assert.deepEqual(permits.activeModelCounts(), { text: 1, tts: 1 });
});

test("lowering a model cap drains existing requests; raising it admits waiting work", () => {
  for (let i = 0; i < 4; i++) draft();
  const claims = Array.from({ length: 4 }, (_, i) => jobs.claimNextJob(`owner-${i}`));
  const tokens = claims.slice(0, 3).map((claim) => permits.tryAcquireModelPermit("text", claim, 60_000));
  preferences.updateRuntimeSettings({ textConcurrency: 1 });
  assert.equal(permits.activeModelCounts().text, 3);
  assert.ok(claims.slice(0, 3).every((claim) => jobs.isJobOwned(claim)));
  assert.equal(permits.tryAcquireModelPermit("text", claims[3], 60_000), null);
  permits.releaseModelPermit(tokens[0]); permits.releaseModelPermit(tokens[1]);
  assert.equal(permits.tryAcquireModelPermit("text", claims[3], 60_000), null);
  preferences.updateRuntimeSettings({ textConcurrency: 3 });
  assert.ok(permits.tryAcquireModelPermit("text", claims[3], 60_000));
});

test("expired permits recover, and old job owners cannot consume another permit", () => {
  draft();
  const stale = jobs.claimNextJob("stale");
  const token = permits.tryAcquireModelPermit("text", stale, 60_000);
  db().prepare("UPDATE jobs SET lease_until=0 WHERE doc_id=?").run(stale.docId);
  db().prepare("UPDATE model_permits SET lease_until=0 WHERE token=?").run(token);
  const next = jobs.claimNextJob("new");
  assert.equal(permits.tryAcquireModelPermit("text", stale, 60_000), null);
  assert.ok(permits.tryAcquireModelPermit("text", next, 60_000));
  permits.releaseModelPermit(token);
  assert.equal(permits.activeModelCounts().text, 1);
});

test("job and model permit renew together; cancelled owners cannot extend either lease", () => {
  draft();
  const claim = jobs.claimNextJob("heartbeat");
  const token = permits.tryAcquireModelPermit("text", claim, 60_000);
  assert.equal(jobs.renewJobLease(claim, 120_000), true);
  assert.equal(db().prepare("SELECT lease_until FROM model_permits WHERE token=?").get(token).lease_until, claim.leaseUntil);
  const until = claim.leaseUntil;
  jobs.cancelDocumentJobs(claim.docId);
  assert.equal(jobs.renewJobLease(claim, 240_000), false);
  assert.equal(db().prepare("SELECT lease_until FROM model_permits WHERE token=?").get(token).lease_until, until);
});

test("model permits are bounded across independent processes, separately for text and TTS", async () => {
  preferences.updateRuntimeSettings({ taskConcurrency: 8, textConcurrency: 2, ttsConcurrency: 3 });
  for (let i = 0; i < 8; i++) draft();
  const claims = Array.from({ length: 8 }, (_, i) => jobs.claimNextJob(`process-${i}`));
  const runtime = `import {registerHooks} from 'node:module'; import {existsSync} from 'node:fs'; import path from 'node:path'; import {fileURLToPath,pathToFileURL} from 'node:url'; const repo=${JSON.stringify(repo)}; registerHooks({resolve:${resolveStore.toString()}}); const {tryAcquireModelPermit}=await import(${JSON.stringify(pathToFileURL(path.join(repo, "src/lib/store/model-permits.ts")).href)});`;
  const acquire = (claim, kind) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `${runtime} process.stdout.write(JSON.stringify(tryAcquireModelPermit(${JSON.stringify(kind)},${JSON.stringify(claim)},60000)));`]);
    let output = "", errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
  const got = await Promise.all(claims.map((claim, i) => acquire(claim, i < 4 ? "text" : "tts")));
  assert.equal(got.slice(0, 4).filter(Boolean).length, 2);
  assert.equal(got.slice(4).filter(Boolean).length, 3);
  assert.deepEqual(permits.activeModelCounts(), { text: 2, tts: 3 });
});
