// 前后端共享的"目录"：讲述角色 + TTS 模型能力描述。不含任何密钥。
//
// TTS 模型信息来源：
// - ZenMux 文档 api/openai/create-audio-speech.md（.agents/skills/zenmux-context）
//   目前文档中唯一出现的 TTS 模型为 google/gemini-3.1-flash-tts-preview，统一走 POST /api/v1/audio/speech
// - Google Gemini TTS 文档（音色列表、行内标签、风格控制）：
//   https://ai.google.dev/gemini-api/docs/speech-generation
// 新增模型前，先运行 `pnpm zenmux:models` 确认模型 slug 在你的账户下可用。

export interface Persona {
  id: string;
  label: string;
  /** 给 LLM 的角色设定 */
  prompt: string;
  /** 朗读风格（英文效果最好，Google 建议风格/标签使用英文，即使正文是中文） */
  voiceStyle: string;
}

export const PERSONAS: Persona[] = [
  {
    id: "teacher",
    label: "耐心的老师",
    prompt:
      "你是一位耐心、条理清晰的老师，正在陪学生一起看这段材料。你会用“我们来看”“注意这里”之类的引导语，把抽象内容讲得具体易懂。",
    voiceStyle: "warm, patient teacher, moderate pace",
  },
  {
    id: "friend",
    label: "懂行的朋友",
    prompt:
      "你是用户一位懂技术的好朋友，说话轻松自然、口语化，偶尔带点幽默，像坐在旁边一起看屏幕聊天。",
    voiceStyle: "casual, friendly",
  },
  {
    id: "narrator",
    label: "简洁播报",
    prompt: "你是一位简洁专业的播报员，尽量贴近原文，只对无法朗读的部分做最简短的概述。",
    voiceStyle: "clear, even, professional narration",
  },
];

/**
 * 行内标签语法（三个模型实测，见 README「TTS 模型实测」）：
 * - none：模型不支持行内标签
 * - angle：<sigh>、<short pause>（Gemini）
 * - square：[sighing]、[laugh]（Qwen-Audio、Grok）
 */
export type TagSyntax = "none" | "angle" | "square";

/**
 * 整体朗读风格的传递方式：
 * - none：不传
 * - prefix：作为一句自然语言前缀写进 input（Gemini 适用；Grok 会把前缀念出来，不能用）
 *   ZenMux /audio/speech 没有独立的 instructions 参数（Qwen 传 instructions 实测无效）
 */
export type StyleMode = "none" | "prefix";

/**
 * 标签类型：
 * - event：在当前位置插入一次性的声音或停顿（笑、叹气、停顿）
 * - style：从当前位置起改变后续语气，直到下一个 style 标签（Qwen 的“控制类标签”）
 */
export interface TtsTag {
  name: string;
  kind: "event" | "style";
  desc: string;
}

export interface TtsModel {
  id: string; // ZenMux 模型 slug
  label: string;
  voices: { id: string; label: string }[];
  defaultVoice: string;
  tagSyntax: TagSyntax;
  /** 模型认识的标签（只列实测或官方文档确认过、且适合讲解场景的），会写进加标签步骤的 prompt */
  tags: TtsTag[];
  styleMode: StyleMode;
}

const ev = (name: string, desc: string): TtsTag => ({ name, kind: "event", desc });
const st = (name: string, desc: string): TtsTag => ({ name, kind: "style", desc });

// Gemini TTS 预置音色（30 个），来源：https://ai.google.dev/gemini-api/docs/speech-generation
const GEMINI_VOICES: [string, string][] = [
  ["Zephyr", "明亮"], ["Puck", "欢快"], ["Charon", "知性"], ["Kore", "坚定"], ["Fenrir", "兴奋"],
  ["Leda", "年轻"], ["Orus", "坚定"], ["Aoede", "轻快"], ["Callirrhoe", "随和"], ["Autonoe", "明亮"],
  ["Enceladus", "气声"], ["Iapetus", "清晰"], ["Umbriel", "随和"], ["Algieba", "圆润"], ["Despina", "圆润"],
  ["Erinome", "清晰"], ["Algenib", "沙哑"], ["Rasalgethi", "知性"], ["Laomedeia", "欢快"], ["Achernar", "柔和"],
  ["Alnilam", "坚定"], ["Schedar", "平稳"], ["Gacrux", "成熟"], ["Pulcherrima", "直率"], ["Achird", "友好"],
  ["Zubenelgenubi", "随意"], ["Vindemiatrix", "温柔"], ["Sadachbia", "活泼"], ["Sadaltager", "博学"], ["Sulafat", "温暖"],
];

