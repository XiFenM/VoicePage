import { connection } from "next/server";
import { z } from "zod";
import { getGenerationSettings, updateGenerationSettings } from "@/lib/store/generation-settings";
import { errorResponse } from "@/lib/http";

const Patch = z.object({ previewBeforeGeneration: z.boolean().optional() }).strict();

export async function GET() {
  await connection();
  try {
    return Response.json(getGenerationSettings(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    return Response.json(updateGenerationSettings(Patch.parse(await request.json())), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
