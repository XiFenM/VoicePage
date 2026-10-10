import "server-only";
import { config } from "./config";

export class UpstreamError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function ensureOk(res: Response, what: string) {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new UpstreamError(`${what} 失败 (${res.status}): ${body.slice(0, 500)}`, res.status);
}

/** OpenAI 兼容的 chat completions */
export async function chatCompletion(opts: {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  json?: boolean;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const res = await fetch(`${config.zenmuxBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.zenmuxApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: opts.signal,
  });
  await ensureOk(res, "调用 LLM");
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new UpstreamError("LLM 返回为空", 502);
  return content;
}

/** OpenAI 兼容的 /audio/speech，返回音频二进制 */
export async function openaiSpeech(opts: {
  model: string;
  input: string;
  voice: string;
  instructions?: string;
  signal?: AbortSignal;
}): Promise<{ audio: ArrayBuffer; mime: string }> {
  const res = await fetch(`${config.zenmuxBaseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.zenmuxApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      input: opts.input,
      voice: opts.voice,
      instructions: opts.instructions,
      response_format: "mp3",
    }),
    signal: opts.signal,
  });
  await ensureOk(res, "调用 TTS");
  return { audio: await res.arrayBuffer(), mime: res.headers.get("content-type") ?? "audio/mpeg" };
}

/**
 * Gemini TTS（通过 ZenMux 的 Vertex AI 协议入口）。
 * 返回的是 24kHz / 16bit / 单声道 PCM，这里包装成 WAV。
 */
export async function geminiSpeech(opts: {
  model: string; // 例如 google/gemini-2.5-flash-preview-tts
  text: string;
  voice: string;
  signal?: AbortSignal;
}): Promise<{ audio: ArrayBuffer; mime: string }> {
  const [publisher, name] = opts.model.includes("/") ? opts.model.split("/", 2) : ["google", opts.model];
  const url = `${config.zenmuxVertexBaseUrl}/v1/publishers/${publisher}/models/${name}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.zenmuxApiKey}`,
      "x-goog-api-key": config.zenmuxApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: opts.text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } },
      },
    }),
    signal: opts.signal,
  });
  await ensureOk(res, "调用 Gemini TTS");
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
  };
  const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new UpstreamError("Gemini TTS 未返回音频", 502);
  const pcm = Buffer.from(inline.data, "base64");
  const rate = Number(inline.mimeType?.match(/rate=(\d+)/)?.[1] ?? 24000);
  return { audio: pcmToWav(pcm, rate), mime: "audio/wav" };
}

function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bits = 16): ArrayBuffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  const out = Buffer.concat([header, pcm]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
