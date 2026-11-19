---
name: gempt
description: >-
  Orchestrate GPT/Codex models and free utility models from Gemini via local Magpie
  3-tier routing (sonnet/opus/fable + chore) in Human-to-Gemini / Gemini-leads-GPT mode.
  Use whenever initializing or configuring gempt (for Antigravity native Gemini or Magpie-routed
  Gemini clients), deciding whether to delegate reasoning or coding to GPT/Codex through Magpie,
  drafting structured Gemini-to-GPT task packets, steering multi-turn GPT/Codex sessions, or
  translating dense Astra/Sol outputs for the user.
---

# gempt — Gemini × GPT 协作编排手册

核心分工：**Human ↔ Gemini，Gemini lead GPT**。
- **Gemini 负责对接人类与主控**：在 Antigravity 客户端走原生官方通道，或在 Claude Code / ZCode 等外部客户端经 Magpie 走 `antigravity/gemini-4-*` 额度；负责聊需求、写任务单、核验改动并翻译人话。
- **GPT/Codex 统一经本地 Magpie 网关调度**（GPT 支持反代）：承接硬核推理、算法推演、代码审查与工程执行；人类不必自己啃生涩的 `GPT-6.2-Astra` 技术长文，也不必自己写大段上下文喂给 GPT。

---

## 1. Initial Setup Wizard（首次使用或用户要求调整配置时）

当 `~/.config/gempt/config.json` 尚未初始化，或用户说“初始化 gempt / 配一下 gempt / 换模型或容灾策略”时：

1. **先自动探测**：调用 `gempt_discover`（不要让用户手工翻配置文件路径或模型 ID）。
   - 检查输出里的 `magpie.gateway.reachable`、`codex_subscription_models`、`openai_api_models`、`utility_candidates`、`routing_groups`、`native_gempt_groups`、`gempt_groups`、`codex` CLI 与 `recommendations`。
   - 如果 `magpie.gateway.reachable` 为 `false`，明确提示用户先启动本地 Magpie 网关（默认 `127.0.0.1:3425`）并确认已暴露 GPT/Codex 模型，再继续。
2. **向用户确认关键决策**（展示自动推荐的默认映射，让用户一键确认或微调）：
   - **三档 GPT 映射**：
     - `sonnet`（日常高频 80%）：推荐 `Sol` 系列（如 `codex/gpt-6.2-sol`，`medium`）
     - `opus`（复杂工程）：推荐常规 `Sol` + 疑难自动升级 `Astra`（如 `codex/gpt-6.2-sol` → `codex/gpt-6.2-astra`，`high`）
     - `fable`（顶配攻坚）：推荐 `Astra` 系列（如 `codex/gpt-6.2-astra`，`high`）
   - **免费打杂 / 压缩通道（`utility`）**：从 `utility_candidates` 推荐（如 `auto/deepseek-v4.1-flash`、`workbuddy/deepseek-v4.1-flash` 或其他已接入的免费快速模型），用于 `tier="chore"` 与 Magpie `compact` 规则。
   - **容灾策略（`failover_mode`）**：
     1. `subscription_only`（推荐默认）：仅用订阅号（不自动切按量 API，防意外扣费）；多号轮转/限流由 Magpie 订阅池承担。
     2. `api_fallback`：订阅失败时按顺序切到按量 `openai/*` API 兜底。
     3. `effort_only`：单模型仅靠 `reasoning_effort`（`low` / `medium` / `high`）区分三档。
   - **可选：同步独立隔离路由组**：默认直接调用具体 GPT 模型 ID 即可工作（不会改动根目录 `install.sh` / `gempt presets` 建的 `group/gempt-*`）。仅当用户需要在 Magpie 侧使用多号轮转、`effort=high` 自动切 Astra 或 `compact` 规则时，才询问是否开启 `sync_magpie_groups: true`（同步 `group/gempt-harness-sonnet`、`group/gempt-harness-opus`、`group/gempt-harness-fable`）并开启 `use_magpie_group_ids: true`。外部客户端如需一次性装好原生路由组或打印 MCP 配置，也可运行 `bash install.sh --apply`、`bash install.sh --print-mcp` 或 `gempt presets --apply`。
   - **默认 Codex 沙箱（`default_sandbox`）**：推荐 `workspace-write`（只在目标工作区可写），或按用户习惯选 `read-only` / `danger-full-access`。
