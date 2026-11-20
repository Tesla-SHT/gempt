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

核心分工：**Human ↔ Gemini，Gemini lead GPT（按领域分工 + 甜点思考强度）**。
- **Gemini 主理人类协同与视觉/前端/多模态**：在 Antigravity 走官方原路（外部客户端经 Magpie 走 `antigravity/gemini-4-*`）；直接承担需求沟通、方案拆解、前端/UI 审美实现、多模态看图读 PDF、最终 Diff/测试验收与人话翻译；棘手 UI 状态可用 `gempt_consult` 找 GPT 交叉复核。
- **GPT/Codex 专攻后端与硬核推理**（经本地 Magpie 网关）：承接后端复杂工程、核心算法/数学推导、深层根因排查，以及**独立 Review** Gemini 或其他分支产出的 Diff（禁止自写自审）；人类不必直接啃 `GPT-6.2-Astra` 技术长文或手写冗长提示词。

---

## 1. Initial Setup Wizard（首次使用或用户要求调整配置时）

当 `~/.config/gempt/config.json` 尚未初始化，或用户说“初始化 gempt / 配一下 gempt / 换模型或容灾策略”时，优先推荐无门槛的 **Codex 订阅直连（`subscription_only`）**，并在当前分支支持按需开启个人 **API 兜底（`api_fallback`）**：

1. **最简一键开启**：如果用户已经打开 Magpie 客户端的 **`Plugins → GemPT`** 页面，只要 Magpie 里已登录 ChatGPT/Codex 订阅，页面会自动检测到 `codex/*` 模型，直接点 **“一键启用订阅配置”** 即可完成初始化；后续也可在页面里一键切换 `仅订阅 | API 兜底` 与 `Codex 执行权限`。
2. **命令行 / 对话内探测与初始化**：调用 `gempt_discover`（不要让用户手工翻配置文件路径或模型 ID）。
   - 检查输出里的 `magpie.gateway.reachable`、`subscription_ready`、`codex_subscription_models`、`openai_api_models`、`utility_candidates`、`codex` CLI 与 `recommendations`。
   - 如果 `magpie.gateway.reachable` 为 `false`，提示用户先启动本地 Magpie（默认 `127.0.0.1:3425`）。
3. **确认三档甜点映射与容灾策略**：
   - `sonnet`（~75% 日常高频）：`Sol @ medium`（`codex/gpt-6.2-sol`，`medium`）
   - `opus`（~20% 复杂工程）：`Sol @ high` 主力 + 疑难 `@ xhigh` 自动升 `Astra`（`codex/gpt-6.2-sol` → `codex/gpt-6.2-astra`）
   - `fable`（~5% 顶配攻坚）：`Astra @ xhigh`（`codex/gpt-6.2-astra`，`xhigh`；**禁止把 Astra 降到 `low`**）
   - **免费打杂 / 压缩通道（`utility`）**：从 `utility_candidates` 推荐免费高速模型（如 `auto/deepseek-v4.1-flash`），用于 `tier="chore"` 与 Magpie `compact` 规则。
   - **容灾策略（`failover_mode`）**：
     1. `subscription_only`（推荐默认）：仅用 Codex 订阅号（不自动切按量 API，防意外扣费）；多订阅号由 Magpie 自动轮转。
     2. `api_fallback`：订阅优先，限流或失败时自动切换按量 `openai/*` API 兜底（页面支持随时无损切换）。
     3. `effort_only`：单模型 `Sol` 仅靠 `reasoning_effort`（`medium` / `high` / `xhigh`）区分三档（不降级使用 `Astra@low`）。
   - **思考定档策略**：可选开启 `auto_effort`（页面点选 **`智能`** 或 CLI 设 `gempt effort auto`）。
   - **可选：同步独立隔离路由组**：默认直接调用具体 GPT 模型 ID 即可工作。仅当用户需要在 Magpie 侧使用多号轮转、`effort=xhigh` 自动切 Astra 或 `compact` 规则时，才开启 `sync_magpie_groups: true` 与 `use_magpie_group_ids: true`。
   - **默认 Codex 沙箱（`default_sandbox`）**：推荐 `workspace-write`（只在目标工作区可写），可在 Magpie `Plugins → GemPT` 页面随手切换 `只读 / 工作区 / 全权限`。
