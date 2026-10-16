/** 生成流程偏好与并发设置独立；关闭预览时直接提交后台任务。 */
export interface GenerationSettings {
  previewBeforeGeneration: boolean;
}

export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = { previewBeforeGeneration: true };

export function validateGenerationSettings(patch: Partial<GenerationSettings>): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("生成设置必须是对象");
  for (const [key, value] of Object.entries(patch)) {
    if (key !== "previewBeforeGeneration" || typeof value !== "boolean") throw new Error("previewBeforeGeneration 必须是布尔值");
  }
}
