# ReadAloud · 边听边读

把 AI 对话中的回复文本转换成**适合朗读的口述稿**，再用 TTS 生成语音，让你一边听一边对照原文阅读。

## 处理流程

```text
提交原始回复 (Markdown)
   ↓ 原文 + 持久任务一起写入 SQLite，立即返回 202
页面可自由切换或关闭
   │
服务端后台队列（任务、文本模型、语音模型、每篇段落分别限制并发）
   ├─ ① 本地分块 → ② LLM 生成口述稿 → 保存分段
   ├─ 第 1 段：③ 添加标签 → ④ TTS → 保存音频 → 可以播放
   ├─ 第 2 段：③ 添加标签 → ④ TTS → 保存音频
   └─ 后续段依次入队；失败段不会挡住其余段落

前端每 2 秒读取持久进度，按块播放并高亮原文。
```

### Group / Session / 听读任务

侧栏支持固定三层结构：**Group → Session → 听读任务**。Session 也可以独立放在顶层；暂不归类的任务保留在“未归档”。旧记录迁移后自动进入未归档，保留原有先后顺序。

- 新建 Group / Session 后，可选择一个 Session 连续添加同一轮 AI 对话中的回复；新建表单也能选择所属 Session。
- 拖动条目左侧的 `⠿`：拖到容器内改变归属，拖到行前/后的提示线调整顺序。任务可跨 Session 移动，Session 可跨 Group 或回到顶层，Group 可在顶层重排；任务可拖回未归档。
- `•••` 菜单提供改名、上下移与选择目标容器，供键盘和触屏使用。
- 解散 Group 会把 Session 提升到顶层；解散 Session 会把任务放回未归档。解散不会删除原文、音频或后台任务。
- 层次与顺序保存在服务端，不随生成进度更新时间自动重排。整理不会中断正在播放或生成的任务。

### 可配置并发

点击左下角“设置”，在“生成与并发”中修改并保存：

设置界面按分类组织，打开或关闭不会重建当前阅读器，也不会清空尚未提交的原文。

| 设置 | 含义 | 默认值 | 范围 |
|---|---|---:|---:|
| 同时推进的记录数 | 同时持有运行中步骤的文档数量；一个 AI 回复算一篇任务 | 4 | 1–32 |
| 文本模型请求数 | 所有口述稿改写与语气标签模型请求的全站总上限 | 4 | 1–32 |
| 语音模型请求数 | 所有 TTS 模型请求的全站总上限 | 4 | 1–32 |
| 每篇同时处理的段数 | 单篇任务内部同时准备标签或生成语音的段数 | 2 | 1–16 |

这四项共同约束实际并发，多个浏览器、Session、Group 和服务进程共享数据库中的同一套上限。调小不取消已经发出的请求，数量会自然回落；调大后会用于后续调度。设置不能提高上游提供商自身的速率/配额限制。

文本与 TTS 使用独立的持久许可，等待某类模型不会占用另一类模型许可；调度优先选择下一阶段有空闲模型名额的任务。任务及模型许可在同一事务中续约，进程退出后都能回收；10 分钟单次模型请求超时从获得模型许可后开始，不包含排队时间。

模型请求的 HTTP 响应头等待、响应体读取空闲超时均设置为 **10 分钟**，与执行器共用同一超时常量。执行器另限制整次请求（含读取响应）的总时长为 10 分钟；即使响应持续缓慢传输，也不会无限延长。此连接配置仅用于 ZenMux 请求，网络异常、超时后的自动重试策略保持不变。

### 真正的后台生成

