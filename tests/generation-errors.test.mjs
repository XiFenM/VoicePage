import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
  let candidate;
  if (specifier.startsWith("@/")) candidate = path.join(repo, "src", specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) candidate = fileURLToPath(new URL(specifier, context.parentURL));
  if (candidate && !path.extname(candidate) && existsSync(candidate + ".ts")) return nextResolve(pathToFileURL(candidate + ".ts").href, context);
  return nextResolve(specifier, context);
} });
const { describeJobError, ModelTimeoutError, ModelResponseError, sanitizeDiagnostic } = await import("../src/lib/generation/errors.ts");
const { retryDelayMs, parseRetryAfter } = await import("../src/lib/generation/retry-policy.ts");
const { UpstreamError, chatCompletion, createSpeech } = await import("../src/lib/zenmux.ts");
const { addTags } = await import("../src/lib/script/pipeline.ts");
const originalFetch = globalThis.fetch;
const originalKey = process.env.ZENMUX_API_KEY;
process.env.ZENMUX_API_KEY = "local-test-secret-123456";
after(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.ZENMUX_API_KEY; else process.env.ZENMUX_API_KEY = originalKey; });

test("fetch failure retains nested socket/timeout causes and distinguishes response waits", () => {
  const nested = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
  const detail = describeJobError(new TypeError("fetch failed", { cause: nested }));
  assert.equal(detail.category, "timeout");
  assert.equal(detail.code, "UND_ERR_HEADERS_TIMEOUT");
  assert.equal(detail.retryable, true);
  assert.match(detail.message, /等待模型接口响应超时/);
  assert.equal(detail.causes[1].message, "Headers Timeout Error");
  const network = describeJobError(new TypeError("fetch failed", { cause: new AggregateError([
    Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
  ]) }));
  assert.equal(network.category, "network");
  assert.equal(network.code, "ECONNRESET");
  assert.equal(network.retryable, true);
});

test("application timeouts retry but cancellation and configuration errors never do", () => {
  assert.equal(describeJobError(new ModelTimeoutError()).retryable, true);
  const aborted = new Error("stopped", { cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }) });
  aborted.name = "AbortError";
  assert.equal(describeJobError(aborted).retryable, false);
  const certificate = describeJobError(new TypeError("fetch failed", { cause: Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }) }));
  assert.equal(certificate.category, "configuration");
  assert.equal(certificate.retryable, false);
  assert.equal(describeJobError(new TypeError("Cannot read properties of undefined")).retryable, false);
});

test("temporary HTTP failures retry while auth, quota, params and response errors are terminal", () => {
  for (const status of [408, 429, 500, 502, 503, 504, 520, 524]) {
    const detail = describeJobError(new UpstreamError("temporary upstream problem", status, "provider_error", "req-test", 10_000));
    assert.equal(detail.retryable, true, String(status));
    assert.equal(detail.httpStatus, status);
    assert.equal(detail.requestId, "req-test");
    assert.equal(detail.retryAfterMs, 10_000);
  }
  for (const status of [400, 401, 402, 403, 404, 413, 422]) assert.equal(describeJobError(new UpstreamError("invalid", status)).retryable, false);
  assert.equal(describeJobError(new UpstreamError("quota gone", 429, "quote_exceeded")).retryable, false);
  assert.equal(describeJobError(new ModelResponseError("invalid output", new SyntaxError("unexpected token"), "req-format", 200)).retryable, false);
});

test("cause traversal is bounded and secrets never enter the serialized diagnostic", () => {
  const error = new Error("Authorization: Bearer token-123 API_KEY=custom-secret sk-ss-v1-test-key-123 local-test-secret-123456");
  error.cause = error;
  const detail = describeJobError(error);
  assert.equal(detail.causes.length, 1);
  const stored = JSON.stringify(detail);
  for (const secret of ["token-123", "custom-secret", "sk-ss-v1-test-key-123", "local-test-secret-123456"]) assert.ok(!stored.includes(secret));
  assert.ok(!stored.includes("stack"));
  assert.ok(!sanitizeDiagnostic("https://alice:password@invalid.test?token=mytoken").includes("mytoken"));
});

