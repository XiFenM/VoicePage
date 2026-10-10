import { BackupError, exportBackup, importBackup, type ImportMode } from "@/lib/store/backup";
import { errorResponse } from "@/lib/http";

/** 导出：GET /api/backup[?ids=a,b] -> zip 下载 */
export async function GET(request: Request) {
  try {
    const ids = new URL(request.url).searchParams.get("ids")?.split(",").filter(Boolean);
    const { zip } = exportBackup(ids);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})(\d{6})/, "$1-$2");
    return new Response(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="readaloud-backup-${stamp}.zip"`,
        "Content-Length": String(zip.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 导入：POST /api/backup?mode=skip|overwrite，请求体为 zip 二进制 */
export async function POST(request: Request) {
  try {
    const mode = (new URL(request.url).searchParams.get("mode") ?? "skip") as ImportMode;
    if (mode !== "skip" && mode !== "overwrite") return Response.json({ error: "mode 参数错误" }, { status: 400 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) return Response.json({ error: "文件为空" }, { status: 400 });
    return Response.json(importBackup(bytes, mode));
  } catch (e) {
    if (e instanceof BackupError) return Response.json({ error: e.message }, { status: 400 });
    return errorResponse(e);
  }
}
