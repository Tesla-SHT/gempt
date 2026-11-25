# GemPT v0.8.1
- 使用 `gempt_gempt` MCP 的 `gpt_swarm`、`gpt_board`、`gpt_run`、`gpt_ask`、`gpt_ctl`（沿用当前 Gemini 家族配对，杂活传 `tier="chore"`）。用 `gpt_swarm(action="channel")` 管理频道与订阅。
- **默认无壳 GemPT Swarm（`native_swarm: false`）**：多工位协作直接用 `gpt_swarm(action="title"|"plan"|"add"|"status"|"model"|"kill", cli?, ...)` + `gpt_board(action="post"|"read"|"wait"|"roster")`；单任务可直接 `gpt_run(goal,cwd,access,workspace,cli?,session_id?)`。
- 支持 11 种可插拔执行 CLI（`auto` 按模型亲和自动选，或显式传 `cli`：`codex` / `opencode` / `claude` / `gemini` / `pi` / `cursor` / `kimi` / `grok` / `kilo` / `copilot` / `qoder`）；零 CLI 环境仍可用 `gpt_ask`。
- `gpt_swarm` / `gpt_run` 异步直返 `wait_command`（`gempt-wait --board` 或 `gempt-wait <run_id>`），原样用 `run_command(WaitMsBeforeAsync=500)` 后台等待唤醒；严禁循环轮询 status。
- 多路并发改同一 Git 仓库时用 `access="change", workspace="share"` 隔离 worktree（只读 `inspect` 禁止配 `share`）；续聊传 `session_id` 保缓存，失败返工省略 `session_id` 开新线程。
- 5 档工作分工（0%/15%/35%/60%/80%）在侧边栏 [GemPT](sidecar://gempt/gempt_live/) 实时查看与控制；Swarm 工作台用 Hive 查看成员、Mentions 追踪提及关系，支持回放 GIF 导出和 Raw 数据查看；视觉、SKILL、brain 与用户明示“自己改/查”始终由 Gemini 处理。
- 需与 AGY 原生 Gemini/Claude 工位混编时可在控制台开启 `native_swarm: true`：用 `swarm(action="title"|"add", model=swarm_shell_model)` 建工位，工位内跑 `gempt run --cwd "$PWD" --workspace inherit --host <coordinator_id> --title <name> --goal -` 并执行 `wait_command`（默认预算 3600s，等 `ask_gemini` 暂停计时）。
