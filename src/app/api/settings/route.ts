import { connection } from "next/server";
import { z } from "zod";
import { RUNTIME_SETTING_LIMITS } from "@/lib/runtime-settings";
import { getRuntimeSettings, updateRuntimeSettings } from "@/lib/store/runtime-settings";
import { startBackgroundWorker } from "@/lib/generation/worker";
import { errorResponse } from "@/lib/http";

const integer = (key: keyof typeof RUNTIME_SETTING_LIMITS) => z.number().int()
  .min(RUNTIME_SETTING_LIMITS[key].min).max(RUNTIME_SETTING_LIMITS[key].max).optional();
const Patch = z.object({
  taskConcurrency: integer("taskConcurrency"),
  textConcurrency: integer("textConcurrency"),
  ttsConcurrency: integer("ttsConcurrency"),
  segmentConcurrency: integer("segmentConcurrency"),
}).strict();

export async function GET() {
  await connection();
  try {
    return Response.json(getRuntimeSettings(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const settings = updateRuntimeSettings(Patch.parse(await request.json()));
    startBackgroundWorker();
    return Response.json(settings, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
