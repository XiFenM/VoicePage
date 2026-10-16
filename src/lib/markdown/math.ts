import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Nodes } from "mdast";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath, { singleDollarTextMath: false });
const protectedTypes = new Set(["code", "inlineCode", "math", "inlineMath", "html", "definition", "link", "image", "linkReference", "imageReference"]);

/**
 * Accept LaTeX \(...\) / \[...\], including doubled delimiters from copied AI
 * replies. Only delimiters change: TeX commands and \\ row breaks stay intact.
 * Shared by rendering and new-script segmentation; never writes stored text.
 */
export function normalizeMathDelimiters(input: string): string {
  if (!input.includes("\\(") && !input.includes("\\[")) return input;
  const protectedAt = new Uint8Array(input.length);
  const inlineOnlyAt = new Uint8Array(input.length);
  function mark(node: Nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    // Inline raw HTML has separate opening/closing nodes; protect the containing
    // paragraph too, so attributes and element contents are never rewritten.
    if (protectedTypes.has(node.type) || node.type === "paragraph" && node.children.some((child) => child.type === "html")) {
      protectedAt.fill(1, start, end);
      return;
    }
    if (node.type === "table" || node.type === "heading") inlineOnlyAt.fill(1, start, end);
    if ("children" in node) node.children.forEach(mark);
  }
  mark(parser.parse(input));

  function slashEnd(start: number): number {
    let end = start;
    while (input[end] === "\\") end++;
    return end;
  }
  function closing(start: number, width: number, bracket: string): number | undefined {
    let braces = 0;
    for (let i = start; i < input.length; i++) {
      if (protectedAt[i]) return undefined;
      if (input[i] === "\\") {
        const end = slashEnd(i);
        if (!braces && end - i === width && input[end] === bracket && !protectedAt[end]) return i;
        // Odd runs escape a following brace; even runs are TeX row breaks.
        i = end - ((end - i) % 2 === 0 ? 1 : 0);
      } else if (input[i] === "{") braces++;
      else if (input[i] === "}" && braces) braces--;
    }
  }

  const output: string[] = [];
  let copied = 0;
  for (let i = 0; i < input.length;) {
    if (input[i] !== "\\" || protectedAt[i]) { i++; continue; }
    const end = slashEnd(i);
    const width = end - i;
    const opener = input[end];
    if (width > 2 || opener !== "(" && opener !== "[") { i = end; continue; }
    const close = closing(end + 1, width, opener === "(" ? ")" : "]");
    if (close === undefined) { i = end + 1; continue; }
    const after = close + width + 1;
    const before = input.slice(input.lastIndexOf("\n", i - 1) + 1, i);
    const prefix = before.match(/^(?:[ \t]*>[ \t]?)*[ \t]*/)?.[0] ?? "";
    const marker = before.slice(prefix.length).match(/^(?:[-+*]|\d{1,9}[.)])[ \t]+/)?.[0] ?? "";
    const continuation = prefix + " ".repeat(marker.length);
    const body = input.slice(end + 1, close).replace(/\r\n?/g, "\n").split("\n")
      .map((line, index) => index && continuation && line.startsWith(continuation) ? line.slice(continuation.length) : line).join("\n").trim();
    if (!body || opener === "(" && /\n[ \t]*\n/.test(body)) { i = after; continue; }

    // A longer delimiter safely encloses dollar signs occurring inside TeX.
    const fence = "$".repeat(Math.max(2, ...Array.from(body.matchAll(/\$+/g), (match) => match[0].length + 1)));
    let replacement: string;
    if (opener === "[" && !inlineOnlyAt[i]) {
      const lead = before.slice(prefix.length + marker.length).trim() ? `\n${continuation}\n${continuation}` : "";
      const lineEnd = input.indexOf("\n", after);
      const tail = input.slice(after, lineEnd < 0 ? input.length : lineEnd).trim() ? `\n${continuation}\n${continuation}` : "";
      replacement = `${lead}${fence}\n${continuation}${body.split("\n").join(`\n${continuation}`)}\n${continuation}${fence}${tail}`;
    } else {
      replacement = `${fence} ${body.replace(/\n/g, " ")} ${fence}`;
    }
    output.push(input.slice(copied, i), replacement);
    copied = after;
    i = after;
  }
  output.push(input.slice(copied));
  return output.join("");
}
