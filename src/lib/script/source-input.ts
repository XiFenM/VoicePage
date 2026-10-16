import { z } from "zod";

// Preserve leading indentation and line breaks; trimming would alter Markdown code.
export const SourceTextSchema = z.string().max(30000, "原文最多支持 30000 个字符")
  .refine((text) => text.trim().length > 0, "原文为空");
