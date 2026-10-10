import "server-only";
import { getPersona, getTtsModel, stripTags } from "@/lib/catalog";
import { geminiSpeech, openaiSpeech } from "@/lib/zenmux";

export async function synthesize(opts: {
  text: string;
  modelId: string;
  voice?: string;
  personaId: string;
  signal?: AbortSignal;
}): Promise<{ audio: ArrayBuffer; mime: string }> {
  const model = getTtsModel(opts.modelId);
  const voice = model.voices.some((v) => v.id === opts.voice) ? opts.voice! : model.defaultVoice;
  const persona = getPersona(opts.personaId);
  const text = model.tagStyle === "none" ? stripTags(opts.text) : opts.text;

  if (model.protocol === "gemini") {
    // Gemini TTS 通过自然语言前缀控制整体风格
    const prompt = model.supportsStyleInstruction ? `${persona.voiceStyle}：\n${text}` : text;
    return geminiSpeech({ model: model.id, text: prompt, voice, signal: opts.signal });
  }
  return openaiSpeech({
    model: model.id,
    input: text,
    voice,
    instructions: model.supportsStyleInstruction ? persona.voiceStyle : undefined,
    signal: opts.signal,
  });
}
