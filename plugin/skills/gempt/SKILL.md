---
name: gempt
description: >-
  Orchestrate GPT/Codex from Antigravity via Gemini family pairings and a free utility channel.
  Use when configuring gempt, deciding whether to delegate reasoning or coding to GPT/Codex,
  drafting structured Gemini-to-GPT task packets, steering multi-turn GPT/Codex sessions, or
  translating dense Astra/Sol outputs for the user.
---

# gempt — Gemini × GPT 协作编排手册

GemPT v0.10.1 使用 Node.js（`>= 22.13.0`）。Antigravity 的 `gempt_gempt` MCP 提供 `gpt_swarm`、`gpt_board`、`gpt_run`、`gpt_ask`、`gpt_ctl`，支持 11 种可插拔执行 CLI（`codex` / `opencode` / `claude` / `gemini` / `pi` / `cursor` / `kimi` / `grok` / `kilo` / `copilot` / `qoder`）以及按 Hydrogen、Neon、Carbon 家族配对 Magpie 模型。

> 启用本插件时，`rules/AGENTS.md` 会常驻生效；按 Magpie 面板的 5 档工作分工（0% / 15% / 35% / 60% / 80%）决定何时委派。

现成材料用 `gpt_ask`。需要查仓库、运行检查或修改代码时，**默认采用无壳 GemPT Swarm（`gpt_swarm` + `gpt_board`）** 或单任务 `gpt_run` 执行。只读任务用 `access="inspect"`，多路并发写入用 `workspace="share"` 自动隔离 git worktree。Gemini 核对返回的证据并向用户汇报。

---

## 1. 首次配置

运行 `gempt discover` 检查 Magpie 网关、可用模型和执行 CLI，再用 `gempt init` 保存配置、`gempt status` 验证。在 Magpie 的 **Plugins → GemPT → 概览** 中设置工作分工、模型配对、思考强度与执行权限；连接与高级设置可测试网关并设置超时。

## 2. 工具选择与思考强度

### 模式选择

