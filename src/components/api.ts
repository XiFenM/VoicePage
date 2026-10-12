// 前端调用后端 API 的薄封装
import type { CollectionKind, DocSettings, DocSummary, GenerationEventsPage, LibraryCollection, LibrarySnapshot, StoredDocument } from "@/lib/store/types";
import type { ImportResult } from "@/lib/store/backup";
import type { RuntimeSettings } from "@/lib/runtime-settings";
import type { LibraryMove } from "./library-tree";

function checkAuth(res: Response) {
  if (res.status === 401) {
    window.location.replace(new URL("/login", window.location.origin));
    throw new Error("未登录");
  }
}

async function readJson<T>(res: Response): Promise<T> {
  checkAuth(res);
  const data = await res.json().catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {};
  });
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  return readJson<T>(await fetch(url, init));
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  list: () => call<DocSummary[]>("/api/documents", { cache: "no-store" }),
  get: (id: string) => call<StoredDocument>(`/api/documents/${id}`, { cache: "no-store" }),
  generationEvents: (id: string, before?: number, signal?: AbortSignal) =>
    call<GenerationEventsPage>(`/api/documents/${id}/events?limit=50${before === undefined ? "" : `&before=${before}`}`, { cache: "no-store", signal }),
  create: (body: DocSettings & { text: string; sessionId?: string | null }) => call<StoredDocument>("/api/documents", json("POST", body)),
  library: () => call<LibrarySnapshot>("/api/library", { cache: "no-store" }),
  createCollection: (body: { kind: CollectionKind; name: string; parentId?: string | null; beforeId?: string | null }) =>
    call<LibraryCollection>("/api/collections", json("POST", body)),
  updateCollection: (id: string, body: { name?: string; parentId?: string | null; beforeId?: string | null }) =>
    call<LibraryCollection>(`/api/collections/${id}`, json("PATCH", body)),
  removeCollection: (id: string) => call<{ ok: true }>(`/api/collections/${id}`, { method: "DELETE" }),
  moveLibraryItem: (body: LibraryMove) => call<LibrarySnapshot>("/api/library/move", json("POST", body)),
  runtimeSettings: () => call<RuntimeSettings>("/api/settings", { cache: "no-store" }),
  saveRuntimeSettings: (settings: RuntimeSettings) => call<RuntimeSettings>("/api/settings", json("PATCH", settings)),
  update: (id: string, patch: Partial<DocSettings> & { title?: string }) =>
    call<StoredDocument>(`/api/documents/${id}`, json("PATCH", patch)),
  remove: (id: string) => call<{ ok: true }>(`/api/documents/${id}`, { method: "DELETE" }),
  saveSegment: (id: string, idx: number, tagged: string) =>
    call<{ ok: true }>(`/api/documents/${id}/segments/${idx}`, json("PATCH", { tagged })),
  generation: (id: string, body: { action: "start" | "retry" | "cancel"; indices?: number[]; force?: boolean }) =>
    call<StoredDocument>(`/api/documents/${id}/generation`, json("POST", body)),
  importBackup: (file: File, mode: "skip" | "overwrite") =>
    call<ImportResult>(`/api/backup?mode=${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
    }),
};
