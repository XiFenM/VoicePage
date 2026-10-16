import { z } from "zod";
import type { SourceBlock } from "./segment";
import { SourceTextSchema } from "./source-input";

const OrderedBlocksSchema = z.array(z.object({
  id: z.number().int().nonnegative(),
  kind: z.enum(["text", "code", "table", "diagram", "math"]),
  markdown: z.string().refine((value) => value.trim().length > 0, "预览分块不能为空"),
  lang: z.string().optional(),
}).strict()).superRefine((blocks, context) => {
  blocks.forEach((block, index) => {
    if (block.id !== index) context.addIssue({ code: "custom", path: [index, "id"], message: "预览分块编号必须连续且从 0 开始" });
  });
});

export const PreparedBlocksSchema = OrderedBlocksSchema.min(1);

/** Validate a saved snapshot without changing its Markdown or block boundaries. */
export function parsePreparedBlocks(value: unknown): SourceBlock[] {
  return PreparedBlocksSchema.parse(value);
}

/** Bound client-supplied previews independently of historical backup snapshots. */
export const DraftBlocksSchema = OrderedBlocksSchema.max(10000).refine(
  (blocks) => blocks.reduce((size, block) => size + block.markdown.length, Math.max(0, blocks.length - 1) * 2) <= 30000,
  "修改后的原文最多支持 30000 个字符",
);

export const EditableBlocksSchema = DraftBlocksSchema.min(1);

const index = z.number().int().nonnegative();
export const SourcePreviewActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("insert"), index, markdown: SourceTextSchema }).strict(),
  z.object({ type: z.literal("delete"), index }).strict(),
  z.object({ type: z.literal("merge"), index }).strict(),
]);
