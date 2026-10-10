import { connection } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { listDocuments } from "@/lib/store/documents";
import { createQueuedDocument } from "@/lib/store/jobs";
import { startBackgroundWorker } from "@/lib/generation/worker";
import { errorResponse } from "@/lib/http";

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
  text: z.string().max(30000).refine((text) => text.trim().length > 0, "原文为空"),
  personaId: z.string().default("teacher"),
  ttsModelId: z.string(),
  voice: z.string(),
  useTags: z.boolean().default(true),
  useStyle: z.boolean().default(true),
});

/** 只等待原文与队列落库，后续生成独立于 HTTP 请求和浏览器生命周期。 */
export async function POST(request: Request) {
  try {
    const body = Body.parse(await request.json());
    const doc = createQueuedDocument({ sourceText: body.text, settings: body, scriptModel: config.scriptModel });
    startBackgroundWorker();
    return Response.json(doc, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
