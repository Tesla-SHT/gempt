# GemPT v0.2.1

GemPT 让 Gemini 通过本机 Magpie 咨询 GPT、委派 Codex 仓库任务，并在 GemPT Live 查看和介入运行。Magpie 插件、Antigravity stdio MCP、hooks、安装器和 CLI 共用一套 Node.js ESM 核心。运行时只使用 Node.js 内置模块。GemPT Live 随包提供预构建资源。

## 安装

需要 Node.js **20.11.0 或更新版本**。先在 Magpie 登录 ChatGPT/Codex 订阅。咨询只需 Magpie 网关。仓库执行需要安装 Codex CLI，并由 Magpie GemPT 插件托管共享 Codex app-server。

### Magpie

```bash
magpie plugin add github:yizhang-dream/gempt
```

打开 **Plugins → GemPT**，查看网关、订阅和 app-server 状态。Magpie 可向已接入客户端分发 HTTP MCP（默认 `http://127.0.0.1:3425/mcp/magpie/tools/gempt`）。需要允许这些客户端写入时，在 GemPT 插件选项设置 `exec: true`，并选择合适的沙箱。

### Antigravity

```bash
npx --yes github:yizhang-dream/gempt install-agy
```

使用本地源码时，Linux/macOS 运行 `bash install.sh`，Windows 运行 `.\install.ps1`。可附加 `--target <目录>`。也可从 Magpie 的 GemPT 页面安装。安装器将 Node MCP、hooks、规则、skills 和 Live 资源复制到 `~/.gemini/config/plugins/gempt`，并在 `~/bin` 安装 `gempt-wait`。

双装时可在 Magpie GemPT 插件选项设置 `mcpTools: false`，让 Antigravity 使用自己的 `gempt_gempt`，同时保留 Magpie 控制面板和共享 app-server。独立 stdio 客户端可用 `gempt print-mcp --installed` 导出已安装配置。

### 从 Python 版升级

对原插件目录运行同一安装命令。新安装不需要 Python。旧目录中已有 `work_split_hook.py` 时，安装器会保留一个生成的兼容入口，让仍缓存旧命令的 Antigravity 会话通过原有 Python 启动器转发到 Node hook。共享配置与会话目录继续沿用。

## 三个 MCP 工具

| Antigravity stdio | Magpie HTTP | 用途 |
| --- | --- | --- |
| `gpt_run` | `gempt_run` | 异步 Codex 任务。传 `goal`、`cwd`，用 `access="inspect"` 只读调查或 `access="change"` 执行改动。并发编辑同一 Git 仓库时使用 `workspace="share"`。 |
| `gpt_ask` | `gempt_ask` | 同步咨询。传 `goal`，可加 `cwd`、`file_paths` 和 `tier`。`chore` 用于摘要或分类。 |
| `gpt_ctl` | `gempt_ctl` | 查看状态、转向、中止或回答 `ask_gemini`。用 `action="status"`、`"steer"`、`"interrupt"` 或 `"reply"`。在 Antigravity 中，`gpt_ctl({})` 打开 GemPT Live。 |

`gpt_run` 返回 `run_id`、`session_id` 和 `wait_command`。在 Antigravity 用 `run_command(WaitMsBeforeAsync=500)` 后台执行等待命令。终端可运行 `gempt-wait <run_id>`、`gempt-wait id1,id2` 或 `gempt-wait --all id1,id2`。续聊时传 `session_id`。从只读升级到可写时，GemPT 会创建可写线程并带上上一轮摘要。

在 Magpie **Plugins → GemPT** 可切换 0% / 15% / 35% / 60% / 80% 工作分工、Gemini 与 GPT 配对、默认沙箱和执行档位。80% 档计入 Gemini 前端编排约 15–20% 的占比下限。`sonnet` 用于日常任务，`opus` 用于复杂工程，`fable` 用于高难推理。Antigravity 的 `/gempt-sonnet`、`/gempt-opus`、`/gempt-fable` 和 `/gempt-chore` 提供对应指引。

## 命令行

以下命令可通过 `npx --yes github:yizhang-dream/gempt <命令>`、安装到 `PATH` 的 `gempt`，或源码中的 `node bin/gempt.mjs` 运行。

```sh
gempt discover
gempt init --non-interactive
gempt tier opus
gempt sandbox workspace-write
gempt effort auto
gempt status --run-id <run_id> --wait
gempt presets --preview
gempt presets --apply
gempt print-mcp --installed
```

`gempt presets --apply` 创建 Magpie 原生 `group/gempt-*` 路由组。要为 GemPT 工具同步独立的 `group/gempt-harness-*` 组，使用 `gempt init --sync-magpie --use-groups`。从源码运行时，安装脚本也接受 `--preview`、`--apply` 和 `--print-mcp`。

## 数据与权限

- 配置和任务记录默认保存在 `~/.config/gempt/`，可通过 `GEMPT_CONFIG` 与 `GEMPT_SESSIONS_DIR` 覆盖。记录可能包含任务文本、输出、进度和命令证据。`workspace="share"` 会创建本地 Git worktree。
- 咨询问题和明确提供的文件内容会发送到配置的 Magpie 网关。Codex 通过同一网关发送模型请求。默认 `subscription_only` 使用订阅模型，启用 `api_fallback` 后可使用按量 `openai/*` 模型。
- Magpie HTTP MCP 默认 `exec: false`，允许只读调查、咨询和现有任务控制。Antigravity 的 stdio MCP 使用共享 Codex 沙箱配置。可用 `GEMPT_WORKSPACE_ROOT` 限定工作区。
- 控制面板默认监听 `127.0.0.1:3498`，受保护的 API 使用 `x-gempt-key`。共享 Codex WebSocket 限定回环地址并使用认证令牌。

## 验证

```sh
node --test tests/test_core_node.mjs tests/test_magpie_plugin.mjs
npm pack --dry-run
```
