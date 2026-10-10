import { getDocument } from "@/lib/store/documents";
import { enqueueDocumentJobs } from "@/lib/store/jobs";
import { startBackgroundWorker } from "@/lib/generation/worker";
import { errorResponse } from "@/lib/http";

/** 兼容旧单段入口；统一入后台队列，不能绕过全局并发限制直接调用模型。 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string; idx: string }> }) {
  try {
    const { id, idx: rawIdx } = await ctx.params;
    const idx = Number(rawIdx);
    if (!Number.isInteger(idx) || !getDocument(id)?.segments.some((s) => s.idx === idx)) {
      return Response.json({ error: "段落不存在" }, { status: 404 });
    }
    const doc = enqueueDocumentJobs(id, { indices: [idx] });
    startBackgroundWorker();
    return Response.json(doc!.segments.find((s) => s.idx === idx), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
