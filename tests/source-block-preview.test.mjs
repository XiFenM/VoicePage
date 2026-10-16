import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import "./register-typescript.mjs";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
  return nextResolve(specifier, context);
} });

const { buildSourcePreview, buildEditedSourcePreview, verifyEditedSourcePreview, previewTokenMatches } = await import("../src/lib/script/source-preview.ts");
const { splitMarkdown } = await import("../src/lib/script/segment.ts");
const secret = "source-block-preview-test-secret";
const block = (id, markdown, extra = {}) => ({ id, kind: "text", markdown, ...extra });
const join = (blocks) => blocks.map((value) => value.markdown).join("\n\n");
const parser = unified().use(remarkParse).use(remarkGfm);
const syntax = (markdown) => JSON.parse(JSON.stringify(parser.parse(markdown).children, (key, value) => key === "position" ? undefined : value));

test("editing one preview module leaves its neighbors and input objects unchanged", () => {
  const original = [block(0, "第一块原文。"), block(1, "第二块原文。"), block(2, "第三块原文。")];
  const before = structuredClone(original);
  const edited = original.map((value, index) => index === 1 ? { ...value, markdown: "第二块已修正。" } : value);
  const preview = buildEditedSourcePreview(edited, secret);
  assert.deepEqual(original, before);
  assert.deepEqual(preview.blocks, edited);
  assert.equal(preview.sourceText, join(edited));
  assert.equal(preview.edited, true);
  assert.match(preview.previewToken, /^b1\./u);
});

test("manual module boundaries survive even when ordinary splitting would merge their paragraphs", () => {
  const input = [block(0, "短段甲。"), block(1, "短段乙。"), block(2, "短段丙。")];
  assert.equal(splitMarkdown(join(input)).length, 1, "The fixture must exercise genuinely distinct manual boundaries");
  const preview = buildEditedSourcePreview(input, secret);
  assert.deepEqual(preview.blocks, input);
  assert.deepEqual(buildEditedSourcePreview(preview.blocks, secret), preview);
});

test("a long manual module stays intact and never absorbs its short neighbors", () => {
  const sentences = Array.from({ length: 32 }, (_, index) => `主题${index + 1}：${"这一句只属于中间模块，".repeat(3)}请继续阅读。`);
  const middle = sentences.join("");
  const input = [block(0, "左侧邻居。"), block(1, middle), block(2, "右侧邻居。")];
  const preview = buildEditedSourcePreview(input, secret);
  assert.ok(splitMarkdown(middle).length > 1, "Automatic first-pass splitting still has normal reading limits");
  assert.equal(preview.blocks.length, 3);
  assert.equal(preview.blocks[0].markdown, input[0].markdown);
  assert.equal(preview.blocks.at(-1).markdown, input[2].markdown);
  assert.deepEqual(preview.blocks.map((value) => value.id), preview.blocks.map((_, index) => index));
  assert.equal(preview.blocks[1].markdown, middle);
  assert.ok(preview.blocks[1].markdown.length > 500);
  assert.equal(preview.sourceText, join(preview.blocks));
});

test("edited code, math, table and diagram modules are identified from Markdown rather than client metadata", () => {
  const inputs = [
    block(0, "```js\nconst answer = 42;\n  \n```", { kind: "math", lang: "wrong" }),
    block(1, String.raw`\[\frac{a}{b}\]`, { kind: "code", lang: "wrong" }),
    block(2, "列一 | 列二\n--- | ---\n甲 | 乙", { kind: "code", lang: "wrong" }),
    block(3, "```mermaid\ngraph LR\n A-->B\n```", { kind: "text" }),
    block(4, "普通正文。", { kind: "code", lang: "wrong" }),
  ];
  const preview = buildEditedSourcePreview(inputs, secret);
  assert.deepEqual(preview.blocks.map((value) => value.kind), ["code", "math", "table", "diagram", "text"]);
  assert.equal(preview.blocks[0].markdown, inputs[0].markdown);
  assert.equal(preview.blocks[0].lang, "js");
  assert.equal(preview.blocks[2].markdown, inputs[2].markdown);
  assert.equal(preview.blocks[3].lang, "mermaid");
  assert.equal(preview.blocks[1].lang, undefined);
  assert.equal(preview.blocks[4].lang, undefined);
  assert.ok(preview.blocks[1].markdown.includes(String.raw`\frac{a}{b}`));
  assert.equal(preview.sourceText, join(preview.blocks));
});

test("edited module input rejects empty content, invalid ids, unsupported metadata and oversized joined text", () => {
  for (const input of [
    [block(0, "")], [block(0, " \n\t ")], [block(1, "wrong start")],
    [block(0, "first"), block(0, "duplicate")], [block(0.5, "fraction")],
    [block(0, "unknown", { kind: "unknown" })], [block(0, "extra", { untrusted: true })],
    [block(0, "language", { lang: 42 })], [block(0, 42)],
    [block(0, "x".repeat(30001))], [block(0, "x".repeat(15000)), block(1, "y".repeat(15000))],
  ]) assert.throws(() => buildEditedSourcePreview(input, secret));
});

