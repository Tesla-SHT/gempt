---
name: gempt-chore
description: >-
  Use GemPT Chore tier (free/fast utility model via Magpie) for log
  compression, summarization, or classification via gpt_ask or gempt_ask.
---

# /gempt-chore — Chore 免费旁路打杂/压缩/分类档

本回合使用 **`chore`** 档（免费/高速 Utility 旁路模型，不占用主配额，用于大日志提纯、长文摘要、粗分类或格式整理）：

1. **严格边界**：
   - 使用 `gpt_ask(tier="chore", ...)`（Magpie `gempt_ask`）。`chore` 仅用于咨询，仓库任务继续由当前 Gemini 配对的 Codex 模型执行。
   - 控制输入体量与期望输出结构，要求模型返回高密度要点或分类表，便于原生 Gemini 在后续决策中直接引用。
2. **无具体任务文本时**：
   - 询问需要整理/压缩/分类的文件或文本内容。
