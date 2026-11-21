# GemPT

一套用于 Codex 的 Magpie 路由预设。每组由 Gemini 优先负责对话、派单和总结，GPT 在 Codex 原生子代理中执行任务。三组都支持用 DeepSeek Flash 压缩长对话。

| 路由组 | 主持 | GPT 子代理 | 适用场景 |
| --- | --- | --- | --- |
| `group/gempt-sonnet` | Gemini 4 Hydrogen | GPT-6.2 Sol | 日常修改、脚本、小功能 |
| `group/gempt-opus` | Gemini 4 Neon | GPT-6.2 Sol，疑难任务可用 GPT-6.2 Astra | 跨文件重构、难 Bug、复杂设计 |
| `group/gempt-fable` | Gemini 4 Argon | GPT-6.2 Astra | 核心算法和长程攻坚 |

## 安装

先在 Magpie 中接好各模型渠道，再从仓库根目录运行：

```sh
bash install.sh           # 预览路由命令
bash install.sh --apply   # 首次创建三组并安装 Codex 子代理
bash install.sh --update  # 将既有同名组替换为本版预设
```

如果 `magpie` 不在 `PATH`，可以设置 `MAGPIE_BIN` 为可执行文件的路径。可以通过 `GEMPT_HYDROGEN`、`GEMPT_NEON` 和 `GEMPT_ARGON` 指定主持模型的渠道。安装器会在 Codex 配置目录注册两个原生子代理，并追加只适用于这三组的派单说明。

安装时，如果 Magpie 提供 `workbuddy/deepseek-v4.1-flash`，三组都会启用 DeepSeek 压缩。找不到默认渠道时，安装会继续，压缩仍由 Gemini 处理。可以用 `DEEPSEEK_FLASH=渠道/模型 bash install.sh --update` 指定其他渠道，指定的模型必须出现在 `magpie models` 中。用 `DEEPSEEK_FLASH=off` 或空值关闭。无参数时只展示计划命令，实际以安装时的渠道校验为准。

## 使用与验证

通过 Magpie 接入 Codex 后，选择一个 `group/gempt-*`。三个预设均提供 `low`、`medium`、`high` 和 `xhigh`，建议从 `high` 开始。默认档位取决于客户端设置，客户端模型目录也可能额外显示 `max` 或 `ultra`。

Codex 原生子代理继承当轮选中的推理档。Magpie 为 Gemini 选择最接近的受支持档位。例如，`agy-cli` 的 Hydrogen 和 Neon 支持 `xhigh`，Argon 收到 `xhigh` 请求时使用 `high`。

让 Codex 执行一次只读任务，然后在 Magpie 的用量页核对三段请求。正常情况下，开始和收尾由组里的 Gemini 处理，子代理请求由对应的 GPT 处理。

启用后，`compact` 规则优先将待压缩的对话上下文发给 DeepSeek，不改变正常回合的分工。如果 DeepSeek 无法处理压缩，请求可以回到 Gemini；如果 Gemini 不可用，Magpie 也可能将普通请求回退给组内第二顺位的 DeepSeek。

协作时通过 PR 修改 `install.sh` 或 `codex/` 中的子代理与分工说明，并附上不含提示词原文或账户信息的验证结果。本地账号、日志、密钥和 Magpie 配置各自保管。

参考 [Magpie 路由组文档](https://usemagpie.ai/docs/start#routing)。
