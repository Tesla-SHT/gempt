# GemPT

一套围绕 **Human ↔ Gemini，Gemini lead GPT** 模式的可共享、可审查 Magpie 原生 **`tools + page` 插件** 与编排方案：人类只和 Gemini 对话与拍板，Gemini 负责规划、拆单与验收，GPT/Codex（统一经本地 Magpie 网关调度，纯订阅即可使用）负责硬核推理与工程执行，DeepSeek Flash 负责意图分类、打杂摘要与上下文压缩。

## 1 分钟上手（任意 Magpie 客户端）

先在 Magpie 登录 ChatGPT/Codex（及可选 Gemini）订阅账号，然后一条命令安装本插件：

```sh
magpie plugin add github:Tesla-SHT/gempt#yizhang-dream/api-fallback
```

装完后即可在 Magpie 左侧 **`Plugins → GemPT`** 打开控制面板，按需选择以下任一方式（两者可随时共用）：

- **方案 A（零规则懒人直连 · 最快上手）**：
  1. 在 `Plugins → GemPT` 右上角切换到 **`路由组直连`** → 点击 **`一键创建直连路由组`**；
  2. 在任意接入 Magpie 的客户端（Claude Code / ZCode / Codex CLI / OpenCode / Cursor 等）模型栏直接选用 `group/gempt-sonnet`、`group/gempt-opus` 或 `group/gempt-fable`；
  3. 聊设计时默认走首顺位 **Gemini**，明确派发写代码/修 Bug 时 Magpie 按回合意图与 `when=subagent` 自动分流到 **Terra / Sol / Astra**，压缩整理自动走 **DeepSeek Flash**。

- **方案 B（全客户端内置 MCP 编排 · 完整主从协作）**：
  1. **免手动装 Python / 免粘 MCP JSON**：安装插件后，Magpie 会自动向已接入客户端分发内置 HTTP 工具 `gempt_dispatch`、`gempt_consult`、`gempt_exec`、`gempt_discover`、`gempt_status`（`http://127.0.0.1:3425/mcp/magpie/tools/gempt`），无需先跑 `init` 即可零配置使用 Codex 订阅直连；
  2. **开启代码执行权（安全默认关闭）**：参照 `@magpie-community/tools-layerfs` 安全规范，`gempt_exec` 默认关闭；需要允许 Codex 改动工作区代码时，在 Magpie 插件选项中把 `exec` 设为 `true`：
     ```sh
     magpie plugin options gempt '{"exec":true}'
     ```
  3. 在页面点 **`复制协作规则`**，粘贴到常用客户端的全局指令（如 `CLAUDE.md`、`AGENTS.md` 或 ZCode / Cursor 规则）并保持主模型为 Gemini 即可。

## 1 分钟安装 Antigravity 插件

