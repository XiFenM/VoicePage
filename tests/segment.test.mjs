import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import "./register-typescript.mjs";

const { splitMarkdown } = await import("../src/lib/script/segment.ts");

// Public reading-block limits, rather than the splitter's packing strategy.
const MAX_TEXT_CHARS = 500;
const MAX_TEXT_LINES = 12;
const compact = (value) => value.replace(/\s+/gu, "");
const parser = unified().use(remarkParse).use(remarkGfm);

function descendants(node, type) {
  return [node.type === type ? node : undefined, ...(node.children ?? []).flatMap((child) => descendants(child, type))].filter(Boolean);
}

function visibleText(node) {
  if (node.type === "definition" || node.type === "footnoteDefinition") return "";
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "break") return "\n";
  return (node.children ?? []).map(visibleText).join("");
}

function assertOrdinaryTextBounds(blocks) {
  for (const block of blocks.filter((value) => value.kind === "text")) {
    assert.ok(block.markdown.length <= MAX_TEXT_CHARS, `Block ${block.id} has ${block.markdown.length} UTF-16 characters`);
    assert.ok(block.markdown.split("\n").length <= MAX_TEXT_LINES, `Block ${block.id} exceeds the source-line budget`);
  }
}

function assertContentInOrder(blocks, input) {
  assert.equal(compact(blocks.map((block) => block.markdown).join("\n\n")), compact(input));
}

function assertEachOnce(blocks, excerpts) {
  const all = blocks.map((block) => block.markdown).join("\n\n");
  let previous = -1;
  for (const excerpt of excerpts) {
    const position = all.indexOf(excerpt);
    assert.ok(position > previous, `Missing or reordered excerpt: ${excerpt.slice(0, 50)}`);
    assert.equal(all.indexOf(excerpt, position + excerpt.length), -1, `Duplicated excerpt: ${excerpt.slice(0, 50)}`);
    assert.ok(blocks.some((block) => block.markdown.includes(excerpt)), `Excerpt was split across blocks: ${excerpt.slice(0, 50)}`);
    previous = position;
  }
}

test("space-only and tab-only blank lines separate headings, prose and GFM tables", () => {
  const input = [
    "# 开始", "这是开始的说明。".repeat(18), "  ",
    "## 比较", "这里先解释两个方案。".repeat(18), "\t \t",
    "方案 | 优点", "--- | ---", "甲 | 易读", "乙 | 简洁", " \t ",
    "## 结论", "结论仍保持独立标题。",
  ].join("\n");
  const blocks = splitMarkdown(input);
  assertOrdinaryTextBounds(blocks);
  assertContentInOrder(blocks, input);
  assert.equal(blocks.filter((block) => block.kind === "table").length, 1);
  for (const heading of ["# 开始", "## 比较", "## 结论"]) {
    assert.ok(blocks.some((block) => block.markdown.startsWith(heading)), `${heading} must begin a block`);
  }
});

test("long Chinese paragraphs split at sentence boundaries without losing or repeating content", () => {
  const sentences = Array.from({ length: 24 }, (_, index) => `第${index + 1}句：${"先理解原文，再听讲解，并结合屏幕上的内容继续阅读，".repeat(2)}这样更容易掌握。`);
  const input = sentences.join("");
  const blocks = splitMarkdown(input);
  assert.ok(blocks.length > 1);
  assertOrdinaryTextBounds(blocks);
  assertEachOnce(blocks, sentences);
  assertContentInOrder(blocks, input);
});

test("long English paragraphs preserve whole sentences and their reading order", () => {
  const sentences = Array.from({ length: 24 }, (_, index) => `Sentence ${index + 1} explains one idea while the listener follows the original text on screen.`);
  const input = sentences.join(" ");
  const blocks = splitMarkdown(input);
  assert.ok(blocks.length > 1);
  assertOrdinaryTextBounds(blocks);
  assertEachOnce(blocks, sentences);
  assertContentInOrder(blocks, input);
});

