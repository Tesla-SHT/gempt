---
name: gempt
description: >-
  Orchestrate GPT/Codex from Antigravity via Gemini family pairings and a free utility channel.
  Use when configuring gempt, deciding whether to delegate reasoning or coding to GPT/Codex,
  drafting structured Gemini-to-GPT task packets, steering multi-turn GPT/Codex sessions, or
  translating dense Astra/Sol outputs for the user.
---

# gempt — Gemini × GPT 协作编排手册

GemPT v0.4.1 使用 Node.js（`>= 20.11.0`）。Antigravity 的 `gempt_gempt` MCP 提供 `gpt_run`、`gpt_ask`、`gpt_ctl`，按 Hydrogen、Neon、Carbon 家族配对 GPT/Codex。Magpie HTTP MCP 对应 `gempt_run`、`gempt_ask`、`gempt_ctl`。其他 Agent 可在模型栏直接选 `group/gempt-{sonnet,opus,fable}`。

> 启用本插件时，`rules/AGENTS.md` 会常驻生效；按 Magpie 面板的 5 档工作分工（0% / 15% / 35% / 60% / 80%）决定何时委派。

现成材料用 `gpt_ask`，需要查仓库或运行检查用 `gpt_run(access="inspect")`（仅允许 `workspace="inherit"`），获得写入授权后用 `gpt_run(access="change")`（多路并发改同一 Git 仓库时传 `workspace="share"`）。Swarm 成员把公开 brief 的角色和任务 ID 写进 `goal`。Gemini 核对返回的证据并向用户汇报。

---

## 1. Initial Setup Wizard（首次使用或用户要求调整配置时）

当 `~/.config/gempt/config.json` 尚未初始化，或用户说“初始化 gempt / 配一下 gempt / 换模型或容灾策略”时，优先推荐无门槛的 **Codex 订阅直连（`subscription_only`）**，并在当前版本支持按需开启个人 **API 兜底（`api_fallback`）**：

1. **最简一键开启**：确认已安装 Magpie（`>= 0.1.1340`）和 Magpie 侧 GemPT 插件并登录 ChatGPT/Codex 订阅后，在 Magpie 左侧栏打开 **`Plugins → GemPT`**，点击 **“一键启用订阅配置”** 即可完成初始化；后续也可在页面里一键切换 `仅订阅 | API 兜底` 与 `Codex 执行权限`。
2. **命令行探测**。运行 `gempt discover`，检查 `magpie.reachable`、`subscription`、`magpie.codex_models`、`magpie.openai_models`、`magpie.utility_candidates` 与 `codex` CLI。
   - 如果 `magpie.reachable` 为 `false`，先启动本地 Magpie（默认 `127.0.0.1:3425`）。
3. **在「MCP 编排」确认配对和容灾策略**。
   - Hydrogen、Neon、Carbon 默认配对 Terra、Sol、Astra。下拉可选其他 Codex 订阅模型，选择「默认模型」则使用 Magpie 探测到的默认订阅模型。
   - **免费打杂 / 压缩通道（`chore` / `utility`）**：从 `utility_candidates` 推荐免费高速模型（如 `auto/deepseek-v4.1-flash`），用于 `gpt_ask(tier="chore")` 与 Magpie `compact` 规则。
   - **容灾策略（`failover_mode`）**：
     1. `subscription_only`（推荐默认）：仅用 Codex 订阅号（不自动切按量 API，防意外扣费）；多订阅号由 Magpie 自动轮转。
     2. `api_fallback` 启用后，咨询遇到限流或可重试的网关错误时可使用匹配的按量 `openai/*` 模型。由 Magpie 路由组托管的执行按组内规则容灾。
   - **思考强度**可固定设置，也可在面板选 **智能** 启用 `auto_effort`。
   - **默认 Codex 沙箱（`default_sandbox`）**：推荐 `workspace-write`（只在目标工作区可写），并可通过环境变量 `GEMPT_WORKSPACE_ROOT` 限定可访问根目录。
4. **落盘并验收**：
   - 运行 `gempt init` 保存配置，再用 `gempt status` 验证。必要时调用 `gpt_ask(goal="Reply with OK")` 与一次只读 `gpt_run(access="inspect")` 做连通性验收。

---

## 2. 工具选择与思考强度

### 模式选择

| 模式 | 底层机制 | 固定开销 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **`gpt_ask`** | Magpie HTTP (`/v1/responses` 或 `/v1/chat/completions`) | 低 | 架构评审、算法推导、审阅指定文件、摘要或分类 |
| **`gpt_run`** | 本机共享 Codex app-server（由 Magpie GemPT 插件托管），经 Magpie 路由 | 较高 | 仓库调查、改代码、跑测试 |
| **`gpt_ctl`** | 现有任务状态和控制 | 低 | `status`、`steer`、`interrupt`、`reply`，或用 `{}` 打开 GemPT Live |

派单时按所需能力选 `access`。只读调查使用 `access="inspect"`（禁止配 `workspace="share"`）；多路并发写入同一 Git 仓库时使用 `access="change"` + `workspace="share"`（基于已提交 `HEAD` 检出，工作区未提交改动不会随行）。

### Gemini 配对与思考强度

调用 `gpt_ask` 或 `gpt_run` 时沿用当前 Gemini 家族。已知时可传 `gemini_family`。回执记录 `paired:<family>`、实际模型和思考强度。日志提纯、摘要与粗分类使用 `/gempt-chore`，由 `gpt_ask(tier="chore")` 调用高速模型。

- **思考强度纪律**：
  1. **新线程开局定好强度，严禁中途 `resume` 加码**：开启 `auto_effort`（页面「智能」）时，首轮按任务风险在 `low..xhigh` 间确定；`resume` 续跑锁定原强度。
  2. **失败升级必开新线程**：首轮失败、超时或未验证通过时，省略 `session_id` 重开线程。
  3. **禁用 `ultra` 与高强度子代理扇出**：默认配置与自动定档最高止步 `xhigh`，避免并发高思考导致配额雪崩。

固定强度保存在 `routing_policy.mcp_effort`。Astra 至少用 `medium`。在 `Plugins → GemPT → 路由组直连` 可为其他 Agent 预览、创建并复制直连组 ID。

---

## 3. Gemini → GPT Task Packet Protocol（给 GPT 下任务单规范）

调用工具时把已知背景、约束、验收命令和回报格式写进 `goal`。咨询时用 `file_paths` 附上要审阅的文件。执行时提供 `cwd` 与 `access`，并发改写同一 Git 仓库时用 `access="change"` + `workspace="share"`。

给出已核实的路径、符号和报错，明确哪些接口必须保留。执行任务可在目标中给出独立的测试命令，例如 `node --test tests/test_core_node.mjs`，并要求回报实际结果和剩余风险。

详细好坏示例见 [task-packet-examples.md](./references/task-packet-examples.md)，Magpie 路由组命令模板见 [magpie-routing.md](./references/magpie-routing.md)。

---

## 4. AI-to-AI Steering & Review Loop（内部纠偏闭环）

1. `gpt_run` 返回 `wait_command` 时，原样通过 `run_command(WaitMsBeforeAsync=500)` 后台等待唤醒。用 `gpt_ctl` 随时查看或介入，收到 `ask_gemini` 时用 `action="reply"` 原回合续跑。
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
