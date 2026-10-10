import fs from "node:fs";
import path from "node:path";
import { getSegmentAudioPath } from "@/lib/store/documents";

const MIME: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav" };

/** 读取已保存的音频。URL 带 ?v=<指纹>，内容变化时 URL 也会变，所以可以长期缓存 */
export async function GET(request: Request, ctx: RouteContext<"/api/documents/[id]/audio/[idx]">) {
  const { id, idx } = await ctx.params;
  const file = getSegmentAudioPath(id, Number(idx));
  if (!file) return new Response("Not found", { status: 404 });
  const data = await fs.promises.readFile(file);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": MIME[path.extname(/*turbopackIgnore: true*/ file)] ?? "application/octet-stream",
      "Content-Length": String(data.length),
      "Cache-Control": new URL(request.url).searchParams.has("v") ? "private, max-age=31536000, immutable" : "no-store",
    },
  });
}
