import { cookies } from "next/headers";
import { config } from "@/lib/config";
import { SESSION_COOKIE, SESSION_MAX_AGE, createSessionToken, timingSafeEqual } from "@/lib/auth";

export async function POST(request: Request) {
  const { password } = (await request.json().catch(() => ({}))) as { password?: string };
  if (typeof password !== "string" || !timingSafeEqual(password, config.appPassword)) {
    await new Promise((r) => setTimeout(r, 800)); // 简单防爆破
    return Response.json({ error: "密码错误" }, { status: 401 });
  }
  (await cookies()).set(SESSION_COOKIE, await createSessionToken(config.sessionSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return Response.json({ ok: true });
}
