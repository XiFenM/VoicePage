import { getDocument } from "@/lib/store/documents";
import { enqueueDocumentJobs } from "@/lib/store/jobs";
import { startBackgroundWorker } from "@/lib/generation/worker";
import { errorResponse } from "@/lib/http";

/** 兼容旧单段入口，返回已入队状态；音频由后台生成，通过文档 GET 查询。 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; idx: string }> }) {
  try {
    const { id, idx: rawIdx } = await ctx.params;
    const idx = Number(rawIdx);
    if (!Number.isInteger(idx) || !getDocument(id)?.segments.some((s) => s.idx === idx)) {
      return Response.json({ error: "段落不存在" }, { status: 404 });
    }
    const doc = enqueueDocumentJobs(id, { indices: [idx], force: new URL(request.url).searchParams.get("force") === "1" });
    startBackgroundWorker();
    return Response.json(doc!.segments.find((s) => s.idx === idx), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
