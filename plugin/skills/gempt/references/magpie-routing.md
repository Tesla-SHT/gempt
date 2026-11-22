# Magpie 三档路由组参考模板（`gempt`）

本文件列出与 `templates/magpie-groups.template.json` 对应的本地 Magpie CLI 配置方法。可用 `gempt init --sync-magpie --use-groups` 同步 harness 路由组。模板随 Antigravity 插件一同安装。

> 注意：
> - **Antigravity 原生用户**：Antigravity 里的 Gemini 使用官方原路，不需要也不能通过 Magpie 反代；在 Antigravity UI 内自选 Gemini 档位即可。
> - **外部客户端用户（通过 Magpie 用 Gemini）**。运行 `gempt presets --apply` 可创建原生预设 `group/gempt-{sonnet,opus,fable}`。Magpie HTTP MCP 提供 `gempt_run`、`gempt_ask`、`gempt_ctl`。独立 stdio 客户端可用 `gempt print-mcp --installed` 导出配置，调用 `gpt_run`、`gpt_ask`、`gpt_ctl`。
> - **命名隔离与共存**。`group/gempt-harness-{sonnet,opus,fable}` 仅包含 GPT/Codex 和可选 `compact` 规则。`gempt presets --apply` 创建的 `group/gempt-*` 可包含 Gemini、GPT 和 Flash。默认可直接使用具体 GPT 模型 ID。

---

## 1. 三组与打杂组定位

| 路由组 ID | 对标档位（推荐占比） | 主力执行模型 × 甜点强度 | 疑难升级 / 兜底 | 免费压缩 (`compact`) |
| :--- | :--- | :--- | :--- | :--- |
| `group/gempt-harness-sonnet` | Sonnet（日常高频 ~75%） | `codex/gpt-6.2-sol` (`medium`) | 可选 `openai/gpt-6.1-sol` | `DeepSeek-V4.1-Flash` |
| `group/gempt-harness-opus` | Opus（复杂工程 ~20%） | `codex/gpt-6.2-sol` (`high`) | `effort=xhigh` 转 `codex/gpt-6.2-astra` | `DeepSeek-V4.1-Flash` |
| `group/gempt-harness-fable` | Fable（顶配攻坚 ~5%） | `codex/gpt-6.2-astra` (`xhigh`) | 可选 `openai/gpt-6-astra` | `DeepSeek-V4.1-Flash` |

---

## 2. Magpie CLI 手工等价命令

以纯订阅号模式 + 嵌套自动组 `group/auto-deepseek-v4-1-flash`（若使用单一渠道模型可替换为 `workbuddy/deepseek-v4.1-flash` 等）为例：

```bash
# 1) Sonnet 档：日常高频
magpie group add gempt-harness-sonnet models=codex/gpt-6.2-sol,group/auto-deepseek-v4-1-flash routing=order stays=session
magpie group set gempt-harness-sonnet note="gempt sonnet (日常高频)"
magpie group rule add gempt-harness-sonnet use=group/auto-deepseek-v4-1-flash compact

# 2) Opus 档：Sol @ high + 极高推理(xhigh+)自动升级 Astra
magpie group add gempt-harness-opus models=codex/gpt-6.2-sol,codex/gpt-6.2-astra,group/auto-deepseek-v4-1-flash routing=order stays=session
magpie group set gempt-harness-opus note="gempt opus (复杂工程)"
magpie group rule add gempt-harness-opus use=codex/gpt-6.2-astra effort=xhigh
magpie group rule add gempt-harness-opus use=group/auto-deepseek-v4-1-flash compact

# 3) Fable 档：顶配攻坚
magpie group add gempt-harness-fable models=codex/gpt-6.2-astra,group/auto-deepseek-v4-1-flash routing=order stays=session
magpie group set gempt-harness-fable note="gempt fable (顶配攻坚)"
magpie group rule add gempt-harness-fable use=group/auto-deepseek-v4-1-flash compact
```

### 多账号轮转 / 成品号容灾技巧

如果在 Magpie 中挂了多个 ChatGPT/Codex 账号：
- 可以按账号钉选并按顺序切换：`models=codex/gpt-6.2-astra#primary,codex/gpt-6.2-astra#backup`
- 或把对应 provider / 路由组的策略改成 `routing=drain`（把一个号额度吃完再切下一个）或 `routing=smart`（剩余时间窗最合适优先）。
- 如果使用 `api_fallback` 模式，可在 `models=` 后追加按量 API 模型（如 `openai/gpt-6.1-sol`、`openai/gpt-6-astra`），这样订阅挂掉才会跌落到按量 API。

---

## 3. 已验证的常见坑位

1. GemPT 的本地网关探测绕过系统代理。手动用 `curl` 检查 `127.0.0.1:3425` 时可加 `--noproxy 127.0.0.1`。
2. **思考模型输出为空**：`max_output_tokens` 给太小会被 reasoning token 吃光；`gempt` 默认按档位给 `8192`~`32768`。
3. `gpt_run` 通过共享 Codex app-server 启动和续接线程。只需要审方案或做推导时用 `gpt_ask`，可省去 Codex 工具上下文。
