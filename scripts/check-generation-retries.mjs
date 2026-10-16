/** Durable retry/history verification with real HTTP and the normal 5s/15s delays.
 * Run: node scripts/check-generation-retries.mjs
 * All source, SQLite data and model requests are isolated local fixtures.
 */
import assert from "node:assert/strict";
import { createFixture, delay, waitFor } from "./qa-fixture.mjs";

const fixture = await createFixture("generation-retries-qa", { spokenMs: 180, tagsMs: 180, speechMs: 180 });
const { request, mock, database } = fixture;
const token = `retry${Date.now()}`;
const settings = { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: true, useStyle: true };
const caseFor = (part) => `MOCK_CASE_${token}_${part}`;
const modelEvents = (part, stage) => mock.events.filter((event) => event.cases.includes(caseFor(part)) && (!stage || event.stage === stage));
const row = (doc, idx = -1) => database.prepare("SELECT * FROM jobs WHERE doc_id = ? AND idx = ?").get(doc.id, idx);
const rows = (doc) => database.prepare("SELECT * FROM jobs WHERE doc_id = ? ORDER BY idx").all(doc.id);

async function ok(endpoint, method = "GET", body) {
  const response = await request(endpoint, method, body);
  assert.ok(response.status >= 200 && response.status < 300, `${endpoint}: ${JSON.stringify(response)}`);
  return response.body;
}
async function create(part, marker, useTags = true) {
  const response = await request("/api/documents", "POST", { ...settings, useTags, text: `${caseFor(part)} MOCK_DOC_${token}_${part} ${marker} 自动重试隔离验证。` });
  assert.equal(response.status, 202);
  assert.equal(response.body.scriptModel, "local/mock");
  return { ...response.body, part };
}
async function waiting(doc, idx = -1, retryNumber = 1) {
  await waitFor(() => row(doc, idx)?.status === "queued" && row(doc, idx).auto_retry_count === retryNumber && row(doc, idx).next_retry_at > Date.now(), `No persisted retry ${retryNumber} for ${doc.part}/${idx}`);
  return row(doc, idx);
}
async function completed(doc) {
  await waitFor(() => rows(doc).length === 2 && rows(doc).every((job) => job.status === "completed"), `Document did not complete: ${doc.part}`, 45000);
  const saved = await ok(`/api/documents/${doc.id}`);
  assert.equal(saved.generation.status, "completed");
  assert.ok(saved.segments[0].audioFresh);
  return saved;
}
async function failed(doc, idx = -1) {
  await waitFor(() => row(doc, idx)?.status === "failed", `Document did not reach final failure: ${doc.part}/${idx}`, 45000);
  return row(doc, idx);
}
const control = (doc, action) => ok(`/api/documents/${doc.id}/generation`, "POST", { action });
async function history(doc) {
  const all = [];
  let before;
  do {
    const page = await ok(`/api/documents/${doc.id}/events?limit=2${before ? `&before=${before}` : ""}`);
    assert.ok(page.events.length <= 2);
    assert.ok(page.events.every((event, index) => index === 0 || page.events[index - 1].id > event.id));
    if (before) assert.ok(page.events.every((event) => event.id < before));
    all.push(...page.events);
    before = page.nextCursor;
    assert.ok(all.length < 100, "History cursor did not advance");
  } while (before !== undefined);
  assert.equal(new Set(all.map((event) => event.id)).size, all.length);
  return all.sort((a, b) => a.id - b.id);
}
function assertBackoff(historyEvents, expectedDelays) {
  const scheduled = historyEvents.filter((event) => event.type === "retry_scheduled");
  assert.equal(scheduled.length, expectedDelays.length);
  scheduled.forEach((event, index) => {
    assert.equal(event.retrySource, "automatic");
    assert.equal(event.retryNumber, index + 1);
    const actual = event.nextRetryAt - event.createdAt;
    assert.ok(Math.abs(actual - expectedDelays[index]) < 1000, `Unexpected retry delay ${actual}ms`);
    const started = historyEvents.find((entry) => entry.type === "retry_started" && entry.retrySource === "automatic" && entry.retryNumber === event.retryNumber);
    assert.ok(started, "Scheduled retry must have a matching start event");
    assert.equal(started.phase, event.phase, "Retry history must retain the failed stage name");
  });
}

