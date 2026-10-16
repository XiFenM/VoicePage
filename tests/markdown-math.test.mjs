import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMathDelimiters } from "../src/lib/markdown/math.ts";
import "./register-typescript.mjs";

const { splitMarkdown } = await import("../src/lib/script/segment.ts");

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath, { singleDollarTextMath: false });

// Load the real, synchronous UI component in memory without writing build files.
const componentSource = fs.readFileSync(new URL("../src/components/MarkdownContent.tsx", import.meta.url), "utf8");
const componentCode = ts.transpileModule(componentSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText.replace(/from (["'])(.*?)\1/gu, (_, quote, specifier) => {
  const resolved = specifier === "@/lib/markdown/math"
    ? new URL("../src/lib/markdown/math.ts", import.meta.url).href
    : import.meta.resolve(specifier);
  return `from ${JSON.stringify(resolved)}`;
});
const { MarkdownContent } = await import(`data:text/javascript;base64,${Buffer.from(componentCode).toString("base64")}`);
const render = (source) => renderToStaticMarkup(createElement(MarkdownContent, null, source));

function descendants(node, type) {
  return [node.type === type ? node : undefined, ...(node.children ?? []).flatMap((child) => descendants(child, type))].filter(Boolean);
}

test("LaTeX parenthesis delimiters become inline math without changing surrounding prose", () => {
  const source = String.raw`前文 \(x^2 + \frac{1}{2}\) 后文；另一个 \(y_1\)。`;
  const output = normalizeMathDelimiters(source);
  const tree = parser.parse(output);
  assert.deepEqual(descendants(tree, "inlineMath").map((node) => node.value), [String.raw`x^2 + \frac{1}{2}`, "y_1"]);
  assert.equal(descendants(tree, "math").length, 0);
  assert.deepEqual(descendants(tree, "text").map((node) => node.value), ["前文 ", " 后文；另一个 ", "。"]);
});

test("LaTeX bracket delimiters become display math and keep multiline formula contents", () => {
  for (const body of [String.raw`E = mc^2`, [String.raw`\begin{aligned}`, String.raw`a &= b + c \\`, String.raw`d &= e`, String.raw`\end{aligned}`].join("\n")]) {
    const source = `公式之前。\n\n\\[\n${body}\n\\]\n\n公式之后。`;
    const tree = parser.parse(normalizeMathDelimiters(source));
    assert.deepEqual(descendants(tree, "math").map((node) => node.value), [body]);
    assert.equal(descendants(tree, "inlineMath").length, 0);
    assert.deepEqual(descendants(tree, "text").map((node) => node.value), ["公式之前。", "公式之后。"]);
  }
});

test("copied double-backslash delimiters preserve single-backslash TeX commands from the reported formula", () => {
  const source = String.raw`\\[ \boxed{S=2^{E-127}} \\]`;
  const tree = parser.parse(normalizeMathDelimiters(source));
  assert.deepEqual(descendants(tree, "math").map((node) => node.value.trim()), [String.raw`\boxed{S=2^{E-127}}`]);
  assert.deepEqual(descendants(parser.parse(normalizeMathDelimiters(String.raw`内联 \\(\frac{a}{b}\\)。`)), "inlineMath").map((node) => node.value), [String.raw`\frac{a}{b}`]);
});

test("same-line display delimiters become a display block without swallowing nearby prose", () => {
  const tree = parser.parse(normalizeMathDelimiters(String.raw`之前。\[E=mc^2\]之后。`));
  assert.deepEqual(descendants(tree, "math").map((node) => node.value.trim()), ["E=mc^2"]);
  assert.deepEqual(descendants(tree, "text").map((node) => node.value), ["之前。", "之后。"]);
});

test("native double-dollar math stays byte-for-byte unchanged and normalization is idempotent", () => {
  const native = [String.raw`Inline $$x + y$$ and literal $5.`, "", "$$", String.raw`\text{Keep \( delimiters \) here} + \frac{1}{2}`, "$$"].join("\n");
  assert.equal(normalizeMathDelimiters(native), native);
  const mixed = `${native}\n\n追加 \\(z\\)。\n\n\\[\na=b\n\\]`;
  const normalized = normalizeMathDelimiters(mixed);
  assert.equal(normalizeMathDelimiters(normalized), normalized);
});

test("backtick and tilde fences protect formulas, including an unclosed fence", () => {
  const body = String.raw`\(not math\) and \[also not math\]`;
  for (const source of [
    ["```tex", body, "```"].join("\n"),
    ["~~~~text", body, "~~~", "~~~~"].join("\n"),
    ["```tex", body, "", String.raw`\[`, "unclosed", String.raw`\]`].join("\n"),
  ]) {
    assert.equal(normalizeMathDelimiters(source), source);
    const tree = parser.parse(normalizeMathDelimiters(source));
    assert.equal(descendants(tree, "code").length, 1);
    assert.equal(descendants(tree, "inlineMath").length + descendants(tree, "math").length, 0);
  }
});

test("inline code and indented code retain their literal delimiters", () => {
  for (const source of [
    String.raw`Use \`\(literal\)\` and \`\`\[literal \` value\]\`\` here.`.replaceAll("\\`", "`"),
    ["Before.", "", String.raw`    \(literal\)`, String.raw`    \[literal\]`, "", "After."].join("\n"),
  ]) {
    assert.equal(normalizeMathDelimiters(source), source);
    const tree = parser.parse(normalizeMathDelimiters(source));
    assert.equal(descendants(tree, "inlineMath").length + descendants(tree, "math").length, 0);
  }
});

test("URLs, link destinations, reference definitions and HTML attributes are not rewritten", () => {
  for (const source of [
    String.raw`https://example.invalid/\(route\)`,
    String.raw`www.example.invalid/\(route\)`,
    String.raw`[route](https://example.invalid/\(route\))`,
    String.raw`![image](https://example.invalid/\[image\].png)`,
    String.raw`<https://example.invalid/\(route\)>`,
    ["[route][id]", "", String.raw`[id]: https://example.invalid/\(route\) "\[title\]"`].join("\n"),
    String.raw`<span data-value="\(attribute\)">ordinary</span>`,
    ["<div>", String.raw`\[literal HTML body\]`, "</div>"].join("\n"),
    String.raw`<!-- \(comment\) -->`,
  ]) assert.equal(normalizeMathDelimiters(source), source);
});

test("ordinary escaped backslashes, incomplete delimiters and unsupported delimiter shapes stay literal", () => {
  for (const source of [
    String.raw`Show \\\(literal\\\) and \\\[literal\\\].`,
    String.raw`An unfinished \(opening and another \[opening.`,
    String.raw`Only closing delimiters \) and \] remain.`,
    String.raw`Ordinary \{braces\}, \alpha, Windows C:\temp\file and [square brackets].`,
  ]) assert.equal(normalizeMathDelimiters(source), source);
});

test("empty formulas and inline delimiters crossing a blank paragraph are left unchanged", () => {
  for (const source of [String.raw`\(\)`, String.raw`\[ \]`, "\\(first paragraph\n\nsecond paragraph\\)"]) {
    assert.equal(normalizeMathDelimiters(source), source);
  }
});

test("single-dollar currency and ordinary dollar text do not become math", () => {
  const source = "价格 $5 与 $10，预算 US$25.50；$variable 仍是普通文本。";
  assert.equal(normalizeMathDelimiters(source), source);
  const tree = parser.parse(normalizeMathDelimiters(source));
  assert.equal(descendants(tree, "inlineMath").length + descendants(tree, "math").length, 0);
});

test("a long inline formula remains one intact math node when surrounding prose is split", () => {
  const body = Array.from({ length: 90 }, (_, index) => `x_{${index}}`).join(" + ");
  assert.ok(body.length > 500);
  const before = "公式前的正文。".repeat(80);
  const after = "公式后的正文。".repeat(80);
  const blocks = splitMarkdown(`${before}\\(${body}\\)${after}`);
  const formulas = blocks.flatMap((block) => descendants(parser.parse(block.markdown), "inlineMath"));
  assert.deepEqual(formulas.map((node) => node.value), [body]);
  assert.equal(blocks.flatMap((block) => descendants(parser.parse(block.markdown), "text")).map((node) => node.value).join(""), before + after);
  for (const block of blocks.filter((block) => !descendants(parser.parse(block.markdown), "inlineMath").length)) {
    assert.ok(block.markdown.length <= 500);
    assert.ok(block.markdown.split("\n").length <= 12);
  }
});

test("a long display formula remains a single math block beyond normal character and line limits", () => {
  const body = Array.from({ length: 24 }, (_, index) => `x_{${index}} = ${"a + ".repeat(8)}b`).join("\n");
  const blocks = splitMarkdown(`之前。\n\n\\[\n${body}\n\\]\n\n之后。`);
  const mathBlocks = blocks.filter((block) => block.kind === "math");
  assert.equal(mathBlocks.length, 1);
  assert.deepEqual(descendants(parser.parse(mathBlocks[0].markdown), "math").map((node) => node.value), [body]);
  assert.ok(mathBlocks[0].markdown.length > 500);
  assert.ok(mathBlocks[0].markdown.split("\n").length > 12);
});

test("the shared Markdown component renders inline, display and copied formulas as KaTeX", () => {
  for (const source of [String.raw`内联 \(x^2\)。`, String.raw`\[\frac{a}{b}\]`, String.raw`\\[ \boxed{S=2^{E-127}} \\]`, "$$\na=b\n$$"]) {
    const html = render(source);
    assert.match(html, /class="katex"/u);
    assert.match(html, /<math[ >]/u);
    assert.doesNotMatch(html, /class="katex-error"/u);
  }
  assert.doesNotMatch(render(String.raw`内联 \(x^2\)。`), /class="katex-display"/u);
  assert.match(render(String.raw`\[x^2\]`), /class="katex-display"/u);
});

test("the shared component keeps code and currency literal and exposes malformed math without enabling HTML", () => {
  const code = "`\\(literal\\)`\n\n```tex\n\\[literal\\]\n```\n\n价格 $5 和 $10。";
  const html = render(code);
  assert.doesNotMatch(html, /class="katex(?:-display)?"/u);
  assert.match(html, /\\\(literal\\\)/u);
  assert.match(html, /价格 \$5 和 \$10/u);
  const invalid = render(String.raw`\(\frac{a}\)`);
  assert.match(invalid, /class="katex-error"/u);
  assert.match(invalid, /\\frac\{a\}/u);
  assert.doesNotMatch(render('<script>alert("x")</script>'), /<script[ >]/u);
});

test("display formulas in blockquotes preserve the quote container and TeX row breaks", () => {
  const body = [String.raw`\begin{aligned}`, String.raw`a &= b \\`, String.raw`c &= d`, String.raw`\end{aligned}`].join("\n");
  const source = ["Before.", "", String.raw`\[`, ...body.split("\n"), String.raw`\]`, "", "After."].map((line) => `> ${line}`).join("\n");
  const normalized = normalizeMathDelimiters(source);
  const tree = parser.parse(normalized);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].type, "blockquote");
  assert.deepEqual(descendants(tree, "math").map((node) => node.value), [body]);
  assert.deepEqual(descendants(tree, "text").map((node) => node.value), ["Before.", "After."]);
  assert.equal(normalizeMathDelimiters(normalized), normalized);
});