test("edited previews reject definition-only modules that cannot produce a visible reading block", () => {
  assert.throws(() => buildEditedSourcePreview([block(0, "[unused]: https://example.invalid/unused")], secret));
});

test("v1 text confirmation and b1 block confirmation remain distinct and content-bound", () => {
  const inputs = [block(0, "第一段。"), block(1, "第二段。")];
  const edited = buildEditedSourcePreview(inputs, secret);
  const ordinary = buildSourcePreview(join(inputs), secret);
  assert.equal(ordinary.sourceText, join(inputs));
  assert.match(ordinary.previewToken, /^v1\./u);
  assert.equal(ordinary.edited, undefined);
  assert.equal(previewTokenMatches(edited.previewToken, ordinary.previewToken), false);
  assert.equal(previewTokenMatches(edited.previewToken, buildEditedSourcePreview(inputs, secret).previewToken), true);
  assert.equal(previewTokenMatches(edited.previewToken, buildEditedSourcePreview([inputs[0], { ...inputs[1], markdown: "第二段修改。" }], secret).previewToken), false);
  assert.equal(previewTokenMatches(edited.previewToken, buildEditedSourcePreview(inputs, "different-test-secret").previewToken), false);
  assert.equal(previewTokenMatches(undefined, edited.previewToken), false);
  assert.equal(previewTokenMatches(`${edited.previewToken}changed`, edited.previewToken), false);
});

test("edited confirmation verifies exact text, boundaries and metadata without silently reinterpreting tampering", () => {
  const preview = buildEditedSourcePreview([block(0, "左侧短段。"), block(1, "右侧短段。"), block(2, "```js\nconst n = 1;\n```")], secret);
  assert.deepEqual(verifyEditedSourcePreview(preview.sourceText, preview.blocks, preview.previewToken, secret), preview);
  assert.equal(verifyEditedSourcePreview(`${preview.sourceText}\n修改正文`, preview.blocks, preview.previewToken, secret), null);
  assert.equal(verifyEditedSourcePreview(preview.sourceText, preview.blocks, undefined, secret), null);
  for (const changed of [
    preview.blocks.map((value, index) => index ? value : { ...value, kind: "code" }),
    preview.blocks.map((value) => value.kind === "code" ? { ...value, lang: "python" } : value),
    preview.blocks.map((value, index) => index ? value : { ...value, markdown: "修改单块正文。" }),
    splitMarkdown(preview.sourceText),
  ]) assert.equal(verifyEditedSourcePreview(join(changed), changed, preview.previewToken, secret), null);
  const reorderedFields = preview.blocks.map(({ id, kind, markdown, lang }) => ({ markdown, kind, ...(lang ? { lang } : {}), id }));
  assert.deepEqual(verifyEditedSourcePreview(preview.sourceText, reorderedFields, preview.previewToken, secret), preview, "JSON object key order is not a content edit");
  assert.throws(() => verifyEditedSourcePreview(preview.sourceText, [{ ...preview.blocks[0], extra: true }], preview.previewToken, secret));
});

function assertSnapshot(preview) {
  assert.equal(preview.edited, true);
  assert.match(preview.previewToken, /^b1\./u);
  assert.equal(preview.sourceText, join(preview.blocks));
  assert.deepEqual(preview.blocks.map((value) => value.id), preview.blocks.map((_, index) => index));
}

test("insertion at the beginning, middle or end returns a new signed snapshot without mutating existing modules", () => {
  const input = [block(0, "原始甲。"), block(1, "原始乙。"), block(2, "原始丙。")];
  const original = structuredClone(input);
  const before = buildEditedSourcePreview(input, secret);
  for (const index of [0, 1, input.length]) {
    const preview = buildEditedSourcePreview(input, secret, { type: "insert", index, markdown: "插入正文。" });
    const expected = input.map((value) => value.markdown);
    expected.splice(index, 0, "插入正文。");
    assertSnapshot(preview);
    assert.deepEqual(preview.blocks.map((value) => value.markdown), expected);
    assert.notEqual(preview.previewToken, before.previewToken);
    assert.deepEqual(input, original);
  }
});

