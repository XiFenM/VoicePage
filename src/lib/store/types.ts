// 前后端共享的持久化数据类型

import type { BlockKind } from "@/lib/script/segment";

export interface DocSettings {
  personaId: string;
  ttsModelId: string;
  voice: string;
  useTags: boolean;
  useStyle: boolean;
}

export type CollectionKind = "group" | "session";

export interface LibraryCollection {
  id: string;
  kind: CollectionKind;
  name: string;
  parentId: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface LibrarySnapshot {
  collections: LibraryCollection[];
  documents: DocSummary[];
}

export interface LibraryMove {
  kind: CollectionKind | "document";
  id: string;
  parentId: string | null;
  beforeId?: string | null;
}

export type BackgroundStatus = "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";
export type JobPhase = "queued" | "spoken" | "tags" | "tts";

export interface JobErrorDetail {
  category: "network" | "timeout" | "rate_limit" | "upstream" | "response" | "configuration" | "unknown";
  message: string;
  code?: string;
  httpStatus?: number;
  requestId?: string;
  causes: { name: string; message: string; code?: string }[];
  retryable: boolean;
  retryAfterMs?: number;
}

export type RetrySource = "automatic" | "manual" | "recovery";

export interface GenerationEvent {
  id: number;
  idx: number;
  phase: JobPhase;
  attempt: number;
  type: "failed" | "retry_scheduled" | "retry_started" | "succeeded" | "cancelled" | "resumed";
  createdAt: number;
  error?: JobErrorDetail;
  retrySource?: RetrySource;
  retryNumber?: number;
  nextRetryAt?: number;
  modelId?: string;
}

export interface GenerationEventsPage {
  events: GenerationEvent[];
  nextCursor?: number;
}

export interface BackgroundProgress {
  status: BackgroundStatus;
  phase: "queued" | "spoken" | "segments" | "done";
  scriptReady: boolean;
  totalSegments: number;
  completedSegments: number;
  queuedSegments: number;
  taggingSegments: number;
  speakingSegments: number;
  failedSegments: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
  error?: string;
  /** 仅有已完成段的实际耗时样本时返回；仍是粗估，不是服务承诺。 */
  estimatedRemainingMs?: number;
  retryingSegments?: number;
  nextRetryAt?: number;
  failurePhase?: JobPhase;
}

export interface SegmentGeneration {
  status: BackgroundStatus;
  phase: JobPhase | "done";
  error?: string;
  attempt?: number;
  autoRetryCount?: number;
  nextRetryAt?: number;
  lastError?: JobErrorDetail;
  failurePhase?: JobPhase;
}

/** owner + attempt 标识一次租约，旧 worker 无权写回被重新领取的任务。 */
export interface JobClaim {
  docId: string;
  idx: number;
  kind: "script" | "segment";
  owner: string;
  attempt: number;
  phase: JobPhase;
  force: boolean;
  leaseUntil: number;
  createdAt: number;
  startedAt: number;
}

export interface DocSummary {
  id: string;
  sessionId: string | null;
  position: number;
  title: string;
  ttsModelId: string;
  voice: string;
  segmentCount: number;
  audioCount: number;
  createdAt: number;
  updatedAt: number;
  generation: BackgroundProgress;
}

export interface StoredSegment {
  idx: number;
  kind: BlockKind;
  lang?: string;
  markdown: string;
  speech: string;
  tagged: string;
  /** pending 需按当前模型加标签；manual 是用户编辑稿，永不自动覆盖。 */
  tagStatus: "pending" | "ready" | "manual";
  /** 自动标签适配的 TTS 模型，不是生成标签的 LLM。 */
  tagModelId?: string;
  /** 有音频时为可播放的 URL（带版本参数避免缓存旧音频） */
  audioUrl?: string;
  /** 音频是否与当前口述稿/设置一致；false 表示口述稿或设置已改，需重新合成 */
  audioFresh?: boolean;
  generation?: SegmentGeneration;
}

export interface StoredDocument extends DocSettings {
  id: string;
  sessionId: string | null;
  position: number;
  title: string;
  sourceText: string;
  scriptModel?: string;
  createdAt: number;
  updatedAt: number;
  generation: BackgroundProgress;
  segments: StoredSegment[];
}
