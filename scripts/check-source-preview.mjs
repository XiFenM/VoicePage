/** Local HTTP verification of optional source preview and confirmation.
 * Run: node scripts/check-source-preview.mjs
 * Uses a disposable local mock fixture, never real credentials or user data.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { createFixture, delay, waitFor } from "./qa-fixture.mjs";

const fixture = await createFixture("source-preview-qa", { spokenMs: 180, tagsMs: 180, speechMs: 180 });
const { request, mock, database } = fixture;
const settings = { personaId: "teacher", ttsModelId: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", useTags: false, useStyle: true };
const marker = `MOCK_CASE_preview${Date.now()}`;
const parser = unified().use(remarkParse).use(remarkGfm);
const syntax = (markdown) => JSON.parse(JSON.stringify(parser.parse(markdown).children, (key, value) => key === "position" ? undefined : value));
const source = [
  `# 先阅读\n${marker} 先理解正文，再结合声音阅读。`,
  "# 公式\n\\[\\boxed{S=2^{E-127}}\\]",
  "```js\nconst value = 2 ** 3;\n```",
  "方案 | 说明\n--- | ---\n甲 | 保留表格结构",
  "# 结束\n分块确认后才能开始调用模型。",
].join("\n\n");

async function ok(endpoint, method = "GET", body) {
  const response = await request(endpoint, method, body);
  assert.ok(response.status >= 200 && response.status < 300, `${endpoint}: ${JSON.stringify(response)}`);
  return response.body;
}

function persistedCounts() {
  return Object.fromEntries(["documents", "jobs", "segments"].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
}

function assertNoGeneration(expectedCounts = { documents: 0, jobs: 0, segments: 0 }, expectedRequests = 0) {
  assert.deepEqual(persistedCounts(), expectedCounts, "Preview or rejection must not persist documents, jobs or segments");
  assert.equal(mock.events.length, expectedRequests, "Preview or rejection must not call a model");
}

function assertPreview(preview, kinds = ["text", "code", "table", "math"]) {
  assert.equal(typeof preview.sourceText, "string");
  assert.equal(typeof preview.previewToken, "string");
  assert.ok(preview.previewToken.length > 10);
  assert.ok(Array.isArray(preview.blocks) && preview.blocks.length >= kinds.length);
  assert.deepEqual(preview.blocks.map((block) => block.id), preview.blocks.map((_, index) => index));
  assert.ok(preview.blocks.every((block) => typeof block.markdown === "string" && block.markdown.trim()));
  for (const kind of kinds) assert.ok(preview.blocks.some((block) => block.kind === kind), `Missing preview kind ${kind}`);
}

const joined = (blocks) => blocks.map((block) => block.markdown).join("\n\n");
function assertEdited(preview) {
  assert.equal(preview.edited, true);
  assert.match(preview.previewToken, /^b1\./u);
  assert.equal(preview.sourceText, joined(preview.blocks));
  assert.deepEqual(preview.blocks.map((block) => block.id), preview.blocks.map((_, index) => index));
}

async function rejected(body, counts, requests) {
  const response = await request("/api/documents", "POST", { ...settings, text: source, ...body });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "PREVIEW_REQUIRED");
  assert.equal(typeof response.body.error, "string");
  assertPreview(response.body.preview, []);
  assertNoGeneration(counts, requests);
  return response.body.preview;
}

async function completed(doc, expectedBlocks) {
  await waitFor(() => {
    const rows = database.prepare("SELECT status FROM jobs WHERE doc_id = ?").all(doc.id);
    return rows.length === expectedBlocks.length + 1 && rows.every((row) => row.status === "completed");
  }, "Confirmed document did not complete in the background", 45000);
  const saved = await ok(`/api/documents/${doc.id}`);
  assert.equal(saved.generation.status, "completed");
  assert.equal(saved.sourceText, doc.sourceText);
  assert.deepEqual(saved.segments.map((segment) => ({ id: segment.idx, kind: segment.kind, markdown: segment.markdown, ...(segment.lang ? { lang: segment.lang } : {}) })), expectedBlocks);
  assert.ok(saved.segments.every((segment) => segment.audioFresh && segment.audioUrl));
  return saved;
}

let succeeded = false;
let failure;
try {
  assert.equal(new URL(fixture.app).hostname, "127.0.0.1");
  assert.equal(mock.server.address().address, "127.0.0.1");
  assert.deepEqual(await ok("/api/settings/generation"), { previewBeforeGeneration: true });
  assertNoGeneration();

  const preview = await ok("/api/documents/preview", "POST", { text: source });
  assertPreview(preview);
  assert.equal(preview.sourceText, source);
  const repeated = await ok("/api/documents/preview", "POST", { text: source });
  assert.deepEqual(repeated.blocks, preview.blocks);
  assertNoGeneration();
  for (const text of ["", " \t\n ", "x".repeat(30001), "[unused]: https://example.invalid/definition-only"]) {
    for (const endpoint of ["/api/documents/preview", "/api/documents"]) {
      const response = await request(endpoint, "POST", endpoint.endsWith("/preview") ? { text } : { ...settings, text });
      assert.equal(response.status, 400, `${endpoint} must reject empty or over-limit source`);
    }
  }
  await delay(350);
  assertNoGeneration();
  console.log("PASS: preview defaults on, validates source locally, and creates no documents/jobs/model requests");

  const missing = await rejected({});
  assert.deepEqual(missing.blocks, preview.blocks);
  await rejected({ text: `${source}\n\n确认后修改的正文。`, previewToken: preview.previewToken });
  await rejected({ previewToken: `${preview.previewToken}tampered` });
  // Reproduce a legitimate preview made before a change to splitting rules.
  // This secret belongs only to createFixture's disposable local environment.
  const signBlocks = (blocks) => `v1.${createHmac("sha256", "voicepage-test-session-secret")
    .update(JSON.stringify(["source-preview:v1", source, blocks])).digest("base64url")}`;
  assert.equal(signBlocks(preview.blocks), preview.previewToken);
  const oldBlocks = preview.blocks.map((block, index) => index ? block : { ...block, markdown: `${block.markdown}\n旧分块规则` });
  const refreshed = await rejected({ previewToken: signBlocks(oldBlocks) });
  assert.deepEqual(refreshed.blocks, preview.blocks);
  await delay(350);
  assertNoGeneration();
  console.log("PASS: missing, stale-source, tampered and outdated-block confirmations return fresh preview with no generation");

  let editedPreview;
  for (const [kind, from, to] of [["code", "2 ** 3", "2 ** 4"], ["math", "E-127", "E-126"], ["table", "甲", "乙"]]) {
    const index = preview.blocks.findIndex((block) => block.kind === kind);
    const edits = preview.blocks.map((block, idx) => idx === index ? { ...block, markdown: block.markdown.replace(from, to) } : block);
    assert.notEqual(edits[index].markdown, preview.blocks[index].markdown);
    const updated = await ok("/api/documents/preview", "POST", { blocks: edits });
    assertEdited(updated);
    assert.deepEqual(updated.blocks, edits, `Editing ${kind} must not rewrite any neighboring module`);
    assertNoGeneration();
    if (kind === "code") editedPreview = updated;
  }
  const forgedTypes = preview.blocks.map((block) => ({ ...block, kind: "text", lang: "ignored-client-metadata" }));
  const reidentified = await ok("/api/documents/preview", "POST", { blocks: forgedTypes });
  assert.deepEqual(reidentified.blocks, preview.blocks, "Only Markdown content determines preview kind and language");
  assertEdited(reidentified);
  const longMiddle = Array.from({ length: 32 }, (_, index) => `模块句${index + 1}：${"中间模块的正文，".repeat(8)}请阅读。`).join("");
  const longPreview = await ok("/api/documents/preview", "POST", { blocks: [
    { id: 0, kind: "text", markdown: "左侧短块。" },
    { id: 1, kind: "text", markdown: longMiddle },
    { id: 2, kind: "text", markdown: "右侧短块。" },
  ] });
  assertEdited(longPreview);
  assert.equal(longPreview.blocks.length, 3);
  assert.equal(longPreview.blocks[0].markdown, "左侧短块。");
  assert.equal(longPreview.blocks.at(-1).markdown, "右侧短块。");
  assert.equal(longPreview.blocks[1].markdown, longMiddle);
  for (const blocks of [
    [{ id: 0, kind: "text", markdown: " \n " }], [{ id: 1, kind: "text", markdown: "编号错误" }],
    [{ id: 0, kind: "unknown", markdown: "种类错误" }], [{ id: 0, kind: "text", markdown: "多余字段", extra: true }],
    [{ id: 0, kind: "text", markdown: "[unused]: https://example.invalid/definition-only" }],
    [{ id: 0, kind: "text", markdown: "x".repeat(30001) }],
  ]) {
    const invalidPreview = await request("/api/documents/preview", "POST", { blocks });
    assert.equal(invalidPreview.status, 400);
    const invalidCreate = await request("/api/documents", "POST", { ...settings, text: joined(blocks), previewBlocks: blocks, previewToken: editedPreview.previewToken });
    assert.equal(invalidCreate.status, 400);
  }
  assertNoGeneration();
  console.log("PASS: code/math/table edits preserve neighbors; long manual modules stay intact; invalid edits call no models");

  const structuralBase = await ok("/api/documents/preview", "POST", { blocks: [
    { id: 0, kind: "text", markdown: "结构原始甲。" },
    { id: 1, kind: "text", markdown: "结构原始乙。" },
    { id: 2, kind: "text", markdown: "结构原始丙。" },
  ] });
  for (const index of [0, 1, structuralBase.blocks.length]) {
    const inserted = await ok("/api/documents/preview", "POST", { blocks: structuralBase.blocks, action: { type: "insert", index, markdown: "新增模块。" } });
    assertEdited(inserted);
    const expected = structuralBase.blocks.map((block) => block.markdown);
    expected.splice(index, 0, "新增模块。");
    assert.deepEqual(inserted.blocks.map((block) => block.markdown), expected);
    assert.notEqual(inserted.previewToken, structuralBase.previewToken);
  }
  let deleted = await ok("/api/documents/preview", "POST", { blocks: structuralBase.blocks, action: { type: "delete", index: 1 } });
  assert.deepEqual(deleted.blocks.map((block) => block.markdown), ["结构原始甲。", "结构原始丙。"]);
  while (deleted.blocks.length) deleted = await ok("/api/documents/preview", "POST", { blocks: deleted.blocks, action: { type: "delete", index: 0 } });
  assertEdited(deleted);
  assert.equal(deleted.sourceText, "");
  assert.deepEqual(deleted.blocks, []);
  assert.deepEqual(await ok("/api/documents/preview", "POST", { blocks: [] }), deleted);
  const emptyCreate = await request("/api/documents", "POST", { ...settings, text: "", previewBlocks: [], previewToken: deleted.previewToken });
  assert.equal(emptyCreate.status, 400);
  const recovered = await ok("/api/documents/preview", "POST", { blocks: [], action: { type: "insert", index: 0, markdown: "从空预览恢复。" } });
  assertEdited(recovered);
  assert.equal(recovered.blocks.length, 1);
  assert.equal(recovered.blocks[0].markdown, "从空预览恢复。");

  const mergedLong = await ok("/api/documents/preview", "POST", { blocks: longPreview.blocks, action: { type: "merge", index: 0 } });
  assertEdited(mergedLong);
  assert.equal(mergedLong.blocks.length, 2);
  assert.equal(mergedLong.blocks[0].markdown, joined(longPreview.blocks.slice(0, 2)));
  assert.equal(mergedLong.blocks[1].markdown, longPreview.blocks[2].markdown);
  const structuredPreview = await ok("/api/documents/preview", "POST", { blocks: mergedLong.blocks.map((block, index) => index ? block : { ...block, markdown: `${block.markdown}\n\n合并后再次编辑。` }) });
  assertEdited(structuredPreview);
  assert.equal(structuredPreview.blocks.length, 2);
  assert.ok(structuredPreview.blocks[0].markdown.length > 500);
  assert.ok(structuredPreview.blocks[0].markdown.endsWith("合并后再次编辑。"));
  const codeIndex = editedPreview.blocks.findIndex((block) => block.kind === "code");
  assert.equal(editedPreview.blocks[codeIndex + 1].kind, "table");
  const mixed = await ok("/api/documents/preview", "POST", { blocks: editedPreview.blocks, action: { type: "merge", index: codeIndex } });
  assertEdited(mixed);
  assert.equal(mixed.blocks.length, editedPreview.blocks.length - 1);
  assert.deepEqual(syntax(mixed.blocks[codeIndex].markdown), [...syntax(editedPreview.blocks[codeIndex].markdown), ...syntax(editedPreview.blocks[codeIndex + 1].markdown)]);
  assert.deepEqual(await ok("/api/documents/preview", "POST", { blocks: mixed.blocks }), mixed);

  for (const action of [
    { type: "insert", index: -1, markdown: "无效" }, { type: "insert", index: 0.5, markdown: "无效" },
    { type: "insert", index: 4, markdown: "无效" }, { type: "insert", index: 0, markdown: " \n " },
    { type: "delete", index: -1 }, { type: "delete", index: 0.5 }, { type: "delete", index: 3 },
    { type: "merge", index: -1 }, { type: "merge", index: 0.5 }, { type: "merge", index: 2 },
    { type: "unknown", index: 0 }, { type: "insert", index: 0, markdown: "x".repeat(30001) },
  ]) {
    const invalidAction = await request("/api/documents/preview", "POST", { blocks: structuralBase.blocks, action });
    assert.equal(invalidAction.status, 400);
    assert.deepEqual(await ok("/api/documents/preview", "POST", { blocks: structuralBase.blocks }), structuralBase);
  }
  const totalTooLong = await request("/api/documents/preview", "POST", {
    blocks: [{ id: 0, kind: "text", markdown: "a".repeat(29000) }],
    action: { type: "insert", index: 1, markdown: "b".repeat(1000) },
  });
  assert.equal(totalTooLong.status, 400, "Joined module separators count toward the total source limit");
  await rejected({ text: mergedLong.sourceText, previewBlocks: mergedLong.blocks, previewToken: longPreview.previewToken });
  await rejected({ text: mixed.sourceText, previewBlocks: mixed.blocks, previewToken: editedPreview.previewToken });
  assertNoGeneration();
  console.log("PASS: insert/delete/merge are atomic local previews; empty previews recover; old structural tokens cannot confirm new blocks");

  const editedBody = { text: editedPreview.sourceText, previewBlocks: editedPreview.blocks, previewToken: editedPreview.previewToken };
  for (const body of [
    { ...editedBody, previewToken: undefined },
    { ...editedBody, previewToken: preview.previewToken },
    { ...editedBody, text: `${editedBody.text}\n正文不一致` },
    { ...editedBody, previewBlocks: editedBody.previewBlocks.map((block, index) => index ? block : { ...block, kind: "code" }) },
    { ...editedBody, previewBlocks: editedBody.previewBlocks.map((block) => block.kind === "code" ? { ...block, lang: "python" } : block) },
    { ...editedBody, previewBlocks: editedBody.previewBlocks.map((block, index) => index ? block : { ...block, markdown: `${block.markdown}\n块内改字` }) },
  ]) {
    const refreshed = await rejected(body);
    assertEdited(refreshed);
  }
  assertNoGeneration();
  console.log("PASS: b1 confirmation rejects missing token and stale text, block contents or metadata without queueing");

  const accepted = await request("/api/documents", "POST", { ...settings, text: source, previewToken: preview.previewToken });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.scriptModel, "local/mock");
  assert.equal(accepted.body.sourceText, source);
  await completed(accepted.body, preview.blocks);
  assert.equal(mock.events.filter((event) => event.stage === "spoken").length, 1);
  assert.equal(mock.events.filter((event) => event.stage === "tags").length, 0);
  assert.equal(mock.events.filter((event) => event.stage === "tts").length, preview.blocks.length);
  console.log("PASS: confirmed 202 task finishes without polling and stores exactly the previewed blocks");

  const editedAccepted = await request("/api/documents", "POST", { ...settings, ...editedBody });
  assert.equal(editedAccepted.status, 202);
  assert.equal(editedAccepted.body.sourceText, editedPreview.sourceText);
  assert.deepEqual(JSON.parse(database.prepare("SELECT prepared_blocks_json FROM documents WHERE id = ?").get(editedAccepted.body.id).prepared_blocks_json), editedPreview.blocks);
  await completed(editedAccepted.body, editedPreview.blocks);
  console.log("PASS: undo restores the old signed snapshot; edited confirmation generates exactly its source and blocks");

  const structuredAccepted = await request("/api/documents", "POST", { ...settings, text: structuredPreview.sourceText, previewBlocks: structuredPreview.blocks, previewToken: structuredPreview.previewToken });
  assert.equal(structuredAccepted.status, 202);
  assert.equal(structuredAccepted.body.sourceText, structuredPreview.sourceText);
  assert.deepEqual(JSON.parse(database.prepare("SELECT prepared_blocks_json FROM documents WHERE id = ?").get(structuredAccepted.body.id).prepared_blocks_json), structuredPreview.blocks);
  await completed(structuredAccepted.body, structuredPreview.blocks);
  const mixedAccepted = await request("/api/documents", "POST", { ...settings, text: mixed.sourceText, previewBlocks: mixed.blocks, previewToken: mixed.previewToken });
  assert.equal(mixedAccepted.status, 202);
  await completed(mixedAccepted.body, mixed.blocks);
  console.log("PASS: long and mixed merged blocks stay intact through editing, persisted confirmation and audio generation");

  const countsBeforeSettings = persistedCounts();
  const requestsBeforeSettings = mock.events.length;
  assert.deepEqual(await ok("/api/settings/generation", "PATCH", { previewBeforeGeneration: false }), { previewBeforeGeneration: false });
  assertNoGeneration(countsBeforeSettings, requestsBeforeSettings);
  await fixture.restart();
  assert.deepEqual(await ok("/api/settings/generation"), { previewBeforeGeneration: false });
  assertNoGeneration(countsBeforeSettings, requestsBeforeSettings);
  await rejected({ previewToken: signBlocks(oldBlocks) }, countsBeforeSettings, requestsBeforeSettings);
  assertEdited(await rejected({ ...editedBody, previewToken: undefined }, countsBeforeSettings, requestsBeforeSettings));
  assertEdited(await rejected({ ...editedBody, text: `${editedBody.text}\n修改` }, countsBeforeSettings, requestsBeforeSettings));
  const direct = await request("/api/documents", "POST", { ...settings, text: source });
  assert.equal(direct.status, 202);
  assert.equal(direct.body.scriptModel, "local/mock");
  await completed(direct.body, preview.blocks);

  assert.deepEqual(await ok("/api/settings/generation", "PATCH", { previewBeforeGeneration: true }), { previewBeforeGeneration: true });
  const countsAfterDirect = persistedCounts();
  const requestsAfterDirect = mock.events.length;
  await rejected({}, countsAfterDirect, requestsAfterDirect);
  await delay(350);
  assertNoGeneration(countsAfterDirect, requestsAfterDirect);
  console.log("PASS: disabling preview survives restart and permits direct queueing; enabling it restores confirmation");
  succeeded = true;
} catch (error) {
  failure = error;
  console.error(error);
  process.exitCode = 1;
} finally {
  await fixture.close({ success: succeeded, error: failure });
}
if (succeeded) {
  assert.equal(fs.existsSync(fixture.dir), false, "Successful fixture workspace must be removed");
  console.log("PASS: source preview fixture shut down and removed its temporary workspace");
}
