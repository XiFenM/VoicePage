import "server-only";
import { z } from "zod";
import { config } from "@/lib/config";
import { chatCompletion, type ModelResponseMetadata } from "@/lib/zenmux";
import { ModelResponseError } from "@/lib/generation/errors";
import { TAG_PATTERN, formatTag, getPersona, getTtsModel, stripTags } from "@/lib/catalog";
import { splitMarkdown, type SourceBlock } from "./segment";
import type { ScriptResult, ScriptSegment } from "./types";

export type { ScriptResult, ScriptSegment };
import { spokenSystemPrompt, spokenUserPrompt, tagSystemPrompt, tagUserPrompt } from "./prompts";

const SegmentsSchema = z.object({
  segments: z.array(z.object({ id: z.coerce.number(), speech: z.string() })),
});

/** 结构化输出：ZenMux chat/completions 的 response_format=json_schema */
const SEGMENTS_JSON_SCHEMA = {
  name: "segments",
  schema: {
    type: "object",
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "integer" }, speech: { type: "string" } },
          required: ["id", "speech"],
          additionalProperties: false,
        },
      },
    },
    required: ["segments"],
    additionalProperties: false,
  },
};

function parseSegments(raw: string, metadata: ModelResponseMetadata) {
  // 兼容模型把 JSON 包在 ```json 里的情况
  const json = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return SegmentsSchema.parse(JSON.parse(json)).segments;
  } catch (error) {
    throw new ModelResponseError("模型返回的分段内容不符合预期格式", error, metadata.requestId, metadata.httpStatus);
  }
}

/** 步骤 1：原文 -> 分块（本地） */
export { splitMarkdown };

/** 步骤 2：分块 -> 口述稿（LLM） */
export async function toSpoken(blocks: SourceBlock[], personaId: string, signal?: AbortSignal, scriptModel = config.scriptModel) {
  const persona = getPersona(personaId);
  const metadata: ModelResponseMetadata = {};
  const raw = await chatCompletion({
    model: scriptModel,
    schema: SEGMENTS_JSON_SCHEMA,
    signal,
    onResponse: (response) => { Object.assign(metadata, response); },
    messages: [
      { role: "system", content: spokenSystemPrompt(persona) },
      { role: "user", content: spokenUserPrompt(blocks) },
    ],
  });
  const got = new Map(parseSegments(raw, metadata).map((s) => [s.id, stripTags(s.speech)]));
  // 保证每个块都有口述稿；缺失时退化为原文去掉 Markdown 符号
  return blocks.map((b) => ({ id: b.id, speech: got.get(b.id) ?? fallbackSpeech(b) }));
}

/** 步骤 3：口述稿 -> 加语气标签（LLM，按 TTS 模型能力决定是否执行） */
export async function addTags(
  segments: { id: number; speech: string }[],
  ttsModelId: string,
  personaId: string,
  signal?: AbortSignal,
  scriptModel = config.scriptModel,
): Promise<ScriptSegment[]> {
  const model = getTtsModel(ttsModelId);
  if (model.tagSyntax === "none" || model.tags.length === 0) {
    return segments.map((s) => ({ ...s, tagged: s.speech }));
  }
  const metadata: ModelResponseMetadata = {};
  const raw = await chatCompletion({
    model: scriptModel,
    schema: SEGMENTS_JSON_SCHEMA,
    signal,
    onResponse: (response) => { Object.assign(metadata, response); },
    messages: [
      { role: "system", content: tagSystemPrompt(model, getPersona(personaId)) },
      { role: "user", content: tagUserPrompt(segments) },
    ],
  });
  const allowed = new Set(model.tags.map((t) => formatTag(model.tagSyntax, t.name)));
  const got = new Map(parseSegments(raw, metadata).map((s) => [s.id, s.speech]));
  return segments.map((s) => {
    let tagged = got.get(s.id) ?? s.speech;
    // 去掉模型自创的标签
    tagged = tagged.replace(TAG_PATTERN, (m) => (allowed.has(m.toLowerCase()) ? m : ""));
    // 若 LLM 擅自改了文字，则放弃标签版本
    if (normalize(stripTags(tagged)) !== normalize(s.speech)) tagged = s.speech;
    return { ...s, tagged: tagged.replace(/[ \t]{2,}/g, " ").trim() };
  });
}

export async function runScriptPipeline(input: {
  text: string;
  personaId: string;
  signal?: AbortSignal;
  scriptModel?: string;
  preparedBlocks?: SourceBlock[];
}): Promise<ScriptResult> {
  input.signal?.throwIfAborted();
  const blocks = input.preparedBlocks ?? splitMarkdown(input.text);
  if (blocks.length === 0) return { blocks, segments: [] };
  const model = input.scriptModel ?? config.scriptModel;
  const spoken = await toSpoken(blocks, input.personaId, input.signal, model);
  input.signal?.throwIfAborted();

  // 整篇口述稿先保存、展示；后台执行器再逐段准备标签与语音。
  const segments = spoken.map((s) => ({ ...s, tagged: s.speech }));
  return { blocks, segments };
}

function normalize(s: string) {
  return s.replace(/\s+/g, "");
}

function fallbackSpeech(b: SourceBlock): string {
  if (b.kind === "code") return "这里有一段代码，请看屏幕。";
  if (b.kind === "diagram") return "这里有一张图，请看屏幕。";
  if (b.kind === "table") return "这里有一个表格，请看屏幕。";
  return b.markdown.replace(/[#*_`>|~-]+/g, " ").replace(/\s+/g, " ").trim();
}
