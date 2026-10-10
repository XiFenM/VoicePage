import { z } from "zod";
import { stripTags } from "@/lib/catalog";
import { updateSegmentText } from "@/lib/store/documents";
import { errorResponse } from "@/lib/http";

const Body = z.object({ tagged: z.string().max(5000) });

/** 保存手动修改的口述稿 */
export async function PATCH(request: Request, ctx: RouteContext<"/api/documents/[id]/segments/[idx]">) {
  try {
    const { id, idx } = await ctx.params;
    const { tagged } = Body.parse(await request.json());
    const ok = updateSegmentText(id, Number(idx), tagged, stripTags(tagged));
    return ok ? Response.json({ ok: true }) : Response.json({ error: "段落不存在" }, { status: 404 });
  } catch (e) {
    return errorResponse(e);
  }
}
