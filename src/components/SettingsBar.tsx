"use client";

import { PERSONAS, TTS_MODELS, getTtsModel } from "@/lib/catalog";
import type { DocSettings } from "@/lib/store/types";

/** 讲述角色 / TTS 模型 / 音色 / 标签 / 角色语气 */
export function SettingsBar(props: {
  value: DocSettings;
  onChange: (patch: Partial<DocSettings>) => void;
  /** 打开已有记录时：标签只在生成口述稿时起作用，不能再改 */
  tagsLocked?: boolean;
}) {
  const v = props.value;
  const model = getTtsModel(v.ttsModelId);
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Select
        label="讲述角色"
        value={v.personaId}
        onChange={(personaId) => props.onChange({ personaId })}
        options={PERSONAS.map((p) => [p.id, p.label])}
        disabled={props.tagsLocked}
        title={props.tagsLocked ? "角色决定口述稿内容，已生成的记录不能更改；如需更换请新建" : undefined}
      />
      <Select
        label="TTS 模型"
        value={v.ttsModelId}
        onChange={(id) => props.onChange({ ttsModelId: id, voice: getTtsModel(id).defaultVoice })}
        options={TTS_MODELS.map((m) => [m.id, m.label])}
      />
      <Select
        label="音色"
        value={v.voice}
        onChange={(voice) => props.onChange({ voice })}
        options={model.voices.map((x) => [x.id, x.label])}
      />
      <label
        className={`flex items-center gap-1 ${model.tagSyntax === "none" || props.tagsLocked ? "opacity-40" : ""}`}
        title={props.tagsLocked ? "标签在生成口述稿时插入；切换模型后，不被新模型识别的标签会在合成时自动去掉" : undefined}
      >
        <input
          type="checkbox"
          checked={v.useTags && model.tagSyntax !== "none"}
          disabled={model.tagSyntax === "none" || props.tagsLocked}
          onChange={(e) => props.onChange({ useTags: e.target.checked })}
        />
        语气标签{model.tagSyntax === "none" && "（该模型不支持）"}
      </label>
      {model.styleMode !== "none" && (
        <label className="flex items-center gap-1" title="在 TTS 输入前加一句角色对应的朗读风格说明">
          <input type="checkbox" checked={v.useStyle} onChange={(e) => props.onChange({ useStyle: e.target.checked })} />
          角色语气
        </label>
      )}
    </div>
  );
}

function Select(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className={`flex items-center gap-1 ${props.disabled ? "opacity-50" : ""}`} title={props.title}>
      <span className="text-zinc-500">{props.label}</span>
      <select
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
      >
        {props.options.map(([val, l]) => (
          <option key={val} value={val}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
