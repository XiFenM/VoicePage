import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire, registerHooks } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Agent, getGlobalDispatcher } from "undici";

const repo = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), "voicepage-model-timeout-"));
const originalEnv = Object.fromEntries(["DATA_DIR", "ZENMUX_BASE_URL", "ZENMUX_API_KEY"].map((key) => [key, process.env[key]]));
process.env.DATA_DIR = directory;
process.env.ZENMUX_API_KEY = "local-timeout-test-key";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
  let candidate;
  if (specifier.startsWith("@/")) candidate = path.join(repo, "src", specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) candidate = fileURLToPath(new URL(specifier, context.parentURL));
  if (candidate && !path.extname(candidate) && existsSync(`${candidate}.ts`)) return nextResolve(pathToFileURL(`${candidate}.ts`).href, context);
  return nextResolve(specifier, context);
} });

const { ModelAgent, getModelAgent, modelFetch } = await import("../src/lib/model-http.ts");
const { chatCompletion, createSpeech } = await import("../src/lib/zenmux.ts");
const { describeJobError } = await import("../src/lib/generation/errors.ts");
const { executeBackgroundJob } = await import("../src/lib/generation/worker.ts");
const { db } = await import("../src/lib/store/db.ts");
const jobs = await import("../src/lib/store/jobs.ts");
const permits = await import("../src/lib/store/model-permits.ts");
const { updateRuntimeSettings } = await import("../src/lib/store/runtime-settings.ts");

// Undici explicitly exports tick/reset for tests. Its clock is independent of
// Date.now; advancing Date alone would never exercise the HTTP parser timeout.
const fastTimers = createRequire(import.meta.url)("undici/lib/util/timers");
const nativeFetch = globalThis.fetch;
const chat = () => chatCompletion({ model: "local/mock", messages: [{ role: "user", content: "timeout fixture" }] });
const speech = () => createSpeech({ model: "local/mock", input: "timeout fixture" });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function localServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.ZENMUX_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await getModelAgent().destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fastTimers.reset();
  });
  return server;
}

async function advanceTransport(ms) {
  fastTimers.tick(ms);
  await nextTurn();
  await nextTurn();
}

after(async () => {
  await getModelAgent().destroy();
  fastTimers.reset();
  globalThis.fetch = nativeFetch;
  globalThis.__readaloudDb?.close();
  delete globalThis.__readaloudDb;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

test("chat and TTS really dispatch with ten-minute header/body limits without changing other fetches", async (t) => {
  const inheritedDispatcher = getGlobalDispatcher();
  const observed = [];
  const originalDispatch = Agent.prototype.dispatch;
  t.mock.method(Agent.prototype, "dispatch", function (options, handler) {
    observed.push({ path: options.path, headersTimeout: options.headersTimeout, bodyTimeout: options.bodyTimeout });
    return originalDispatch.call(this, options, handler);
  });
  await localServer(t, (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/chat/completions"
      ? { choices: [{ message: { content: "real local response" } }] }
      : { audio: "AQACAA==", mime_type: "audio/pcm;rate=24000" }));
  });
  assert.equal(await chat(), "real local response");
  assert.equal((await speech()).pcm.length, 4);
  assert.deepEqual(observed, [
    { path: "/chat/completions", headersTimeout: 600000, bodyTimeout: 600000 },
    { path: "/audio/speech", headersTimeout: 600000, bodyTimeout: 600000 },
  ]);
  assert.equal(getGlobalDispatcher(), inheritedDispatcher);
  assert.equal(getModelAgent(), getModelAgent(), "Model connection pool is reused");
});

test("dispatch overrides shorter timeout values supplied by a fetch implementation", async (t) => {
  const agent = new ModelAgent();
  t.after(() => agent.destroy());
  let effective;
  t.mock.method(Agent.prototype, "dispatch", (options) => { effective = options; return true; });
  agent.dispatch({ origin: "http://127.0.0.1:47865", path: "/", method: "GET", headersTimeout: 300000, bodyTimeout: 300000 }, {});
  assert.equal(effective.headersTimeout, 600000);
  assert.equal(effective.bodyTimeout, 600000);
});

test("a real chat response may send its first headers after the old five-minute limit", async (t) => {
  fastTimers.reset();
  const received = deferred();
  let response;
  await localServer(t, (_request, res) => { response = res; received.resolve(); });
  let settled = false;
  const result = chat().finally(() => { settled = true; });
  await received.promise;
  await advanceTransport(0); // Activate the parser's pending timeout before jumping.
  await advanceTransport(301000);
  assert.equal(settled, false);
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ choices: [{ message: { content: "late headers accepted" } }] }));
  assert.equal(await result, "late headers accepted");
});

