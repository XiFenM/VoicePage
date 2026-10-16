import "server-only";
import { db, tx } from "./db";
import { DEFAULT_GENERATION_SETTINGS, validateGenerationSettings, type GenerationSettings } from "@/lib/generation-settings";

export function getGenerationSettings(): GenerationSettings {
  const row = db().prepare("SELECT preview_before_generation FROM generation_settings WHERE id = 1").get();
  return row ? { previewBeforeGeneration: !!row.preview_before_generation } : { ...DEFAULT_GENERATION_SETTINGS };
}

export function updateGenerationSettings(patch: Partial<GenerationSettings>): GenerationSettings {
  validateGenerationSettings(patch);
  return tx(() => {
    const next = { ...getGenerationSettings(), ...patch };
    db().prepare(`INSERT INTO generation_settings (id, preview_before_generation, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET preview_before_generation = excluded.preview_before_generation, updated_at = excluded.updated_at`)
      .run(+next.previewBeforeGeneration, Date.now());
    return next;
  });
}