- 提交后立即保存原文和任务，口述稿阶段也不需要留在页面。可以切到其他记录听读、继续新建任务、刷新或关闭浏览器。
- 后台执行器随 **常驻 Node 服务**启动，不依赖某次 HTTP 连接。运行应用的服务器必须在线；如果服务跑在自己的电脑上，关闭电脑或停止 `pnpm dev/start` 会暂停生成。
- SQLite 保存排队、运行、完成、失败和停止状态。执行器每秒检查队列，使用默认 60 秒租约和心跳；进程异常退出后，重启服务会自动接续排队任务，过期租约会重新领取，无需浏览器访问。
- 标签和音频逐段保存。重试复用已保存结果；音频保存与任务完成在同一事务中提交。若进程在上游请求已发出、结果尚未保存时退出，该请求恢复后可能需要重新调用，不能保证上游恰好计费一次。
- “停止生成”会停止未完成工作和等待中的自动重试，保留已有成果。临时网络、超时、限流等可恢复错误，每轮最多额外自动重试 **2 次**，默认等待 **5 秒、15 秒**；上游 `Retry-After` 可延长等待，但单次最多 **5 分钟**。等待时不占用执行名额，超过次数或遇到不可重试错误后可手动重试。重新打开旧记录或导入备份不会自动消耗模型额度，尚未生成的内容可点击“继续生成”。
- 修改口述稿会暂停该段任务；修改声音设置会暂停该篇任务。旧异步结果通过租约、修订号和输入快照校验，不能覆盖手工修改。保存后可明确重新生成。

### 状态与进度

历史列表和阅读页显示排队、口述稿生成中、语音完成段数、失败、已停止及已完成。页面刷新后状态仍在；列表刷新不打断当前播放。剩余时间仅在已有该任务的段落耗时样本时以粗略区间展示，长时间超出样本会改为“暂无法准确估计”。

失败段会直接显示失败阶段、原因、错误码、HTTP 状态和请求 ID（有返回时），底层原因链可展开查看。自动重试会显示次数和等待时间，等待期间可停止，不需要反复点击重试。

阅读页的“生成日志”始终保留，记录失败、自动或手动重试、恢复、成功和停止事件；生成成功和重新打开记录后仍能查看。日志仅在展开时更新，支持按段筛选、加载更早记录。该功能加入前未保存的底层错误、请求 ID 和尝试过程无法事后恢复。

接口：

- `POST /api/documents`：保存原文并入队，可带 `sessionId`，立即返回 `202` 与包含 `generation` 的文档草稿。
- `GET /api/documents` / `GET /api/documents/:id`：查询列表、文档和持久进度。
- `GET /api/library`、`POST /api/collections`、`PATCH/DELETE /api/collections/:id`：查询组织树、管理 Group / Session。
- `POST /api/library/move`：以 `kind/id/parentId/beforeId` 原子移动或排序。
- `GET/PATCH /api/settings`：读取和持久保存四项并发上限。
- `POST /api/documents/:id/generation`：`{ action: "start" | "retry" | "cancel", indices?: number[], force?: boolean }`，继续、重试或停止全部/指定段落。
- `GET /api/documents/:id/events?before=<事件id>&limit=50`：按时间倒序读取持久生成日志，返回 `events` 和可选的 `nextCursor`。
- 旧单段 `tags` / `tts` 入口现在同样返回 `202` 入队状态，不能绕过全局并发限制直接调用模型。

运行 `pnpm test` 可执行组织树、拖拽规则、独立模型许可、持久队列、租约、迁移与前端状态合并测试。`node scripts/check-library-concurrency.mjs` 会用本地假模型验证分组/备份及并发调高、调低和独立资源池。`node scripts/check-background-generation.mjs` 会自建独立本地模拟环境，验证关闭连接后继续生成、全局并发、失败重试、取消和服务重启恢复，不调用真实模型。运行方式和可选参数见脚本开头。

`node scripts/check-generation-retries.mjs` 验证断线恢复、临时错误自动重试上限、永久错误不重试、手动重试保留历史、取消退避和服务重启后的重试计划，全程使用隔离数据库和本地假模型。

## 数据存储与备份

所有数据保存在服务端的 `data/` 目录（可用环境变量 `DATA_DIR` 改位置，已加入 `.gitignore`）：

```
data/
├── readaloud.db          # SQLite（Node 内置 node:sqlite）：原文、分块、口述稿、分组、排序、并发设置、后台任务
└── audio/<记录id>/       # 每段一个 MP3（64kbps 单声道，约 0.47MB/分钟）
```

- 新建后原文与任务立即保存，每段标签和音频也独立落盘；关闭页面后服务端继续生成，回来读取最新进度。
- 手动修改的口述稿会自动保存。修改口述稿，或更改模型、音色、角色语气后，旧音频会标记为“已过期”，可以一键重新合成，新音频覆盖旧的。
- 重新打开已有记录时直接播放已存的音频，不会重复调用 TTS。

