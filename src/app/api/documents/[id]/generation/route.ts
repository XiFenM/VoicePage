import { z } from "zod";
import { getDocument } from "@/lib/store/documents";
import { cancelDocumentJobs, enqueueDocumentJobs } from "@/lib/store/jobs";
import { abortBackgroundJobs, startBackgroundWorker } from "@/lib/generation/worker";
import { errorResponse } from "@/lib/http";

const Body = z.object({
  action: z.enum(["start", "retry", "cancel"]),
  indices: z.array(z.number().int().min(0)).min(1).max(1000).optional(),
  force: z.boolean().default(false),
});

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { action, indices, force } = Body.parse(await request.json());
    const existing = getDocument(id);
    if (!existing) return Response.json({ error: "记录不存在" }, { status: 404 });
    if (indices?.some((idx) => !existing.segments.some((segment) => segment.idx === idx))) {
      return Response.json({ error: "段落不存在" }, { status: 400 });
    }
    if (action === "cancel") {
      const doc = cancelDocumentJobs(id, indices);
      abortBackgroundJobs(id, indices);
      return Response.json(doc, { headers: { "Cache-Control": "no-store" } });
    }
    const doc = enqueueDocumentJobs(id, { indices, force, retryOnly: action === "retry" });
    startBackgroundWorker();
    return Response.json(doc, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
