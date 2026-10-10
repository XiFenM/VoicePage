import { z } from "zod";
import { deleteDocument, getDocument, updateDocument } from "@/lib/store/documents";
import { errorResponse } from "@/lib/http";

const notFound = () => Response.json({ error: "记录不存在" }, { status: 404 });

export async function GET(_req: Request, ctx: RouteContext<"/api/documents/[id]">) {
  try {
    const doc = getDocument((await ctx.params).id);
    return doc ? Response.json(doc) : notFound();
  } catch (e) {
    return errorResponse(e);
  }
}

const Patch = z.object({
  title: z.string().max(200).optional(),
  personaId: z.string().optional(),
  ttsModelId: z.string().optional(),
  voice: z.string().optional(),
  useTags: z.boolean().optional(),
  useStyle: z.boolean().optional(),
});

/** 改标题或 TTS 设置（改设置后旧音频会被标记为过期） */
export async function PATCH(request: Request, ctx: RouteContext<"/api/documents/[id]">) {
  try {
    const doc = updateDocument((await ctx.params).id, Patch.parse(await request.json()));
    return doc ? Response.json(doc) : notFound();
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/documents/[id]">) {
  try {
    return deleteDocument((await ctx.params).id) ? Response.json({ ok: true }) : notFound();
  } catch (e) {
    return errorResponse(e);
  }
}