test("a long sentence falls back to smaller text blocks without breaking Unicode characters", () => {
  const input = "甲乙丙丁😀".repeat(220);
  const blocks = splitMarkdown(input);
  assert.ok(blocks.length > 1);
  assertOrdinaryTextBounds(blocks);
  assertContentInOrder(blocks, input);
  for (const block of blocks) {
    assert.doesNotMatch(block.markdown, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }
});

test("many short source lines obey the line budget even below the character limit", () => {
  const lines = Array.from({ length: 48 }, (_, index) => `短行${String(index + 1).padStart(2, "0")}`);
  const input = lines.join("\n");
  assert.ok(input.length < MAX_TEXT_CHARS);
  const blocks = splitMarkdown(input);
  assert.ok(blocks.length >= 4);
  assertOrdinaryTextBounds(blocks);
  assertEachOnce(blocks, lines);
  assertContentInOrder(blocks, input);
});

test("short adjacent paragraphs may be packed but merged separators count toward both limits", () => {
  const paragraphs = Array.from({ length: 10 }, (_, index) => `段落${index + 1}：${"阅读与听讲相互配合。".repeat(7)}`);
  const input = paragraphs.join("\n\n");
  const blocks = splitMarkdown(input);
  assertOrdinaryTextBounds(blocks);
  assertEachOnce(blocks, paragraphs);
  assertContentInOrder(blocks, input);
});

test("ATX headings interrupt a paragraph without a blank line and always start a new block", () => {
  const input = "前一节的结束。\n# 第一节\n这一节的说明。\n## 第二节\n下一节的说明。";
  const blocks = splitMarkdown(input);
  assertContentInOrder(blocks, input);
  assert.ok(blocks.some((block) => block.markdown.startsWith("# 第一节")));
  assert.ok(blocks.some((block) => block.markdown.startsWith("## 第二节")));
  assert.ok(!blocks.some((block) => block.markdown.includes("前一节的结束。") && block.markdown.includes("# 第一节")));
});

test("a list splits between complete top-level items while nested children stay with their parent", () => {
  const items = Array.from({ length: 8 }, (_, index) => [
    `- 父项${index + 1}：${"需要结合屏幕理解这一个主题。".repeat(5)}`,
    `  - 子项${index + 1}甲：保留层级。`,
    `    - 深层${index + 1}：不能孤立。`,
    `  - 子项${index + 1}乙：仍属于同一父项。`,
  ].join("\n"));
  const input = items.join("\n");
  const blocks = splitMarkdown(input);
  assert.ok(blocks.length > 1);
  assertOrdinaryTextBounds(blocks);
  assertEachOnce(blocks, items);
  assertContentInOrder(blocks, input);
  for (const block of blocks) assert.match(block.markdown, /^- 父项\d+：/u);
});

test("one oversized list item can split its prose at paragraph and sentence boundaries", () => {
  const sentences = Array.from({ length: 18 }, (_, index) => `说明${index + 1}：${"这一项需要较长的说明，但仍应分成适合听读的片段，".repeat(2)}请继续阅读。`);
  const input = `- 长项目\n\n  ${sentences.slice(0, 9).join("")}\n\n  ${sentences.slice(9).join("")}\n\n- 最后一项：结束。`;
  const blocks = splitMarkdown(input);
  assert.ok(blocks.length > 2);
  assertOrdinaryTextBounds(blocks);
  assertEachOnce(blocks, ["长项目", ...sentences, "最后一项：结束。"]);
});

test("GFM tables without outside pipes and with escaped pipes remain whole table blocks", () => {
  const table = [
    "名称 | 说明", ":--- | ---:",
    ...Array.from({ length: 18 }, (_, index) => `项目${index + 1} | 含有转义的 \\| 符号以及${"完整说明".repeat(7)}`),
  ].join("\n");
  const input = `表格前。\n\n${table}\n\n表格后。`;
  const blocks = splitMarkdown(input);
  const tables = blocks.filter((block) => block.kind === "table");
  assert.equal(tables.length, 1);
  assert.equal(tables[0].markdown, table);
  assert.ok(table.length > MAX_TEXT_CHARS);
  assertContentInOrder(blocks, input);
});

test("fenced code keeps whitespace-only lines and content beyond normal text budgets intact", () => {
  const code = ["```ts", "const begin = true;", "  ", "\t", ...Array.from({ length: 22 }, (_, index) => `console.log('line ${index + 1}: ${"x".repeat(30)}');`), "```"].join("\n");
  const input = `代码前。\n\n${code}\n\n代码后。`;
  const blocks = splitMarkdown(input);
  const codes = blocks.filter((block) => block.kind === "code");
  assert.equal(codes.length, 1);
  assert.equal(codes[0].lang, "ts");
  assert.equal(codes[0].markdown, code);
  assertContentInOrder(blocks, input);
});

test("indented code is classified as code and keeps indentation and blank lines", () => {
  const code = ["    function example() {", "      const text = 'keep indentation';", "    ", "      return text;", "    }"].join("\n");
  const input = `引言。\n\n${code}\n\n结尾。`;
  const blocks = splitMarkdown(input);
  const codes = blocks.filter((block) => block.kind === "code");
  assert.equal(codes.length, 1);
  assert.equal(codes[0].markdown, code);
  assertContentInOrder(blocks, input);
});

test("diagram and display-math blocks stay intact across blank lines", () => {
  const diagram = ["~~~mermaid", "flowchart TD", "  ", ...Array.from({ length: 16 }, (_, index) => `  A${index} --> A${index + 1}`), "~~~"].join("\n");
  const math = ["$$", "\\begin{aligned}", "  ", ...Array.from({ length: 16 }, (_, index) => `x_{${index}} &= ${index} + ${index + 1} \\\\`), "\\end{aligned}", "$$"].join("\n");
  const input = `${diagram}\n\n${math}`;
  const blocks = splitMarkdown(input);
  assert.deepEqual(blocks.map((block) => block.kind), ["diagram", "math"]);
  assert.equal(blocks[0].lang, "mermaid");
  assert.equal(blocks[0].markdown, diagram);
  assert.equal(blocks[1].markdown, math);
});

test("an indivisible long inline-code span or link stays valid even if it exceeds the text limit", () => {
  for (const atomic of ["`" + "an_unbroken_identifier_".repeat(30) + "`", `[参考资料](https://example.invalid/${"long-path-".repeat(65)})`]) {
    const input = `前面的说明。${atomic}后面的说明。`;
    const blocks = splitMarkdown(input);
    assert.ok(blocks.some((block) => block.markdown.includes(atomic)));
    assertContentInOrder(blocks, input);
    assert.ok(blocks.filter((block) => block.markdown.length > MAX_TEXT_CHARS).every((block) => block.markdown.includes(atomic)));
  }
});

test("CRLF and CR line endings produce the same blocks as LF, without changing code whitespace", () => {
  const input = "开头。\n  \n# 标题\n正文。\n\n```js\nconst x = 1;\n  \n\t\n```\n\n结尾。";
  const expected = splitMarkdown(input);
  assert.deepEqual(splitMarkdown(input.replace(/\n/g, "\r\n")), expected);
  assert.deepEqual(splitMarkdown(input.replace(/\n/g, "\r")), expected);
});

test("all emitted blocks are nonempty, keep stable consecutive ids and preserve complete source order", () => {
  const input = " \t\n# 第一节\n正文。\n\n```js\nconsole.log(1);\n```\n\n名称 | 值\n--- | ---\n甲 | 1\n\n# 第二节\n结束。\n\t ";
  const blocks = splitMarkdown(input);
  assert.deepEqual(blocks.map((block) => block.id), blocks.map((_, index) => index));
  assert.ok(blocks.every((block) => block.markdown.trim()));
  assertContentInOrder(blocks, input);
  assert.deepEqual(splitMarkdown(input), blocks);
  assert.deepEqual(splitMarkdown(" \t\r\n\n\t "), []);
});

test("reference links and footnotes keep the definitions needed when each block is rendered independently", () => {
  const paragraphs = Array.from({ length: 12 }, (_, index) => `说明${index + 1}：${"阅读时需要对照资料，".repeat(8)}请看[文档][GUIDE]和注释[^note]。`);
  const input = `${paragraphs.join("\n\n")}\n\n[guide]: https://example.invalid/guide "说明文档"\n\n[^note]: 补充说明，见[来源][source]。\n\n[source]: https://example.invalid/source\n\n[unused]: https://example.invalid/unused`;
  const blocks = splitMarkdown(input);
  assert.ok(blocks.length > 1);
  let guideReferences = 0;
  let footnoteReferences = 0;
  for (const block of blocks) {
    const tree = parser.parse(block.markdown);
    const definitions = new Map(descendants(tree, "definition").map((node) => [node.identifier.toLowerCase(), node]));
    const notes = new Map(descendants(tree, "footnoteDefinition").map((node) => [node.identifier.toLowerCase(), node]));
    for (const reference of descendants(tree, "linkReference")) {
      assert.ok(definitions.has(reference.identifier.toLowerCase()), "A block must carry its referenced link definition");
      if (reference.identifier.toLowerCase() === "guide") guideReferences++;
    }
    for (const reference of descendants(tree, "footnoteReference")) {
      assert.ok(notes.has(reference.identifier.toLowerCase()), "A block must carry its referenced footnote");
      footnoteReferences++;
    }
    assert.equal(definitions.get("guide")?.url, "https://example.invalid/guide");
    assert.equal(definitions.get("guide")?.title, "说明文档");
    assert.equal(definitions.get("source")?.url, "https://example.invalid/source", "Definitions referenced from footnotes must travel too");
    assert.equal(definitions.has("unused"), false);
  }
  assert.equal(guideReferences, paragraphs.length);
  assert.equal(footnoteReferences, paragraphs.length);
  assert.equal(compact(blocks.map((block) => visibleText(parser.parse(block.markdown))).join("")), compact(visibleText(parser.parse(input))));
});

test("split ordered lists keep displayed numbering for a non-one start and repeated one markers", () => {
  for (const firstNumber of [7, 1]) {
    const input = Array.from({ length: 20 }, (_, index) => `${firstNumber === 1 ? 1 : firstNumber + index}. 项目${index + 1}：${"这一项的阅读说明。".repeat(8)}`).join("\n");
    const blocks = splitMarkdown(input);
    assert.ok(blocks.length > 1);
    assertOrdinaryTextBounds(blocks);
    const displayed = [];
    for (const block of blocks) {
      const tree = parser.parse(block.markdown);
      assert.ok(tree.children.every((node) => node.type === "list"));
      for (const list of tree.children) {
        assert.equal(list.ordered, true);
        for (const [index, item] of list.children.entries()) displayed.push({ number: list.start + index, label: visibleText(item).match(/^项目(\d+)：/u)?.[1] });
      }
    }
    assert.deepEqual(displayed, Array.from({ length: 20 }, (_, index) => ({ number: firstNumber + index, label: String(index + 1) })));
  }
});

test("long strong and emphasis spans remain formatted after splitting and reparsing", () => {
  const content = Array.from({ length: 28 }, (_, index) => `格式${index + 1}：${"这一整句都应保留原有强调，".repeat(2)}不要丢失格式。`).join("");
  for (const [delimiter, requiredTypes] of [["**", ["strong"]], ["*", ["emphasis"]], ["***", ["strong", "emphasis"]]]) {
    const blocks = splitMarkdown(`${delimiter}${content}${delimiter}`);
    assert.ok(blocks.length > 1);
    assertOrdinaryTextBounds(blocks);
    for (const block of blocks) {
      const tree = parser.parse(block.markdown);
      const visit = (node, ancestors = []) => {
        if (node.type === "text" && node.value.trim()) {
          for (const type of requiredTypes) assert.ok(ancestors.includes(type), `Lost ${type} around a text fragment`);
        }
        for (const child of node.children ?? []) visit(child, [...ancestors, node.type]);
      };
      visit(tree);
    }
    assert.equal(blocks.map((block) => visibleText(parser.parse(block.markdown))).join(""), content);
  }
});

test("oversized code nested in a list remains one complete code node within its list", () => {
  const codeLines = Array.from({ length: 25 }, (_, index) => `console.log('nested ${index + 1}: ${"x".repeat(25)}');`);
  const input = ["- 主项目：说明代码。", "", "  ```js", ...codeLines.map((line) => `  ${line}`), "  ```", "", "  代码后继续说明。", "", "- 后一项目：正常结束。"].join("\n");
  const blocks = splitMarkdown(input);
  const codeNodes = blocks.flatMap((block) => descendants(parser.parse(block.markdown), "code"));
  assert.equal(codeNodes.length, 1);
  assert.equal(codeNodes[0].lang, "js");
  assert.equal(codeNodes[0].value, codeLines.join("\n"));
  const containing = blocks.find((block) => descendants(parser.parse(block.markdown), "code").length);
  assert.ok(containing);
  assert.ok(containing.markdown.length > MAX_TEXT_CHARS, "The code block is an intentional atomic-size exception");
  const tree = parser.parse(containing.markdown);
  assert.equal(tree.children[0].type, "list");
  assert.equal(descendants(tree.children[0], "code").length, 1);
  assertEachOnce(blocks, ["主项目：说明代码。", "代码后继续说明。", "后一项目：正常结束。"]);
});

test("hard line breaks remain hard breaks inside chunks and do not add visible backslashes at boundaries", () => {
  const lines = Array.from({ length: 30 }, (_, index) => `硬行${String(index + 1).padStart(2, "0")}`);
  const blocks = splitMarkdown(lines.join("  \n"));
  assert.ok(blocks.length > 1);
  assertOrdinaryTextBounds(blocks);
  for (const block of blocks) {
    const tree = parser.parse(block.markdown);
    const labels = visibleText(tree).match(/硬行\d+/gu) ?? [];
    assert.equal(descendants(tree, "break").length, labels.length - 1);
  }
  assert.equal(compact(blocks.map((block) => visibleText(parser.parse(block.markdown))).join("")), lines.join(""));
});

test("long blockquotes remain quotations after splitting with no missing content", () => {
  const lines = Array.from({ length: 30 }, (_, index) => `引用${index + 1}：${"这段话仍属于引用。".repeat(3)}`);
  const input = lines.map((line) => `> ${line}`).join("\n");
  const blocks = splitMarkdown(input);
  assert.ok(blocks.length > 1);
  assertOrdinaryTextBounds(blocks);
  for (const block of blocks) assert.ok(parser.parse(block.markdown).children.every((node) => node.type === "blockquote"));
  assert.equal(compact(blocks.map((block) => visibleText(parser.parse(block.markdown))).join("")), compact(lines.join("")));
});

test("an oversized inline atom does not absorb the surrounding ordinary prose", () => {
  for (const atomic of ["`" + "indivisible_identifier_".repeat(32) + "`", `[完整链接](https://example.invalid/${"long-path-".repeat(70)})`]) {
    const before = "原子之前的正文。".repeat(12);
    const after = "原子之后的正文。".repeat(12);
    const blocks = splitMarkdown(`${before}${atomic}${after}`);
    const atomIndex = blocks.findIndex((block) => block.markdown.includes(atomic));
    assert.ok(atomIndex > 0 && atomIndex < blocks.length - 1);
    assert.equal(blocks[atomIndex].markdown.trim(), atomic);
    assertOrdinaryTextBounds(blocks.filter((_, index) => index !== atomIndex));
    assertContentInOrder(blocks, `${before}${atomic}${after}`);
  }
});

test("ordered lists that would need ten-digit continuation markers keep their complete structure", () => {
  const list = Array.from({ length: 14 }, (_, index) => `999999999. item-${index}`).join("\n");
  for (const input of [list, list.split("\n").map((line) => `> ${line}`).join("\n")]) {
    const blocks = splitMarkdown(input);
    assert.equal(blocks.length, 1, "An unrepresentable continuation is an atomic structural exception");
    const tree = parser.parse(blocks[0].markdown);
    const lists = descendants(tree, "list");
    assert.equal(lists.length, 1);
    assert.equal(lists[0].start, 999999999);
    assert.deepEqual(lists[0].children.map(visibleText), Array.from({ length: 14 }, (_, index) => `item-${index}`));
    assert.doesNotMatch(blocks[0].markdown, /(?:^|\n)[> ]*\d{10,}\. /u);
    if (input === list) assert.equal(blocks[0].markdown, input);
    else assert.equal(tree.children[0].type, "blockquote");
  }
});

test("paragraph continuations keep their original ordered or checked list item identity", () => {
  const paragraphs = Array.from({ length: 2 }, (_, paragraph) =>
    Array.from({ length: 6 }, (_, line) => `O${paragraph}-${line} aaaaaaaaaa`).join("\n"));
  const ordered = `7. ${paragraphs.join("\n\n").replaceAll("\n", "\n   ")}\n8. actual-next`;
  const checked = `- [x] ${paragraphs.join("\n\n").replaceAll("\n", "\n  ")}\n- [ ] actual-next`;
  for (const input of [ordered, ordered.split("\n").map((line) => `> ${line}`).join("\n"), checked]) {
    const blocks = splitMarkdown(input);
    assert.ok(blocks.length > 1);
    assertOrdinaryTextBounds(blocks);
    const items = blocks.flatMap((block) => descendants(parser.parse(block.markdown), "list").flatMap((list) =>
      list.children.map((item, index) => ({
        label: visibleText(item).match(/^(O\d|actual-next)/u)?.[1],
        number: list.ordered ? list.start + index : null,
        checked: item.checked,
      }))));
    const expected = input === checked
      ? [{ label: "O0", number: null, checked: true }, { label: "O1", number: null, checked: true }, { label: "actual-next", number: null, checked: false }]
      : [{ label: "O0", number: 7, checked: null }, { label: "O1", number: 7, checked: null }, { label: "actual-next", number: 8, checked: null }];
    assert.deepEqual(items, expected);
    assert.equal(compact(blocks.map((block) => visibleText(parser.parse(block.markdown))).join("")), compact(visibleText(parser.parse(input))));
    if (input.startsWith(">")) {
      for (const block of blocks) assert.ok(parser.parse(block.markdown).children.every((node) => node.type === "blockquote"));
    }
  }
});

test("link definitions nested inside a footnote also resolve references in other blocks", () => {
  const input = "Outside [link][target].\n\n# Another block\n\nFootnote [^n].\n\n[^n]: Footnote text.\n\n    [target]: https://example.invalid/nested";
  assert.equal(descendants(parser.parse(input), "linkReference").length, 1);
  const blocks = splitMarkdown(input);
  assert.ok(blocks.length > 1);
  const outside = blocks.find((block) => block.markdown.startsWith("Outside"));
  assert.ok(outside);
  const tree = parser.parse(outside.markdown);
  assert.deepEqual(descendants(tree, "linkReference").map((node) => node.identifier), ["target"]);
  assert.equal(descendants(tree, "definition").find((node) => node.identifier === "target")?.url, "https://example.invalid/nested");
  assert.equal(descendants(tree, "footnoteDefinition").length, 0, "Only the needed link definition must travel with the outside paragraph");
  assert.equal(compact(blocks.map((block) => visibleText(parser.parse(block.markdown))).join("")), compact(visibleText(parser.parse(input))));
});
