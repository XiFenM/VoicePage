// 前端调用后端 API 的薄封装
import type { CollectionKind, DocSettings, DocSummary, GenerationEventsPage, LibraryCollection, LibrarySnapshot, StoredDocument } from "@/lib/store/types";
import type { ImportResult } from "@/lib/store/backup";
import type { RuntimeSettings } from "@/lib/runtime-settings";
import type { GenerationSettings } from "@/lib/generation-settings";
import type { SourcePreview, SourcePreviewAction } from "@/lib/script/types";
import type { SourceBlock } from "@/lib/script/segment";
import type { LibraryMove } from "./library-tree";

export type SourcePreviewResult = SourcePreview;

export class PreviewRequiredError extends Error {
  constructor(message: string, readonly preview: SourcePreviewResult) {
    super(message);
    this.name = "PreviewRequiredError";
  }
}

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
  if (!res.ok) {
    if (res.status === 409 && data.code === "PREVIEW_REQUIRED" && Array.isArray(data.preview?.blocks) && typeof data.preview?.previewToken === "string") {
      throw new PreviewRequiredError(data.error ?? "请确认最新分段后再生成。", data.preview);
    }
    throw new Error((data as { error?: string }).error ?? res.statusText);
  }
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
  get: (id: string, signal?: AbortSignal) => call<StoredDocument>(`/api/documents/${id}`, { cache: "no-store", signal }),
  generationEvents: (id: string, before?: number, signal?: AbortSignal) =>
    call<GenerationEventsPage>(`/api/documents/${id}/events?limit=50${before === undefined ? "" : `&before=${before}`}`, { cache: "no-store", signal }),
  create: (body: DocSettings & { text: string; sessionId?: string | null; previewToken?: string; previewBlocks?: SourceBlock[] }) => call<StoredDocument>("/api/documents", json("POST", body)),
  previewSource: (text: string, signal?: AbortSignal) => call<SourcePreviewResult>("/api/documents/preview", { ...json("POST", { text }), signal }),
  previewBlocks: (blocks: SourceBlock[], signal?: AbortSignal, action?: SourcePreviewAction) =>
    call<SourcePreviewResult>("/api/documents/preview", { ...json("POST", { blocks, ...(action ? { action } : {}) }), signal }),
  library: (signal?: AbortSignal) => call<LibrarySnapshot>("/api/library", { cache: "no-store", signal }),
  createCollection: (body: { kind: CollectionKind; name: string; parentId?: string | null; beforeId?: string | null }) =>
    call<LibraryCollection>("/api/collections", json("POST", body)),
  updateCollection: (id: string, body: { name?: string; parentId?: string | null; beforeId?: string | null }) =>
    call<LibraryCollection>(`/api/collections/${id}`, json("PATCH", body)),
  removeCollection: (id: string) => call<{ ok: true }>(`/api/collections/${id}`, { method: "DELETE" }),
  moveLibraryItem: (body: LibraryMove) => call<LibrarySnapshot>("/api/library/move", json("POST", body)),
  runtimeSettings: () => call<RuntimeSettings>("/api/settings", { cache: "no-store" }),
  saveRuntimeSettings: (settings: RuntimeSettings) => call<RuntimeSettings>("/api/settings", json("PATCH", settings)),
  generationSettings: (signal?: AbortSignal) => call<GenerationSettings>("/api/settings/generation", { cache: "no-store", signal }),
  saveGenerationSettings: (settings: GenerationSettings) => call<GenerationSettings>("/api/settings/generation", json("PATCH", settings)),
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
