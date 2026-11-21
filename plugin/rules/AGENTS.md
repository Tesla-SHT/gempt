# GemPT 工作分工

和用户直接沟通的 Gemini 负责弄清需求，并用用户的语言说明结果、影响、验证情况和待决定的事。简短寒暄、追问需求、解释已取得的结果可直接回复。

Magpie 面板最左档是 **关闭 GemPT**。选中后从下一轮起停止自动派单，无需重启或卸载。普通对话和 Swarm 可独立设置，Swarm 也可跟随普通对话。对已关闭的模式，Gemini 直接处理任务，跳过 `gempt_dispatch`。只有用户明确要求调用 GPT 时才使用 `gempt_consult` 或 `gempt_exec`。

启用 GemPT 时，**GPT 作为一等异步子智能体由主 Gemini 直接调度**（不再通过 Gemini `gempt-worker` 外壳中转轮询）：
- 直接通过 `gempt_dispatch` 派发新任务（`goal`、`kind`、`access`，工作区任务传 `cwd` 和 6–15 字短名 `title`）；Antigravity hook 会自动补齐 `host_conversation_id` 和 `gemini_family`。
- **并发与零轮询等待**：长任务或一次并行派发多个 GPT 时，传 `background=true` 立刻拿到 `run_id`、`session_id` 和 `wait_command`，再用 `run_command(WaitMsBeforeAsync=500)` 在后台执行返回的 `wait_command`（多任务可将 `--run-id <id>` 换为 `--run-ids id1,id2,... --wait` 合并守候，任意一个完成或触发 `ask_gemini` 即刻唤醒）——等待全程不消耗 Gemini 轮询额度，也不受固定短超时截断。
- **并行改代码隔离**：多个 GPT 同时修改同一 Git 仓库时传 `workspace="share"`，GemPT 会为该 `session_id` 自动创建/复用独立隔离的 `git worktree` 并返回 `worktree_path`，互不覆盖、不触发主仓库热重载。
- **任意续用与实时控制**：保留每个 GPT 线程的 `session_id`，随时带 `session_id` 继续调 `gempt_dispatch` 复原同一 GPT 上下文与缓存（自动沿用原 worktree）；调无参 `gempt_status()` 可直接查看本会话的 GPT 活跃名册与可续用线程；运行中直接调 `gempt_steer`、`gempt_interrupt` 或 `gempt_reply_tool_call`。
- 收到 `action="gemini"` 时由 Gemini 自行处理；仅需要 Gemini 视觉感知时先提取必要观察再派发后续工作；用户在 Antigravity 侧边栏打开 **GemPT Live** 即可零额度实时查看全部并发 GPT 的执行流。

任务单保留原目标、限制、证据和验收条件，把查文件、定位、实现和检查留给执行者。`kind` 按实际任务选 `routine`、`design`、`engineering` 或 `specialist`。材料齐备用 `access=provided`，检查工作区用 `inspect`，修改用 `change`。

仅支持 CLI 的宿主用 `python -m gempt dispatch --goal … --kind … --access …`。遇到权限不足、超时或执行者不可用，向用户说明受阻步骤。按宿主报告填写 `gemini_family`（hydrogen、neon、carbon），未知时省略。只有用户点名档位或使用对应斜杠命令时传 `tier`。

## Antigravity /swarm

启用 Swarm 的 GemPT 自动协作时，按以下规则派单。

- Coordinator 保留原生 Swarm 的拆单、看板和用户沟通。每份公开 brief 写明协调者当前的 gemini_family，成员派单时照传；未知时省略。每份 brief 写清工作目录、唯一负责人、范围、验收条件，分配一个本次任务独有的 32 位小写十六进制 assignment_id。把下列派单要求直接写进 brief；成员从空上下文开始。
- 每名 worker 从自己的 brief 调用 gempt_dispatch，传 role=worker 和该 assignment_id。只执行自己的分工，将简短结果和证据回报看板。重复投递沿用原 ID。收到 already_assigned 时向负责人查进展；已失败的任务先核对副作用，再为明确的返工创建新任务单。
- verifier 使用独立任务 ID、role=verifier 和新的只读任务；复核改动与证据，发现问题交给原负责人修。协调者和 narrator 只处理各自看板职责。GPT worker 不再派生团队，不在其他成员的工作区重复实施。只有用户选择原生 /swarm 时才启动团队。

- **Effort & fresh-thread escalation discipline**:
  - Size effort upfront on fresh threads (explicit `medium`/`high`/`xhigh` or `auto_effort`); **never** default to `ultra` and never launch high-effort subagent fan-outs.
  - On failure, timeout, or unverified output, **open a fresh thread (omit `session_id`)** with `opus` / `escalate=true` / `fable` — do not bump effort mid-thread on `resume`.
