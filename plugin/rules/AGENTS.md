# gempt Collaboration Rules

- **Domain split (Human ↔ Gemini, Gemini leads GPT)**:
  - **Gemini** owns human dialogue, planning, acceptance verification, and frontend/UI/visual/multimodal edits directly (keeping Antigravity's native Gemini on its official channel, or `antigravity/gemini-4-*` via Magpie in external clients; use `gempt_consult` to cross-review tricky UX state).
  - **GPT/Codex** (routed through local **Magpie**) owns backend logic, deep math/algorithms, hard debugging, cross-file refactors, and **independent diff/architecture review** (never let GPT self-grade its own code).
- **When to delegate & usage share (~75% / ~20% / ~5% + `chore`)**:
  - Use `gempt_consult` for reasoning, algorithms, deep diagnosis, independent review, or free utility summarization/classification (`tier="chore"`, avoids Codex CLI's ~18K–50K token overhead).
  - Use `gempt_exec` when GPT/Codex should read/edit files and run verification tests inside `cwd`.
  - Tier & effort sweet spots: `sonnet` (~75% daily work, `Sol @ medium`), `opus` (~20% complex engineering, `Sol @ high`; pass `escalate=true` or `xhigh` -> `Astra @ xhigh`), `fable` (~5% extreme bugs/math/architecture, `Astra @ xhigh`; never downgrade Astra to `low`).
  - Omit `tier` to follow `routing_policy.default_tier`; control `tier`, `default_sandbox`, `failover_mode` (`subscription_only` | `api_fallback`), and `思考强度（当前档）` (`中 | 高 | 极高 | 智能`) in Magpie's `Plugins -> GemPT` page or via `gempt tier` / `gempt sandbox` / `gempt effort`. Subscription-only routing (`subscription_only`) is recommended by default, while `api_fallback` supports automatic OpenAI API backup when configured.
- **Effort & fresh-thread escalation discipline**:
  - Size effort upfront on fresh threads (explicit `medium`/`high`/`xhigh` or `auto_effort`); **never** default to `ultra` and never launch high-effort subagent fan-outs.
  - On failure, timeout, or unverified output, **open a fresh thread (omit `session_id`)** with `opus` / `escalate=true` / `fable` — do not bump effort mid-thread on `resume`.
- **Task quality & handoff**: Send structured Task Packets (Goal, Verified Context/Files, Hard Constraints, Verification Commands, Expected Report). Translate GPT output into clear conclusions, modified files, and test evidence. If unconfigured, run the `gempt` setup flow (`gempt_discover` -> confirm -> `gempt_configure`).
