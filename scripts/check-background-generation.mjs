/**
 * Real HTTP + process-lifecycle checks against an isolated Next dev instance.
 * Run: node scripts/check-background-generation.mjs
 *
 * Copies source/config and isolated dependencies (never .env files), injects a local fake model and
 * test credentials, and uses a fresh SQLite/audio directory. No paid API calls.
 * Abruptly restarts its own Next process and waits for lease recovery, using a
 * 6s lease for this fixture (set TEST_LEASE_MS=60000 to test the 60s default).
 * Success removes the temporary workspace; failures retain bounded diagnostic logs only.
 */
import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createMockZenmux } from "./mock-zenmux.mjs";
import { createQaWorkspace, prepareQaSource, stopQaProcess, closeQaServer } from "./qa-workspace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let workspace;
let fixture;
let dataDir;
let mock;
let reserve;
let appPort;
let app;
let mockUrl;
let appEnv;
let nextRuntime;
let child;
let database;
let logs = "";
let cookie = "";
let success = false;
let failure;
let cleanupPromise;
let interrupted = false;
const runAbort = new AbortController();
const token = `MOCK_CASE_bg${Date.now()}`;
const delay = (ms) => sleep(ms, undefined, { signal: runAbort.signal });

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    runAbort.abort(new Error("QA cleanup"));
    const errors = [];
    for (const release of [
      () => stopQaProcess(child),
      () => { database?.close(); database = undefined; },
      () => closeQaServer(reserve),
      () => closeQaServer(mock?.server),
    ]) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    const primaryFailure = failure;
    if (errors.length) failure = new AggregateError(primaryFailure ? [primaryFailure, ...errors] : errors, "QA resource cleanup failed");
    try {
      workspace?.finish({ success: success && !failure, error: primaryFailure ?? failure, logs: {
        "next-test.log": logs, "mock-events.json": mock?.events ?? [],
        ...(errors.length ? { "cleanup-errors.log": errors.map((error) => error instanceof Error ? error.stack : String(error)).join("\n") } : {}),
      } });
    } catch (error) {
      failure = new AggregateError(failure ? [failure, error] : [error], "QA workspace cleanup failed");
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  })();
  return cleanupPromise;
}

function interrupt(signal) {
  if (interrupted) return;
  interrupted = true;
  failure ??= new Error(`QA interrupted by ${signal}`);
  runAbort.abort(failure);
  const code = signal === "SIGINT" ? 130 : 143;
  process.exitCode = code;
  void cleanup().finally(() => process.exit(code));
}
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

async function listen(server) {
  runAbort.signal.throwIfAborted();
  const ready = once(server, "listening", { signal: runAbort.signal });
  server.listen(0, "127.0.0.1");
  await ready;
  runAbort.signal.throwIfAborted();
}

async function startNext() {
  runAbort.signal.throwIfAborted();
  child = spawn(process.execPath, [nextRuntime.bin, "dev", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: fixture, env: appEnv, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  const processRef = child;
  const recordOutput = (bytes) => { logs = `${logs}${bytes}`.slice(-50000); };
  processRef.stdout.on("data", recordOutput);
  processRef.stderr.on("data", recordOutput);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      processRef.stdout.removeListener("data", ready);
      processRef.stderr.removeListener("data", ready);
      processRef.removeListener("exit", exited);
      processRef.removeListener("error", failed);
      runAbort.signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const ready = (bytes) => { if (String(bytes).includes("Ready in")) finish(); };
    const exited = (code) => finish(new Error(`Isolated Next exited before ready (${code})`));
    const failed = (error) => finish(error);
    const aborted = () => finish(runAbort.signal.reason);
    const timeout = setTimeout(() => finish(new Error("Isolated Next server did not become ready")), 60000);
    processRef.stdout.on("data", ready);
    processRef.stderr.on("data", ready);
    processRef.once("exit", exited);
    processRef.once("error", failed);
    runAbort.signal.addEventListener("abort", aborted, { once: true });
    if (runAbort.signal.aborted) aborted();
  });
}

async function stopNext(signal = "SIGTERM") {
  await stopQaProcess(child, signal);
}

async function request(endpoint, method = "GET", body) {
  const response = await fetch(`${app}${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie, Connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([runAbort.signal, AbortSignal.timeout(30000)]),
  });
  return { status: response.status, body: await response.json() };
}

const settings = { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: true, useStyle: true };
async function create(part, count = 1, marker = "") {
  const text = Array.from({ length: count }, (_, idx) => `# 第${idx + 1}段\n${token}_${part}_${idx} ${typeof marker === "function" ? marker(idx) : marker} 后台生成测试。`).join("\n\n");
  const startedAt = Date.now();
  const response = await request("/api/documents", "POST", { ...settings, text });
  assert.equal(response.status, 202);
  assert.equal(response.body.scriptModel, "local/mock");
  assert.equal(response.body.generation.scriptReady, false);
  assert.ok(["queued", "running"].includes(response.body.generation.status));
  console.log(JSON.stringify({ event: "accepted", part, documentId: response.body.id, responseMs: Date.now() - startedAt }));
  return response.body;
}

function matching(part, stage, status) {
  return mock.events.filter((event) => event.cases.some((label) => label.startsWith(`${token}_${part}_`)) && (!stage || event.stage === stage) && (!status || event.status === status));
}

function waitMock(predicate, message, timeoutMs = 30000) {
  runAbort.signal.throwIfAborted();
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      mock.changes.removeListener("change", check);
      runAbort.signal.removeEventListener("abort", aborted);
    };
    const check = () => {
      if (predicate()) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(message));
    }, timeoutMs);
    const aborted = () => { cleanup(); reject(runAbort.signal.reason); };
    runAbort.signal.addEventListener("abort", aborted, { once: true });
    mock.changes.on("change", check);
    check();
  });
}

