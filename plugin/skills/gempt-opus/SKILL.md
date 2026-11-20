---
name: gempt-opus
description: >-
  Use GemPT Opus tier (~20% complex cross-file engineering via Magpie Sol @ high, escalating
  to Astra @ xhigh) for this task, or switch GemPT default_tier to opus.
---

# /gempt-opus — Opus 复杂工程档

本回合强制将 GPT/Codex 委派档位锁定为 **`opus`**（推荐占比约 **20%**，默认甜点 **`Sol @ high`**，跨文件重构、大仓库排查、复杂设计与独立 Diff 审查）：

1. **有明确任务时**：
   - 先用 `gempt_consult(tier="opus", ...)` 核清方案或根因；遇到常规 `Sol @ high` 拿不准的疑难子问题时，在**新线程（不带旧 `session_id`）** 传 `escalate=true`（自动升级至 `Astra @ xhigh`）。
   - 需要动手改代码并自测时，按 [../gempt/SKILL.md](../gempt/SKILL.md) 发送完整五要素任务单到 `gempt_exec(tier="opus", ...)`；禁止使用 `ultra` 或扇出多个高思考子代理。
   - Gemini 亲自检查 Diff 与测试退出码后，再向用户汇报结论、验证结果与遗留风险。
2. **仅输入 `/gempt-opus`、无具体任务文本时**：
   - 询问本轮需要用 `opus` 档处理的复杂工程任务；
   - 若用户希望将全局默认档位切换为 `opus`，引导其在 Magpie 左侧栏 **`Plugins → GemPT`** 点选，或运行 `python -m gempt tier opus`。
