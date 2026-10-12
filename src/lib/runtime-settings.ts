/** 前后端共用的并发配置。值表示全站上限，不按浏览器标签页或 Session 叠加。 */
export interface RuntimeSettings {
  taskConcurrency: number;
  textConcurrency: number;
  ttsConcurrency: number;
  segmentConcurrency: number;
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  taskConcurrency: 4,
  textConcurrency: 4,
  ttsConcurrency: 4,
  segmentConcurrency: 2,
};

export const RUNTIME_SETTING_LIMITS: Record<keyof RuntimeSettings, { min: number; max: number }> = {
  taskConcurrency: { min: 1, max: 32 },
  textConcurrency: { min: 1, max: 32 },
  ttsConcurrency: { min: 1, max: 32 },
  segmentConcurrency: { min: 1, max: 16 },
};

export function validateRuntimeSettings(patch: Partial<RuntimeSettings>): void {
  for (const [key, value] of Object.entries(patch)) {
    const limit = RUNTIME_SETTING_LIMITS[key as keyof RuntimeSettings];
    if (!limit || !Number.isInteger(value) || value < limit.min || value > limit.max) {
      throw new Error(`并发设置 ${key} 必须是 ${limit?.min ?? 1}–${limit?.max ?? 32} 之间的整数`);
    }
  }
}
