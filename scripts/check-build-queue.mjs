/**
 * Verify build never consumes a job, but production startup resumes it unaided.
 * Run: node scripts/check-build-queue.mjs
 * Uses a fresh source copy, test SQLite database, fake model, and local upstream.
 * No server runs during the build check; no worker-disable flag is set. After
 * build assertions, next start must finish the job without any HTTP request.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createMockZenmux } from "./mock-zenmux.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = fs.mkdtempSync(path.join(os.homedir(), "voicepage-build-queue-"));
const dataDir = path.join(fixture, "data");
for (const name of ["src", "public", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"]) {
  if (fs.existsSync(path.join(root, name))) fs.cpSync(path.join(root, name), path.join(fixture, name), { recursive: true });
}
let commonRoot = root;
while (!fixture.startsWith(`${commonRoot}${path.sep}`)) {
  const parent = path.dirname(commonRoot);
  if (parent === commonRoot) break;
  commonRoot = parent;
}
fs.writeFileSync(path.join(fixture, "next.config.ts"), fs.readFileSync(path.join(root, "next.config.ts"), "utf8").replace("turbopack: {", `turbopack: {\n    root: ${JSON.stringify(commonRoot)},`));
fs.symlinkSync(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "dir");
assert.ok(!fs.readdirSync(fixture).some((name) => name.startsWith(".env")));

// Seed via the actual store API without importing the worker or instrumentation.
process.env.DATA_DIR = dataDir;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    let candidate;
    if (specifier.startsWith("@/")) candidate = path.join(fixture, "src", specifier.slice(2));
    else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (candidate && !path.extname(candidate) && fs.existsSync(`${candidate}.ts`)) return nextResolve(pathToFileURL(`${candidate}.ts`).href, context);
    return nextResolve(specifier, context);
  },
});
const { createQueuedDocument } = await import(pathToFileURL(path.join(fixture, "src/lib/store/jobs.ts")).href);
const document = createQueuedDocument({
  sourceText: "MOCK_CASE_build_queued 构建时不得生成这份稿件。",
  settings: { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: true, useStyle: true },
  scriptModel: "local/mock",
});
assert.equal(document.generation.status, "queued");
globalThis.__readaloudDb?.close();
delete globalThis.__readaloudDb;

const mock = createMockZenmux({ spokenMs: 10, tagsMs: 10, speechMs: 10 });
await new Promise((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
const buildEnv = {
  ...process.env,
  DATA_DIR: dataDir,
  ZENMUX_BASE_URL: `http://127.0.0.1:${mock.server.address().port}/api/v1`,
  ZENMUX_API_KEY: "voicepage-local-mock",
  SCRIPT_MODEL: "local/mock",
  APP_PASSWORD: "voicepage-test",
  SESSION_SECRET: "voicepage-test-session-secret",
};
delete buildEnv.BACKGROUND_WORKER_DISABLED;
delete buildEnv.NEXT_PHASE;
delete buildEnv.NODE_ENV;
let log = "";
let startLog = "";
let production;
try {
  console.log(JSON.stringify({ fixture, documentId: document.id, workerDisabled: false, command: "pnpm build" }));
  const build = spawn("pnpm", ["build"], { cwd: fixture, env: buildEnv, stdio: ["ignore", "pipe", "pipe"] });
  build.stdout.on("data", (chunk) => { log += chunk; });
  build.stderr.on("data", (chunk) => { log += chunk; });
  const code = await new Promise((resolve, reject) => {
    build.once("exit", resolve);
    build.once("error", reject);
  });
  assert.equal(code, 0, log);
  const db = new DatabaseSync(path.join(dataDir, "readaloud.db"), { readOnly: true });
  const job = db.prepare("SELECT status, attempt, owner, lease_until FROM jobs WHERE doc_id = ? AND idx = -1").get(document.id);
  const saved = db.prepare("SELECT script_ready FROM documents WHERE id = ?").get(document.id);
  const segmentCount = db.prepare("SELECT COUNT(*) AS count FROM segments WHERE doc_id = ?").get(document.id).count;
  db.close();
  assert.deepEqual({ ...job }, { status: "queued", attempt: 0, owner: null, lease_until: null });
  assert.equal(saved.script_ready, 0);
  assert.equal(segmentCount, 0);
  assert.equal(mock.events.length, 0, "Production build must not call any model");
  console.log(JSON.stringify({ check: "production build leaves persisted job untouched", buildExitCode: code, job, segmentCount, upstreamRequests: mock.events.length }));

  const reserve = net.createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  production = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: fixture,
    env: buildEnv,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  production.stdout.on("data", (chunk) => { startLog += chunk; });
  production.stderr.on("data", (chunk) => { startLog += chunk; });
  const completedUpstream = () => mock.events.some((event) => event.stage === "tts" && event.status === "complete");
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      mock.changes.removeListener("change", check);
      production.removeListener("exit", onExit);
      production.removeListener("error", onError);
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
    mock.changes.on("change", check);
    production.once("exit", onExit);
    production.once("error", onError);
    check();
  });
  // The fake TTS completed; wait for local audio encoding and its transaction.
  await new Promise((resolve) => setTimeout(resolve, 700));
  const afterStart = new DatabaseSync(path.join(dataDir, "readaloud.db"), { readOnly: true });
  const finalJobs = afterStart.prepare("SELECT kind, status, attempt FROM jobs WHERE doc_id = ? ORDER BY idx").all(document.id);
  const finalDocument = afterStart.prepare("SELECT script_ready FROM documents WHERE id = ?").get(document.id);
  const audio = afterStart.prepare("SELECT audio_file FROM segments WHERE doc_id = ?").get(document.id);
  afterStart.close();
  assert.equal(finalDocument.script_ready, 1);
  assert.equal(finalJobs.length, 2);
  assert.ok(finalJobs.every((item) => item.status === "completed" && item.attempt === 1), JSON.stringify(finalJobs));
  assert.ok(audio.audio_file && fs.existsSync(path.join(dataDir, "audio", audio.audio_file)));
  assert.deepEqual(mock.events.map((event) => [event.stage, event.status]), [["spoken", "complete"], ["tags", "complete"], ["tts", "complete"]]);
  console.log(JSON.stringify({ check: "next start resumes build-preserved job without any HTTP request", jobs: finalJobs, upstreamRequests: mock.events.length }));
} finally {
  if (production && production.exitCode === null && production.signalCode === null) {
    const exited = once(production, "exit");
    if (process.platform === "win32") production.kill("SIGTERM");
    else process.kill(-production.pid, "SIGTERM");
    await exited;
  }
  mock.server.closeAllConnections();
  await new Promise((resolve) => mock.server.close(resolve));
  fs.writeFileSync(path.join(fixture, "build-test.log"), log);
  fs.writeFileSync(path.join(fixture, "start-test.log"), startLog);
  fs.writeFileSync(path.join(fixture, "mock-events.json"), JSON.stringify(mock.events, null, 2));
  console.log(`Kept isolated fixture: ${fixture}`);
}
