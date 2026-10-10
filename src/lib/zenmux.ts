import "server-only";
import { config } from "./config";

// ZenMux 客户端。接口约定见项目级 skill：
//   .agents/skills/zenmux-context → docs_source/zh/api/openai/create-chat-completion.md
//                                 → docs_source/zh/api/openai/create-audio-speech.md
//                                 → docs_source/zh/guide/advanced/error-codes.md

export class UpstreamError extends Error {
  constructor(
    message: string,
    public status: number,
    public type?: string,
    public requestId?: string,
  ) {
    super(message);
  }
}

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${config.zenmuxApiKey}`,
    "Content-Type": "application/json",
    // 可选：在 ZenMux 日志中标识来源应用
    "X-Title": "ReadAloud",
  };
}

/** 解析 ZenMux 错误格式 `{ error: { code, type, message } }` */
async function ensureOk(res: Response, what: string) {
  if (res.ok) return;
  const requestId = res.headers.get("X-ZenMux-RequestId") ?? undefined;
  const text = await res.text().catch(() => "");
  let type: string | undefined;
  let message = text.slice(0, 500);
  try {
    const err = (JSON.parse(text) as { error?: { type?: string; message?: string } }).error;
    if (err) {
      type = err.type;
      message = err.message ?? message;
    }
  } catch {}
  const hint = ERROR_HINTS[type ?? ""] ?? "";
  throw new UpstreamError(
    `${what}失败 (${res.status}${type ? ` ${type}` : ""}): ${message}${hint ? ` —— ${hint}` : ""}${
      requestId ? ` [RequestId: ${requestId}]` : ""
    }`,
    res.status,
    type,
    requestId,
  );
}

const ERROR_HINTS: Record<string, string> = {
  access_denied: "API Key 无效或缺失，检查 ZENMUX_API_KEY",
  insufficient_credit: "账户欠费",
  reject_no_credit: "余额不足",
  quote_exceeded: "订阅配额用尽",
  model_not_available: "该模型不在当前订阅计划中",
  invalid_model: "模型不存在，检查模型 slug",
  model_not_supported: "该模型不支持此 API",
  rate_limit: "请求频率超限，稍后重试",
};

type JsonSchemaFormat = { name: string; schema: Record<string, unknown> };

/** POST /chat/completions */
export async function chatCompletion(opts: {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /** 结构化输出（json_schema 模式） */
  schema?: JsonSchemaFormat;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const res = await fetch(`${config.zenmuxBaseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
      ...(opts.schema
        ? { response_format: { type: "json_schema", json_schema: { ...opts.schema, strict: true } } }
        : {}),
    }),
    signal: opts.signal,
  });
  await ensureOk(res, "调用 LLM ");
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new UpstreamError("LLM 返回为空", 502);
  return content;
}

/**
 * POST /audio/speech
 * 非流式时返回 JSON：{ audio: base64, mime_type: "audio/L16;rate=24000", usage }。
 * 默认 response_format=pcm（16bit LE / 单声道 / 24kHz 裸 PCM），这里封装成 WAV 以便浏览器直接播放。
 */
export async function createSpeech(opts: {
  model: string;
  input: string;
  voice?: string;
  speed?: number;
  signal?: AbortSignal;
}): Promise<{ audio: ArrayBuffer; mime: string }> {
  const res = await fetch(`${config.zenmuxBaseUrl}/audio/speech`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: opts.model,
      input: opts.input,
      voice: opts.voice,
      response_format: "pcm",
      ...(opts.speed ? { speed: opts.speed } : {}),
    }),
    signal: opts.signal,
  });
  await ensureOk(res, "调用 TTS ");
  const data = (await res.json()) as { audio?: string; mime_type?: string };
  if (!data.audio) throw new UpstreamError("TTS 未返回音频", 502);
  const bytes = Buffer.from(data.audio, "base64");
  const mime = (data.mime_type ?? "audio/L16;rate=24000").toLowerCase();

  // 已是带容器的格式（某些供应商可能返回 wav/mp3），直接透传
  if (!mime.startsWith("audio/l16") && !mime.startsWith("audio/pcm")) {
    return { audio: toArrayBuffer(bytes), mime: mime.split(";")[0] };
  }
  const rate = Number(mime.match(/rate=(\d+)/)?.[1] ?? 24000);
  const channels = Number(mime.match(/channels=(\d+)/)?.[1] ?? 1);
  return { audio: pcmToWav(bytes, rate, channels), mime: "audio/wav" };
}

/** GET /models —— 列出可用模型（用于核对 TTS 模型） */
export async function listModels(): Promise<
  { id: string; display_name?: string; input_modalities?: string[]; output_modalities?: string[] }[]
> {
  const res = await fetch(`${config.zenmuxBaseUrl}/models`, { headers: headers() });
  await ensureOk(res, "获取模型列表");
  return ((await res.json()) as { data: [] }).data;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
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
  return toArrayBuffer(Buffer.concat([header, pcm]));
}