### 导出 / 导入（换机器）

左下角“设置” → “数据与备份”：

- **导出备份**：下载 `readaloud-backup-<时间>.zip`，内含 `manifest.json`（全部记录）和 `audio/` 下的所有 MP3。
- **选择备份文件**：选择备份 zip。默认跳过已存在的记录和分组，重复导入同一个备份是安全的；勾选“覆盖已有记录及组织信息”则用备份中的版本替换，包括 Group / Session 的名称、层次和顺序。备份 v5 保留层次、排序、空容器、原文草稿、已生成成果以及失败和重试日志；部分导出包含所需的祖先容器。导入后的未完成任务处于停止状态，需要手动继续；兼容 v1/v2/v3/v4 备份（没有归档信息的旧记录进入未归档）。并发偏好不会被导入覆盖。

迁移步骤：旧机器导出 → 新机器部署并配好 `.env.local` → 登录后导入。也可以直接把整个 `data/` 目录拷过去（需先停止服务）。

接口：`GET /api/backup[?ids=a,b]` 导出，`POST /api/backup?mode=skip|overwrite`（请求体为 zip）导入。

## 目录结构

```
src/
├── instrumentation.ts        # Node 启动时恢复后台队列
├── proxy.ts                  # 单用户鉴权（Next 16 中 middleware 已更名为 proxy）
├── app/
│   ├── page.tsx              # 主页面
│   ├── login/page.tsx        # 登录页
│   └── api/
│       ├── login|logout/     # 密码登录 / 退出
│       ├── collections/      # Group / Session 创建、改名、解散
│       ├── library/          # 组织树快照与移动排序
│       ├── settings/         # 持久并发配置
│       ├── documents/        # 记录：新建入队、读取持久进度、改设置、删除
│       │   └── [id]/generation        # 启动、失败重试、停止任务
│       │   └── [id]/segments/[idx]/   # 编辑口述稿及兼容单段入队接口
│       │   └── [id]/audio/[idx]         # 读取已存音频
│       └── backup/route.ts   # 导出 / 导入 zip
├── components/
│   ├── Studio.tsx            # 总布局：历史栏 + 新建 / 阅读
│   ├── HistorySidebar.tsx    # 组织树、导出导入
│   ├── LibraryTree.tsx       # Group / Session / 任务拖拽
│   ├── SettingsDialog.tsx  # 统一设置界面（生成与并发、数据与备份）
│   ├── RuntimeSettingsPanel.tsx # 并发设置
│   ├── BackupSettings.tsx  # 备份导入与导出
│   ├── Reader.tsx            # 阅读 + 播放 + 编辑口述稿 + 进度轮询
│   └── SettingsBar.tsx       # 角色 / 模型 / 音色 / 标签设置
└── lib/
    ├── catalog.ts            # 讲述角色、TTS 模型能力表（音色/标签/协议）
    ├── config.ts             # 环境变量
    ├── auth.ts               # HMAC 签名 session
    ├── zenmux.ts             # ZenMux 客户端（chat / audio speech / models）
    ├── http.ts               # 错误响应
    ├── store/                # SQLite、任务与租约、记录读写、备份
    ├── generation/worker.ts  # 服务端调度、标签与 TTS 执行
    ├── audio/mp3.ts          # PCM -> MP3（lamejs）
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

开发模式关闭 Turbopack 的跨重启文件系统缓存，重启后重新建立热更新状态；生产构建缓存不受影响。历史列表会区分正在加载、加载失败和空列表，更新失败时保留已显示的记录并提供重试。

## Cloudflare 部署评估（2026-10-10）

当前代码运行在拥有持久磁盘的 Node 服务上，尚未适配 Cloudflare。可以迁移到 Cloudflare，但不能把现有仓库原样部署为 Pages 静态站点：[Pages 的 Next.js 指南](https://developers.cloudflare.com/pages/framework-guides/nextjs/)将静态导出放在 Pages，完整应用指向 Workers。

建议的目标结构是 **Workers（页面和 API）+ D1（文档和分段）+ 私有 R2（音频）+ Cloudflare Access（仅本人访问）**。迁移时至少需要：

- 将 `node:sqlite` 改为 D1 或其他持久数据库接口；将本地音频读写和备份改为 R2。Workers 的 [`node:fs` 临时文件跨请求不持久](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)，不能沿用当前 `data/` 目录。
- 验证 Next.js 16.4 的框架适配。官方当前推荐 [vinext on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)，但仍处于 beta；本仓库的 `cacheComponents`、`partialPrefetching` 需要单独检查。[OpenNext](https://opennext.js.org/cloudflare)也是候选适配器，不能仅凭支持 Next.js 16 就认为所有配置与运行时已兼容。
- 后台执行器当前依赖常驻 Node 进程，不能把内存定时器直接搬到请求结束后可能休眠的运行时。迁移时需要托管持久队列/工作流接管执行，并保留状态、重试与幂等写入。
- 在 Workers 运行时测试 MP3 编码的 CPU/内存开销和备份大小；本地 Node 构建成功不等于 Workers 部署验证通过。

只供本人访问时，保留应用现有密码登录，并按以下方式保护发布入口：

- 在该 Worker 的 Access 页选择 **All traffic**，保护生产和预览。Worker 级策略会覆盖其自定义域名、routes、`workers.dev` 与预览入口；如果只使用域名级策略，则需要单独保护或关闭其他入口。见 [Worker 级 Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-one-worker)。
- Allow 规则只填写自己的完整邮箱，通过[邮箱一次性验证码](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)或自己的身份提供商登录；不要放行整个邮箱域名或所有用户。
- 保护整个应用，包括模型调用 API、音频和备份。若拆分为 Pages 前端，也需保护生产 `pages.dev`、自定义域及预览，避免旁路。
- ZenMux 密钥和会话密钥放服务端 Secrets；R2 保持私有，音频通过鉴权 API 返回。

上述云端迁移与 Access 配置尚未执行。

## ZenMux 接入说明

所有接口都依据 ZenMux 官方文档（见下方“项目级 Skills”）编写，统一走 OpenAI 兼容入口 `https://zenmux.ai/api/v1`：