let succeeded = false;
let failure;
try {
  await ok("/api/settings/generation", "PATCH", { previewBeforeGeneration: false });
  await ok("/api/settings", "PATCH", { taskConcurrency: 1, textConcurrency: 1, ttsConcurrency: 1, segmentConcurrency: 1 });
  const network = await create("network", "MOCK_LLM_NETWORK_ONCE", false);
  const networkDue = await waiting(network);
  assert.equal(networkDue.owner, null);
  assert.equal(networkDue.lease_until, null);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM model_permits WHERE doc_id = ?").get(network.id).count, 0);
  const storedNetworkError = JSON.parse(networkDue.last_error_json);
  assert.equal(storedNetworkError.category, "network");
  assert.equal(storedNetworkError.retryable, true);
  assert.ok(storedNetworkError.causes.some((cause) => cause.code || cause.name));
  // The only task/model slot is free while the failed document waits.
  const other = await create("unblocked", "", false);
  await completed(other);
  assert.ok(modelEvents("unblocked", "tts")[0].finishedAt < networkDue.next_retry_at);
  await completed(network);
  assert.equal(modelEvents("network", "spoken").length, 2);
  const networkHistory = await history(network);
  assertBackoff(networkHistory, [5000]);
  assert.ok(networkHistory.some((event) => event.type === "retry_started" && event.retrySource === "automatic"));
  assert.ok(networkHistory.some((event) => event.type === "failed" && event.phase === "spoken" && event.modelId === "local/mock"));
  console.log("PASS: socket failure is persisted and retried after 5s; backoff releases all concurrency slots");

  await ok("/api/settings", "PATCH", { taskConcurrency: 8, textConcurrency: 4, ttsConcurrency: 4, segmentConcurrency: 2 });
  const [tags, tts, networkTts, permanent400, permanent403, exhausted, cancelled] = await Promise.all([
    create("tags", "MOCK_TAG_RETRY"),
    create("tts", "MOCK_TTS_RETRY"),
    create("networkTts", "MOCK_TTS_NETWORK_ONCE"),
    create("permanent400", "MOCK_LLM_HTTP_400_ONCE", false),
    create("permanent403", "MOCK_TTS_HTTP_403_ONCE"),
    create("exhausted", "MOCK_TTS_HTTP_503_THREE"),
    create("cancelled", "MOCK_TAG_ERROR"),
  ]);
  const cancelDue = await waiting(cancelled, 0);
  await control(cancelled, "cancel");
  assert.equal(row(cancelled, 0).status, "cancelled");
  assert.equal(row(cancelled, 0).next_retry_at, null);
  await Promise.all([completed(tags), completed(tts), completed(networkTts), failed(permanent400), failed(permanent403, 0), failed(exhausted, 0)]);
  assert.equal(modelEvents("tags", "tags").length, 2);
  assert.equal(modelEvents("tts", "tts").length, 2);
  assert.equal(modelEvents("tts", "tags").length, 1, "TTS retry must not repeat saved tags");
  assert.equal(modelEvents("tags", "spoken").length, 1);
  assert.equal(modelEvents("tts", "spoken").length, 1);
  assert.equal(modelEvents("networkTts", "tts").length, 2);
  assert.equal(modelEvents("networkTts", "tags").length, 1);
  const networkTtsHistory = await history(networkTts);
  assert.ok(networkTtsHistory.some((event) => event.type === "failed" && event.error?.category === "network"));
  assertBackoff(networkTtsHistory, [5000]);
  assertBackoff(await history(tags), [5000]);
  assertBackoff(await history(tts), [5000]);
  for (const [doc, idx, status, stage] of [[permanent400, -1, 400, "spoken"], [permanent403, 0, 403, "tts"]]) {
    const lastError = JSON.parse(row(doc, idx).last_error_json);
    assert.equal(lastError.httpStatus, status);
    assert.equal(lastError.retryable, false);
    assert.match(lastError.requestId, /^mock-/);
    assert.equal(row(doc, idx).auto_retry_count, 0);
    assert.equal(modelEvents(doc.part, stage).length, 1);
    assert.equal((await history(doc)).filter((event) => event.type === "retry_scheduled").length, 0);
  }
  assert.ok(Date.now() > cancelDue.next_retry_at);
  assert.equal(modelEvents("cancelled", "tags").length, 1);
  assert.equal(modelEvents("cancelled", "tts").length, 0);
  assert.ok((await history(cancelled)).some((event) => event.type === "cancelled"));
  console.log("PASS: tags/TTS recover independently; HTTP 400/403 do not auto-retry; cancellation prevents due retries");

  const exhaustedJob = row(exhausted, 0);
  assert.equal(exhaustedJob.auto_retry_count, 2);
  assert.equal(exhaustedJob.next_retry_at, null);
  assert.equal(modelEvents("exhausted", "tts").length, 3);
  assert.equal(modelEvents("exhausted", "tags").length, 1);
  const beforeManual = await history(exhausted);
  assertBackoff(beforeManual, [5000, 15000]);
  assert.equal(beforeManual.filter((event) => event.type === "failed").length, 3);
  await delay(700);
  assert.equal(modelEvents("exhausted", "tts").length, 3, "Automatic retries must stop after three total attempts");
  await control(exhausted, "retry");
  assert.equal(row(exhausted, 0).auto_retry_count, 0);
  await completed(exhausted);
  assert.equal(row(exhausted, 0).attempt, 4, "Manual retry keeps monotonically increasing claim identity");
  const afterManual = await history(exhausted);
  assert.ok(beforeManual.every((prior) => afterManual.some((event) => event.id === prior.id)));
  assert.ok(afterManual.some((event) => event.type === "retry_started" && event.retrySource === "manual"));
  assert.equal(modelEvents("exhausted", "tts").length, 4);
  assert.equal(modelEvents("exhausted", "tags").length, 1);
  console.log("PASS: exactly three automatic attempts, 5s/15s durable schedule; manual retry resets budget and retains paginated history");

  // Restart only after every other fixture is terminal, to isolate retry-budget recovery.
  const restarted = await create("restart", "MOCK_LLM_ERROR", false);
  const beforeRestart = await waiting(restarted, -1, 2);
  await fixture.restart();
  const afterRestart = row(restarted);
  assert.equal(afterRestart.auto_retry_count, beforeRestart.auto_retry_count);
  assert.equal(afterRestart.next_retry_at, beforeRestart.next_retry_at);
  assert.equal(afterRestart.attempt, beforeRestart.attempt);
  // No HTTP request is sent to wake the restarted worker; only inspect its test DB.
  await failed(restarted);
  assert.equal(modelEvents("restart", "spoken").length, 3);
  assert.equal(row(restarted).auto_retry_count, 2);
  assert.ok(modelEvents("restart", "spoken")[2].startedAt >= beforeRestart.next_retry_at);
  assertBackoff(await history(restarted), [5000, 15000]);
  console.log("PASS: process restart preserves retry due time/budget and resumes without a browser request");
  console.log("All durable generation retry checks passed.");
  succeeded = true;
} catch (error) {
  failure = error;
  throw error;
} finally {
  await fixture.close({ success: succeeded, error: failure });
}
