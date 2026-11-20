# Magpie 三档路由组参考模板（`gempt`）

本文件列出与仓库根目录 `templates/magpie-groups.template.json` 对应的本地 Magpie CLI 配置方法，供 `gempt_configure(..., sync_magpie_groups=True)` 或手工调整 Magpie 路由时参考。

> 注意：
> - **Antigravity 原生用户**：Antigravity 里的 Gemini 使用官方原路，不需要也不能通过 Magpie 反代；在 Antigravity UI 内自选 Gemini 档位即可。
> - **外部客户端用户（通过 Magpie 用 Gemini）**：可用根目录 `install.sh --apply`（或 `gempt presets --apply`）一键创建原生预设 `group/gempt-{sonnet,opus,fable}`；若要在同一回合内主动调度 GPT/Codex，可通过 `install.sh --print-mcp`（或 `gempt print-mcp`）挂接本插件 MCP。
> - **命名隔离与共存**：本插件可选同步的 `group/gempt-harness-{sonnet,opus,fable}` 仅包含 GPT/Codex（及可选 `compact` 规则），与根目录 `install.sh` 的 `group/gempt-*`（含 Gemini + GPT + Flash）完全独立、互不冲突；日常默认不新建组也可直接使用具体 GPT 模型 ID。

---

## 1. 三组与打杂组定位

| 路由组 ID | 对标档位（推荐占比） | 主力执行模型 × 甜点强度 | 疑难升级 | 免费压缩 (`compact`) |
| :--- | :--- | :--- | :--- | :--- |
| `group/gempt-harness-sonnet` | Sonnet（日常高频 ~75%） | `codex/gpt-6.2-sol` (`medium`) | — | `DeepSeek-V4.1-Flash` |
| `group/gempt-harness-opus` | Opus（复杂工程 ~20%） | `codex/gpt-6.2-sol` (`high`) | `effort=xhigh` 时自动转 `codex/gpt-6.2-astra` | `DeepSeek-V4.1-Flash` |
| `group/gempt-harness-fable` | Fable（顶配攻坚 ~5%） | `codex/gpt-6.2-astra` (`xhigh`) | — | `DeepSeek-V4.1-Flash` |

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

---

## 3. 已验证的常见坑位

1. **回环请求被系统代理劫持**：访问 `127.0.0.1:3425` 必须绕过代理（`gempt` 内置 `ProxyHandler({})`；手动用 curl 测试请加 `--noproxy 127.0.0.1`）。
2. **思考模型输出为空**：`max_output_tokens` 给太小会被 reasoning token 吃光；`gempt` 默认按档位给 `8192`~`32768`。
3. **`codex exec` vs `codex exec resume` 参数差异**：`codex exec` 支持 `-C` 和 `-s`；`codex exec resume` 不支持 `-C`/`-s` 参数（由 `gempt` 的 `codex_runner.py` 自动处理）。
4. **Codex 固定注入开销**：每次 `codex exec` 会带入约 18K–50K input tokens 的系统工具上下文；纯审方案、纯数学/算法推导务必用 `gempt_consult`。