3. **落盘并验收**：
   - 调用 `gempt_configure` 保存配置。
   - 调用 `gempt_status` 验证配置已生效；必要时用 `gempt_consult(tier="chore", goal="Reply with OK")` 或 `sonnet` 跑一次极短连通性测试，然后把结果汇总给用户。

---

## 2. Mode & 3+1 Tier Decision Matrix（选模式与选档位）

### 模式选择：`gempt_consult` vs `gempt_exec`

| 模式 | 底层机制 | 固定开销 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **`gempt_consult`** | 直连 Magpie HTTP (`/v1/responses` 或 `/v1/chat/completions`) | 极低（无 Codex 工具注入） | 架构评审、算法/数学推导、定位复杂 bug 根因、对指定文件做深度 code review、免费摘要/分类 |
| **`gempt_exec`** | 调本机 `codex exec`（经 Magpie 路由） | 较高（每次约 18K–50K tok 工具上下文） | 跨文件改代码、重构、需要 GPT 自己跑测试并修到通过的完整任务 |

**经验法则**：能用 `gempt_consult` 先把方案/根因审透，就不要一上来就开 `gempt_exec` 盲跑。

### 档位选择：3 主档 + 1 打杂档

| 档位 | 对标定位 | 典型场景 | 备注 |
| :--- | :--- | :--- | :--- |
| **`chore`** | 免费打杂/压缩/分类 | 日志提纯、大文本摘要、粗分类、格式整理 | 仅限 `gempt_consult`；走 `utility.model`（如 `DeepSeek-V4.1-Flash`） |
| **`sonnet`** | 日常高频（~80%） | 常规单/少文件实现、加小功能、改 UI、写脚本、常规审阅 | 默认档位 |
| **`opus`** | 复杂工程 | 跨文件重构、读大仓库、复杂逻辑设计与排查 | 常规用主模型；遇到硬骨头传 `escalate=true` 或 `reasoning_effort="high"` 自动升级到 `Astra` |
| **`fable`** | 顶配攻坚 | 极难 Bug、核心算法/数学推导、长程架构设计 | 直接上最强模型高推理深度；慎用 `ultra`，只在最难问题上手动指定 |

---

## 3. Gemini → GPT Task Packet Protocol（给 GPT 下任务单规范）

不要把用户的口语碎片直接转发给 GPT。每次调用 `gempt_consult` 或 `gempt_exec` 前，Gemini 必须自己先读清相关文件并整理成五要素：

1. **`goal`（唯一明确目标）**：一句话写清边界与完成定义（禁止“帮我看看顺便优化一下”）。
2. **`context` + `file_paths`（已核实事实）**：给出实际文件绝对/相对路径、相关符号名、已观察到的报错或限制。
3. **`constraints`（硬约束与红线）**：明确哪些文件/接口/行为**不准改**，禁止引入多余依赖或破坏既有协议。
4. **`verification`（可运行验收命令，用于 `exec`）**：给出明确命令（如 `pytest tests/test_x.py`），要求 GPT/Codex 跑完并贴实测结果。
5. **`expected_output` / `expected_report`（回报结构）**：要求按“结论 / 改动文件 / 实测证据 / 遗留风险”返回。

详细好坏示例见 [task-packet-examples.md](./references/task-packet-examples.md)，Magpie 路由组命令模板见 [magpie-routing.md](./references/magpie-routing.md)。

---

## 4. AI-to-AI Steering & Review Loop（内部纠偏闭环）

1. 收到 `gempt_consult` 或 `gempt_exec` 返回后，**先自己核验**：
   - 对 `exec` 任务，亲自查看实际文件改动或跑一遍关键测试，不要只信 GPT 的口头报告。
2. **发现漏项、逻辑漏洞或测试未过**：
   - 不要把半成品甩给人类；带着具体技术证据和返回的 `session_id` 继续追问/返工。
   - **硬上限**：同一子任务内部 AI-to-AI 拉扯不超过配置中的 `max_internal_rounds`（默认 3 轮）。超过上限仍未收敛，或出现需要产品/架构拍板的取舍、破坏性操作、渠道报错/额度耗尽，立即停下向人类汇报。

---

## 5. Human-Friendly Handoff（向人类翻译汇报）

向用户汇报时：
- **先给结论**（做成了什么 / 发现什么根因），用人话讲清影响。
- **附实测证据**（改了哪些文件、跑了什么命令、通过情况，以及本次使用了哪个 `tier` / 实际模型）。
- **隐藏或翻译生涩细节**：把 `Astra` 长篇底层推演浓缩成 2~5 条可操作要点；只有用户追问底层证明或需要做架构抉择时才展开细节。
