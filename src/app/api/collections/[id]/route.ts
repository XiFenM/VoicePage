import { z } from "zod";
import { deleteCollection, updateCollection, LibraryError } from "@/lib/store/collections";
import { errorResponse } from "@/lib/http";

const Patch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  parentId: z.string().min(1).nullable().optional(),
  beforeId: z.string().min(1).nullable().optional(),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    return Response.json(updateCollection((await ctx.params).id, Patch.parse(await request.json())));
  } catch (error) {
    if (error instanceof LibraryError) return Response.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    return deleteCollection((await ctx.params).id)
      ? Response.json({ ok: true }) : Response.json({ error: "容器不存在" }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
