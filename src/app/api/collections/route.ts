import { z } from "zod";
import { createCollection, LibraryError } from "@/lib/store/collections";
import { errorResponse } from "@/lib/http";

const Body = z.object({
  kind: z.enum(["group", "session"]),
  name: z.string().trim().min(1).max(200),
  parentId: z.string().min(1).nullable().optional(),
  beforeId: z.string().min(1).nullable().optional(),
});

export async function POST(request: Request) {
  try {
    return Response.json(createCollection(Body.parse(await request.json())), { status: 201 });
  } catch (error) {
    if (error instanceof LibraryError) return Response.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
