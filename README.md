# ReadAloud · 边听边读

把 AI 对话中的回复文本转换成**适合朗读的口述稿**，再用 TTS 生成语音，让你一边听一边对照原文阅读。

## 处理流程

```
原始回复 (Markdown)
   │ ① 分块（本地）           src/lib/script/segment.ts
   ▼    text / code / table / diagram / math
阅读块[]
   │ ② 转口述稿（LLM）         src/lib/script/pipeline.ts · toSpoken
   ▼    按“老师 / 朋友 / 播报”等角色讲解代码、表格、图表，不逐字念
口述稿[]
   │ ③ 加语气标签（LLM，可选） src/lib/script/pipeline.ts · addTags
   ▼    只用所选 TTS 模型支持的标签，不改文字（会做校验）
带标签口述稿[]
   │ ④ 逐块 TTS（ZenMux）      src/lib/tts/synthesize.ts
   ▼
音频[]  →  前端按块顺序播放，并高亮当前阅读块
```

按块处理的好处：前面几块合成好就能开始播放；播放时可以精确高亮对应原文；单块失败可以单独重试；口述稿也可以手动修改后重新合成。

## 目录结构

```
src/
├── proxy.ts                  # 单用户鉴权（Next 16 中 middleware 已更名为 proxy）
├── app/
│   ├── page.tsx              # 主页面
│   ├── login/page.tsx        # 登录页
│   └── api/
│       ├── login|logout/     # 密码登录 / 退出
│       ├── script/route.ts   # 步骤 ①②③：原文 -> 分块 + 口述稿
│       └── tts/route.ts      # 步骤 ④：单段口述稿 -> 音频
├── components/Studio.tsx     # 输入、设置、阅读 + 播放界面
└── lib/
    ├── catalog.ts            # 讲述角色、TTS 模型能力表（音色/标签/协议）
    ├── config.ts             # 环境变量
    ├── auth.ts               # HMAC 签名 session
    ├── zenmux.ts             # ZenMux 客户端（chat / audio speech / models）
    ├── http.ts               # 错误响应
    ├── script/               # 分块、prompt、流水线
    └── tts/                  # TTS 调度
```

## 运行

```bash
pnpm install
cp .env.example .env.local     # 填入 ZENMUX_API_KEY、APP_PASSWORD、SESSION_SECRET
pnpm zenmux:models             # 可选：确认账户下可用的 TTS 模型
pnpm dev                       # http://localhost:3000
```

## ZenMux 接入说明

所有接口都依据 ZenMux 官方文档（见下方“项目级 Skills”）编写，统一走 OpenAI 兼容入口 `https://zenmux.ai/api/v1`：

| 用途 | 接口 | 说明 |
|---|---|---|
| 口述稿 / 加标签 | `POST /chat/completions` | `response_format: json_schema` 结构化输出，模型由 `SCRIPT_MODEL` 指定 |
| 语音合成 | `POST /audio/speech` | 返回 JSON `{ audio: base64, mime_type: "audio/L16;rate=24000" }`，服务端把裸 PCM 封装成 WAV |
| 核对模型 | `GET /models` | `pnpm zenmux:models` 列出可输出音频的模型 |

TTS 模型在 `src/lib/catalog.ts` 的 `TTS_MODELS` 中配置。ZenMux 文档只写了 Gemini，另外两个模型的用法来自厂商官方文档，并通过 ZenMux 实测验证（合成后再用 `qwen/qwen3-asr-flash` 转写回来比对）：

| 模型 | 音色 | 行内标签 | 角色语气 | 实测速度* |
|---|---|---|---|---|
| `google/gemini-3.1-flash-tts-preview` | 30 个预置音色 | `<short pause>` `<sigh>` 等尖括号写法，只表示某一时刻的声音或停顿 | 写一句英文风格前缀到输入里 | 慢（约 7~18s） |
| `qwen/qwen-audio-3.0-tts-plus` | `longanlingxin`、`longanlufeng` | `[sighing]` 等一次性标签，加 `[serious]` 等语气切换标签（作用于后续所有文字） | 不支持（`instructions` 实测无效，前缀会被丢掉） | 中（约 4~14s） |
| `x-ai/grok-voice-tts-1.0` | `ara` `eve` `leo` `rex` `sal` `una` | `[pause]` `[laugh]` 等方括号写法，不认识的标签会被静默忽略 | 不支持（前缀会被念出来） | 快（约 2~4s） |

\* 一段 100~200 字中文的合成时间。另外：

- 三个模型都返回 24kHz 单声道 PCM，服务端统一封装成 WAV。
- 标签写法用错会出问题：Gemini 遇到 `[sigh]` 会发出“啊”的声音。所以合成前会用 `sanitizeTags` 去掉当前模型不认识的标签（比如切换模型后旧口述稿里的标签）。
- `speed` 参数：Qwen 和 Grok 实测生效（1.5 倍时音频时长约缩短 1/3），Gemini 不生效。目前没有用它，倍速可以交给浏览器播放器的 `playbackRate` 处理。

错误按 ZenMux 的 `{ error: { type, message } }` 格式解析，附带中文提示和 `X-ZenMux-RequestId`。

## 项目级 Skills

ZenMux 官方 skills（[ZenMux/skills](https://github.com/ZenMux/skills)）安装在 `.agents/skills/`，pi 等 agent 会自动发现：

| Skill | 用途 |
|---|---|
| `zenmux-context` | 查阅 ZenMux 官方文档（会把 `ZenMux/zenmux-doc` clone 到 skill 目录下，已加入 `.agents/.gitignore`） |
| `zenmux-setup` | 接入配置引导 |
| `zenmux-usage` | 查询订阅、配额、余额、单次请求费用 |
| `zenmux-feedback` | 向 ZenMux 提 issue |

```bash
npx skills update -p                                              # 更新 skills
bash .agents/skills/zenmux-context/scripts/update-references.sh   # 拉取/更新文档
```

## 后续可做

- 历史记录持久化（SQLite），缓存已合成的音频
- 句子级高亮（利用 TTS 时间戳或按句切分）
- 播放倍速、键盘快捷键
- ZenMux 上线新 TTS 模型（如 Gemini 3.8 TTS）后加入 `catalog.ts`
- `/audio/speech` 的 `stream: true`，边合成边播放，减少等待
