<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## ZenMux（项目级 skills）

本项目通过 ZenMux 调用所有远程模型。官方 skills 安装在 `.agents/skills/`（`skills-lock.json` 记录来源，用 `npx skills update -p` 更新）：

- `zenmux-context`：查官方文档。先运行 `bash .agents/skills/zenmux-context/scripts/update-references.sh` 拉取/更新文档，再到 `.agents/skills/zenmux-context/references/zenmux-doc/docs_source/zh/` 查阅。
- `zenmux-setup` / `zenmux-usage` / `zenmux-feedback`：接入配置、用量查询、反馈。

修改 `src/lib/zenmux.ts` 或 `src/lib/catalog.ts` 之前，先查阅对应文档：
- `api/openai/create-chat-completion.md`、`guide/advanced/structured-output.md`
- `api/openai/create-audio-speech.md`（返回 JSON + base64，默认裸 PCM 24kHz）
- `guide/advanced/error-codes.md`

## 测试工作区与清理

- 集成测试、生产构建检查和临时浏览器验证统一使用 `scripts/qa-workspace.mjs` 的 `createQaWorkspace` / `prepareQaSource`，放在系统临时目录的 `voicepage-tests/workspaces/`。不要在用户主目录或正式仓库旁创建新的 `voicepage-*` 测试副本。
- 只复制源码和必要配置，不复制 `.env*` 或真实 `data/`；所有模型调用使用本地 mock，测试数据放在独立工作区。
- 测试结束先关闭自己启动的进程、端口和数据库，再显式调用 `finish({ success, error, logs })`，或共享 fixture 的 `close({ success, error })`。成功自动删除工作区；失败只保留有界诊断日志，不能留下源码、构建缓存、测试数据库或音频。
- 清理只针对当前创建且验证身份的工作区，不能跟随依赖软链接删除正式仓库内容，也不能用宽泛的 `voicepage-*` 通配符删除其它目录。
