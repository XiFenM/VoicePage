import "server-only";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}，请在 .env.local 中配置`);
  return v;
}

export const config = {
  get zenmuxApiKey() {
    return required("ZENMUX_API_KEY");
  },
  /** OpenAI 兼容协议入口（chat / audio speech） */
  get zenmuxBaseUrl() {
    return (process.env.ZENMUX_BASE_URL ?? "https://zenmux.ai/api/v1").replace(/\/$/, "");
  },
  /** Vertex AI 协议入口（Gemini TTS 使用） */
  get zenmuxVertexBaseUrl() {
    return (process.env.ZENMUX_VERTEX_BASE_URL ?? "https://zenmux.ai/api/vertex-ai").replace(/\/$/, "");
  },
  /** 转口述稿用的 LLM */
  get scriptModel() {
    return process.env.SCRIPT_MODEL ?? "openai/gpt-4.1-mini";
  },
  get appPassword() {
    return required("APP_PASSWORD");
  },
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
};
