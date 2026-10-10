// 前端调用后端 API 的薄封装
import type { DocSettings, DocSummary, StoredDocument, StoredSegment } from "@/lib/store/types";
import type { ImportResult } from "@/lib/store/backup";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 401) {
    window.location.replace(new URL("/login", window.location.origin));
    throw new Error("未登录");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  list: () => call<DocSummary[]>("/api/documents"),
  get: (id: string) => call<StoredDocument>(`/api/documents/${id}`),
  create: (body: DocSettings & { text: string }) => call<StoredDocument>("/api/documents", json("POST", body)),
  update: (id: string, patch: Partial<DocSettings> & { title?: string }) =>
    call<StoredDocument>(`/api/documents/${id}`, json("PATCH", patch)),
  remove: (id: string) => call<{ ok: true }>(`/api/documents/${id}`, { method: "DELETE" }),
  saveSegment: (id: string, idx: number, tagged: string) =>
    call<{ ok: true }>(`/api/documents/${id}/segments/${idx}`, json("PATCH", { tagged })),
  synthesize: (id: string, idx: number, force = false) =>
    call<StoredSegment>(`/api/documents/${id}/segments/${idx}/tts${force ? "?force=1" : ""}`, { method: "POST" }),
  importBackup: (file: File, mode: "skip" | "overwrite") =>
    call<ImportResult>(`/api/backup?mode=${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
    }),
};
