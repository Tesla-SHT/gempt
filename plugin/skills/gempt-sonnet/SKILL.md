---
name: gempt-sonnet
description: >-
  Use GemPT Sonnet tier (~75% daily coding/review via Magpie Sol @ medium) for this task,
  or switch GemPT default_tier to sonnet.
---

# /gempt-sonnet — Sonnet 日常高频档

本回合强制将 GPT/Codex 委派档位锁定为 **`sonnet`**（推荐占日常开发约 **75%**，默认甜点 `Sol @ medium`）：

1. **有明确任务时**。咨询用 `gpt_ask`（Magpie `gempt_ask`），传 `tier="sonnet"`。需要仓库操作时用 `gpt_run`（Magpie `gempt_run`），执行档位取共享配置。若用户授权切换执行档位，先运行 `gempt tier sonnet`。用用户的语言汇报验证结果。
2. **仅输入 `/gempt-sonnet`、无具体任务文本时**：
   - 询问本轮需要用 `sonnet` 档完成什么任务；
   - 切换默认档位可在 **Plugins → GemPT** 点选，或运行 `gempt tier sonnet`。