export const TTS_MODELS: TtsModel[] = [
  {
    id: "google/gemini-3.1-flash-tts-preview",
    label: "Gemini 3.1 Flash TTS (Preview)",
    voices: GEMINI_VOICES.map(([id, desc]) => ({ id, label: `${id}（${desc}）` })),
    defaultVoice: "Sulafat",
    tagSyntax: "angle",
    // Google 推荐标签中适合讲解场景的子集
    tags: [
      ev("short pause", "短停顿"),
      ev("long pause", "长停顿"),
      ev("breath", "吸气"),
      ev("sigh", "叹气"),
      ev("chuckle", "轻笑"),
      ev("laugh", "笑"),
      ev("giggle", "咯咯笑"),
      ev("gasp", "倒吸一口气"),
      ev("phew", "松一口气"),
      ev("tsk", "啧"),
      ev("throat-clearing", "清嗓子"),
    ],
    styleMode: "prefix",
  },
  {
    id: "qwen/qwen-audio-3.0-tts-plus",
    label: "Qwen-Audio 3.0 TTS Plus",
    // 系统音色，来源：https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list
    // （另有 500 余个 qwen-audio-3.0-tts-plus-{后缀} 基础音色，按需添加）
    voices: [
      { id: "longanlingxin", label: "龙安灵心（知心温暖·女）" },
      { id: "longanlufeng", label: "龙安鲁风（明亮开朗·男）" },
    ],
    defaultVoice: "longanlingxin",
    tagSyntax: "square",
    // 来源：https://help.aliyun.com/zh/model-studio/qwen-tts 「情感与富语言标签」
    tags: [
      ev("sighing", "叹息"),
      ev("gasp", "倒吸一口气"),
      ev("clears throat", "清嗓"),
      ev("giggles", "咯咯笑"),
      ev("laughing", "大笑"),
      st("curious", "好奇"),
      st("excited", "兴奋"),
      st("serious", "严肃"),
      st("empathetic", "共情、体贴"),
      st("mischievously", "调皮"),
      st("whispers", "耳语"),
      st("very slowly", "非常缓慢地说"),
    ],
    styleMode: "none",
  },
  {
    id: "x-ai/grok-voice-tts-1.0",
    label: "Grok Voice TTS 1.0",
    // 音色名经 ZenMux 实测可用（无效音色返回 404）；官方音色描述暂未核实
    voices: ["ara", "eve", "leo", "rex", "sal", "una"].map((id) => ({ id, label: id })),
    defaultVoice: "eve",
    tagSyntax: "square",
    // 均经实测：插入后音频变长且不会被念出；未知标签会被静默忽略
    tags: [
      ev("pause", "停顿"),
      ev("long-pause", "长停顿"),
      ev("breath", "吸气"),
      ev("sigh", "叹气"),
      ev("chuckle", "轻笑"),
      ev("laugh", "笑"),
      ev("giggle", "咯咯笑"),
    ],
    styleMode: "none",
  },
];

export function getPersona(id: string): Persona {
  return PERSONAS.find((p) => p.id === id) ?? PERSONAS[0];
}

export function getTtsModel(id: string): TtsModel {
  return TTS_MODELS.find((m) => m.id === id) ?? TTS_MODELS[0];
}

export function formatTag(syntax: TagSyntax, name: string): string {
  return syntax === "square" ? `[${name}]` : `<${name}>`;
}

/** 匹配形如 <short pause> / [sigh] 的标签（只认小写字母、空格、连字符，避免误伤正文） */
export const TAG_PATTERN = /<[a-z][a-z -]{0,30}>|\[[a-z][a-z -]{0,30}\]/g;

/** 只保留该模型认识的标签，其余去掉（例如切换模型后，旧口述稿里写法不同的标签） */
export function sanitizeTags(text: string, model: TtsModel): string {
  if (model.tagSyntax === "none") return stripTags(text);
  const allowed = new Set(model.tags.map((t) => formatTag(model.tagSyntax, t.name)));
  return text
    .replace(TAG_PATTERN, (m) => (allowed.has(m.toLowerCase()) ? m : " "))
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 去掉口述稿中的标签 */
export function stripTags(text: string): string {
  return text.replace(TAG_PATTERN, " ").replace(/[ \t]{2,}/g, " ").trim();
}
