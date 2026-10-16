import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "./register-typescript.mjs";

const { mergeMarkdownBlocks } = await import("../src/lib/script/merge-markdown.ts");
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath, { singleDollarTextMath: false });
const merged = (left, right) => parser.parse(mergeMarkdownBlocks(left, right));
const nodes = (node, type) => [node.type === type ? node : undefined,
  ...(node.children ?? []).flatMap((child) => nodes(child, type))].filter(Boolean);
const texts = (node) => nodes(node, "text").map((value) => value.value);
const normalizeId = (value) => value.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();

function referencedUrls(tree, type = "linkReference") {
  const definitions = new Map();
  for (const node of nodes(tree, "definition")) {
    const id = normalizeId(node.identifier);
    if (!definitions.has(id)) definitions.set(id, node.url);
  }
  return nodes(tree, type).map((node) => definitions.get(normalizeId(node.identifier)));
}

test("ordinary prose, formatting, inline code and URLs survive a mixed module", () => {
  const tree = merged("## 标题\n\n正文有 **重点**、`x < 3` 和 [网页](https://example.test?a=1&b=2)。", "后面的正文。\n\n<https://other.test/path>");
  assert.deepEqual(tree.children.map((node) => node.type), ["heading", "paragraph", "paragraph", "paragraph"]);
  assert.equal(nodes(tree, "strong")[0].children[0].value, "重点");
  assert.equal(nodes(tree, "inlineCode")[0].value, "x < 3");
  assert.deepEqual(nodes(tree, "link").map((node) => node.url), ["https://example.test?a=1&b=2", "https://other.test/path"]);
});

test("an unclosed left fence is closed before the right document", () => {
  const tree = merged("```ts\n  const keep = `value`;\n\n  // 尾部空格  ", "# 仍是标题\n\n独立正文。");
  assert.deepEqual(tree.children.map((node) => node.type), ["code", "heading", "paragraph"]);
  assert.equal(tree.children[0].value, "  const keep = `value`;\n\n  // 尾部空格  ");
  assert.equal(tree.children[0].lang, "ts");
  assert.deepEqual(texts(tree), ["仍是标题", "独立正文。"]);
});

test("two code blocks keep metadata, inner fences, indentation and empty lines", () => {
  const left = "````md title=one\n```js\nx()\n```\n\n  indented  \n````";
  const right = "~~~python title=two\n  y = 2\n\nprint(y)\n~~~";
  const tree = merged(left, right);
  assert.deepEqual(tree.children.map((node) => node.type), ["code", "code"]);
  assert.deepEqual(nodes(tree, "code").map(({ value, lang, meta }) => ({ value, lang, meta })), [
    { value: "```js\nx()\n```\n\n  indented  ", lang: "md", meta: "title=one" },
    { value: "  y = 2\n\nprint(y)", lang: "python", meta: "title=two" },
  ]);
});

test("adjacent tables remain distinct and retain alignment and escaped pipes", () => {
  const tree = merged("| A | B |\n| :-- | --: |\n| x\\|y | `one` |", "| C | D |\n| :-: | --- |\n| two | three |");
  assert.deepEqual(tree.children.map((node) => node.type), ["table", "table"]);
  assert.deepEqual(nodes(tree, "table").map((node) => node.align), [["left", "right"], ["center", null]]);
  assert.ok(texts(tree).includes("x|y"));
  assert.equal(nodes(tree, "inlineCode")[0].value, "one");
});

test("display math, copied LaTeX delimiters and ordinary dollars stay independent", () => {
  const tree = merged("$$\n\\frac{a}{b} + 1\n$$", "\\[\\begin{matrix}a&b\\\\c&d\\end{matrix}\\]\n\n价格 $5，内联 \\(x^2\\)。");
  assert.deepEqual(nodes(tree, "math").map((node) => node.value), ["\\frac{a}{b} + 1", "\\begin{matrix}a&b\\\\c&d\\end{matrix}"]);
  assert.equal(nodes(tree, "inlineMath")[0].value, "x^2");
  assert.ok(texts(tree).some((value) => value.includes("价格 $5")));
});

test("an unfinished math fence cannot consume the following prose", () => {
  const tree = merged("$$\na = b + c", "后续文本。");
  assert.deepEqual(tree.children.map((node) => node.type), ["math", "paragraph"]);
  assert.equal(tree.children[0].value, "a = b + c");
  assert.deepEqual(texts(tree), ["后续文本。"]);
});

