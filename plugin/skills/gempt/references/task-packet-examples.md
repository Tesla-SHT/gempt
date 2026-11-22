# Gemini → GPT 任务单示例

以下使用 Antigravity 工具名。Magpie HTTP MCP 对应 `gempt_ask`、`gempt_run`、`gempt_ctl`。

## 用 `gpt_ask` 审阅算法

```json
{
  "tier": "fable",
  "cwd": "/work/repo",
  "file_paths": ["src/rewards/contact.py", "configs/ppo.yaml"],
  "goal": "Explain why PPO policy entropy collapses around epoch 40. Rank causes using the attached code and propose an A/B test. Keep the observation space and physics timestep fixed."
}
```

## 用 `gpt_run` 修改代码并验收

```json
{
  "cwd": "/work/repo",
  "access": "change",
  "workspace": "share",
  "goal": "Add Retry-After backoff without changing public signatures. Run node --test tests/http.test.mjs and report changed files, test counts, and uncovered edge cases."
}
```

用回执中的 `wait_command` 等待完成。用 `gpt_ctl` 的 `steer`、`interrupt`、`reply` 介入现有 `run_id`。

## 用 `gpt_ask` 整理日志

```json
{
  "tier": "chore",
  "cwd": "/work/repo",
  "file_paths": ["logs/ci_fail.txt"],
  "goal": "List distinct error signatures with counts and first occurrence lines."
}
```
