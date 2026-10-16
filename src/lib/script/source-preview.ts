import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { splitMarkdown } from "./segment";
import { SourceTextSchema } from "./source-input";
import { DraftBlocksSchema, EditableBlocksSchema, SourcePreviewActionSchema } from "./source-blocks";
import type { SourceBlock } from "./segment";
import type { SourcePreview, SourcePreviewAction } from "./types";
import { normalizeMathDelimiters } from "../markdown/math";
import { mergeMarkdownBlocks } from "./merge-markdown";

export class SourcePreviewError extends Error {}

/** No models, jobs or database writes: preview and confirmation share this path. */
export function buildSourcePreview(text: string, secret: string): SourcePreview {
  SourceTextSchema.parse(text);
  const blocks = splitMarkdown(text);
  if (!blocks.length) throw new SourcePreviewError("原文中没有可预览的正文，请补充内容后重试。");
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify(["source-preview:v1", text, blocks])).digest("base64url");
  return { sourceText: text, blocks, previewToken: `v1.${signature}` };
}

function editedSnapshot(blocks: SourceBlock[], secret: string): SourcePreview {
  const sourceText = blocks.length ? SourceTextSchema.parse(blocks.map((block) => block.markdown).join("\n\n")) : "";
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify(["source-preview:blocks:v1", sourceText, blocks])).digest("base64url");
  return { sourceText, blocks, previewToken: `b1.${signature}`, edited: true };
}

/** Manual boundaries override automatic size targets, including after merging. */
export function buildEditedSourcePreview(value: unknown, secret: string, action?: SourcePreviewAction): SourcePreview {
  const input = DraftBlocksSchema.parse(value);
  const adjusted = [...input];
  if (action !== undefined) {
    const operation = SourcePreviewActionSchema.parse(action);
    const { index } = operation;
    if (operation.type === "insert") {
      if (index > adjusted.length) throw new SourcePreviewError("插入位置已变化，请重试。");
      adjusted.splice(index, 0, { id: index, kind: "text", markdown: operation.markdown });
    } else if (operation.type === "delete") {
      if (index >= adjusted.length) throw new SourcePreviewError("要删除的模块不存在，请重试。");
      adjusted.splice(index, 1);
    } else {
      if (index + 1 >= adjusted.length) throw new SourcePreviewError("只能合并前后相邻的两个模块。");
      let markdown: string;
      try { markdown = mergeMarkdownBlocks(adjusted[index].markdown, adjusted[index + 1].markdown); }
      catch (error) { throw new SourcePreviewError(error instanceof Error ? error.message : "无法安全合并这两个模块，请先检查内容。"); }
      adjusted.splice(index, 2, { id: index, kind: "text", markdown });
    }
  }
  // Validate the total size again after inserts/merges, before parsing Markdown.
  const ordered = DraftBlocksSchema.parse(adjusted.map((block, id) => ({ ...block, id })));
  const blocks = ordered.map((block, index): SourceBlock => {
    const markdown = normalizeMathDelimiters(block.markdown.replace(/\r\n?/g, "\n"));
    const parsed = splitMarkdown(markdown);
    if (!parsed.length) throw new SourcePreviewError(`第 ${index + 1} 段没有可预览的正文，请补充内容后重试。`);
    const only = parsed.length === 1 ? parsed[0] : undefined;
    return { id: index, kind: only?.kind ?? "text", markdown, ...(only?.lang ? { lang: only.lang } : {}) };
  });
  return editedSnapshot(DraftBlocksSchema.parse(blocks), secret);
}

/** Verify the exact reviewed payload, including kind/lang, without reparsing it. */
export function verifyEditedSourcePreview(text: string, value: unknown, token: string | undefined, secret: string): SourcePreview | null {
  const blocks = EditableBlocksSchema.parse(value);
  const expected = editedSnapshot(blocks, secret);
  return text === expected.sourceText && previewTokenMatches(token, expected.previewToken) ? expected : null;
}

export function previewTokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
