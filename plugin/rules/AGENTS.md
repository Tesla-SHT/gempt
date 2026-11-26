# GemPT v0.10.1
- 使用 `gempt_gempt` MCP 的 `gpt_swarm`、`gpt_board`、`gpt_run`、`gpt_ask`、`gpt_ctl`（沿用当前 Gemini 家族配对，杂活传 `tier="chore"`）。用 `gpt_swarm(action="channel")` 管理频道与订阅。
- 单任务用 `gpt_run`，多工位用 `gpt_swarm`，两者共用当前会话的工作台。用 `gpt_board` 发帖交接。审阅已知文件可直接用 `gpt_ask(file_paths)`。
- 支持 11 种可插拔执行 CLI（`auto` 按模型亲和自动选，或显式传 `cli`：`codex` / `opencode` / `claude` / `gemini` / `pi` / `cursor` / `kimi` / `grok` / `kilo` / `copilot` / `qoder`）；零 CLI 环境仍可用 `gpt_ask`。
- `gpt_swarm` / `gpt_run` 异步直返 `wait_command`（`gempt-wait --board` 或 `gempt-wait <run_id>`），原样用 `run_command(WaitMsBeforeAsync=500, NotificationTimeoutSeconds=180)` 后台等待唤醒。等待进度写入 stderr，结果从 stdout 读取。
- 多 worktree 写入先让短只读 `scout` 用 `access="inspect", workspace="inherit"` 勘查，再用同 CLI、同模型的 `fork="scout", access="change", workspace="share"` 原生分叉。实测缓存命中约 98%，独立冷启约 80%。父线程超过 120k token 时优先摘要交接。续聊传 `session_id`，失败返工开新线程；`@name` 用于唤醒，旧帖用 `#seq` 引用。
- 普通聊天与手动 `/swarm` 共用侧栏的工作分工设置。用户明示“自己改/查”时由 Gemini 处理。
- 手动 AGY `/swarm` 工位可运行 `gempt run --cwd "$PWD" --workspace inherit --host <coordinator_id> --title <name> --goal -`，再执行返回的 `wait_command`。等待结果给出 `reply_command` 时，替换 `<answer>` 并执行，再继续等待。工具回复可用 `gempt reply-tool RUN_ID CALL_ID "答复"` 或 `gempt reply-tool RUN_ID CALL_ID --text "答复"`（也可用 `--message`）。用 `-` 从 stdin 读取答复。只有一个待回复工具调用时可用 `gempt reply-tool RUN_ID --text "答复"`。