test("independent ordered and unordered lists retain starts, tasks and nested structure", () => {
  const ordered = merged("2. 第二步\n   - 子项\n3. 第三步", "1. 新的第一步\n2. 新的第二步");
  assert.deepEqual(ordered.children.map((node) => [node.type, node.start, node.children.length]), [["list", 2, 2], ["list", 1, 2]]);
  assert.equal(nodes(ordered, "list").length, 3);
  const tasks = merged("- [x] 已完成\n- [ ] 待完成", "- 新列表");
  assert.deepEqual(tasks.children.map((node) => node.type), ["list", "list"]);
  assert.deepEqual(nodes(tasks.children[0], "listItem").map((node) => node.checked), [true, false]);
});

test("adjacent quotations keep independent boundaries and nested code", () => {
  const tree = merged("> 第一段\n>\n> ```js\n> x()\n> ```", "> 第二段");
  assert.deepEqual(tree.children.map((node) => node.type), ["blockquote", "blockquote"]);
  assert.deepEqual(texts(tree), ["第一段", "第二段"]);
  assert.equal(nodes(tree, "code")[0].value, "x()");
});

test("same-name references are isolated, including shortcut links and collapsed images", () => {
  const tree = merged("[same] ![same][]\n\n[same]: https://left.test/a 'Left'", "[SAME] ![same][]\n\n[same]: https://right.test/b 'Right'");
  assert.deepEqual(referencedUrls(tree), ["https://left.test/a", "https://right.test/b"]);
  assert.deepEqual(referencedUrls(tree, "imageReference"), ["https://left.test/a", "https://right.test/b"]);
  assert.deepEqual(texts(tree).filter((value) => value.trim()), ["same", "SAME"]);
  assert.deepEqual(nodes(tree, "imageReference").map((node) => node.alt), ["same", "same"]);
  assert.deepEqual(nodes(tree, "definition").map((node) => node.title), ["Left", "Right"]);
});

test("generated reference names avoid existing targets and preserve first-definition semantics", () => {
  const tree = merged("[left][same]\n\n[same]: https://left.test\n[merged-right-1]: https://reserved.test", "[right][same] [reserved][merged-right-2]\n\n[same]: https://right.test/first\n[same]: https://right.test/ignored\n[merged-right-2]: https://reserved-right.test");
  assert.deepEqual(referencedUrls(tree), ["https://left.test", "https://right.test/first", "https://reserved-right.test"]);
  assert.equal(nodes(tree, "definition").length, 5);
});

test("nonbreaking spaces in reference names remain distinct when a normal-space name collides", () => {
  const tree = merged("[left][a b]\n\n[a b]: https://left.test", "[space][a b] [nbsp][a\u00a0b]\n\n[a b]: https://right.test/space\n[a\u00a0b]: https://right.test/nbsp");
  assert.deepEqual(referencedUrls(tree), ["https://left.test", "https://right.test/space", "https://right.test/nbsp"]);
});

test("colliding footnotes and references within them keep the correct definition", () => {
  const tree = merged("Left[^Note]\n\n[^Note]: Left [source][x].\n\n[x]: https://left.test", "Right[^note]\n\n[^note]: Right [source][x].\n\n[x]: https://right.test");
  const references = nodes(tree, "footnoteReference");
  assert.notEqual(normalizeId(references[0].identifier), normalizeId(references[1].identifier));
  const definitions = new Map(nodes(tree, "footnoteDefinition").map((node) => [normalizeId(node.identifier), texts(node).join("")]));
  assert.deepEqual(references.map((node) => definitions.get(normalizeId(node.identifier))), ["Left source.", "Right source."]);
  assert.deepEqual(referencedUrls(tree), ["https://left.test", "https://right.test"]);
});

test("an unresolved reference cannot become active because of the other document", () => {
  const tree = merged("Literal [text][right] and [^note].", "[right]: https://right.test\n\n[^note]: Other footnote\n\nVisible text.");
  assert.equal(nodes(tree, "linkReference").length, 0);
  assert.equal(nodes(tree, "footnoteReference").length, 0);
  assert.ok(texts(tree).includes("Literal [text][right] and [^note]."));
});

test("long manual content is never repartitioned by the automatic size limits", () => {
  const left = "完整长段落。".repeat(200);
  const right = "后续完整长段落。".repeat(200);
  const tree = merged(left, right);
  assert.deepEqual(tree.children.map((node) => node.type), ["paragraph", "paragraph"]);
  assert.deepEqual(texts(tree), [left, right]);
});

test("raw HTML fails explicitly instead of swallowing a neighboring module", () => {
  assert.throws(() => mergeMarkdownBlocks("<div>\nleft", "right"), /原始 HTML/);
  assert.throws(() => mergeMarkdownBlocks("left", "right <span>inline</span>"), /原始 HTML/);
});