4. **落盘并验收**：
   - 调用 `gempt_configure` 保存配置，调用 `gempt_status` 验证生效；必要时用 `gempt_consult(tier="chore", goal="Reply with OK")` 或 `sonnet` 跑一次极短连通性测试后汇报。

---

## 2. Mode & 3+1 Tier Decision Matrix（选模式与选档位）

### 模式选择：`gempt_consult` vs `gempt_exec`

| 模式 | 底层机制 | 固定开销 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **`gempt_consult`** | 直连 Magpie HTTP (`/v1/responses` 或 `/v1/chat/completions`) | 极低（无 Codex 工具注入） | 架构评审、算法/数学推导、定位复杂 bug 根因、对指定文件做深度 code review、免费摘要/分类 |
| **`gempt_exec`** | 调本机 `codex exec`（经 Magpie 路由） | 较高（每次约 18K–50K tok 工具上下文） | 跨文件改代码、重构、需要 GPT 自己跑测试并修到通过的完整任务 |

**经验法则**：能用 `gempt_consult` 先把方案/根因审透，就不要一上来就开 `gempt_exec` 盲跑。

### 档位甜点、占比与思考强度纪律

| 档位 / 快捷命令 | 推荐占比 | 默认甜点模型 × 强度 | 典型场景与升档约束 |
| :--- | :--- | :--- | :--- |
| **`chore`** (`/gempt-chore`) | 旁路打杂 | `DeepSeek-V4.1-Flash` | 日志提纯、大文本摘要、粗分类（仅限 `gempt_consult`） |
| **`sonnet`** (`/gempt-sonnet`) | **~75%** | `Sol @ medium` | 日常实现、单测、UI 交互逻辑与常规审阅 |
| **`opus`** (`/gempt-opus`) | **~20%** | `Sol @ high` | 跨文件重构、大仓库排查、复杂设计；`escalate=true` 或 `xhigh` 自动升 `Astra` |
| **`fable`** (`/gempt-fable`) | **~5%** | `Astra @ xhigh` | 极难 Bug、数学/算法推导、核心架构；禁止降级 `Astra` 到 `low` |

- **思考强度纪律（防踩坑）**：
  1. **新线程开局定好强度，严禁中途 `resume` 加码**：开启 `auto_effort`（页面「智能」）时，首轮按任务风险在 `low..xhigh` 间确定；`resume` 续跑强制锁定原强度（规避 Codex 中途改 effort 导致实际推理缩水的问题）。
  2. **失败升级必开新线程（不传 `session_id`）**：首轮失败、超时或未验证通过，用 `opus`/`escalate=true`/`fable` 另起新线程，而不是在同一 `session_id` 上加档硬磨。
  3. **禁用 `ultra` 与高强度子代理扇出**：默认配置与自动定档最高止步 `xhigh`，禁止并行扇出多个高思考 Codex 子代理以免配额雪崩。
  4. **匹配思考超时下限**：未显式指定超时时，`high` 自动保护至少 `900s`（exec）/ `240s`（consult），`xhigh` 至少 `1200s` / `300s`。

> **控制面板与单回合快捷命令**：保持 Antigravity 原生 Gemini 官方登录不变，在 **Magpie 左侧栏 `Plugins → GemPT`**（或终端 `gempt tier` / `gempt sandbox` / `gempt effort [medium|high|xhigh|auto]`）统一切换共享默认档位、沙箱与思考强度；`/gempt-sonnet`、`/gempt-opus`、`/gempt-fable`、`/gempt-chore` 可单回合锁定档位。

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