| 用途 | 接口 | 说明 |
|---|---|---|
| 口述稿 / 加标签 | `POST /chat/completions` | `response_format: json_schema` 结构化输出，模型由 `SCRIPT_MODEL` 指定 |
| 语音合成 | `POST /audio/speech` | 返回 JSON `{ audio: base64, mime_type: "audio/L16;rate=24000" }`，服务端把裸 PCM 编码成 MP3 |
| 核对模型 | `GET /models` | `pnpm zenmux:models` 列出可输出音频的模型 |

TTS 模型在 `src/lib/catalog.ts` 的 `TTS_MODELS` 中配置。ZenMux 文档只写了 Gemini，另外两个模型的用法来自厂商官方文档，并通过 ZenMux 实测验证（合成后再用 `qwen/qwen3-asr-flash` 转写回来比对）：

| 模型 | 音色 | 行内标签 | 角色语气 | 实测速度* |
|---|---|---|---|---|
| `google/gemini-3.1-flash-tts-preview` | 30 个预置音色 | `<short pause>` `<sigh>` 等尖括号写法，只表示某一时刻的声音或停顿 | 写一句英文风格前缀到输入里 | 慢（约 7~18s） |
| `qwen/qwen-audio-3.0-tts-plus` | `longanlingxin`、`longanlufeng` | `[sighing]` 等一次性标签，加 `[serious]` 等语气切换标签（作用于后续所有文字） | 不支持（`instructions` 实测无效，前缀会被丢掉） | 中（约 4~14s） |
| `x-ai/grok-voice-tts-1.0` | `ara` `eve` `leo` `rex` `sal` `una` | `[pause]` `[laugh]` 等方括号写法，不认识的标签会被静默忽略 | 不支持（前缀会被念出来） | 快（约 2~4s） |

\* 一段 100~200 字中文的合成时间。另外：

- 三个模型都返回 24kHz 单声道 PCM，服务端统一编码成 MP3 保存。
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

- 句子级高亮（利用 TTS 时间戳或按句切分）
- 键盘快捷键
- ZenMux 上线新 TTS 模型（如 Gemini 3.8 TTS）后加入 `catalog.ts`
- `/audio/speech` 的 `stream: true`，边合成边播放，减少等待
