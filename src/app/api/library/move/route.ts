import { z } from "zod";
import { moveLibraryItem, LibraryError } from "@/lib/store/collections";
import { errorResponse } from "@/lib/http";

const Body = z.object({
  kind: z.enum(["group", "session", "document"]),
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  beforeId: z.string().min(1).nullable().optional(),
});

export async function POST(request: Request) {
  try {
    return Response.json(moveLibraryItem(Body.parse(await request.json())), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof LibraryError) return Response.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
