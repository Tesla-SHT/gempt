# GemPT

一套可共享、可审查的 Magpie 原生路由预设。Gemini 负责对话和规划，GPT 负责执行，DeepSeek Flash 负责分类与上下文压缩。

| 路由组 | 默认对话 | 执行 | 适用场景 |
| --- | --- | --- | --- |
| `group/gempt-sonnet` | Gemini 4 Hydrogen | GPT-6.2 Sol | 日常修改、脚本、小功能。简单意图也可交给 DeepSeek |
| `group/gempt-opus` | Gemini 4 Neon | GPT-6.2 Sol，疑难意图优先 GPT-6.2 Astra | 跨文件重构、难 Bug、复杂设计 |
| `group/gempt-fable` | Gemini 4 Argon | GPT-6.2 Astra | 核心算法和长程攻坚。DeepSeek 的显式任务规则只有压缩 |

## 安装

先在 Magpie 中接好各模型渠道，再从仓库根目录运行：

```sh
bash install.sh          # 预览命令
bash install.sh --apply  # 创建三组，保留当前客户端的模型设置
```

如果 `magpie` 不在 `PATH`，可以设置 `MAGPIE_BIN` 为可执行文件的路径。默认模型 ID 见 `install.sh`，可以通过同名环境变量覆盖。例如，用本机可用的 DeepSeek 渠道替换默认的 WorkBuddy：

```sh
DEEPSEEK_FLASH=your-provider/your-deepseek-flash bash install.sh --apply
```

DeepSeek 的额度取决于你绑定的渠道。用 `magpie models` 查看本机实际暴露的模型 ID。安装器遇到同名组会停止，以免覆盖本地改动。

## 使用与验证

在 Magpie 接入的客户端里手动选一个 `group/gempt-*`，然后到 Magpie 的 Routing 页查看实际命中的规则。聊需求和执行是独立回合时，可以先让 Gemini 规划，再发一条明确的执行消息。Magpie 在回合开始时判断意图，回合内的工具调用通常继续走同一条路由。

建议分别试一次纯规划、代码修改、支持的子代理请求和上下文压缩。`order` 和规则定义的是优先顺序。目标不可用时，同组其他模型仍可接手，所以 Fable 中的 DeepSeek 也可能作为最后的故障回退。分类器会收到用户消息的文字片段，压缩模型会接收要压缩的上下文。选渠道时请按项目的数据要求判断。

协作时通过 PR 修改 `install.sh` 里的路由规则，并附上不含提示词原文或账户信息的验证结果。仓库只共享规则和文档，本地账号、日志、密钥和 Magpie 配置各自保管。

参考 [Magpie 意图路由文档](https://usemagpie.ai/docs/intent) 和 [路由组文档](https://usemagpie.ai/docs/start)。
