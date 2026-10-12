/** Isolated HTTP verification of library organization and live concurrency limits.
 * Run: node scripts/check-library-concurrency.mjs
 * Uses only a local mock and disposable SQLite/audio data; leaves fixture logs.
 */
import assert from "node:assert/strict";
import { unzipSync, zipSync } from "fflate";
import { createFixture, delay, waitFor } from "./qa-fixture.mjs";

const fixture = await createFixture("library-concurrency-qa", { spokenMs: 300, tagsMs: 400, speechMs: 2500, slowSpokenMs: 7000, slowTagsMs: 7000, slowSpeechMs: 7000 });
const { request, raw, mock, database } = fixture;
const token = `qa${Date.now()}`;
const voice = { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: true, useStyle: true };
let sequence = 0;

async function ok(endpoint, method = "GET", body) {
  const response = await request(endpoint, method, body);
  assert.ok(response.status >= 200 && response.status < 300, `${endpoint}: ${JSON.stringify(response)}`);
  return response.body;
}
async function invalid(endpoint, method, body) {
  const response = await request(endpoint, method, body);
  assert.ok(response.status >= 400 && response.status < 500, `${endpoint} accepted invalid input: ${JSON.stringify(response)}`);
}
async function create(part, count = 1, extra = {}, marker = "") {
  const label = `${token}_${part}_${sequence++}`;
  const text = Array.from({ length: count }, (_, idx) => `# 第${idx + 1}段\nMOCK_DOC_${label} MOCK_CASE_${label}_${idx} ${typeof marker === "function" ? marker(idx) : marker} 隔离验证。`).join("\n\n");
  const response = await request("/api/documents", "POST", { ...voice, ...extra, text });
  assert.equal(response.status, 202);
  assert.equal(response.body.scriptModel, "local/mock");
  return { ...response.body, label };
}
const eventsFor = (doc, stage) => mock.events.filter((event) => event.documents.includes(`MOCK_DOC_${doc.label}`) && (!stage || event.stage === stage));
const jobsFor = (id) => database.prepare("SELECT idx,status,phase,owner,attempt,lease_until FROM jobs WHERE doc_id = ? ORDER BY idx").all(id);
async function complete(doc) {
  await waitFor(() => {
    const jobs = jobsFor(doc.id);
    return jobs.length > 1 && jobs.every((job) => job.status === "completed");
  }, `Document did not finish: ${doc.id}`, 60000);
  const saved = await ok(`/api/documents/${doc.id}`);
  assert.equal(saved.generation.status, "completed");
  return saved;
}
const move = (kind, id, parentId, beforeId = null) => ok("/api/library/move", "POST", { kind, id, parentId, beforeId });
const settings = (body) => ok("/api/settings", "PATCH", body);
const control = (id, action, extra = {}) => ok(`/api/documents/${id}/generation`, "POST", { action, ...extra });
const collection = (kind, name, parentId = null) => ok("/api/collections", "POST", { kind, name, parentId });

