import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkStringify from "remark-stringify";
import type { Nodes, Root } from "mdast";
import { normalizeMathDelimiters } from "../markdown/math";

const markdown = unified().use(remarkParse).use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: false })
  .use(remarkStringify, { bullet: "-", fences: true, listItemIndent: "one", incrementListMarker: false });

function visit(node: Nodes, callback: (node: Nodes) => void): void {
  callback(node);
  if ("children" in node) for (const child of node.children) visit(child, callback);
}

function identifier(value: string): string {
  // Match CommonMark identifier equivalence: NBSP is not Markdown whitespace.
  return value.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();
}

function referenceKey(node: Nodes): string | undefined {
  if (node.type === "definition" || node.type === "linkReference" || node.type === "imageReference") {
    return `link:${identifier(node.identifier)}`;
  }
  if (node.type === "footnoteDefinition" || node.type === "footnoteReference") {
    return `footnote:${identifier(node.identifier)}`;
  }
}

/** Rename the right document's definitions and uses together, including nested footnotes. */
function isolateReferences(left: Root, right: Root): void {
  const leftDefinitions = new Set<string>();
  const occupied = new Set<string>();
  const renames = new Map<string, string>();
  for (const tree of [left, right]) visit(tree, (node) => {
    const key = referenceKey(node);
    if (key) occupied.add(key);
    if (tree === left && (node.type === "definition" || node.type === "footnoteDefinition")) {
      leftDefinitions.add(key!);
    }
  });
  let counter = 0;
  visit(right, (node) => {
    if (node.type !== "definition" && node.type !== "footnoteDefinition") return;
    const key = referenceKey(node)!;
    if (!leftDefinitions.has(key) || renames.has(key)) return;
    const prefix = node.type === "definition" ? "link:" : "footnote:";
    let replacement: string;
    do { replacement = `merged-right-${++counter}`; }
    while (occupied.has(`${prefix}${identifier(replacement)}`));
    occupied.add(`${prefix}${identifier(replacement)}`);
    renames.set(key, replacement);
  });
  visit(right, (node) => {
    const key = referenceKey(node);
    const replacement = key && renames.get(key);
    if (!replacement || !("identifier" in node)) return;
    node.identifier = replacement;
    if ("label" in node) node.label = replacement;
    // Shortcut/collapsed syntax would otherwise continue using the visible
    // label as its target. Keep the text/alt, but spell out the renamed target.
    if (node.type === "linkReference" || node.type === "imageReference") node.referenceType = "full";
  });
}

/** Source locations and reference spelling do not affect Markdown meaning. */
function semanticTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticTree);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["position", "data", "label", "referenceType"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, key === "identifier" && typeof item === "string" ? identifier(item) : semanticTree(item)]));
}

/**
 * Merge two independently rendered Markdown documents into one manual module.
 * Parsing first closes unfinished code/math fences before the other document
 * is introduced. The serializer also separates adjacent lists and quotations.
 * This deliberately never invokes the automatic reading-block splitter.
 */
export function mergeMarkdownBlocks(left: string, right: string): string {
  const trees = [left, right].map((source) => markdown.parse(normalizeMathDelimiters(source.replace(/\r\n?/g, "\n"))));
  for (const tree of trees) visit(tree, (node) => {
    // Raw HTML can open a container across the boundary; Markdown alone cannot
    // guarantee that closing it preserves the original rendered meaning.
    if (node.type === "html") throw new Error("含有原始 HTML 的模块暂不支持直接合并，请先改为 Markdown 后重试。");
  });
  isolateReferences(trees[0], trees[1]);
  const merged: Root = { type: "root", children: [...trees[0].children, ...trees[1].children] };
  const output = markdown.stringify(merged).trimEnd();
  // Refuse unusual constructs the serializer cannot round-trip rather than
  // silently changing a list, losing code, or letting a fence absorb its neighbor.
  if (JSON.stringify(semanticTree(merged)) !== JSON.stringify(semanticTree(markdown.parse(output)))) {
    throw new Error("这两个模块包含无法安全保留的 Markdown 结构，请先分别调整内容后再合并。");
  }
  return output;
}
