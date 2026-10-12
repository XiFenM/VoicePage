import { z } from "zod";
import { db } from "@/lib/store/db";
import { listGenerationEvents } from "@/lib/store/generation-events";
import { errorResponse } from "@/lib/http";

const Query = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** 仅查询历史，不领取任务、不调用模型。 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const params = new URL(request.url).searchParams;
    const query = Query.parse({ before: params.get("before") ?? undefined, limit: params.get("limit") ?? undefined });
    if (!db().prepare("SELECT 1 FROM documents WHERE id = ?").get(id)) return Response.json({ error: "记录不存在" }, { status: 404 });
    return Response.json(listGenerationEvents(id, query), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
