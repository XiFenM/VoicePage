// 前后端共享的持久化数据类型

import type { BlockKind } from "@/lib/script/segment";

export interface DocSettings {
  personaId: string;
  ttsModelId: string;
  voice: string;
  useTags: boolean;
  useStyle: boolean;
}

export interface DocSummary {
  id: string;
  title: string;
  ttsModelId: string;
  voice: string;
  segmentCount: number;
  audioCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredSegment {
  idx: number;
  kind: BlockKind;
  lang?: string;
  markdown: string;
  speech: string;
  tagged: string;
  /** 有音频时为可播放的 URL（带版本参数避免缓存旧音频） */
  audioUrl?: string;
  /** 音频是否与当前口述稿/设置一致；false 表示口述稿或设置已改，需重新合成 */
  audioFresh?: boolean;
}

export interface StoredDocument extends DocSettings {
  id: string;
  title: string;
  sourceText: string;
  scriptModel?: string;
  createdAt: number;
  updatedAt: number;
  segments: StoredSegment[];
}
