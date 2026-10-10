import { z } from "zod";
import { synthesize } from "@/lib/tts/synthesize";
import { errorResponse } from "@/lib/http";

const Body = z.object({
  text: z.string().min(1).max(5000),
  modelId: z.string(),
  voice: z.string().optional(),
  personaId: z.string().default("teacher"),
});

export async function POST(request: Request) {
  try {
    const body = Body.parse(await request.json());
    const { audio, mime } = await synthesize({ ...body, signal: request.signal });
    return new Response(audio, { headers: { "Content-Type": mime, "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
