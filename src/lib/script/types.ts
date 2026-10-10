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
