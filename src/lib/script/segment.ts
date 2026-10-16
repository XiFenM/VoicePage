import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkStringify from "remark-stringify";
import type { Definition, FootnoteDefinition, List, ListItem, PhrasingContent, RootContent } from "mdast";
import { normalizeMathDelimiters } from "../markdown/math";

// 每块对应一段口述稿、一段音频和一个阅读高亮区域。只在生成新口述稿时运行。
export type BlockKind = "text" | "code" | "table" | "diagram" | "math";
export interface SourceBlock {
  id: number;
  kind: BlockKind;
  markdown: string;
  lang?: string;
}

// 源码行数不能保证任意屏幕都放得下，但能限制短列表/硬换行造成的超高块。
export const MAX_TEXT_CHARS = 500;
export const MAX_TEXT_LINES = 12;
const MERGE_CHARS = 300;
const MERGE_LINES = 8;
const DIAGRAM_LANGS = new Set(["mermaid", "plantuml", "puml", "dot", "graphviz", "d2"]);
const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkMath, { singleDollarTextMath: false })
  .use(remarkStringify, { bullet: "-", fences: true, listItemIndent: "one", incrementListMarker: false });
const sentences = new Intl.Segmenter("zh", { granularity: "sentence" });
const words = new Intl.Segmenter("zh", { granularity: "word" });
const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });

function within(text: string, chars = MAX_TEXT_CHARS, lines = MAX_TEXT_LINES): boolean {
  return text.length <= chars && text.split("\n").length <= lines;
}

/** Greedy packing never divides an indivisible Markdown structure. */
function pack<T, R>(items: T[], wrap: (items: T[]) => R, fits: (value: R) => boolean): R[] {
  const result: R[] = [];
  let pending: T[] = [];
  for (const item of items) {
    if (pending.length && !fits(wrap([...pending, item]))) {
      result.push(wrap(pending));
      pending = [];
    }
    pending.push(item);
  }
  if (pending.length) result.push(wrap(pending));
  return result;
}

function splitText(value: string, fits: (value: string) => boolean): string[] {
  const units: string[] = [];
  for (const { segment: sentence } of sentences.segment(value)) {
    if (fits(sentence)) units.push(sentence);
    else for (const { segment: word } of words.segment(sentence)) {
      if (fits(word)) units.push(word);
      else units.push(...Array.from(graphemes.segment(word), ({ segment }) => segment));
    }
  }
  return pack(units, (parts) => parts.join(""), fits);
}

function trimEdges(children: PhrasingContent[]): PhrasingContent[] {
  const result = [...children];
  // A block boundary already supplies a line break. Serializing a terminal
  // break and trimming its newline would leave a visible trailing backslash.
  while (result[0]?.type === "text" || result[0]?.type === "break") {
    if (result[0].type === "break") { result.shift(); continue; }
    const value = result[0].value.trimStart();
    if (value) { result[0] = { type: "text", value }; break; }
    result.shift();
  }
  while (result.at(-1)?.type === "text" || result.at(-1)?.type === "break") {
    if (result.at(-1)?.type === "break") { result.pop(); continue; }
    const last = result.at(-1) as Extract<PhrasingContent, { type: "text" }>;
    const value = last.value.trimEnd();
    if (value) { result[result.length - 1] = { type: "text", value }; break; }
    result.pop();
  }
  return result;
}

function splitInline(node: PhrasingContent, fits: (node: PhrasingContent) => boolean): PhrasingContent[] {
  if (fits(node)) return [node];
  if (node.type === "text") return splitText(node.value, (value) => fits({ type: "text", value }))
    .map((value) => ({ type: "text", value }));
  if (node.type === "emphasis" || node.type === "strong" || node.type === "delete") {
    const wrap = (children: PhrasingContent[]): PhrasingContent => ({ ...node, position: undefined, children: trimEdges(children) });
    const parts = node.children.flatMap((child) => splitInline(child, (part) => fits(wrap([part]))));
    return pack(parts, wrap, fits);
  }
  // Inline code, URLs/links, images, HTML and inline math are atomic. A single
  // oversized atom is an explicit exception, rather than corrupting its syntax.
  return [node];
}

