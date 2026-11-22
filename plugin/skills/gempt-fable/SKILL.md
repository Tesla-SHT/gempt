---
name: gempt-fable
description: >-
  Use GemPT Fable tier (~5% top-tier Astra @ xhigh reasoning for core algorithms,
  math, and extreme bugs) for this task, or switch GemPT default_tier to fable.
---

# /gempt-fable — Fable 顶配攻坚档

本回合强制将 GPT/Codex 委派档位锁定为 **`fable`**（推荐聚焦最硬 **~5%** 任务：极难 Bug、核心算法/数学推导、长程架构攻坚，默认甜点 **`Astra @ xhigh`**，严禁降级 `Astra` 到 `low` 且禁止默认 `ultra`）：

1. **有明确任务时**。咨询用 `gpt_ask`（Magpie `gempt_ask`），传 `tier="fable"`。需要仓库操作时用 `gpt_run`（Magpie `gempt_run`），执行档位取共享配置。若用户授权切换执行档位，先运行 `gempt tier fable`。用用户的语言汇报验证结果。
2. **仅输入 `/gempt-fable`、无具体任务文本时**：
   - 询问要交由 `fable` 档攻坚的核心问题；
   - 切换默认档位可在 **Plugins → GemPT** 点选，或运行 `gempt tier fable`。
