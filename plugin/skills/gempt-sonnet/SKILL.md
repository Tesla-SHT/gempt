---
name: gempt-sonnet
description: >-
  Use GemPT Sonnet tier (~75% daily coding/review via Magpie Sol @ medium) for this task,
  or switch GemPT default_tier to sonnet.
---

# /gempt-sonnet — Sonnet 日常高频档

本回合强制将 GPT/Codex 委派档位锁定为 **`sonnet`**（推荐占日常开发约 **75%**，默认甜点 `Sol @ medium`）：

1. **有明确任务时**：
   - Gemini 保持在原生官方通道，继续充当人类对接与前端/规划协调者；不要直接把人类原话原样转发给 GPT。
   - 按 [../gempt/SKILL.md](../gempt/SKILL.md) 整理结构化五要素任务单，调用 `gempt_consult(tier="sonnet", ...)`（日常后端复核/交叉评审）或 `gempt_exec(tier="sonnet", ...)`（小范围改代码并自测）。
   - 若执行失败或连续返工，**另起新线程（不传 `session_id`）** 升到 `opus`，不要在原会话加档。
2. **仅输入 `/gempt-sonnet`、无具体任务文本时**：
   - 询问本轮需要用 `sonnet` 档完成什么任务；
   - 若用户意在**切换默认档位**为 `sonnet`，可提示在 Magpie 左侧栏 **`Plugins → GemPT`** 控制页点选，或运行 `python -m gempt tier sonnet`（只更新 `routing_policy.default_tier`）。