test("retry delays respect Retry-After dates/seconds with a five-minute bound", () => {
  assert.equal(retryDelayMs(1), 5_000);
  assert.equal(retryDelayMs(2), 15_000);
  assert.equal(retryDelayMs(1, 30_000), 30_000);
  assert.equal(retryDelayMs(2, Infinity), 15_000);
  assert.equal(parseRetryAfter("12"), 12_000);
  assert.equal(parseRetryAfter("Wed, 01 Jan 2025 00:00:12 GMT", Date.parse("2025-01-01T00:00:00Z")), 12_000);
  assert.equal(parseRetryAfter("9999999"), 300_000);
  assert.equal(parseRetryAfter("invalid"), undefined);
});

test("ZenMux errors preserve HTTP/request id/backoff; missing model output is not fake HTTP 502", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { type: "rate_limit", message: "slow down" } }), {
    status: 429, headers: { "X-ZenMux-RequestId": "req-rate", "Retry-After": "20" },
  });
  await assert.rejects(chatCompletion({ model: "local/mock", messages: [] }), (error) => {
    const detail = describeJobError(error);
    assert.equal(detail.httpStatus, 429); assert.equal(detail.requestId, "req-rate"); assert.equal(detail.retryAfterMs, 20_000); return true;
  });
  globalThis.fetch = async () => new Response('{"choices":[]}', { headers: { "X-ZenMux-RequestId": "req-empty" } });
  await assert.rejects(chatCompletion({ model: "local/mock", messages: [] }), (error) => {
    const detail = describeJobError(error);
    assert.equal(detail.category, "response"); assert.equal(detail.httpStatus, 200); assert.equal(detail.requestId, "req-empty"); assert.equal(detail.retryable, false); return true;
  });
});

test("a broken response stream preserves its network cause and request id", async () => {
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.error(new TypeError("terminated", { cause: Object.assign(new Error("socket gone"), { code: "UND_ERR_SOCKET" }) }));
  } }), { headers: { "X-ZenMux-RequestId": "req-stream" } });
  await assert.rejects(createSpeech({ model: "local/mock", input: "test" }), (error) => {
    const detail = describeJobError(error);
    assert.equal(detail.category, "network"); assert.equal(detail.code, "UND_ERR_SOCKET");
    assert.equal(detail.requestId, "req-stream"); assert.equal(detail.retryable, true); return true;
  });
});

test("tag output validation preserves the successful HTTP request id without automatic retry", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"segments":"bad"}' } }] }), {
    headers: { "X-ZenMux-RequestId": "req-tags-format" },
  });
  await assert.rejects(addTags([{ id: 0, speech: "本地测试" }], "qwen/qwen-audio-3.0-tts-plus", "teacher", undefined, "local/mock"), (error) => {
    const detail = describeJobError(error);
    assert.equal(detail.category, "response"); assert.equal(detail.retryable, false);
    assert.equal(detail.requestId, "req-tags-format"); assert.equal(detail.httpStatus, 200);
    assert.ok(detail.causes.some((cause) => cause.name === "ZodError")); return true;
  });
});

test("JSON diagnostics retain positions without leaking response text into history", async () => {
  globalThis.fetch = async () => new Response("patient Alice private transcript", { headers: { "X-ZenMux-RequestId": "req-private" } });
  await assert.rejects(chatCompletion({ model: "local/mock", messages: [] }), (error) => {
    const detail = describeJobError(error);
    assert.equal(detail.category, "response");
    assert.ok(!JSON.stringify(detail).includes("patient"));
    assert.ok(!JSON.stringify(detail).includes("Alice"));
    assert.match(detail.causes[1].message, /JSON 解析失败/); return true;
  });
  const detail = describeJobError(new SyntaxError('Expected property name at position 2 (line 1 column 3): "private words"'));
  assert.match(detail.causes[0].message, /position 2/);
  assert.ok(!JSON.stringify(detail).includes("private words"));
});
