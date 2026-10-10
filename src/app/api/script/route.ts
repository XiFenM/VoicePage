import { z } from "zod";
import { runScriptPipeline } from "@/lib/script/pipeline";
import { errorResponse } from "@/lib/http";

const Body = z.object({
  text: z.string().min(1).max(30000),
  personaId: z.string().default("teacher"),
  ttsModelId: z.string(),
  useTags: z.boolean().default(true),
});

export async function POST(request: Request) {
  try {
    const body = Body.parse(await request.json());
    const result = await runScriptPipeline({ ...body, signal: request.signal });
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
