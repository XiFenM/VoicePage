// 把原始 AI 回复（Markdown）切成若干"阅读块"。
// 每个块之后会对应一段口述稿与一段音频，播放时高亮当前块，实现"边听边读"。

export type BlockKind = "text" | "code" | "table" | "diagram" | "math";

export interface SourceBlock {
  id: number;
  kind: BlockKind;
  /** 原始 Markdown 片段，用于在页面上渲染 */
  markdown: string;
  /** 代码块的语言（若有） */
  lang?: string;
}

const DIAGRAM_LANGS = new Set(["mermaid", "plantuml", "puml", "dot", "graphviz", "d2"]);
const MAX_TEXT_BLOCK = 700; // 合并相邻文本段时的字符上限

export function splitMarkdown(input: string): SourceBlock[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const raw: Omit<SourceBlock, "id">[] = [];
  let buf: string[] = [];

  const flushText = () => {
    const md = buf.join("\n").trim();
    buf = [];
    if (!md) return;
    // 按空行切成段落
    for (const para of md.split(/\n{2,}/)) {
      const p = para.trim();
      if (!p) continue;
      raw.push({ kind: isTable(p) ? "table" : "text", markdown: p });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)/);
    const mathFence = /^\s*\$\$\s*$/.test(line);
    if (fence || mathFence) {
      flushText();
      const closer = fence ? new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`) : /^\s*\$\$\s*$/;
      const block = [line];
      i++;
      while (i < lines.length && !closer.test(lines[i])) block.push(lines[i++]);
      if (i < lines.length) block.push(lines[i]);
      const lang = fence?.[2]?.toLowerCase() || undefined;
      raw.push({
        kind: mathFence ? "math" : lang && DIAGRAM_LANGS.has(lang) ? "diagram" : "code",
        markdown: block.join("\n"),
        lang,
      });
      continue;
    }
    buf.push(line);
  }
  flushText();

  // 合并过短的相邻文本块，减少 TTS 请求次数，同时保持高亮粒度合理
  const merged: Omit<SourceBlock, "id">[] = [];
  for (const b of raw) {
    const last = merged[merged.length - 1];
    if (
      last &&
      b.kind === "text" &&
      last.kind === "text" &&
      !/^#{1,6}\s/.test(b.markdown) && // 标题另起一块
      last.markdown.length + b.markdown.length < MAX_TEXT_BLOCK
    ) {
      last.markdown += "\n\n" + b.markdown;
    } else {
      merged.push({ ...b });
    }
  }
  return merged.map((b, id) => ({ id, ...b }));
}

function isTable(p: string): boolean {
  const ls = p.split("\n");
  return ls.length >= 2 && /^\s*\|.*\|\s*$/.test(ls[0]) && /^\s*\|?\s*:?-{3,}/.test(ls[1]);
}
