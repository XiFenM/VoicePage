import { z } from "zod";
import { config } from "@/lib/config";
import { errorResponse } from "@/lib/http";
import { SourceTextSchema } from "@/lib/script/source-input";
import { buildEditedSourcePreview, buildSourcePreview, SourcePreviewError } from "@/lib/script/source-preview";
import { DraftBlocksSchema, SourcePreviewActionSchema } from "@/lib/script/source-blocks";

const Body = z.union([
  z.object({ text: SourceTextSchema }).strict(),
  z.object({ blocks: DraftBlocksSchema, action: SourcePreviewActionSchema.optional() }).strict(),
]);

/** Preview is local parsing only. Nothing is queued until POST /api/documents. */
export async function POST(request: Request) {
  try {
    const body = Body.parse(await request.json());
    const preview = "blocks" in body ? buildEditedSourcePreview(body.blocks, config.sessionSecret, body.action) : buildSourcePreview(body.text, config.sessionSecret);
    return Response.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SourcePreviewError) return Response.json({ error: error.message }, { status: 400 });
    return errorResponse(error);
  }
}
