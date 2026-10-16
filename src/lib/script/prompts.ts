import { formatTag, type Persona, type TtsModel } from "@/lib/catalog";
import type { SourceBlock } from "./segment";

export function spokenSystemPrompt(persona: Persona): string {
  return `${persona.prompt}

## 任务
用户会给你一段 AI 回复，已经被切成若干编号的"块"。用户会**一边看原文、一边听你的讲述**。
请为每个块写一段"口述稿"，用于交给语音合成朗读。
用户可能手工合并了相邻内容，因此同一块内可以同时包含文字、代码、表格或公式。请按其中各部分的实际内容分别遵循下方规则，仍保持每个输入块对应一段口述稿。

## 规则
1. 普通文字块：基本按原文朗读，只做口语化的轻微调整（去掉 Markdown 符号、把"→"之类的符号读成文字、把列表读顺）。不要大幅改写或删减，因为用户正对照着原文读。
2. 代码块：不要逐字符念代码。像坐在旁边的人一样，说明"这段代码在做什么"、关键结构或关键行，引导用户看屏幕上的代码。较短的关键标识符可以读出来。
3. 表格：概括表格比较的是什么、有哪几列，点出最重要的一两个结论，而不是逐格朗读。
4. 图表语言（mermaid 等）：用一两句话描述图的结构和含义，例如"这张流程图从……开始，经过……最后到……"。
5. 数学公式与复杂度记号：按中文习惯读出来，例如 O(n log n) 写成“O n log n”或“n log n 级别”，n² 写成“n 的平方”；复杂公式只说明其作用。
6. 链接、URL、文件路径：不要念完整地址，说"这里有个链接""这个文件"之类即可。
7. 口述稿语言与原文主体语言一致。英文术语可保留英文。
8. 只输出纯文本口述内容，不要输出任何 Markdown、括号注释、表情符号或语气标签。
9. 块与块之间可以有自然的衔接语，但每段口述稿必须只对应它自己的块。

## 输出
按给定 JSON Schema 输出，每个输入块恰好一项，id 与输入一致。`;
}

export function spokenUserPrompt(blocks: SourceBlock[]): string {
  return blocks
    .map((b) => `<block id="${b.id}" kind="${b.kind}"${b.lang ? ` lang="${b.lang}"` : ""}>\n${b.markdown}\n</block>`)
    .join("\n\n");
}

export function tagSystemPrompt(model: TtsModel, persona: Persona): string {
  const fmt = (t: { name: string; desc: string }) => `${formatTag(model.tagSyntax, t.name)}（${t.desc}）`;
  const events = model.tags.filter((t) => t.kind === "event");
  const styles = model.tags.filter((t) => t.kind === "style");
  const ex = formatTag(model.tagSyntax, events[0]?.name ?? "pause");

  let tagDoc = "";
  if (events.length) {
    tagDoc += `### 一次性标签\n在所在位置插入一次声音或停顿，不影响前后语气：\n${events.map(fmt).join("  ")}\n`;
  }
  if (styles.length) {
    tagDoc += `\n### 语气切换标签\n从所在位置起改变**之后所有文字**的语气，直到遇到下一个语气切换标签：\n${styles.map(fmt).join("  ")}\n只在语气确实需要变化的句首使用，一段口述稿里最多用 1~2 个。\n`;
  }

  return `你是语音导演。下面是一组将交给语音合成模型「${model.label}」朗读的口述稿，讲述者的角色是：${persona.label}。
请在**不改动任何文字**的前提下，插入少量标签，让朗读更自然、更像真人在讲解。

## 可用标签（只能使用以下标签，原样书写，正文是中文也保持英文）
${tagDoc}
## 规则
1. 不得增删或改写原文字（包括标点），只能在合适的位置插入标签。
2. 示例："注意看这里 ${ex} 这一行是关键"。
3. 克制使用：平均每 2~3 句话最多一个标签，大多数句子不需要标签。
4. 停顿类标签适合放在转折处，或引导用户看屏幕上的代码、表格、图之前。
5. 笑、叹气这类情绪标签必须与内容和角色相符，宁缺毋滥。

## 输出
按给定 JSON Schema 输出，id 与输入一致，每个输入项恰好一项。`;
}

export function tagUserPrompt(segments: { id: number; speech: string }[]): string {
  return JSON.stringify({ segments });
}
