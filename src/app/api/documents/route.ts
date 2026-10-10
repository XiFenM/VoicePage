import { z } from "zod";
import { config } from "@/lib/config";
import { runScriptPipeline } from "@/lib/script/pipeline";
import { createDocument, listDocuments } from "@/lib/store/documents";
import { errorResponse } from "@/lib/http";

/** 历史列表 */
export async function GET() {
  try {
    return Response.json(listDocuments());
  } catch (e) {
    return errorResponse(e);
  }
}

const Body = z.object({
  text: z.string().min(1).max(30000),
  personaId: z.string().default("teacher"),
  ttsModelId: z.string(),
  voice: z.string(),
  useTags: z.boolean().default(true),
  useStyle: z.boolean().default(true),
});

/** 新建：原文 -> 分块 + 口述稿（+标签），并立即保存 */
export async function POST(request: Request) {
  try {
    const body = Body.parse(await request.json());
    const { blocks, segments } = await runScriptPipeline({ ...body, signal: request.signal });
    if (blocks.length === 0) return Response.json({ error: "原文为空" }, { status: 400 });
    const doc = createDocument({
      sourceText: body.text,
      settings: body,
      scriptModel: config.scriptModel,
      blocks,
      segments,
    });
    return Response.json(doc);
  } catch (e) {
    return errorResponse(e);
  }
}