| 模式 | 底层机制 | 固定开销 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **`gpt_ask`** | Magpie HTTP (`/v1/responses` 或 `/v1/chat/completions`) | 低 | 架构评审、算法推导、审阅指定文件、摘要或分类 |
| **`gpt_run`** | 本机共享 Codex app-server（由 Magpie GemPT 插件托管），经 Magpie 路由 | 较高 | 仓库调查、改代码、跑测试 |
| **`gpt_ctl`** | 现有任务状态和控制 | 低 | `status`、`steer`、`interrupt`、`reply`。侧边栏打开 [GemPT](sidecar://gempt/gempt_live/) 看流与介入 |

派单时按所需能力选 `access`。只读调查使用 `access="inspect"`（禁止配 `workspace="share"`）；多路并发写入同一 Git 仓库时使用 `access="change"` + `workspace="share"`（基于已提交 `HEAD` 检出，工作区未提交改动不会随行）。

### Gemini 配对与思考强度

调用 `gpt_ask` 或 `gpt_run` 时沿用当前 Gemini 家族。已知时可传 `gemini_family`。回执记录 `paired:<family>`、实际模型和思考强度。日志提纯、摘要与粗分类使用 `/gempt-chore`，由 `gpt_ask(tier="chore")` 调用高速模型。

- **思考强度纪律**：
  1. **新线程开局定好强度，严禁中途 `resume` 加码**：开启 `auto_effort`（页面「智能」）时，首轮按任务风险在 `low..xhigh` 间确定；`resume` 续跑锁定原强度。
  2. **失败升级必开新线程**：首轮失败、超时或未验证通过时，省略 `session_id` 重开线程。
  3. **禁用 `ultra` 与高强度子代理扇出**：默认配置与自动定档最高止步 `xhigh`，避免并发高思考导致配额雪崩。

固定强度保存在 `routing_policy.mcp_effort`。Astra 至少用 `medium`。

---

## 3. Gemini → GPT Task Packet Protocol（给 GPT 下任务单规范）

调用工具时把已知背景、约束、验收命令和回报格式写进 `goal`。咨询时用 `file_paths` 附上要审阅的文件。执行时提供 `cwd` 与 `access`，并发改写同一 Git 仓库时用 `access="change"` + `workspace="share"`。

给出已核实的路径、符号和报错，明确哪些接口必须保留。执行任务可在目标中给出独立的测试命令，例如 `node --test tests/test_core_node.mjs`，并要求回报实际结果和剩余风险。

详细好坏示例见 [task-packet-examples.md](./references/task-packet-examples.md)。

---

### 会话 Swarm

普通对话中的 `gpt_run` 和 `gpt_swarm` 共用当前会话的工作台。单工位显示任务卡；增加工位、收到消息或需要回复时自动展开。

- 用 `gpt_swarm(action="title"|"plan"|"add"|"status"|"model"|"kill", cli?, ...)` 规划与拉起多 CLI 工位（不消耗 AGY 原生外壳 token），并行写入用 `workspace="share"` 自动创建 worktree。
- 用 `gpt_board(action="post"|"read"|"wait"|"roster")` 在共享 SQLite 消息板上协同与自动唤醒。通过 `run_command(WaitMsBeforeAsync=500, NotificationTimeoutSeconds=180)` 执行返回的 `gempt-wait --board <swarm_id>`。
- 可通过 `cli` 参数或控制台 `execution.default_cli` 选择 `auto`（按模型亲和匹配已安装 CLI）或任意 11 种受支持 CLI。
- **角色工位（按需启用）**：
  - `role="monitor"`（如 `gpt_swarm(action="add", name="monitor", role="monitor", brief="watch stalls")`）：零 LLM 进程，由守护循环每 3 分钟及发帖后巡检停摆并在消息板 `@target [stall]` 提醒唤醒。
  - `role="narrator"`（如 `gpt_swarm(action="add", name="narrator", role="narrator", brief="maintain overview")`）：只读工位，监听消息板并调用 `board_publish_view` 持续更新侧栏 Overview 卡片。
- **消息板与模式边界**：
  - 仅显式 `gpt_swarm` 工位接入 GemPT SQLite 消息板并支持 `@mention` 自动唤醒（`codex` / `claude` / `opencode` 注入完整板工具，其余 CLI 经 shell 调 `gempt board post/read/wait/ask/roster/swarm/publish-view`）；单任务 `gpt_run` 不发板帖。
  - 原生 AGY `/swarm`（`board.jsonl`）与 GemPT（`swarm.sqlite`）各自独立、不跨侧唤醒，侧栏混合视图为只读投影。
- **提示词缓存纪律（对齐原生 Swarm）**：
  - **热上下文分叉**：新工位需继承某成员已读代码与推理时传 `fork="<member>"`（同 CLI/模型下 Codex 走原生 `thread/fork`、Claude 走 `--resume --fork-session`，其余场景自动回退板贴摘要）。
  - 多 worktree 编辑时，先让短只读 `scout` 在 `workspace="inherit"` 勘查，再用 `fork="scout"` 派出 `access="change", workspace="share"` 的原生分叉。实测缓存命中约 98%，独立 worktree 冷启约 80%。父线程超过 120k token 时，优先写简短交接再分工。
  - **同批同模型与共享前缀**：同批 `n` 副本或 `tasks` 分片默认沿用同一配对模型、把公共上下文写进共享 `brief`（引擎会自动把静态协议与共享 `brief` 前置、把工位身份与个人切片后置）；仅配额耗尽或用户指定时用 `action="model"` 原地切换。
  - **克制唤醒与引用**：`@name` 是唤醒门铃而非 CC（点对点交接勿顺手 `@coordinator`），旧帖一律用 `#seq` 引用勿复制粘贴；多领域并行时用 `action="channel"` 分区保持 `main` 安静。
  - **`gpt_ask` 文件前缀复用**：同一批 `file_paths` 会前置到 `Goal` 之前（Responses 路径附带确定性 `prompt_cache_key`），多次审阅同一组文件时保持 `file_paths` 集合稳定可提高前缀命中率。

手动使用 AGY `/swarm` 时，工位沿用相同工作分工。在工位中执行 `gempt run --cwd "$PWD" --workspace inherit --host <coordinator_id> --title <name> --goal -`，随后运行返回的 `wait_command`。

## 4. AI-to-AI Steering & Review Loop（内部纠偏闭环）

1. `gpt_run` 或 `gpt_swarm` 返回 `wait_command` 时，原样通过 `run_command(WaitMsBeforeAsync=500, NotificationTimeoutSeconds=180)` 后台等待唤醒。等待心跳在 stderr，stdout 返回 JSON。等待结果给出 `reply_command` 时，替换 `<answer>` 并执行，再运行等待命令。工具回复可用 `gempt reply-tool RUN_ID CALL_ID "答复"`、`gempt reply-tool RUN_ID CALL_ID --text "答复"`（`--message` 同义），或用 `-` 从 stdin 读取原文。只有一个待回复工具调用时可省略 `CALL_ID`，使用 `gempt reply-tool RUN_ID --text "答复"`。也可用 `gpt_ctl` 的 `action="reply"` 接续原回合。
   - 核对实际文件、命令和结果。证据不足时安排有针对性的独立复核。
2. **发现漏项、逻辑漏洞或测试未过**：
   - 不要把半成品甩给人类；带着具体技术证据和返回的 `session_id` 继续追问/返工。
   - **硬上限**：同一子任务内部 AI-to-AI 拉扯不超过配置中的 `max_internal_rounds`（默认 3 轮）。超过上限仍未收敛，或出现需要产品/架构拍板的取舍、破坏性操作、渠道报错/额度耗尽，立即停下向人类汇报。

---

## 5. Human-Friendly Handoff（向人类翻译汇报）

向用户汇报时：
- **先给结论**（做成了什么 / 发现什么根因），用人话讲清影响。
- **附实测证据**（改了哪些文件、跑了什么命令、通过情况，以及本次使用了哪个 `tier` / 实际模型）。
- **隐藏或翻译生涩细节**：把长篇底层推演浓缩成 2~5 条可操作要点；只有用户追问底层证明或需要做架构抉择时才展开细节。
