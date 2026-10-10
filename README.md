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
    ├── zenmux.ts             # ZenMux 客户端（OpenAI 协议 + Vertex AI 协议）
    ├── http.ts               # 错误响应
    ├── script/               # 分块、prompt、流水线
    └── tts/                  # TTS 调度
```

## 运行

```bash
pnpm install
cp .env.example .env.local     # 填入 ZENMUX_API_KEY、APP_PASSWORD、SESSION_SECRET
pnpm dev                       # http://localhost:3000
```

## ZenMux 接入说明

- **口述稿 LLM**：走 OpenAI 兼容的 `POST {ZENMUX_BASE_URL}/chat/completions`，模型由 `SCRIPT_MODEL` 指定。
- **TTS**：在 `src/lib/catalog.ts` 的 `TTS_MODELS` 中配置，每个模型声明：
  - `protocol`：`gemini`（Vertex AI 协议 `:generateContent`，返回 PCM，服务端封装为 WAV）或 `openai-speech`（`/audio/speech`）
  - `voices` / `defaultVoice`
  - `tagStyle` + `tags`：是否支持内联语气标签、支持哪些标签（会写入步骤 ③ 的 prompt）
  - `supportsStyleInstruction`：是否支持自然语言朗读风格指令（角色的 `voiceStyle`）

> ⚠️ 模型 slug 和接口路径是按 ZenMux 文档的约定写的，请到 ZenMux 控制台核对你账户可用的 TTS 模型名，不一致时修改 `catalog.ts` 或 `.env.local` 中的 `ZENMUX_*_BASE_URL` 即可。

## 后续可做

- 历史记录持久化（SQLite），缓存已合成的音频
- 句子级高亮（利用 TTS 时间戳或按句切分）
- 播放倍速、键盘快捷键
- 更多 TTS 模型（如支持 SSML / 情绪标签的国产模型）
