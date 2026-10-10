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
  /** ZenMux OpenAI 兼容协议入口：chat/completions、audio/speech、models 都在这里 */
  get zenmuxBaseUrl() {
    return (process.env.ZENMUX_BASE_URL ?? "https://zenmux.ai/api/v1").replace(/\/$/, "");
  },
  /** 转口述稿用的 LLM（需支持 response_format=json_schema） */
  get scriptModel() {
    return process.env.SCRIPT_MODEL ?? "google/gemini-2.5-flash";
  },
  get appPassword() {
    return required("APP_PASSWORD");
  },
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
};