try {
  assert.deepEqual(await ok("/api/settings"), { taskConcurrency: 4, textConcurrency: 4, ttsConcurrency: 4, segmentConcurrency: 2 });
  const groupA = await collection("group", "分组甲");
  const groupB = await collection("group", "分组乙");
  const sessionA = await collection("session", "会话甲", groupA.id);
  const sessionB = await collection("session", "会话乙", groupB.id);
  const empty = await collection("session", "空会话");
  await invalid("/api/collections", "POST", { kind: "group", name: "非法嵌套", parentId: groupA.id });
  await invalid("/api/collections", "POST", { kind: "session", name: "非法会话父级", parentId: sessionA.id });
  await move("group", groupB.id, null, groupA.id);
  const reordered = await ok("/api/library");
  assert.ok(reordered.collections.find((item) => item.id === groupB.id).position < reordered.collections.find((item) => item.id === groupA.id).position);

  const running = await create("moving", 1, { sessionId: sessionA.id, useTags: false }, "MOCK_SLOW_SPOKEN");
  const peer = await create("peer", 1, { sessionId: sessionB.id, useTags: false });
  await waitFor(() => eventsFor(running, "spoken").some((event) => event.status === "running"), "Moving document never started");
  const originalJob = jobsFor(running.id)[0];
  const originalUpdatedAt = (await ok(`/api/documents/${running.id}`)).updatedAt;
  const sessionOrder = await move("session", sessionA.id, groupB.id, sessionB.id);
  assert.ok(sessionOrder.collections.find((item) => item.id === sessionA.id).position < sessionOrder.collections.find((item) => item.id === sessionB.id).position);
  const documentOrder = await move("document", running.id, sessionB.id, peer.id);
  assert.ok(documentOrder.documents.find((item) => item.id === running.id).position < documentOrder.documents.find((item) => item.id === peer.id).position);
  const moved = await ok(`/api/documents/${running.id}`);
  assert.equal(moved.sessionId, sessionB.id);
  assert.equal(moved.updatedAt, originalUpdatedAt, "Organization must not change content modification time");
  const movedJob = jobsFor(running.id)[0];
  assert.equal(movedJob.owner, originalJob.owner);
  assert.equal(movedJob.attempt, originalJob.attempt);
  assert.ok(movedJob.lease_until >= originalJob.lease_until);
  await invalid("/api/library/move", "POST", { kind: "document", id: running.id, parentId: groupA.id });
  await invalid("/api/library/move", "POST", { kind: "document", id: running.id, parentId: sessionB.id, beforeId: "missing" });
  await invalid("/api/library/move", "POST", { kind: "session", id: sessionA.id, parentId: sessionB.id });
  await ok(`/api/collections/${groupB.id}`, "DELETE");
  const promoted = await ok("/api/library");
  assert.equal(promoted.collections.find((item) => item.id === sessionA.id).parentId, null);
  assert.equal(promoted.collections.find((item) => item.id === sessionB.id).parentId, null);
  await ok(`/api/collections/${sessionB.id}`, "DELETE");
  assert.equal((await ok(`/api/documents/${running.id}`)).sessionId, null);
  assert.equal(jobsFor(running.id)[0].owner, originalJob.owner);
  assert.equal(jobsFor(running.id)[0].attempt, originalJob.attempt);
  const [ready] = await Promise.all([complete(running), complete(peer)]);
  const audioUrl = ready.segments[0].audioUrl;
  await move("session", sessionA.id, groupA.id);
  await move("document", running.id, sessionA.id);
  assert.equal((await ok(`/api/documents/${running.id}`)).segments[0].audioUrl, audioUrl);
  console.log("PASS: create/move/reorder/delete/invalid hierarchy actions preserve running jobs and completed audio");

  const exported = new Uint8Array(await (await raw("/api/backup")).arrayBuffer());
  const unpacked = unzipSync(exported);
  const manifest = JSON.parse(new TextDecoder().decode(unpacked["manifest.json"]));
  assert.equal(manifest.version, 5);
  assert.ok(manifest.collections.some((item) => item.id === empty.id), "Full backup must include empty containers");
  const partial = unzipSync(new Uint8Array(await (await raw(`/api/backup?ids=${running.id}`)).arrayBuffer()));
  const partialManifest = JSON.parse(new TextDecoder().decode(partial["manifest.json"]));
  assert.deepEqual(new Set(partialManifest.collections.map((item) => item.id)), new Set([groupA.id, sessionA.id]));
  await ok(`/api/collections/${groupA.id}`, "PATCH", { name: "本地改名" });
  const importZip = async (zip, mode) => {
    const response = await raw(`/api/backup?mode=${mode}`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: zip });
    assert.equal(response.status, 200);
    return response.json();
  };
  const callsBeforeImport = mock.events.length;
  await importZip(exported, "skip");
  assert.equal((await ok("/api/library")).collections.find((item) => item.id === groupA.id).name, "本地改名");
  await importZip(exported, "overwrite");
  assert.equal((await ok("/api/library")).collections.find((item) => item.id === groupA.id).name, "分组甲");
  const legacy = { ...partialManifest, version: 3 };
  delete legacy.collections;
  legacy.documents = legacy.documents.map((doc) => { const copy = { ...doc }; delete copy.sessionId; delete copy.position; return copy; });
  await importZip(zipSync({ ...partial, "manifest.json": new TextEncoder().encode(JSON.stringify(legacy)) }), "overwrite");
  assert.equal((await ok(`/api/documents/${running.id}`)).sessionId, null);
  await delay(300);
  assert.equal(mock.events.length, callsBeforeImport, "Importing completed records must not generate models again");
  console.log("PASS: backup v5 preserves hierarchy/empty containers, skip/overwrite work, legacy imports stay unfiled");

  for (const patch of [{ textConcurrency: 0 }, { textConcurrency: 33 }, { ttsConcurrency: 1.5 }, { taskConcurrency: -1 }, { segmentConcurrency: 17 }]) await invalid("/api/settings", "PATCH", patch);
  const configured = { taskConcurrency: 4, textConcurrency: 3, ttsConcurrency: 5, segmentConcurrency: 2 };
  assert.deepEqual(await settings(configured), configured);
  const measurements = [];
  const sampleJobs = () => {
    const rows = database.prepare("SELECT doc_id,kind,COUNT(*) AS count FROM jobs WHERE status='running' GROUP BY doc_id,kind").all();
    measurements.push({ documents: new Set(rows.map((row) => row.doc_id)).size, perDocSegments: Math.max(0, ...rows.filter((row) => row.kind === "segment").map((row) => row.count)) });
  };
  const sampleTimer = setInterval(sampleJobs, 100);
  const eventStart = mock.events.length;
  let saturated;
  try {
    saturated = await Promise.all(Array.from({ length: 6 }, (_, idx) => create(`saturated${idx}`, 4)));
    await Promise.all(saturated.map(complete));
  } finally { clearInterval(sampleTimer); }
  const saturationEvents = mock.events.slice(eventStart);
  const peak = {
    text: Math.max(...saturationEvents.map((event) => event.activeAtStart.activeTextRequests)),
    tts: Math.max(...saturationEvents.map((event) => event.activeAtStart.activeTtsRequests)),
    activeDocuments: Math.max(...measurements.map((sample) => sample.documents)),
    segmentsPerDoc: Math.max(...measurements.map((sample) => sample.perDocSegments)),
  };
  assert.deepEqual(peak, { text: 3, tts: 5, activeDocuments: 4, segmentsPerDoc: 2 });
  console.log(JSON.stringify({ check: "independent concurrency limits saturate above old fixed two", peak }));

  // Lowering a limit must not abort admitted requests; future starts obey it.
  await settings({ taskConcurrency: 4, textConcurrency: 3, ttsConcurrency: 5, segmentConcurrency: 2 });
  const lowerDocs = await Promise.all(Array.from({ length: 4 }, (_, idx) => create(`lower${idx}`, 3, { useTags: false }, "MOCK_SLOW_TTS")));
  await waitFor(() => mock.stats().activeTtsRequests === 5, "Five TTS requests did not start before lowering cap");
  const admitted = mock.events.filter((event) => event.status === "running").map((event) => event.id);
  await settings({ ttsConcurrency: 2 });
  const lastAdmittedId = Math.max(...mock.events.map((event) => event.id));
  await Promise.all(lowerDocs.map(complete));
  assert.ok(mock.events.filter((event) => admitted.includes(event.id)).every((event) => event.status === "complete"));
  assert.ok(mock.events.filter((event) => event.id > lastAdmittedId && event.stage === "tts").every((event) => event.activeAtStart.activeTtsRequests <= 2));
  console.log("PASS: lowering TTS cap keeps in-flight work and only admits new requests below the new cap");

  await settings({ taskConcurrency: 4, textConcurrency: 1, ttsConcurrency: 5, segmentConcurrency: 2 });
  const higherDocs = await Promise.all(Array.from({ length: 3 }, (_, idx) => create(`higher${idx}`, 1, { useTags: false }, "MOCK_SLOW_SPOKEN")));
  await waitFor(() => mock.stats().activeTextRequests === 1, "Initial text request missing");
  const firstText = mock.events.findLast((event) => event.stage === "spoken" && event.status === "running");
  await settings({ textConcurrency: 3 });
  await waitFor(() => mock.stats().activeTextRequests === 3, "Raising cap did not wake additional requests", 2000);
  assert.equal(firstText.status, "running", "Additional work should start before the first request ends");
  await Promise.all(higherDocs.map(complete));
  console.log("PASS: increasing text cap wakes queued work without waiting for the first call to finish");

  await settings({ taskConcurrency: 4, textConcurrency: 1, ttsConcurrency: 5, segmentConcurrency: 2 });
  const mixed = await create("headOfLine", 3, { useTags: false }, (idx) => idx < 2 ? "MOCK_SLOW_TAGS" : "");
  const mixedReady = await complete(mixed);
  await ok(`/api/documents/${mixed.id}`, "PATCH", { useTags: true });
  await ok(`/api/documents/${mixed.id}/segments/2`, "PATCH", { tagged: mixedReady.segments[2].tagged });
  const boundary = mock.events.length;
  await control(mixed.id, "start", { force: true });
  await waitFor(() => mock.events.slice(boundary).some((event) => event.stage === "tts" && event.cases.includes(`MOCK_CASE_${mixed.label}_2`)), "A text waiter occupied the second segment slot instead of admitting ready TTS", 2000);
  assert.ok(mock.events.slice(boundary).some((event) => event.stage === "tags" && event.status === "running"));
  assert.equal(mock.stats().activeTextRequests, 1);
  await control(mixed.id, "cancel");
  await waitFor(() => mock.stats().activeRequests === 0, "Cancelled head-of-line fixture still has model requests");
  console.log("PASS: ready segment TTS bypasses an earlier tag waiter under a two-segment document cap");

  const persisted = await settings(configured);
  await fixture.restart();
  assert.deepEqual(await ok("/api/settings"), persisted);
  const libraryAfterRestart = await ok("/api/library");
  assert.ok(libraryAfterRestart.collections.some((item) => item.id === sessionA.id));
  console.log("PASS: hierarchy and concurrency settings survive a Next process restart");
  console.log("All library and concurrency integration checks passed.");
} finally {
  await fixture.close();
}
