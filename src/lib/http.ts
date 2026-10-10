import "server-only";
import { ZodError } from "zod";
import { UpstreamError } from "./zenmux";

export function errorResponse(e: unknown): Response {
  if (e instanceof ZodError) {
    return Response.json({ error: "请求参数错误", detail: e.issues }, { status: 400 });
  }
  if (e instanceof UpstreamError) {
    console.error(e.message);
    return Response.json({ error: e.message }, { status: 502 });
  }
  console.error(e);
  return Response.json({ error: e instanceof Error ? e.message : "未知错误" }, { status: 500 });
}
