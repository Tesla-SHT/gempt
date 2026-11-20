---
name: gempt-fable
description: >-
  Use GemPT Fable tier (~5% top-tier Astra @ xhigh reasoning for core algorithms,
  math, and extreme bugs) for this task, or switch GemPT default_tier to fable.
---

# /gempt-fable — Fable 顶配攻坚档

本回合强制将 GPT/Codex 委派档位锁定为 **`fable`**（推荐聚焦最硬 **~5%** 任务：极难 Bug、核心算法/数学推导、长程架构攻坚，默认甜点 **`Astra @ xhigh`**，严禁降级 `Astra` 到 `low` 且禁止默认 `ultra`）：

1. **有明确任务时**：调用 `gempt_dispatch`，传 `tier="fable"` 以及任务的 kind 和 access。当前工作分工决定执行者，本命令只指定委派时的模型档位。Swarm 成员同时传入角色和任务 ID。用用户的语言解释返回的结果和验证证据。
2. **仅输入 `/gempt-fable`、无具体任务文本时**：
   - 询问要交由 `fable` 档攻坚的核心问题；
   - 若用户希望将默认档位切换为 `fable`，提示可在 Magpie 左侧栏 **`Plugins → GemPT`** 一键点选，或运行 `python -m gempt tier fable`。
