// 前后端共享的"目录"：讲述角色 + TTS 模型能力描述。不含任何密钥。

export interface Persona {
  id: string;
  label: string;
  /** 给 LLM 的角色设定 */
  prompt: string;
  /** 给支持自然语言风格控制的 TTS 的朗读指令 */
  voiceStyle: string;
}

export const PERSONAS: Persona[] = [
  {
    id: "teacher",
    label: "耐心的老师",
    prompt:
      "你是一位耐心、条理清晰的老师，正在陪学生一起看这段材料。你会用“我们来看”“注意这里”之类的引导语，把抽象内容讲得具体易懂。",
    voiceStyle: "用温和、耐心、语速适中的老师口吻讲解，重点处稍作停顿",
  },
  {
    id: "friend",
    label: "懂行的朋友",
    prompt:
      "你是用户一位懂技术的好朋友，说话轻松自然、口语化，偶尔带点幽默，像坐在旁边一起看屏幕聊天。",
    voiceStyle: "用轻松、自然、亲切的朋友聊天口吻说话，语气活泼一些",
  },
  {
    id: "narrator",
    label: "简洁播报",
    prompt: "你是一位简洁专业的播报员，尽量贴近原文，只对无法朗读的部分做最简短的概述。",
    voiceStyle: "用清晰、平稳、专业的播音口吻朗读",
  },
];

/**
 * 语气标签风格：
 * - none：模型不支持内联标签，口述稿只能是纯文本
 * - bracket：支持形如 [laughs] 的方括号内联标签
 */
export type TagStyle = "none" | "bracket";

export interface TtsModel {
  id: string; // ZenMux 上的模型 slug
  label: string;
  protocol: "gemini" | "openai-speech";
  voices: { id: string; label: string }[];
  defaultVoice: string;
  tagStyle: TagStyle;
  /** 模型认识的标签（写进 LLM prompt，让它只用这些） */
  tags: string[];
  /** 是否支持用自然语言描述整体朗读风格 */
  supportsStyleInstruction: boolean;
}

export const TTS_MODELS: TtsModel[] = [
  {
    id: "google/gemini-2.5-flash-preview-tts",
    label: "Gemini 2.5 Flash TTS",
    protocol: "gemini",
    voices: [
      { id: "Kore", label: "Kore（坚定）" },
      { id: "Puck", label: "Puck（欢快）" },
      { id: "Charon", label: "Charon（知性）" },
      { id: "Aoede", label: "Aoede（轻快）" },
      { id: "Leda", label: "Leda（年轻）" },
      { id: "Sulafat", label: "Sulafat（温暖）" },
      { id: "Achird", label: "Achird（友好）" },
    ],
    defaultVoice: "Kore",
    tagStyle: "bracket",
    tags: ["[laughs]", "[sigh]", "[short pause]", "[long pause]", "[whispering]", "[excited]", "[curious]", "[serious]"],
    supportsStyleInstruction: true,
  },
  {
    id: "google/gemini-2.5-pro-preview-tts",
    label: "Gemini 2.5 Pro TTS",
    protocol: "gemini",
    voices: [
      { id: "Kore", label: "Kore（坚定）" },
      { id: "Puck", label: "Puck（欢快）" },
      { id: "Charon", label: "Charon（知性）" },
      { id: "Sulafat", label: "Sulafat（温暖）" },
    ],
    defaultVoice: "Charon",
    tagStyle: "bracket",
    tags: ["[laughs]", "[sigh]", "[short pause]", "[long pause]", "[whispering]", "[excited]", "[curious]", "[serious]"],
    supportsStyleInstruction: true,
  },
  {
    id: "openai/gpt-4o-mini-tts",
    label: "OpenAI gpt-4o-mini-tts",
    protocol: "openai-speech",
    voices: [
      { id: "alloy", label: "alloy" },
      { id: "nova", label: "nova" },
      { id: "shimmer", label: "shimmer" },
      { id: "coral", label: "coral" },
      { id: "sage", label: "sage" },
    ],
    defaultVoice: "coral",
    tagStyle: "none",
    tags: [],
    supportsStyleInstruction: true,
  },
];

export function getPersona(id: string): Persona {
  return PERSONAS.find((p) => p.id === id) ?? PERSONAS[0];
}

export function getTtsModel(id: string): TtsModel {
  return TTS_MODELS.find((m) => m.id === id) ?? TTS_MODELS[0];
}

/** 去掉口述稿中的标签，用于在界面上显示"干净"的稿子或给不支持标签的模型 */
export function stripTags(text: string): string {
  return text.replace(/\[[^\]\n]{1,30}\]\s*/g, "").trim();
}
