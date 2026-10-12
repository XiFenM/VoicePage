import { connection } from "next/server";
import { getLibrary } from "@/lib/store/collections";
import { errorResponse } from "@/lib/http";

export async function GET() {
  await connection();
  try {
    return Response.json(getLibrary(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