test("deleting the middle or last remaining module allows an empty preview and insertion can recover it", () => {
  const input = [block(0, "原始甲。"), block(1, "原始乙。"), block(2, "原始丙。")];
  let preview = buildEditedSourcePreview(input, secret, { type: "delete", index: 1 });
  assertSnapshot(preview);
  assert.deepEqual(preview.blocks.map((value) => value.markdown), ["原始甲。", "原始丙。"]);
  while (preview.blocks.length) preview = buildEditedSourcePreview(preview.blocks, secret, { type: "delete", index: 0 });
  assertSnapshot(preview);
  assert.deepEqual(preview.blocks, []);
  assert.equal(preview.sourceText, "");
  assert.deepEqual(buildEditedSourcePreview([], secret), preview);
  const recovered = buildEditedSourcePreview(preview.blocks, secret, { type: "insert", index: 0, markdown: "从空预览重新开始。" });
  assertSnapshot(recovered);
  assert.deepEqual(recovered.blocks, [block(0, "从空预览重新开始。")]);
});

test("merging long neighboring modules creates one permanent manual block through editing and confirmation", () => {
  const input = [block(0, "合并前半段。".repeat(100)), block(1, "合并后半段。".repeat(100)), block(2, "邻居保持独立。")];
  const original = structuredClone(input);
  const merged = buildEditedSourcePreview(input, secret, { type: "merge", index: 0 });
  assertSnapshot(merged);
  assert.equal(merged.blocks.length, 2);
  assert.equal(merged.blocks[0].markdown, join(input.slice(0, 2)));
  assert.ok(merged.blocks[0].markdown.length > 500);
  assert.equal(merged.blocks[1].markdown, input[2].markdown);
  assert.deepEqual(input, original);
  assert.deepEqual(buildEditedSourcePreview(merged.blocks, secret), merged);
  const edited = buildEditedSourcePreview(merged.blocks.map((value, index) => index ? value : { ...value, markdown: `${value.markdown}\n\n合并后继续编辑。` }), secret);
  assert.equal(edited.blocks.length, 2);
  assert.ok(edited.blocks[0].markdown.endsWith("合并后继续编辑。"));
  assert.deepEqual(verifyEditedSourcePreview(edited.sourceText, edited.blocks, edited.previewToken, secret), edited);
});

test("merging mixed code and table structures preserves both inside one reviewed module", () => {
  const code = "```js\nconst x = 1;\n```";
  const table = "列甲 | 列乙\n--- | ---\n一 | 二";
  const before = buildEditedSourcePreview([block(0, code), block(1, table)], secret);
  const merged = buildEditedSourcePreview(before.blocks, secret, { type: "merge", index: 0 });
  assertSnapshot(merged);
  assert.equal(merged.blocks.length, 1);
  assert.deepEqual(syntax(merged.blocks[0].markdown), [...syntax(code), ...syntax(table)]);
  assert.deepEqual(buildEditedSourcePreview(merged.blocks, secret), merged);
  assert.deepEqual(verifyEditedSourcePreview(merged.sourceText, merged.blocks, merged.previewToken, secret), merged);
});

test("invalid structural actions fail atomically without changing the prior signed preview", () => {
  const input = [block(0, "甲。"), block(1, "乙。")];
  const before = buildEditedSourcePreview(input, secret);
  const original = structuredClone(input);
  for (const action of [
    { type: "insert", index: -1, markdown: "无效" }, { type: "insert", index: 0.5, markdown: "无效" },
    { type: "insert", index: 3, markdown: "无效" }, { type: "insert", index: 0, markdown: " \n " },
    { type: "delete", index: -1 }, { type: "delete", index: 0.5 }, { type: "delete", index: 2 },
    { type: "merge", index: -1 }, { type: "merge", index: 0.5 }, { type: "merge", index: 1 },
    { type: "unknown", index: 0 }, { type: "insert", index: 0, markdown: "额外字段", extra: true },
    { type: "insert", index: 0, markdown: "x".repeat(30001) },
  ]) {
    assert.throws(() => buildEditedSourcePreview(input, secret, action));
    assert.deepEqual(input, original);
    assert.deepEqual(buildEditedSourcePreview(input, secret), before);
  }
  assert.throws(() => buildEditedSourcePreview([], secret, { type: "delete", index: 0 }));
  assert.throws(() => buildEditedSourcePreview([], secret, { type: "merge", index: 0 }));
  assert.throws(() => buildEditedSourcePreview([block(0, "a".repeat(29000))], secret, { type: "insert", index: 1, markdown: "b".repeat(1000) }));
});

test("a token for the old structure cannot confirm the new structure while undo can restore the old signed snapshot", () => {
  const before = buildEditedSourcePreview([block(0, "可撤销的甲。"), block(1, "可撤销的乙。")], secret);
  const after = buildEditedSourcePreview(before.blocks, secret, { type: "merge", index: 0 });
  assert.equal(verifyEditedSourcePreview(after.sourceText, after.blocks, before.previewToken, secret), null);
  assert.deepEqual(verifyEditedSourcePreview(before.sourceText, before.blocks, before.previewToken, secret), before);
  assert.notEqual(after.previewToken, before.previewToken);
});
