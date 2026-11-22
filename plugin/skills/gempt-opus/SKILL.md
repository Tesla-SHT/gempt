---
name: gempt-opus
description: >-
  Use GemPT Opus tier (~20% complex cross-file engineering via Magpie Sol @ high, escalating
  to Astra @ xhigh) for this task, or switch GemPT default_tier to opus.
---

# /gempt-opus — Opus 复杂工程档

本回合强制将 GPT/Codex 委派档位锁定为 **`opus`**（推荐占比约 **20%**，默认甜点 **`Sol @ high`**，跨文件重构、大仓库排查、复杂设计与独立 Diff 审查）：

1. **有明确任务时**。咨询用 `gpt_ask`（Magpie `gempt_ask`），传 `tier="opus"`。需要仓库操作时用 `gpt_run`（Magpie `gempt_run`），执行档位取共享配置。若用户授权切换执行档位，先运行 `gempt tier opus`。用用户的语言汇报验证结果。
2. **仅输入 `/gempt-opus`、无具体任务文本时**：
   - 询问本轮需要用 `opus` 档处理的复杂工程任务；
   - 切换默认档位可在 **Plugins → GemPT** 点选，或运行 `gempt tier opus`。
