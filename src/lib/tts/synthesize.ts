import "server-only";
import { getPersona, getTtsModel, sanitizeTags } from "@/lib/catalog";
import { createSpeech } from "@/lib/zenmux";
import { pcmToMp3 } from "@/lib/audio/mp3";

export interface SynthesizeOptions {
  text: string;
  modelId: string;
  voice?: string;
  personaId: string;
  useStyle?: boolean;
  signal?: AbortSignal;
}

/** 调用 TTS 并统一输出 MP3 */
export async function synthesize(opts: SynthesizeOptions): Promise<{ audio: Buffer; mime: string; voice: string }> {
  const model = getTtsModel(opts.modelId);
  const voice = model.voices.some((v) => v.id === opts.voice) ? opts.voice! : model.defaultVoice;
  let input = sanitizeTags(opts.text, model);

  if (opts.useStyle !== false && model.styleMode === "prefix") {
    // Gemini 3.1 及更早 TTS：在文本前用一句简短的自然语言说明朗读风格
    input = `Read the following in a ${getPersona(opts.personaId).voiceStyle} tone:\n${input}`;
  }

  const r = await createSpeech({ model: model.id, input, voice, signal: opts.signal });
  if (r.kind === "encoded") return { audio: r.data, mime: r.mime, voice };
  return { audio: pcmToMp3(r.pcm, r.sampleRate, r.channels), mime: "audio/mpeg", voice };
}
