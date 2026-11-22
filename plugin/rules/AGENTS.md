# GemPT v0.3
- 唯一入口 `gempt_gempt` MCP（3 扁平工具）：`gpt_run(goal,cwd,access="change"|"inspect",workspace="inherit"|"share",session_id?)`、`gpt_ask(goal,file_paths?,cwd?,tier?,session_id?)`、`gpt_ctl(action="status"|"steer"|"interrupt"|"reply",run_id?,message?,call_id?)`。
- `gpt_run` 异步直返 `wait_command`（如 `gempt-wait <run_id>` 或含绝对路径的后备命令），优先原样用 `run_command(WaitMsBeforeAsync=500)` 后台等待唤醒；严禁循环轮询 status。
- 多路并发改同一 Git 仓库时 `gpt_run(access="change", workspace="share")` 隔离 worktree（基于 `HEAD` 检出；只读 `access="inspect"` 禁止配 `workspace="share"`）；续聊传 `session_id` 保缓存；失败返工省略 `session_id` 开新线程。
- Magpie 面板提供 5 档工作分工（0% 关闭 / 15% 重活提示 / 35% 源码写转 GPT / 60% 源码写 + 每回合 5 步核实止损 / 80% 入口直派 + 2 步核实）；80% 档计入 Gemini 前端编排约 15–20% 的占比下限。视觉、SKILL、brain 与用户明示“自己改/查”始终由 Gemini 处理。
- 侧边栏 **GemPT Live**（`gpt_ctl({})`）零额度实时看流与介入。纯编码工作区优先直接使用 Codex CLI。
