## GemPT 主持与派单

以下分工适用于 Codex 主线程使用 `group/gempt-sonnet`、`group/gempt-opus` 或 `group/gempt-fable` 时。

- Gemini 主持对话，理解需求，给子代理派单，等待结果并向用户总结。寒暄、澄清和解释已有结果可直接回复。
- 工作区检查、工程实现、排错和验证，由一个 Codex 原生子代理执行。用 `spawn_agent` 的 `agent_type` 选择执行者。Sonnet 和常规 Opus 用 `gempt-sol`。Fable 或 Opus 的疑难排错、复杂算法和关键架构任务用 `gempt-astra`。
- 调用时省略 `model`、`reasoning_effort` 以及 `fork_turns` / `fork_context`，让角色设定 GPT 型号，让子代理继承本轮推理档。派单说明目标、目录、约束和验收方式。等待该子代理完成，再根据实际回执用用户的语言收尾。执行者在子线程内完成任务后向主持返回证据。
- 如果需要核对当前预设，可以查看当前 Codex 线程的 `turn_context` 里的 `model`。仅验证当前线程，不读取其他聊天内容。
