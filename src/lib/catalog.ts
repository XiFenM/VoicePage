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
 * 行内语气标签语法：
 * - none：模型不支持行内标签
 * - angle：<sigh>、<short pause>（Gemini TTS 推荐写法）
 * - square：[sigh]（部分其他模型的写法，预留）
 */
export type TagSyntax = "none" | "angle" | "square";

/**
 * 整体朗读风格的传递方式：
 * - none：不传
 * - prefix：作为自然语言前缀写进 input（Gemini 3.1 及更早 TTS 的用法，如 "Say in a warm tone: ..."）
 *   /audio/speech 没有独立的 instructions 参数，所以只能这样传
 */
export type StyleMode = "none" | "prefix";

export interface TtsModel {
  id: string; // ZenMux 模型 slug
  label: string;
  voices: { id: string; label: string }[];
  defaultVoice: string;
  tagSyntax: TagSyntax;
  /** 模型认识的标签名（不含括号），会写进加标签步骤的 prompt */
  tags: string[];
  styleMode: StyleMode;
}

// Gemini TTS 预置音色（30 个）
const GEMINI_VOICES: [string, string][] = [
  ["Zephyr", "明亮"], ["Puck", "欢快"], ["Charon", "知性"], ["Kore", "坚定"], ["Fenrir", "兴奋"],
  ["Leda", "年轻"], ["Orus", "坚定"], ["Aoede", "轻快"], ["Callirrhoe", "随和"], ["Autonoe", "明亮"],
  ["Enceladus", "气声"], ["Iapetus", "清晰"], ["Umbriel", "随和"], ["Algieba", "圆润"], ["Despina", "圆润"],
  ["Erinome", "清晰"], ["Algenib", "沙哑"], ["Rasalgethi", "知性"], ["Laomedeia", "欢快"], ["Achernar", "柔和"],
  ["Alnilam", "坚定"], ["Schedar", "平稳"], ["Gacrux", "成熟"], ["Pulcherrima", "直率"], ["Achird", "友好"],
  ["Zubenelgenubi", "随意"], ["Vindemiatrix", "温柔"], ["Sadachbia", "活泼"], ["Sadaltager", "博学"], ["Sulafat", "温暖"],
];

// 从 Google 推荐列表中挑选适合"讲解/陪读"场景的子集，避免 <scream>、<growl> 之类不合语境的标签
const GEMINI_TAGS = [
  "short pause",
  "long pause",
  "breath",
  "sigh",
  "chuckle",
  "laugh",
  "giggle",
  "gasp",
  "phew",
  "tsk",
  "throat-clearing",
  "whispering",
];

export const TTS_MODELS: TtsModel[] = [
  {
    id: "google/gemini-3.1-flash-tts-preview",
    label: "Gemini 3.1 Flash TTS (Preview)",
    voices: GEMINI_VOICES.map(([id, desc]) => ({ id, label: `${id}（${desc}）` })),
    defaultVoice: "Sulafat",
    tagSyntax: "angle",
    tags: GEMINI_TAGS,
    styleMode: "prefix",
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

/** 去掉口述稿中的标签 */
export function stripTags(text: string): string {
  return text.replace(TAG_PATTERN, " ").replace(/[ \t]{2,}/g, " ").trim();
}
