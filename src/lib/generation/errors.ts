import "server-only";
import type { JobErrorDetail } from "@/lib/store/types";
import { MODEL_REQUEST_TIMEOUT_MS } from "./timeouts";

export class ModelTimeoutError extends Error {
  readonly code = "MODEL_TIMEOUT";
  constructor() { super(`模型请求超过 ${MODEL_REQUEST_TIMEOUT_MS / 60_000} 分钟，已停止等待`); this.name = "ModelTimeoutError"; }
}

export class ModelResponseError extends Error {
  readonly code = "INVALID_MODEL_RESPONSE";
  requestId?: string;
  httpStatus?: number;
  constructor(message: string, cause?: unknown, requestId?: string, httpStatus?: number) {
    super(message, { cause });
    this.name = "ModelResponseError";
    this.requestId = requestId;
    this.httpStatus = httpStatus;
  }
}

/** 诊断只保存错误链，不保存输入稿件、请求头、响应正文或堆栈。 */
export function sanitizeDiagnostic(value: string, limit = 1_000): string {
  let result = value;
  for (const key of ["ZENMUX_API_KEY", "APP_PASSWORD", "SESSION_SECRET"]) {
    const secret = process.env[key];
    if (secret && secret.length >= 4) result = result.split(secret).join("[已隐藏]");
  }
  return result
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[已隐藏]")
    .replace(/((?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s&;,"'}]+/gi, "$1[已隐藏]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[已隐藏]@")
    .slice(0, limit);
}

type ErrorLike = { name?: unknown; message?: unknown; code?: unknown; cause?: unknown; errors?: unknown;
  status?: unknown; httpStatus?: unknown; type?: unknown; requestId?: unknown; retryAfterMs?: unknown };
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET", "UND_ERR_CONNECT", "UND_ERR_DESTROYED"]);
const TIMEOUT_CODES = new Set(["MODEL_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT"]);
const PERMANENT_TYPES = new Set(["access_denied", "insufficient_credit", "reject_no_credit", "quote_exceeded", "quota_exceeded", "model_not_available", "invalid_model", "model_not_supported", "invalid_params", "safety_check_failed"]);
const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);

function causeMessage(item: ErrorLike): string {
  const message = typeof item.message === "string" ? item.message : "未知错误";
  // V8 的 JSON.parse 错误会引用原始内容，不能把稿件片段带进诊断/备份。
  if (item.name === "SyntaxError") {
    const position = message.match(/\bposition\s+\d+(?:\s*\(line\s+\d+\s+column\s+\d+\))?|\bline\s+\d+\s+column\s+\d+/i)?.[0];
    return position ? `JSON 解析失败（${position}）` : "JSON 解析失败";
  }
  if (item.name === "ZodError") return "结构化输出字段校验失败";
  return sanitizeDiagnostic(message);
}

export function describeJobError(error: unknown): JobErrorDetail {
  const chain: ErrorLike[] = [];
  const seen = new Set<object>();
  function visit(value: unknown) {
    if (chain.length >= 8 || value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const item = value as ErrorLike;
    chain.push(item);
    visit(item.cause);
    if (Array.isArray(item.errors)) for (const nested of item.errors) visit(nested);
  }
  visit(error);
  const causes = chain.map((item) => ({
    name: sanitizeDiagnostic(typeof item.name === "string" ? item.name : "Error", 80),
    message: causeMessage(item),
    ...(typeof item.code === "string" ? { code: sanitizeDiagnostic(item.code, 100) } : {}),
  }));
  if (!causes.length) causes.push({ name: "Error", message: sanitizeDiagnostic(typeof error === "string" ? error : "后台生成失败") });
  const withStatus = chain.find((item) => typeof item.status === "number" || typeof item.httpStatus === "number");
  const status = withStatus?.status ?? withStatus?.httpStatus;
  const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const type = chain.find((item) => typeof item.type === "string")?.type as string | undefined;
  const requestId = chain.find((item) => typeof item.requestId === "string")?.requestId as string | undefined;
  const retryAfterMs = chain.find((item) => typeof item.retryAfterMs === "number")?.retryAfterMs as number | undefined;
  const codes = causes.flatMap((item) => item.code ? [item.code] : []);
  const timeoutCode = codes.find((code) => TIMEOUT_CODES.has(code));
  const networkCode = codes.find((code) => NETWORK_CODES.has(code));
  const detail: JobErrorDetail = {
    category: "unknown", message: causes[0].message, causes, retryable: false,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(requestId ? { requestId: sanitizeDiagnostic(requestId, 200) } : {}),
    ...(codes[0] || type ? { code: codes[0] ?? sanitizeDiagnostic(type!, 100) } : {}),
    ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
  };
  // 主动取消/租约丢失在 worker 中直接退出；不能因 cause 是网络异常而重新启动。
  if (causes.some((item) => item.name === "AbortError" || item.name === "LeaseLostError")) return detail;
  if (type && PERMANENT_TYPES.has(type) || httpStatus !== undefined && [400, 401, 402, 403, 404, 413, 422].includes(httpStatus)) {
    detail.category = "configuration";
  } else if (timeoutCode || causes.some((item) => item.name === "TimeoutError")) {
    detail.category = "timeout";
    detail.code = timeoutCode ?? "TIMEOUT";
    detail.retryable = true;
    detail.message = timeoutCode === "MODEL_TIMEOUT" ? causes[0].message : timeoutCode === "UND_ERR_HEADERS_TIMEOUT"
      ? "等待模型接口响应超时" : timeoutCode === "UND_ERR_BODY_TIMEOUT" ? "接收模型响应数据超时" : "连接或等待模型接口超时";
  } else if (networkCode || causes.some((item) => /^(fetch failed|network error|network request failed|terminated)$/i.test(item.message))) {
    // fetch failed 只有在底层原因未知/确属网络错误时重试；TLS证书/无效URL等配置错误除外。
    const permanentTransport = codes.find((code) => /CERT|TLS|SSL|INVALID_URL|INVALID_ARG|BAD_PORT/.test(code));
    detail.category = permanentTransport ? "configuration" : "network";
    detail.code = permanentTransport ?? networkCode ?? "FETCH_FAILED";
    detail.retryable = !permanentTransport;
    detail.message = permanentTransport ? "模型接口连接配置或证书校验失败" : "模型接口网络请求失败或连接中断";
  } else if (httpStatus !== undefined && httpStatus >= 400) {
    detail.category = httpStatus === 429 ? "rate_limit" : "upstream";
    detail.retryable = TRANSIENT_HTTP.has(httpStatus);
  } else if (codes.includes("INVALID_MODEL_RESPONSE") || causes.some((item) => item.name === "SyntaxError" || item.name === "ZodError")) {
    detail.category = "response";
    detail.code = "INVALID_MODEL_RESPONSE";
    detail.message = "模型返回的内容或数据格式无效";
  }
  return detail;
}