const inspect = async (id) => (await request(`/api/documents/${id}`)).body;
async function control(id, action, extra = {}) {
  const response = await request(`/api/documents/${id}/generation`, "POST", { action, ...extra });
  assert.ok([200, 202].includes(response.status), JSON.stringify(response));
  return response.body;
}

async function completed(part, doc, count = 1) {
  await waitMock(() => matching(part, "tts", "complete").length === count, `${part} did not finish without document polling`);
  // Upstream has completed; allow the local MP3 encode and transaction to commit.
  await delay(700);
  const saved = await inspect(doc.id);
  assert.equal(saved.generation.status, "completed", JSON.stringify(saved.generation));
  assert.equal(saved.generation.completedSegments, count);
  assert.ok(saved.segments.every((segment) => segment.audioFresh && segment.audioUrl));
  return saved;
}

try {
  workspace = createQaWorkspace("background-generation");
  fixture = workspace.dir;
  dataDir = path.join(fixture, "data");
  nextRuntime = prepareQaSource(root, fixture);
  mock = createMockZenmux({ spokenMs: 700, tagsMs: 500, speechMs: 500, slowSpokenMs: 5000, slowTagsMs: 12000 });
  await listen(mock.server);
  mockUrl = `http://127.0.0.1:${mock.server.address().port}/api/v1`;
  reserve = net.createServer();
  await listen(reserve);
  appPort = reserve.address().port;
  await closeQaServer(reserve);
  reserve = undefined;
  app = `http://127.0.0.1:${appPort}`;
  appEnv = {
    ...process.env, ZENMUX_BASE_URL: mockUrl, ZENMUX_API_KEY: "voicepage-local-mock", SCRIPT_MODEL: "local/mock",
    APP_PASSWORD: "voicepage-test", SESSION_SECRET: "voicepage-test-session-secret", DATA_DIR: dataDir,
    BACKGROUND_LEASE_MS: process.env.TEST_LEASE_MS ?? "6000", NODE_PATH: nextRuntime.nodePath,
  };
  delete appEnv.BACKGROUND_WORKER_DISABLED;
  delete appEnv.NEXT_PHASE;
  delete appEnv.NODE_ENV;
  assert.equal(appEnv.SCRIPT_MODEL, "local/mock");
  await startNext();
  console.log(JSON.stringify({ fixture, app, mockUrl, model: appEnv.SCRIPT_MODEL, leaseMs: Number(appEnv.BACKGROUND_LEASE_MS) }));
  const login = await fetch(`${app}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "voicepage-test" }), signal: AbortSignal.any([runAbort.signal, AbortSignal.timeout(30000)]) });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  const generationSettings = await request("/api/settings/generation", "PATCH", { previewBeforeGeneration: false });
  assert.equal(generationSettings.status, 200);
  assert.equal(generationSettings.body.previewBeforeGeneration, false);
  const limits = { taskConcurrency: 2, textConcurrency: 2, ttsConcurrency: 2, segmentConcurrency: 2 };
  const configured = await request("/api/settings", "PATCH", limits);
  assert.equal(configured.status, 200);
  assert.deepEqual(configured.body, limits);

  const detached = await create("detached", 2);
  await completed("detached", detached, 2);
  console.log("PASS: received 202 and closed the client connection; generation completed without any document request");

  const [first, second] = await Promise.all([create("parallelA", 2), create("parallelB", 2)]);
  // Reading another completed document must not switch away from server work.
  assert.equal((await inspect(detached.id)).generation.status, "completed");
  await Promise.all([completed("parallelA", first, 2), completed("parallelB", second, 2)]);
  assert.ok(mock.stats().maxTextRequests <= 2 && mock.stats().maxTtsRequests <= 2 && mock.stats().maxActiveRequests <= 4, JSON.stringify(mock.stats()));
  console.log(JSON.stringify({ check: "two documents continue while reading an old document", ...mock.stats() }));

  const failed = await create("retry", 1, "MOCK_LLM_HTTP_400_ONCE");
  await waitMock(() => matching("retry", "spoken", "failed").length === 1, "First model failure was not observed");
  await delay(700);
  const failureState = await inspect(failed.id);
  assert.equal(failureState.generation.status, "failed");
  assert.match(failureState.generation.error, /mock_failure/);
  await delay(1000);
  assert.equal(matching("retry", "spoken").length, 1, "A failed job must not retry or incur cost silently");
  await control(failed.id, "retry");
  await completed("retry", failed);
  assert.equal(matching("retry", "spoken").length, 2);
  console.log("PASS: model failure remains persisted until explicit retry, then completes");

  const segmentFailures = await create("segmentfail", 3, (idx) => ["", "MOCK_TAG_HTTP_403_ONCE", "MOCK_TTS_HTTP_403_ONCE"][idx]);
  await waitMock(() => matching("segmentfail", "tts", "complete").length === 1 && matching("segmentfail", "tags", "failed").length === 1 && matching("segmentfail", "tts", "failed").length === 1, "Segment failures should not stop the independent successful segment");
  await delay(700);
  const partial = await inspect(segmentFailures.id);
  assert.equal(partial.generation.failedSegments, 2);
  assert.equal(partial.generation.completedSegments, 1);
  await control(segmentFailures.id, "retry", { indices: [1, 2] });
  await completed("segmentfail", segmentFailures, 3);
  const tagsForTtsRetry = mock.events.filter((event) => event.stage === "tags" && event.cases.includes(`${token}_segmentfail_2`));
  assert.equal(tagsForTtsRetry.length, 1, "Background TTS retry must reuse saved tags");
  assert.equal(matching("segmentfail", "spoken").length, 1, "Segment retries must reuse the spoken script");
  console.log("PASS: tag and TTS failures are isolated; targeted retries reuse completed script and tags");

  const cancelled = await create("cancel", 2, "MOCK_SLOW_TAGS");
  await waitMock(() => matching("cancel", "tags", "running").length > 0, "Cancellation test never reached tags");
  await control(cancelled.id, "cancel");
  const manual = "取消后保存的手工口述稿。";
  assert.equal((await request(`/api/documents/${cancelled.id}/segments/0`, "PATCH", { tagged: manual })).status, 200);
  await delay(1500);
  assert.equal(matching("cancel", "tts").length, 0, "Cancelled tag jobs must not start TTS");
  const afterCancel = await inspect(cancelled.id);
  assert.equal(afterCancel.segments[0].tagged, manual);
  assert.equal(afterCancel.segments[0].tagStatus, "manual");
  assert.equal(afterCancel.generation.status, "cancelled");
  console.log("PASS: cancellation stops later model calls and preserves manual edits");

  const leaseA = await create("leaseA", 1, "MOCK_SLOW_SPOKEN");
  const leaseB = await create("leaseB", 1, "MOCK_SLOW_SPOKEN");
  await waitMock(() => matching("leaseA", "spoken", "running").length === 1 && matching("leaseB", "spoken", "running").length === 1, "Both recovery slots must be leased before crash");
  const queued = await create("queued");
  assert.equal(matching("queued", "spoken").length, 0, "Third document should remain queued behind global limit");
  await stopNext("SIGKILL");
  await delay(200);
  database = new DatabaseSync(path.join(dataDir, "readaloud.db"), { readOnly: true });
  const jobs = database.prepare("SELECT doc_id, status, attempt, lease_until FROM jobs WHERE doc_id IN (?, ?, ?)").all(leaseA.id, leaseB.id, queued.id);
  database.close();
  database = undefined;
  assert.equal(jobs.filter((job) => job.status === "running").length, 2);
  assert.equal(jobs.filter((job) => job.status === "queued").length, 1);
  const leaseUntil = Math.max(...jobs.map((job) => job.lease_until ?? 0));
  console.log(JSON.stringify({ check: "crashed worker left two leased jobs and one queued", waitForLeaseMs: Math.max(0, leaseUntil - Date.now()) }));
  await startNext();
  // No login, page load, API request, or polling to the restarted Next process.
  // Only listen to events from the fake upstream until all work is done.
  await waitMock(() => ["leaseA", "leaseB", "queued"].every((part) => matching(part, "tts", "complete").length === 1), "Restarted server failed to recover without browser requests", Math.max(90000, leaseUntil - Date.now() + 30000));
  await delay(700);
  for (const doc of [leaseA, leaseB, queued]) assert.equal((await inspect(doc.id)).generation.status, "completed");
  assert.equal(matching("leaseA", "spoken").length, 2);
  assert.equal(matching("leaseB", "spoken").length, 2);
  assert.equal(matching("queued", "spoken").length, 1);
  assert.ok(mock.stats().maxTextRequests <= 2 && mock.stats().maxTtsRequests <= 2 && mock.stats().maxActiveRequests <= 4, JSON.stringify(mock.stats()));
  console.log(JSON.stringify({ check: "restart recovers queued and expired leases without any browser request", ...mock.stats() }));
  success = true;
  console.log("All background generation lifecycle checks passed.");
} catch (error) {
  failure ??= error;
} finally {
  await cleanup();
}
if (failure && !interrupted) throw failure;
