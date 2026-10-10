import "server-only";
import { z } from "zod";
import { config } from "@/lib/config";
import { chatCompletion } from "@/lib/zenmux";
import { getPersona, getTtsModel, stripTags } from "@/lib/catalog";
import { splitMarkdown, type SourceBlock } from "./segment";
import type { ScriptResult, ScriptSegment } from "./types";

export type { ScriptResult, ScriptSegment };
import { spokenSystemPrompt, spokenUserPrompt, tagSystemPrompt, tagUserPrompt } from "./prompts";

const SegmentsSchema = z.object({
  segments: z.array(z.object({ id: z.coerce.number(), speech: z.string() })),
});

function parseSegments(raw: string) {
  // 兼容模型把 JSON 包在 ```json 里的情况
  const json = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return SegmentsSchema.parse(JSON.parse(json)).segments;
}

/** 步骤 1：原文 -> 分块（本地） */
export { splitMarkdown };

/** 步骤 2：分块 -> 口述稿（LLM） */
export async function toSpoken(blocks: SourceBlock[], personaId: string, signal?: AbortSignal) {
  const persona = getPersona(personaId);
  const raw = await chatCompletion({
    model: config.scriptModel,
    json: true,
    signal,
    messages: [
      { role: "system", content: spokenSystemPrompt(persona) },
      { role: "user", content: spokenUserPrompt(blocks) },
    ],
  });
  const got = new Map(parseSegments(raw).map((s) => [s.id, stripTags(s.speech)]));
  // 保证每个块都有口述稿；缺失时退化为原文去掉 Markdown 符号
  return blocks.map((b) => ({ id: b.id, speech: got.get(b.id) ?? fallbackSpeech(b) }));
}

/** 步骤 3：口述稿 -> 加语气标签（LLM，按 TTS 模型能力决定是否执行） */
export async function addTags(
  segments: { id: number; speech: string }[],
  ttsModelId: string,
  personaId: string,
  signal?: AbortSignal,
): Promise<ScriptSegment[]> {
  const model = getTtsModel(ttsModelId);
  if (model.tagStyle === "none" || model.tags.length === 0) {
    return segments.map((s) => ({ ...s, tagged: s.speech }));
  }
  const raw = await chatCompletion({
    model: config.scriptModel,
    json: true,
    temperature: 0.5,
    signal,
    messages: [
      { role: "system", content: tagSystemPrompt(model, getPersona(personaId)) },
      { role: "user", content: tagUserPrompt(segments) },
    ],
  });
  const allowed = new Set(model.tags.map((t) => t.toLowerCase()));
  const got = new Map(parseSegments(raw).map((s) => [s.id, s.speech]));
  return segments.map((s) => {
    let tagged = got.get(s.id) ?? s.speech;
    // 去掉模型自创的标签
    tagged = tagged.replace(/\[[^\]\n]{1,30}\]/g, (m) => (allowed.has(m.toLowerCase()) ? m : ""));
    // 若 LLM 擅自改了文字，则放弃标签版本
    if (normalize(stripTags(tagged)) !== normalize(s.speech)) tagged = s.speech;
    return { ...s, tagged };
  });
}

export async function runScriptPipeline(input: {
  text: string;
  personaId: string;
  ttsModelId: string;
  useTags: boolean;
  signal?: AbortSignal;
}): Promise<ScriptResult> {
  const blocks = splitMarkdown(input.text);
  if (blocks.length === 0) return { blocks, segments: [] };
  const spoken = await toSpoken(blocks, input.personaId, input.signal);
  const segments = input.useTags
    ? await addTags(spoken, input.ttsModelId, input.personaId, input.signal)
    : spoken.map((s) => ({ ...s, tagged: s.speech }));
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
