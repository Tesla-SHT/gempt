---
name: gempt-sonnet
description: >-
  Use GemPT Sonnet tier (daily 80% coding/review via Magpie Sol) for this task,
  or switch GemPT default_tier to sonnet.
---

# /gempt-sonnet — Sonnet 日常高频档

本回合强制将 GPT/Codex 委派档位锁定为 **`sonnet`**（日常高频 80%，默认映射 `Sol` / `medium`）：

1. **有明确任务时**：
   - Gemini 保持在原生官方通道，继续充当人类对接与主控协调者；不要直接把人类原话原样转发给 GPT。
   - 按 [../gempt/SKILL.md](../gempt/SKILL.md) 整理结构化五要素任务单（Goal / Verified Context / Constraints / Verification / Expected Report），调用 `gempt_consult(tier="sonnet", ...)`（设计/评审/排错）或 `gempt_exec(tier="sonnet", ...)`（跨文件改代码并跑验收命令）。
   - 核验输出与实际改动后，用清晰中文向用户汇报结论、实测证据与本次使用的档位/实际模型。
2. **仅输入 `/gempt-sonnet`、无具体任务文本时**：
   - 询问本轮需要用 `sonnet` 档完成什么任务；
   - 若用户意在**切换默认档位**为 `sonnet`，可提示在 Magpie 左侧栏 **`Plugins → GemPT`** 独立子页面一键切换，或运行 `python -m gempt tier sonnet`（只更新 `routing_policy.default_tier`，保留现有 `failover_mode` 与模型配置）。
