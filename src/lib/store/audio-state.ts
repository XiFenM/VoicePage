import "server-only";
import crypto from "node:crypto";
import { getTtsModel, stripTags } from "@/lib/catalog";
import type { DocSettings, StoredSegment } from "./types";

export function needsAutomaticTags(settings: DocSettings): boolean {
  const model = getTtsModel(settings.ttsModelId);
  return settings.useTags && model.tagSyntax !== "none" && model.tags.length > 0;
}

export function effectiveTagStatus(status: unknown, modelId: unknown, settings: DocSettings): StoredSegment["tagStatus"] {
  if (status === "manual") return "manual";
  if (!needsAutomaticTags(settings)) return "ready";
  return status === "ready" && modelId === settings.ttsModelId ? "ready" : "pending";
}

/** 唯一的音频输入指纹算法，文档详情、后台进度及生成写入共用。 */
export function audioHash(p: { text: string; modelId: string; voice: string; useStyle: boolean; personaId: string }) {
  return crypto.createHash("sha1")
    .update(JSON.stringify([p.text, p.modelId, p.voice, p.useStyle, p.useStyle ? p.personaId : ""]))
    .digest("hex").slice(0, 16);
}

export function isAudioFresh(
  segment: { audioFile: unknown; storedHash: unknown; tagged: string; tagStatus: unknown; tagModelId: unknown },
  settings: DocSettings,
): boolean {
  return !!segment.audioFile && effectiveTagStatus(segment.tagStatus, segment.tagModelId, settings) !== "pending" &&
    segment.storedHash === audioHash({
      text: settings.useTags ? segment.tagged : stripTags(segment.tagged),
      modelId: settings.ttsModelId, voice: settings.voice, useStyle: settings.useStyle, personaId: settings.personaId,
    });
}
