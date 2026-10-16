/**
 * Verify build never consumes a job, but production startup resumes it unaided.
 * Run: node scripts/check-build-queue.mjs
 * Uses a fresh source copy, test SQLite database, fake model, and local upstream.
 * No server runs during the build check; no worker-disable flag is set. After
 * build assertions, next start must finish the job without any HTTP request.
 * Success removes the temporary workspace; failure retains bounded logs only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createMockZenmux } from "./mock-zenmux.mjs";
import { createQaWorkspace, prepareQaSource, stopQaProcess, closeQaServer } from "./qa-workspace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let workspace;
let fixture;
let dataDir;
let mock;
let reserve;
let build;
let production;
let database;
let seedDatabase;
let resolver;
let log = "";
let startLog = "";
let success = false;
let failure;
let cleanupPromise;
let interrupted = false;
const runAbort = new AbortController();

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    runAbort.abort(new Error("QA cleanup"));
    const errors = [];
    for (const release of [
      () => stopQaProcess(build),
      () => stopQaProcess(production),
      () => { database?.close(); database = undefined; },
      () => { seedDatabase?.close(); if (globalThis.__readaloudDb === seedDatabase) delete globalThis.__readaloudDb; seedDatabase = undefined; },
      () => closeQaServer(reserve),
      () => closeQaServer(mock?.server),
      () => resolver?.deregister(),
    ]) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    const primaryFailure = failure;
    if (errors.length) failure = new AggregateError(primaryFailure ? [primaryFailure, ...errors] : errors, "QA resource cleanup failed");
    try {
      workspace?.finish({ success: success && !failure, error: primaryFailure ?? failure,
        logs: { "build-test.log": log, "start-test.log": startLog, "mock-events.json": mock?.events ?? [],
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

try {
  workspace = createQaWorkspace("build-queue");
  fixture = workspace.dir;
  dataDir = path.join(fixture, "data");
  const nextRuntime = prepareQaSource(root, fixture);

  // Seed via the actual store API without importing the worker or instrumentation.
  process.env.DATA_DIR = dataDir;
  resolver = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
      let candidate;
      if (specifier.startsWith("@/")) candidate = path.join(fixture, "src", specifier.slice(2));
      else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) candidate = fileURLToPath(new URL(specifier, context.parentURL));
      if (candidate && !path.extname(candidate) && fs.existsSync(`${candidate}.ts`)) return nextResolve(pathToFileURL(`${candidate}.ts`).href, context);
      return nextResolve(specifier, context);
    },
  });
  const { db } = await import(pathToFileURL(path.join(fixture, "src/lib/store/db.ts")).href);
  const { createQueuedDocument } = await import(pathToFileURL(path.join(fixture, "src/lib/store/jobs.ts")).href);
  seedDatabase = db();
  const document = createQueuedDocument({
    sourceText: "MOCK_CASE_build_queued 构建时不得生成这份稿件。",
    settings: { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: true, useStyle: true },
    scriptModel: "local/mock",
  });
  assert.equal(document.generation.status, "queued");
  seedDatabase.close();
  seedDatabase = undefined;
  delete globalThis.__readaloudDb;

  mock = createMockZenmux({ spokenMs: 10, tagsMs: 10, speechMs: 10 });
  await listen(mock.server);
  const buildEnv = {
    ...process.env, DATA_DIR: dataDir, ZENMUX_BASE_URL: `http://127.0.0.1:${mock.server.address().port}/api/v1`,
    ZENMUX_API_KEY: "voicepage-local-mock", SCRIPT_MODEL: "local/mock", APP_PASSWORD: "voicepage-test",
    SESSION_SECRET: "voicepage-test-session-secret", NODE_PATH: nextRuntime.nodePath,
  };
  delete buildEnv.BACKGROUND_WORKER_DISABLED;
  delete buildEnv.NEXT_PHASE;
  delete buildEnv.NODE_ENV;
  console.log(JSON.stringify({ fixture, documentId: document.id, workerDisabled: false, command: "next build" }));
  runAbort.signal.throwIfAborted();
  build = spawn(process.execPath, [nextRuntime.bin, "build"], { cwd: fixture, env: buildEnv, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  build.stdout.on("data", (chunk) => { log = `${log}${chunk}`.slice(-50000); });
  build.stderr.on("data", (chunk) => { log = `${log}${chunk}`.slice(-50000); });
  const [code] = await once(build, "exit", { signal: AbortSignal.any([runAbort.signal, AbortSignal.timeout(5 * 60_000)]) });
  assert.equal(code, 0, log);
  database = new DatabaseSync(path.join(dataDir, "readaloud.db"), { readOnly: true });
  const job = database.prepare("SELECT status, attempt, owner, lease_until FROM jobs WHERE doc_id = ? AND idx = -1").get(document.id);
  const saved = database.prepare("SELECT script_ready FROM documents WHERE id = ?").get(document.id);
  const segmentCount = database.prepare("SELECT COUNT(*) AS count FROM segments WHERE doc_id = ?").get(document.id).count;
  database.close();
  database = undefined;
  assert.deepEqual({ ...job }, { status: "queued", attempt: 0, owner: null, lease_until: null });
  assert.equal(saved.script_ready, 0);
  assert.equal(segmentCount, 0);
  assert.equal(mock.events.length, 0, "Production build must not call any model");
  console.log(JSON.stringify({ check: "production build leaves persisted job untouched", buildExitCode: code, job, segmentCount, upstreamRequests: mock.events.length }));

  reserve = net.createServer();
  await listen(reserve);
  const port = reserve.address().port;
  await closeQaServer(reserve);
  reserve = undefined;
  runAbort.signal.throwIfAborted();
  production = spawn(process.execPath, [nextRuntime.bin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: fixture,
    env: buildEnv,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  production.stdout.on("data", (chunk) => { startLog = `${startLog}${chunk}`.slice(-50000); });
  production.stderr.on("data", (chunk) => { startLog = `${startLog}${chunk}`.slice(-50000); });
  const completedUpstream = () => mock.events.some((event) => event.stage === "tts" && event.status === "complete");
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      mock.changes.removeListener("change", check);
      production.removeListener("exit", onExit);
      production.removeListener("error", onError);
      runAbort.signal.removeEventListener("abort", onAbort);
    };
    const check = () => {
      if (completedUpstream()) {
        cleanup();
        resolve();
      }
    };
    const onExit = (exitCode) => {
      cleanup();
      reject(new Error(`Production server exited before processing its job (${exitCode}): ${startLog}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Production startup did not resume the queued job without HTTP: ${startLog}`));
    }, 30000);
    const onAbort = () => { cleanup(); reject(runAbort.signal.reason); };
    runAbort.signal.addEventListener("abort", onAbort, { once: true });
    mock.changes.on("change", check);
    production.once("exit", onExit);
    production.once("error", onError);
    check();
  });
  // The fake TTS completed; wait for local audio encoding and its transaction.
  await sleep(700, undefined, { signal: runAbort.signal });
  database = new DatabaseSync(path.join(dataDir, "readaloud.db"), { readOnly: true });
  const finalJobs = database.prepare("SELECT kind, status, attempt FROM jobs WHERE doc_id = ? ORDER BY idx").all(document.id);
  const finalDocument = database.prepare("SELECT script_ready FROM documents WHERE id = ?").get(document.id);
  const audio = database.prepare("SELECT audio_file FROM segments WHERE doc_id = ?").get(document.id);
  database.close();
  database = undefined;
  assert.equal(finalDocument.script_ready, 1);
  assert.equal(finalJobs.length, 2);
  assert.ok(finalJobs.every((item) => item.status === "completed" && item.attempt === 1), JSON.stringify(finalJobs));
  assert.ok(audio.audio_file && fs.existsSync(path.join(dataDir, "audio", audio.audio_file)));
  assert.deepEqual(mock.events.map((event) => [event.stage, event.status]), [["spoken", "complete"], ["tags", "complete"], ["tts", "complete"]]);
  console.log(JSON.stringify({ check: "next start resumes build-preserved job without any HTTP request", jobs: finalJobs, upstreamRequests: mock.events.length }));
  success = true;
} catch (error) {
  failure ??= error;
} finally {
  await cleanup();
}
if (failure && !interrupted) throw failure;
