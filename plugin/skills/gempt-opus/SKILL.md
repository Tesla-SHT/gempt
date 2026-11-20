---
name: gempt-opus
description: >-
  Use GemPT Opus tier (~20% complex cross-file engineering via Magpie Sol @ high, escalating
  to Astra @ xhigh) for this task, or switch GemPT default_tier to opus.
---

# /gempt-opus — Opus 复杂工程档

本回合强制将 GPT/Codex 委派档位锁定为 **`opus`**（推荐占比约 **20%**，默认甜点 **`Sol @ high`**，跨文件重构、大仓库排查、复杂设计与独立 Diff 审查）：

1. **有明确任务时**：调用 `gempt_dispatch`，传 `tier="opus"` 以及任务的 kind 和 access。当前工作分工决定执行者，本命令只指定委派时的模型档位。Swarm 成员同时传入角色和任务 ID。用用户的语言解释返回的结果和验证证据。
2. **仅输入 `/gempt-opus`、无具体任务文本时**：
   - 询问本轮需要用 `opus` 档处理的复杂工程任务；
   - 若用户希望将全局默认档位切换为 `opus`，引导其在 Magpie 左侧栏 **`Plugins → GemPT`** 点选，或运行 `python -m gempt tier opus`。
