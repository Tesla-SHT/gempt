---
name: gempt-sonnet
description: >-
  Use GemPT Sonnet tier (~75% daily coding/review via Magpie Sol @ medium) for this task,
  or switch GemPT default_tier to sonnet.
---

# /gempt-sonnet — Sonnet 日常高频档

本回合强制将 GPT/Codex 委派档位锁定为 **`sonnet`**（推荐占日常开发约 **75%**，默认甜点 `Sol @ medium`）：

1. **有明确任务时**：调用 `gempt_dispatch`，传 `tier="sonnet"` 以及任务的 kind 和 access。当前工作分工决定执行者，本命令只指定委派时的模型档位。Swarm 成员同时传入角色和任务 ID。用用户的语言解释返回的结果和验证证据。
2. **仅输入 `/gempt-sonnet`、无具体任务文本时**：
   - 询问本轮需要用 `sonnet` 档完成什么任务；
   - 若用户意在**切换默认档位**为 `sonnet`，可提示在 Magpie 左侧栏 **`Plugins → GemPT`** 控制页点选，或运行 `python -m gempt tier sonnet`（只更新 `routing_policy.default_tier`）。
