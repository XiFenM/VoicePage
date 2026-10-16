import { connection } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { listDocuments } from "@/lib/store/documents";
import { createQueuedDocument } from "@/lib/store/jobs";
import { startBackgroundWorker } from "@/lib/generation/worker";
import { errorResponse } from "@/lib/http";
import { LibraryError } from "@/lib/store/organization";
import { getGenerationSettings } from "@/lib/store/generation-settings";
import { SourceTextSchema } from "@/lib/script/source-input";
import { buildEditedSourcePreview, buildSourcePreview, previewTokenMatches, SourcePreviewError, verifyEditedSourcePreview } from "@/lib/script/source-preview";
import { EditableBlocksSchema } from "@/lib/script/source-blocks";
import type { SourcePreview } from "@/lib/script/types";

/** 历史与持久进度，读取不会重新提交已完成或失败的任务。 */
export async function GET() {
  await connection();
  try {
    startBackgroundWorker();
    return Response.json(listDocuments(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

const Body = z.object({
  sessionId: z.string().min(1).nullable().optional(),
  text: SourceTextSchema,
  previewToken: z.string().max(256).optional(),
  previewBlocks: EditableBlocksSchema.optional(),
  personaId: z.string().default("teacher"),
  ttsModelId: z.string(),
  voice: z.string(),
  useTags: z.boolean().default(true),
  useStyle: z.boolean().default(true),
});

/** Validate confirmation before persisting any document/job or starting models. */
export async function POST(request: Request) {
  try {
    const body = Body.parse(await request.json());
    let preview: SourcePreview;
    let confirmed: boolean;
    if (body.previewBlocks) {
      const verified = verifyEditedSourcePreview(body.text, body.previewBlocks, body.previewToken, config.sessionSecret);
      preview = verified ?? buildEditedSourcePreview(body.previewBlocks, config.sessionSecret);
      confirmed = verified !== null;
    } else {
      preview = buildSourcePreview(body.text, config.sessionSecret);
      confirmed = !(getGenerationSettings().previewBeforeGeneration || body.previewToken !== undefined)
        || previewTokenMatches(body.previewToken, preview.previewToken);
    }
    if (!confirmed) {
      return Response.json({ code: "PREVIEW_REQUIRED", error: "请先预览并确认当前原文和分段，再开始生成。", preview },
        { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const doc = createQueuedDocument({ sourceText: preview.sourceText, settings: body, scriptModel: config.scriptModel,
      sessionId: body.sessionId, preparedBlocks: preview.blocks });
    startBackgroundWorker();
    return Response.json(doc, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SourcePreviewError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof LibraryError) return Response.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