Windows、macOS 和 Linux 都可以用 [uv](https://docs.astral.sh/uv/getting-started/installation/) 安装，无需提前克隆仓库：

```sh
uvx --from git+https://github.com/Tesla-SHT/gempt.git@yizhang-dream/api-fallback gempt install-agy
```

用 pip 安装时，在 wheel 所在目录运行 `python -m pip install ./gempt-0.1.0-py3-none-any.whl`，再运行 `gempt install-agy`。如果已下载分支源码，在源码目录运行对应的脚本。

- Windows PowerShell 运行 `.\install.ps1`。如果本机执行策略阻止脚本，运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`。
- macOS / Linux 运行 `bash install.sh`。

安装目录为 `~/.gemini/config/plugins/gempt/`。安装器先启动暂存的 MCP 和 hook 做检查，然后更新插件目录。若 Windows 报插件目录正在使用，退出 Antigravity 后重新运行安装器。重新打开或重载插件，在 Antigravity 中运行 `/gempt` 初始化。GPT 调用仍需本机 Magpie 及可用的 Codex 订阅模型。

### MCP 接入方式

- **Magpie HTTP MCP** 由 Magpie 托管，自动分发给接入的客户端。默认地址为 `http://127.0.0.1:3425/mcp/magpie/tools/gempt`，这一入口无需 Python。
- **独立 Python stdio MCP** 由 Antigravity 或其他支持 stdio 的 MCP 客户端启动。Antigravity 插件已写好配置。其他独立客户端可运行 `gempt print-mcp --installed` 导出，或在源码目录运行 `.\install.ps1 -PrintMcp`（Windows）或 `bash install.sh --print-mcp`（macOS / Linux）。使用 `uvx` 安装时，可沿用上面的 `uvx --from … gempt` 命令前缀。

---

## 一、Magpie 原生路由预设（`group/gempt-*`）

| 路由组 | 默认对话 | 执行 | 适用场景 |
| --- | --- | --- | --- |
| `group/gempt-sonnet` | Gemini 4 Hydrogen | GPT-6.1 Terra | 日常修改、脚本、小功能。简单意图也可交给 DeepSeek |
| `group/gempt-opus` | Gemini 4 Neon | GPT-6.2 Sol，疑难意图优先 GPT-6.2 Astra | 跨文件重构、难 Bug、复杂设计 |
| `group/gempt-fable` | 可用的高档 Gemini（如 Carbon 或 Neon） | GPT-6.2 Astra | 核心算法和长程攻坚。DeepSeek 的显式任务规则只有压缩 |

### 用命令行创建 Magpie 路由组

在 Magpie 接入 Gemini 和 Codex 订阅模型后，运行 `gempt presets --apply`。也可以从源码目录运行以下命令。

**Windows PowerShell**

```powershell
.\install.ps1 -Preview
.\install.ps1 -Apply
```

**macOS / Linux**

```bash
bash install.sh --preview
bash install.sh --apply
```

安装器读取 `magpie models`，应用 `GEMPT_EXCLUDED_MODELS` 和宿主配置中的 `routing_policy.excluded_models`。若没有可用的压缩模型，仍可创建直连组，有可用模型时才添加专门的压缩规则。安装器遇到同名组会停止。

Magpie CLI 可通过 `--magpie-cli`、配置项 `magpie.cli_path` 或环境变量 `MAGPIE_BIN` 指定。用 `magpie models` 查看模型 ID。可用环境变量指定模型，例如在 PowerShell 运行 `$env:DEEPSEEK_FLASH = 'your-provider/your-deepseek-flash'`，然后再运行 `.\install.ps1 -Apply`。

### 使用与验证

在 Magpie 接入的客户端里手动选一个 `group/gempt-*`，然后到 Magpie 的 Routing 页查看实际命中的规则。聊需求和执行是独立回合时，可以先让 Gemini 规划，再发一条明确的执行消息。Magpie 在回合开始时判断意图，回合内的工具调用通常继续走同一条路由。

建议分别试一次纯规划、代码修改、支持的子代理请求和上下文压缩。`order` 和规则定义的是优先顺序。目标不可用时，同组其他模型仍可接手，所以 Fable 中的 DeepSeek 也可能作为最后的故障回退。分类器会收到用户消息的文字片段，压缩模型会接收要压缩的上下文。选渠道时请按项目的数据要求判断。

协作时通过 PR 修改 `src/gempt/presets.py` 里的 CLI 路由规则，并附上不含提示词原文或账户信息的验证结果。仓库只共享规则、代码和文档，本地账号、日志、密钥和 Magpie 配置各自保管。

参考 [Magpie 意图路由文档](https://usemagpie.ai/docs/intent) 和 [路由组文档](https://usemagpie.ai/docs/start)。

---

## 插件页里的工作分工

在 **Plugins → GemPT → MCP 编排** 选择普通对话的工作分工。Gemini 为主、按领域分工、GPT 为主、基本全由 GPT 做分别表示 GPT 承担约 20%、50%、80%、95% 工作量的倾向。实际决策按任务类别执行，百分比不计量订阅额度。旧配置沿用按领域分工。

在同一页的 **Gemini 与 GPT 配对** 中，每个 Gemini 系列可以独立选择本机 Magpie 已接入的 Codex 订阅模型。初始组合为 Hydrogen → Terra、Neon → Sol、Carbon → Astra。选择后，下个新任务的咨询和代码执行都会使用该 GPT，配对调用仅走所选订阅模型；续接同一任务保留原搭档。Gemini 仍在 Antigravity 原生界面选择，Swarm 成员从协调者的任务单继承系列。选“沿用默认档位”、宿主未报告系列或用户显式指定档位时，使用原档位路由及其兜底设置。

每个新实质任务先走 `gempt_dispatch`。最高档会立即把普通写作、方案、调研和工程交给 GPT。已有材料走咨询；需要读仓库或跑检查走只读 Codex；实现和测试走已授权的 Codex 工作区。Gemini 处理必要的原生视觉观察、澄清需求，并用通俗语言汇报结论和证据。执行权限关闭时会报告阻塞。外部 MCP 客户端首次接入或从旧版升级需复制新版协作规则；Antigravity 使用随插件安装的规则。只选择直连组的客户端仍按整回合路由。

**Antigravity Swarm** 可以跟随普通对话，也可以独立选四档。协调者分配带唯一 ID 的公开任务单，worker 按单派发，verifier 独立核验，narrator 处理看板汇报。在同一 GemPT 会话存储内重复投递一个 ID 只会启动一次 GPT 工作。每个原生 Swarm 角色仍然消耗宿主的协调回合。参见 [Antigravity Swarm 官方说明](https://antigravity.google/docs/swarm)。

## 二、Gemini 主导 GPT 编排插件（`consult` / `exec`）

```text
你（自然语言）
  ↕
Gemini 主控（Antigravity 官方原路 或 外部客户端经 Magpie 调 antigravity/gemini-4-*）
  │  └─ 聊需求 / 拆任务单 / 审 Diff / 翻译人话
  │
  ├── gempt_consult（直连 Magpie HTTP /v1/responses 或 /chat/completions）
  │     ↳ 零 Codex 工具注入开销（省掉 ~18K–50K tok），适合算法推导、架构评审、定位根因、chore 摘要
  │
  └── gempt_exec（调用本机 codex exec / codex exec resume，指向 Magpie）
        ↳ 完整本地沙箱读写文件、跑测试、按 session_id 多轮纠偏
  ↓
本地 Magpie 网关（127.0.0.1:3425）── 统一代理 GPT/Codex 订阅池、多号轮转与容灾
```

### 3+1 编排档位、甜点强度与领域分工

- **「按领域分工」档**：**Gemini** 专职人类需求沟通、方案拆解、前端/UI 审美实现、多模态核验与最终验收；**GPT/Codex**（经本地 Magpie 调度）专攻后端重构、硬核调试、算法数学与独立 Diff 审查（不自写自审）。
- **甜点配置与思考强度纪律**：控制面板右侧提供 **`思考强度（当前档）`**（`中 | 高 | 极高 | 智能`）。选 **`智能`**（`auto_effort`）时，仅在新线程首轮按任务风险在 `low..xhigh` 间自动定档；`resume` 续跑强制锁定原强度，禁用 `ultra` 与高强度子代理扇出，也不将 `Astra` 降至 `low`。

| 编排档位 / 推荐占比 | 对标定位 | 执行 / 咨询模型 × 甜点强度 | 免费旁路 (`compact`) | 典型场景 |
| :--- | :--- | :--- | :--- | :--- |
| `sonnet`（**~75%**） | 日常高频 | `codex/gpt-6.2-sol` @ **`medium`** | `DeepSeek-V4.1-Flash` | 单/少文件实现、UI 交互逻辑、常规单测 |
| `opus`（**~20%**） | 复杂工程 | `codex/gpt-6.2-sol` @ **`high`**（疑难 / `xhigh` 升 **`Astra`**） | `DeepSeek-V4.1-Flash` | 跨文件重构、大仓库排查、独立审查、复杂设计 |
| `fable`（**~5%**） | 顶配攻坚 | `codex/gpt-6.2-astra` @ **`xhigh`** | `DeepSeek-V4.1-Flash` | 极难 Bug、核心算法/数学推导、长程架构 |
| `chore`（旁路 `consult`） | 免费打杂 | `DeepSeek-V4.1-Flash` 等免费高速模型 | — | 日志提纯、大文本摘要、粗分类 |

> 日常默认直接调用 Magpie 中具体的 GPT/Codex 模型 ID 即可工作；仅当开启组同步时才会创建独立命名的 `group/gempt-harness-*`，与根目录 `install.sh` 的 `group/gempt-*` 完全独立、互不覆盖。`high` / `xhigh` 自动保障长思考超时下限（exec ≥ 900s/1200s）。

### Python CLI 快速开始

安装 wheel 后可直接运行以下 `gempt` 命令。只用 `uvx` 时可沿用上面的命令前缀。

1. **环境探测**（同时检查原生 `group/gempt-*` 预设、GPT/Codex/Utility 模型与 Codex CLI）：

```bash
gempt discover
```

2. **接入客户端**。按上面的安装说明启用 Magpie HTTP MCP 或 Antigravity 的独立 Python stdio MCP。接入后复制协作规则，Antigravity 插件自带规则。

3. **首次初始化**：在客户端直接说“初始化 gempt”（Gemini 会调 `gempt_discover` + `gempt_configure`），或命令行运行：

```bash
gempt init
# 无交互预览（可选同步 group/gempt-harness-*）：
gempt init --non-interactive --sync-magpie --use-groups --dry-run
```

### 常用 CLI 命令

```bash
# 查看或切换 Codex 执行权限（只读 / 工作区 / 全权限）
gempt sandbox
gempt sandbox workspace-write

# 查看或切换默认委派档位（工具调用省略 --tier / tier 时自动生效）
gempt tier
gempt tier opus

# 查看或切换思考强度（对当前或指定档位设为 low/medium/high/xhigh，或 auto 智能定档）
gempt effort
gempt effort auto
gempt effort high --tier opus

# 查看当前配置（已脱敏）、Magpie/Codex 健康状态与近期会话
gempt status

# 纯推理/审查咨询（不触发 Codex 固定上下文开销）
gempt consult --tier fable --file src/algo.py --goal "找出收敛震荡根因并给修复 diff"

# 免费打杂档做日志压缩/分类
gempt consult --tier chore --file logs/build.log --goal "提取前 5 类报错和首次出现行号"

# 派给 Codex CLI 动手改代码并自测
gempt exec --tier opus --cwd /path/to/repo --goal "修复重试退避" --verification "python -m unittest -v"

# 疑难问题手动升级到 Astra（或直接传 --tier fable）
gempt exec --tier opus --escalate --cwd /path/to/repo --goal "排查并发死锁"
```

---

## 三、配置、容灾与安全边界

- 配置文件查找顺序：`--config` 参数 → 环境变量 `GEMPT_CONFIG` → 当前及上级目录 `.gempt.json` → `~/.config/gempt/config.json`。
- 基于面向大众用户的纯订阅基线（`yizhang-dream/collab` 分支），当前个人分支额外开启按量 API 兜底能力与 Magpie 页面内的 **`仅订阅 | API 兜底`** 实时切换开关：
  1. `subscription_only`（推荐默认）：只用 Codex 订阅模型，不自动切换按量 API，避免意外扣费；多订阅号在 Magpie 侧配 `#account` 或 `routing=drain/smart` 即可无感切换。
  2. `api_fallback`：订阅优先，限流或失败时按顺序降级到按量 `openai/*` API（支持页面内无损往返切换）。
  3. `effort_only`：单模型（`Sol`）仅用 `reasoning_effort`（`medium` / `high` / `xhigh`，避免 Astra 降 `low`）区分三档。
- 若要在 `discover` / `status` 推荐里隐藏特定模型，可设置环境变量 `GEMPT_EXCLUDED_MODELS`（逗号分隔子串）或在宿主配置 `routing_policy.excluded_models` 中填入字符串列表。
- 参考模板见 [templates/gempt.config.example.json](templates/gempt.config.example.json) 与 [templates/magpie-groups.template.json](templates/magpie-groups.template.json)。

### 工作区、网关与续跑边界

初始化默认写入个人配置；写到其他位置须显式指定配置路径。CLI 自动发现的项目 `.gempt.json` 不能覆盖宿主的 `magpie`、`codex` 或 `routing_policy` 策略。

MCP 宿主用 `GEMPT_WORKSPACE_ROOT` 指定授权工作区，默认采用服务启动目录。文件路径按真实路径检查（含符号链接和目录联接）。MCP 宿主可通过 `gempt_configure` 收紧 `default_sandbox`，但不能放宽沙箱、修改远端网关或替换 CLI 路径。纯订阅模式下，三个 GPT 档位只接受具体的 Codex 订阅模型，或可通过本地 Magpie CLI 核对成员的本机 `group/gempt-harness-*` 组。

默认本机网关可使用本机调用凭据；其他地址使用专用配置中的密钥，通过环境提供远端密钥时须用 `GEMPT_TRUSTED_GATEWAY` 绑定目标。HTTP 请求拒绝重定向。Codex 子进程使用本次网关的专用 provider，并在指向回环网关时自动绕过 `HTTP_PROXY`/`HTTPS_PROXY`（补全 `NO_PROXY`），同时禁止可覆盖路由和沙箱的任意 `extra_args`。

同步 `group/gempt-harness-*` 时，gempt 先读取同名组、核对管理备注、只写差异并回读成员和规则。续跑使用 gempt 的 exec 会话 ID，沿用原工作区及网关且沙箱不可放宽。Windows 独立 Codex CLI 需要本机已配置可用的 Windows 沙箱；结果里的 `requested_sandbox` 是请求值，`sandbox` 来自 Codex 实际 `turn_context`，无法确认时为空。

### 断线后检查任务与退出码验收

```sh
gempt exec --background --cwd . --goal "修复解析器并运行单测" --verification "python -m unittest"
gempt status --run-id <返回的32位ID>
```

Magpie 原生 MCP 对短任务直接返回结果，运行约 20 秒仍在执行时返回 `run_id`，可用 `gempt_status(run_id=..., wait_sec=20)` 等待并读取最终结果。原生调用可传 `background=true` 立即取得任务号，重复使用同一 `run_id` 只启动一次。

Antigravity Python MCP 对应 `gempt_exec(background=true)` 与 `gempt_status(run_id=...)`。调用方可以预先生成 32 位小写十六进制 `run_id`，相同 ID 只派发一次。`verification` 填一条独立的 shell 命令；gempt 从 Codex 的命令事件匹配该命令（支持拆解 PowerShell / `cmd /c` / `bash -lc` 外壳，但拒绝 `echo` 或 `|| true` 伪造）及退出码，最近一次匹配决定 `passed` 或 `failed`，否则为 `unverified`。Git 工作区的 `before`/`after` 记录相对 `HEAD` 的 diff 与状态（每项最多 64 KiB）。

---

## 四、常见问题排查

1. **访问 `127.0.0.1:3425` 报错或被代理拦住**：`gempt` 与 `install.sh` 对回环地址和本地 Magpie CLI 一律绕过系统代理；`gempt_exec` 在指向回环网关时也会为 `codex exec` 自动补全 `NO_PROXY`。终端手动 `curl` 自测请加 `--noproxy 127.0.0.1`。
2. **思考型模型返回空内容**：`max_output_tokens` 过小时会被 reasoning tokens 占满；`gempt` 默认按档位设 `8192`~`32768`，如遇报错可用 `--max-tokens` 调大。
3. **Windows 下无弹窗与 `.cmd` 转义**：`gempt` 在 Windows 调用子进程一律传 `CREATE_NO_WINDOW`，并通过 `stdin` 传长文本 prompt、直接用 Node 启动 npm 版 Codex 包，不经过 `cmd.exe` 二次转义。
4. **Codex 沙箱若报 `cap_sid` 错误**：清理陈旧的 `~/.codex/cap_sid` 后重试即可。
5. **运行自检**。在源码目录先运行 `python -m pip install -e .`，再运行 `python -m unittest discover -s tests -v`。要启用隔离的 Magpie CLI 集成测试，把 `GEMPT_TEST_MAGPIE_CLI` 设为 Magpie 可执行文件路径。