test("a real TTS JSON body may pause beyond five minutes and still complete", async (t) => {
  fastTimers.reset();
  const headersArrived = deferred();
  let response;
  await localServer(t, (_request, res) => {
    response = res;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"audio":"');
  });
  t.mock.method(globalThis, "fetch", async (...args) => {
    const res = await nativeFetch(...args);
    headersArrived.resolve();
    return res;
  });
  let settled = false;
  const result = speech().finally(() => { settled = true; });
  await headersArrived.promise;
  await advanceTransport(0);
  await advanceTransport(301000);
  assert.equal(settled, false);
  response.end('AQACAA==","mime_type":"audio/pcm;rate=24000"}');
  assert.equal((await result).pcm.length, 4);
});

test("real slow headers reach the ten-minute transport limit and remain retryable", async (t) => {
  fastTimers.reset();
  const received = deferred();
  await localServer(t, () => received.resolve());
  let settled = false;
  const result = chat().then(() => ({ success: true }), (error) => ({ error })).finally(() => { settled = true; });
  await received.promise;
  await advanceTransport(0);
  await advanceTransport(301000);
  assert.equal(settled, false);
  await advanceTransport(300000);
  const { error } = await result;
  const detail = describeJobError(error);
  assert.equal(detail.code, "UND_ERR_HEADERS_TIMEOUT");
  assert.equal(detail.category, "timeout");
  assert.equal(detail.retryable, true);
});

test("real stalled TTS bodies reach ten minutes and retain timeout cause and request id", async (t) => {
  fastTimers.reset();
  const headersArrived = deferred();
  await localServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "X-ZenMux-RequestId": "timeout-body-fixture" });
    response.write('{"audio":"');
  });
  t.mock.method(globalThis, "fetch", async (...args) => {
    const res = await nativeFetch(...args);
    headersArrived.resolve();
    return res;
  });
  let settled = false;
  const result = speech().then(() => ({ success: true }), (error) => ({ error })).finally(() => { settled = true; });
  await headersArrived.promise;
  await advanceTransport(0);
  await advanceTransport(301000);
  assert.equal(settled, false);
  await advanceTransport(300000);
  const { error } = await result;
  const detail = describeJobError(error);
  assert.equal(detail.code, "UND_ERR_BODY_TIMEOUT");
  assert.equal(detail.requestId, "timeout-body-fixture");
  assert.equal(detail.httpStatus, 200);
  assert.equal(detail.category, "timeout");
  assert.equal(detail.retryable, true);
});

test("modelFetch preserves caller cancellation instead of converting it into a retryable timeout", async (t) => {
  const received = deferred();
  await localServer(t, () => received.resolve());
  const controller = new AbortController();
  let forwardedSignal;
  t.mock.method(globalThis, "fetch", (url, options) => {
    forwardedSignal = options.signal;
    return nativeFetch(url, options);
  });
  const result = modelFetch(`${process.env.ZENMUX_BASE_URL}/cancel`, { signal: controller.signal }).catch((error) => error);
  await received.promise;
  controller.abort(new DOMException("cancelled by caller", "AbortError"));
  const error = await result;
  assert.equal(forwardedSignal, controller.signal);
  assert.equal(error.name, "AbortError");
  assert.equal(describeJobError(error).retryable, false);
});

test("worker starts its exact ten-minute deadline after admission, excluding time waiting for a model slot", async (t) => {
  db().exec("DELETE FROM model_permits; DELETE FROM documents;");
  updateRuntimeSettings({ taskConcurrency: 2, textConcurrency: 1, ttsConcurrency: 1, segmentConcurrency: 1 });
  const settings = { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: false, useStyle: true };
  jobs.createQueuedDocument({ sourceText: "permit holder", settings, scriptModel: "local/mock" });
  jobs.createQueuedDocument({ sourceText: "waiting request", settings, scriptModel: "local/mock" });
  const holder = jobs.claimNextJob("timeout-holder", 2_000_000);
  const waiting = jobs.claimNextJob("timeout-waiter", 2_000_000);
  const permit = permits.tryAcquireModelPermit("text", holder, 2_000_000);
  assert.ok(permit);
  let requestSignal;
  let requests = 0;
  t.mock.method(globalThis, "fetch", (_url, options) => new Promise((_resolve, reject) => {
    requests++;
    requestSignal = options.signal;
    requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
  }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const result = executeBackgroundJob(waiting, new AbortController().signal).catch((error) => error).finally(() => { settled = true; });
  t.mock.timers.tick(601000);
  await nextTurn();
  assert.equal(requests, 0);
  assert.equal(settled, false, "Waiting for admission must not use the model deadline");
  permits.releaseModelPermit(permit);
  t.mock.timers.tick(250);
  await nextTurn();
  assert.equal(requests, 1);
  t.mock.timers.tick(599999);
  assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1);
  const error = await result;
  assert.equal(error.name, "ModelTimeoutError");
  assert.equal(describeJobError(error).retryable, true);
  assert.deepEqual(permits.activeModelCounts(), { text: 0, tts: 0 });
});
