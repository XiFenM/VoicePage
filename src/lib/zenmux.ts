import "server-only";
import { config } from "./config";
import { ModelResponseError } from "./generation/errors";
import { parseRetryAfter } from "./generation/retry-policy";
import { modelFetch } from "./model-http";

// ZenMux 客户端。接口约定见项目级 skill：
//   .agents/skills/zenmux-context → docs_source/zh/api/openai/create-chat-completion.md
//                                 → docs_source/zh/api/openai/create-audio-speech.md
//                                 → docs_source/zh/guide/advanced/error-codes.md

export class UpstreamError extends Error {
  status: number;
  type?: string;
  requestId?: string;
  retryAfterMs?: number;
  constructor(
    message: string,
    status: number,
    type?: string,
    requestId?: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.type = type;
    this.requestId = requestId;
    this.retryAfterMs = retryAfterMs;
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
  let message = res.statusText || "上游接口返回非 JSON 错误响应";
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
    parseRetryAfter(res.headers.get("Retry-After")),
  );
}

async function readModelJson<T>(res: Response): Promise<T> {
  const requestId = res.headers.get("X-ZenMux-RequestId") ?? undefined;
  try {
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") throw new ModelResponseError("模型接口未返回有效 JSON 对象", undefined, requestId, res.status);
    return data as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ModelResponseError("模型接口返回了无法解析的 JSON", error, requestId, res.status);
    if (error instanceof ModelResponseError) throw error;
    // 读取响应体时也可能断线/超时，保留 cause 以区分网络故障和 JSON 格式错误。
    throw Object.assign(new Error("接收模型接口响应失败", { cause: error }), { requestId, httpStatus: res.status });
  }
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
export type ModelResponseMetadata = { requestId?: string; httpStatus?: number };

/** POST /chat/completions */
export async function chatCompletion(opts: {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /** 结构化输出（json_schema 模式） */
  schema?: JsonSchemaFormat;
  temperature?: number;
  signal?: AbortSignal;
  /** 供结构化内容校验继续携带请求编号，不包含请求/响应正文。 */
  onResponse?: (metadata: ModelResponseMetadata) => void;
}): Promise<string> {
  const res = await modelFetch(`${config.zenmuxBaseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      // 部分新模型（如 claude-sonnet-5.5）已不接受 temperature，未指定时不传
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.schema
        ? { response_format: { type: "json_schema", json_schema: { ...opts.schema, strict: true } } }
        : {}),
    }),
    signal: opts.signal,
  });
  opts.onResponse?.({ requestId: res.headers.get("X-ZenMux-RequestId") ?? undefined, httpStatus: res.status });
  await ensureOk(res, "调用 LLM ");
  const data = await readModelJson<{ choices?: { message?: { content?: string } }[] }>(res);
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new ModelResponseError("LLM 返回为空或不是文本", undefined, res.headers.get("X-ZenMux-RequestId") ?? undefined, res.status);
  return content;
}

export type SpeechResult =
  | { kind: "pcm"; pcm: Buffer; sampleRate: number; channels: number }
  | { kind: "encoded"; data: Buffer; mime: string };

/**
 * POST /audio/speech
 * 非流式时返回 JSON：{ audio: base64, mime_type: "audio/L16;rate=24000", usage }。
 * 默认 response_format=pcm（16bit LE / 单声道 / 24kHz 裸 PCM）。
 * 实测三家模型的 mime：audio/l16; rate=24000（Gemini）、audio/pcm;rate=24000（Qwen）、audio/pcm（Grok）
 */
export async function createSpeech(opts: {
  model: string;
  input: string;
  voice?: string;
  signal?: AbortSignal;
}): Promise<SpeechResult> {
  const res = await modelFetch(`${config.zenmuxBaseUrl}/audio/speech`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: opts.model,
      input: opts.input,
      voice: opts.voice,
      response_format: "pcm",
    }),
    signal: opts.signal,
  });
  await ensureOk(res, "调用 TTS ");
  const data = await readModelJson<{ audio?: string; mime_type?: string }>(res);
  if (typeof data.audio !== "string" || !data.audio) throw new ModelResponseError("TTS 未返回音频", undefined, res.headers.get("X-ZenMux-RequestId") ?? undefined, res.status);
  const bytes = Buffer.from(data.audio, "base64");
  const mime = (data.mime_type ?? "audio/L16;rate=24000").toLowerCase();

  // 已是带容器的格式（某些供应商可能返回 wav/mp3），直接透传
  if (!mime.startsWith("audio/l16") && !mime.startsWith("audio/pcm")) {
    return { kind: "encoded", data: bytes, mime: mime.split(";")[0] };
  }
  return {
    kind: "pcm",
    pcm: bytes,
    sampleRate: Number(mime.match(/rate=(\d+)/)?.[1] ?? 24000),
    channels: Number(mime.match(/channels=(\d+)/)?.[1] ?? 1),
  };
}

/** GET /models —— 列出可用模型（用于核对 TTS 模型） */
export async function listModels(): Promise<
  { id: string; display_name?: string; input_modalities?: string[]; output_modalities?: string[] }[]
> {
  const res = await modelFetch(`${config.zenmuxBaseUrl}/models`, { headers: headers() });
  await ensureOk(res, "获取模型列表");
  return ((await res.json()) as { data: [] }).data;
}
