# Gemini → GPT 任务单（Task Packet）示例

## 示例 1：`gempt_consult` 架构/算法诊断（低开销高密度）

**反例（不要这样写）：**
> 帮我看看我这个 RL reward 为什么不收敛，顺便改改。

**正例（应该这样写）：**
- `tier`: `"fable"`
- `goal`: `"Diagnose why policy entropy collapses around epoch 40 and propose exact bounded reward-shaping changes."`
- `context`: `"PPO training on 4096 envs diverges after contact-rich phase. Action std drops from 0.8 to 0.05 between steps 18M and 24M; KL stays < 0.015."`
- `file_paths`: `["src/rewards/contact.py", "configs/ppo.yaml"]`
- `constraints`: `"Do not change observation space dimension or physics dt=0.005."`
- `expected_output`: `"1. Root-cause ranking with exact equations/lines; 2. Concrete diff proposal for contact.py; 3. A/B ablation check to verify within 5M steps."`

---

## 示例 2：`gempt_exec` 跨文件改造并自验证

- `tier`: `"opus"`
- `escalate`: `false`（若首轮回来后发现边界问题复杂，下一轮带上 `session_id` 并设 `escalate=true` 升级 Astra）
- `cwd`: `"/path/to/repo"`
- `goal`: `"Add retry-after header backoff to src/client/http.py and cover 429/503 cases in tests/test_http.py."`
- `context`: `"Currently `_request()` in src/client/http.py raises immediately on HTTP 429."`
- `constraints`: `"Keep public function signatures backward-compatible; use Python stdlib only."`
- `verification`: `"python -m unittest tests/test_http.py -v"`
- `expected_report`: `"List changed files, exact unittest command and pass/fail counts, and any uncovered edge cases."`

---

## 示例 3：`gempt_consult` 使用 `chore` 免费打杂档

- `tier`: `"chore"`
- `goal`: `"Extract the 5 distinct error signatures and their first occurrence lines from this CI log."`
- `file_paths`: `["logs/ci_fail.txt"]`
- `expected_output`: `"Markdown table: signature | count | first_line | suspected_module."`
