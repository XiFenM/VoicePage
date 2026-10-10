import "server-only";
import { getPersona, getTtsModel, sanitizeTags } from "@/lib/catalog";
import { createSpeech } from "@/lib/zenmux";

export async function synthesize(opts: {
  text: string;
  modelId: string;
  voice?: string;
  personaId: string;
  useStyle?: boolean;
  signal?: AbortSignal;
}): Promise<{ audio: ArrayBuffer; mime: string }> {
  const model = getTtsModel(opts.modelId);
  const voice = model.voices.some((v) => v.id === opts.voice) ? opts.voice! : model.defaultVoice;
  let input = sanitizeTags(opts.text, model);

  if (opts.useStyle !== false && model.styleMode === "prefix") {
    // Gemini 3.1 及更早 TTS：在文本前用一句简短的自然语言说明朗读风格
    input = `Read the following in a ${getPersona(opts.personaId).voiceStyle} tone:\n${input}`;
  }

  return createSpeech({ model: model.id, input, voice, signal: opts.signal });
}
