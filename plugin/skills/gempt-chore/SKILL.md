---
name: gempt-chore
description: >-
  Use GemPT Chore tier (free/fast utility model via Magpie) for log
  compression, summarization, or classification (gempt_consult only).
---

# /gempt-chore — Chore 免费打杂/压缩/分类档

本回合使用 **`chore`** 档（免费/高速 Utility 模型，用于大日志提纯、长文摘要、粗分类或格式整理）：

1. **严格边界**：
   - **只能调用 `gempt_consult(tier="chore", ...)`**，禁止调用 `gempt_exec`（`chore` 不支持 Codex 执行，也不能设置为 `routing_policy.default_tier`）。
   - 控制输入体量与期望输出结构，要求模型返回高密度要点或分类表，便于原生 Gemini 在后续决策中直接引用。
2. **无具体任务文本时**：
   - 询问需要整理/压缩/分类的文件或文本内容。
