import type { SourceBlock } from "./segment";

export interface ScriptSegment {
  id: number;
  /** 不含标签的口述稿 */
  speech: string;
  /** 含语气标签的口述稿（模型不支持标签时与 speech 相同） */
  tagged: string;
}

export interface ScriptResult {
  blocks: SourceBlock[];
  segments: ScriptSegment[];
}

/** Local parsing only; the token binds confirmation to this exact source and block list. */
export interface SourcePreview {
  sourceText: string;
  blocks: SourceBlock[];
  previewToken: string;
  /** Per-module edits have independent boundaries and their own signed snapshot. */
  edited?: true;
}

export type SourcePreviewAction =
  | { type: "insert"; index: number; markdown: string }
  | { type: "delete"; index: number }
  | { type: "merge"; index: number };