function splitBlock(node: RootContent, fits: (node: RootContent) => boolean): RootContent[] {
  // CommonMark markers allow at most nine digits. Splitting such a list would
  // require an invalid continuation start; preserve its original structure.
  if (node.type === "list" && node.ordered && (node.start ?? 1) + node.children.length - 1 > 999_999_999) return [node];
  if (fits(node)) return [node];
  if (node.type === "paragraph" || node.type === "heading") {
    const wrap = (children: PhrasingContent[]): RootContent => ({ ...node, position: undefined, children: trimEdges(children) });
    const parts = node.children.flatMap((child) => splitInline(child, (part) => fits(wrap([part]))));
    return pack(parts, wrap, fits);
  }
  if (node.type === "blockquote") {
    const wrap = (children: RootContent[]): RootContent => ({ ...node, position: undefined, children: children as typeof node.children });
    const parts = node.children.flatMap((child) => splitBlock(child, (part) => fits(wrap([part]))));
    return pack(parts, wrap, fits);
  }
  if (node.type === "list") {
    type Item = { item: ListItem; index: number };
    const wrap = (parts: Item[]): List => ({ ...node, position: undefined,
      start: node.ordered ? (node.start ?? 1) + parts[0].index : node.start,
      children: parts.map(({ item }) => item),
    });
    const parts = node.children.flatMap((item, index): Item[] => {
      if (fits(wrap([{ item, index }]))) return [{ item, index }];
      const wrapItem = (children: RootContent[]): ListItem => ({ ...item, position: undefined, children: children as ListItem["children"] });
      const fitsItem = (part: ListItem) => fits(wrap([{ item: part, index }]));
      const children = item.children.flatMap((child) => splitBlock(child, (part) => fitsItem(wrapItem([part]))));
      return pack(children, wrapItem, fitsItem).map((part) => ({ item: part, index }));
    });
    // Continuations of one original item must not turn into additional steps.
    return pack(parts, (items) => items, (items) =>
      new Set(items.map(({ index }) => index)).size === items.length && fits(wrap(items)))
      .map(wrap);
  }
  // Fenced/indented code, tables, diagrams, math and raw HTML stay intact,
  // including when nested inside a list or quotation.
  return [node];
}

type DefinitionNode = Definition | FootnoteDefinition;
function isDefinition(node: RootContent): node is DefinitionNode {
  return node.type === "definition" || node.type === "footnoteDefinition";
}

export function splitMarkdown(input: string): SourceBlock[] {
  const source = normalizeMathDelimiters(input.replace(/\r\n?/g, "\n"));
  // CommonMark recognizes whitespace-only blank lines, headings without blank
  // lines, nested lists and GFM table boundaries. Never trim code lines globally.
  const tree = markdown.parse(source);
  const definitions = new Map<string, DefinitionNode>();
  const key = (type: string, identifier: string) => `${type}:${identifier.toUpperCase()}`;
  function collect(node: RootContent) {
    if (isDefinition(node)) {
      const id = key(node.type, node.identifier);
      if (!definitions.has(id)) definitions.set(id, node);
    }
    if ("children" in node) for (const child of node.children) collect(child as RootContent);
  }
  tree.children.forEach(collect);

  // Each displayed block is a separate Markdown document: carry just its link
  // and footnote definitions so splitting does not break cross-block references.
  function references(node: RootContent): DefinitionNode[] {
    const found = new Set<DefinitionNode>();
    function visit(value: RootContent | PhrasingContent) {
      if (value.type === "linkReference" || value.type === "imageReference" || value.type === "footnoteReference") {
        const def = definitions.get(key(value.type === "footnoteReference" ? "footnoteDefinition" : "definition", value.identifier));
        if (def && !found.has(def)) { found.add(def); visit(def); }
      }
      if ("children" in value) value.children.forEach((child) => visit(child as RootContent));
    }
    visit(node);
    return [...found];
  }
  function render(node: RootContent): string {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const body = start !== undefined && end !== undefined
      ? source.slice(start, end)
      : markdown.stringify({ type: "root", children: [node] }).trimEnd();
    const refs = references(node);
    return refs.length ? `${body}\n\n${markdown.stringify({ type: "root", children: refs }).trimEnd()}` : body;
  }

  const result: Omit<SourceBlock, "id">[] = [];
  let mergeAllowed = false;
  let afterHeading = false;
  for (const node of tree.children) {
    if (isDefinition(node)) continue;
    for (const part of splitBlock(node, (candidate) => within(render(candidate)))) {
      const text = render(part);
      if (!text.trim()) continue;
      const lang = part.type === "code" ? part.lang?.toLowerCase() || undefined : undefined;
      const kind: BlockKind = part.type === "code" ? (lang && DIAGRAM_LANGS.has(lang) ? "diagram" : "code")
        : part.type === "table" ? "table" : part.type === "math" ? "math" : "text";
      const previous = result[result.length - 1];
      const joined = previous ? `${previous.markdown}\n\n${text}` : text;
      // A heading always opens a new block; keep short heading + following text
      // together, including a following list when it fits the full budget.
      // Do not merge separate lists/quotes or across a thematic break.
      const mayJoin = part.type === "paragraph" || afterHeading && part.type === "list";
      const fitsMerge = afterHeading ? within(joined) : within(joined, MERGE_CHARS, MERGE_LINES);
      if (mergeAllowed && mayJoin && previous?.kind === "text" && fitsMerge) {
        previous.markdown = joined;
      } else result.push({ kind, markdown: text, ...(lang ? { lang } : {}) });
      mergeAllowed = part.type === "paragraph" || part.type === "heading";
      afterHeading = part.type === "heading";
    }
  }
  return result.map((block, id) => ({ id, ...block }));
}
