# GemPT v2
- 唯一入口 `gempt_gempt` MCP（3 扁平工具）：`gpt_run(goal,cwd,access="change"|"inspect",workspace="inherit"|"share",session_id?)`、`gpt_ask(goal,file_paths?,cwd?,tier?,session_id?)`、`gpt_ctl(action="status"|"steer"|"interrupt"|"reply",run_id?,message?,call_id?)`。
- `gpt_run` 异步直返短命令 `gempt-wait <run_id>`（多单 `gempt-wait id1,id2`），立即用 `run_command(WaitMsBeforeAsync=500)` 后台等待唤醒；严禁循环轮询 status。
- 多路并发改同一仓库时 `gpt_run` 传 `workspace="share"` 隔离 git worktree；续聊传 `session_id` 保缓存；失败返工省略 `session_id` 开新线程。
- 5 档分流由 Magpie 面板控制（0% 关闭 / 30% 重活提示 / 50% 源码写转 GPT / 80% 源码写 + 每回合 5 步核实止损 / 95% 入口直派 + 2 步核实）；视觉、SKILL、brain 与用户明示“自己改/查”始终由 Gemini 处理。
- 侧边栏 **GemPT Live**（`gpt_ctl({})`）零额度实时看流与介入；纯 95% 编码工作区优先直接使用 Codex CLI / `codex-lab`。
