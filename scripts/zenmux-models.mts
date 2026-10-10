// 列出 ZenMux 上可用的模型，帮助核对 catalog.ts 中的 TTS / LLM slug。
// 用法：pnpm zenmux:models            —— 只列出输出含 audio 的模型
//       pnpm zenmux:models --all      —— 列出全部
// 依赖 .env.local 中的 ZENMUX_API_KEY（通过 node --env-file 加载）
const base = (process.env.ZENMUX_BASE_URL ?? "https://zenmux.ai/api/v1").replace(/\/$/, "");
const key = process.env.ZENMUX_API_KEY;
if (!key) {
  console.error("缺少 ZENMUX_API_KEY");
  process.exit(1);
}
const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
if (!res.ok) {
  console.error(res.status, await res.text());
  process.exit(1);
}
type M = { id: string; display_name?: string; output_modalities?: string[] };
const all = ((await res.json()) as { data: M[] }).data;
const list = process.argv.includes("--all")
  ? all
  : all.filter((m) => m.output_modalities?.includes("audio") || /tts|speech/i.test(m.id));
for (const m of list) console.log(`${m.id.padEnd(50)} ${(m.output_modalities ?? []).join(",")}  ${m.display_name ?? ""}`);
console.log(`\n共 ${list.length} 个（全部 ${all.length} 个）`);
export {};