test("a display formula in a list item does not change item identity or nested list structure", () => {
  const source = [String.raw`- Formula \[a=b\]`, String.raw`  - Child \(x^2\)`, "- Next item."].join("\n");
  const tree = parser.parse(normalizeMathDelimiters(source));
  assert.equal(tree.children.length, 1);
  const list = tree.children[0];
  assert.equal(list.type, "list");
  assert.equal(list.children.length, 2);
  assert.deepEqual(descendants(list.children[0], "math").map((node) => node.value), ["a=b"]);
  assert.equal(descendants(list.children[0], "list").length, 1);
  assert.deepEqual(descendants(list.children[0], "inlineMath").map((node) => node.value), ["x^2"]);
  assert.deepEqual(descendants(list.children[1], "text").map((node) => node.value), ["Next item."]);
});

test("formulas in table cells and headings stay inline so their Markdown containers remain valid", () => {
  const source = [String.raw`# Heading \[E=mc^2\]`, "", "Name | Formula", "--- | ---", String.raw`First | \[a=b\]`, String.raw`Second | \(c=d\)`].join("\n");
  const tree = parser.parse(normalizeMathDelimiters(source));
  assert.equal(tree.children[0].type, "heading");
  const tables = descendants(tree, "table");
  assert.equal(tables.length, 1);
  assert.equal(tables[0].children.length, 3);
  assert.ok(tables[0].children.every((row) => row.children.length === 2));
  assert.deepEqual(descendants(tree, "inlineMath").map((node) => node.value), ["E=mc^2", "a=b", "c=d"]);
  assert.equal(descendants(tree, "math").length, 0);
});

test("native math protects delimiter-like TeX even when its dollar fence is unclosed", () => {
  for (const source of [String.raw`before $$ \text{\[literal\]} $$ after`, ["$$", String.raw`\text{\(literal\)} + \[x\]`, "unclosed"].join("\n")]) {
    assert.equal(normalizeMathDelimiters(source), source);
  }
  const body = String.raw`\text{price \$5 and $$ marker}`;
  const tree = parser.parse(normalizeMathDelimiters(`Before \\(${body}\\) after.`));
  assert.deepEqual(descendants(tree, "inlineMath").map((node) => node.value), [body]);
});
