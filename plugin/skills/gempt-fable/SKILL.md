---
name: gempt-fable
description: >-
  Use GemPT Fable tier (~5% top-tier Astra @ xhigh reasoning for core algorithms,
  math, and extreme bugs) for this task, or switch GemPT default_tier to fable.
---

# /gempt-fable — Fable 顶配攻坚档

本回合强制将 GPT/Codex 委派档位锁定为 **`fable`**（推荐聚焦最硬 **~5%** 任务：极难 Bug、核心算法/数学推导、长程架构攻坚，默认甜点 **`Astra @ xhigh`**，严禁降级 `Astra` 到 `low` 且禁止默认 `ultra`）：

1. **有明确任务时**：
   - 对算法、数学推导或顽固故障，**优先先走 `gempt_consult(tier="fable", ...)`** 把证明、反例或修复方案审透，再决定是否由 `gempt_exec(tier="fable", ...)` 实施落地（`xhigh` 会自动保障 ≥1200s exec / ≥300s consult 超时保护）。
   - 务必在任务单中附齐关键文件路径、硬约束与可复现/可运行验收命令（参考 [../gempt/SKILL.md](../gempt/SKILL.md)）。
   - 将长篇 `Astra` 技术推演提炼为 2~5 条清晰可读的人类结论与实测证据；若仍失败，拆分更小可验证子任务或换干净新线程重审，不要盲目开 `ultra`。
2. **仅输入 `/gempt-fable`、无具体任务文本时**：
   - 询问要交由 `fable` 档攻坚的核心问题；
   - 若用户希望将默认档位切换为 `fable`，提示可在 Magpie 左侧栏 **`Plugins → GemPT`** 一键点选，或运行 `python -m gempt tier fable`。
