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
