# gempt Collaboration Rules

- **Role split (Human ↔ Gemini, Gemini leads GPT)**:
  - **Gemini** talks with the human, clarifies goals, decomposes work, drafts structured task packets, verifies outputs, and summarizes conclusions clearly. Keep Antigravity's native Gemini on its official channel (never reverse-proxy Antigravity's native Gemini); in external MCP clients, keep Gemini on its Magpie `antigravity/gemini-4-*` channel.
  - **GPT/Codex** handles deep math/algorithm reasoning, second-opinion reviews, and code execution — always routed through the user's local **Magpie** gateway.
- **When to delegate via `gempt`**:
  - Use `gempt_consult` for non-text/math/algorithm reasoning, deep bug diagnosis, architecture second opinions, or free utility summarization/classification (`tier="chore"`). It avoids Codex CLI's ~18K–50K token tool-injection overhead.
  - Use `gempt_exec` when GPT/Codex should read/edit files and run commands/tests inside a workspace.
  - Pick the right tier: `sonnet` (80% daily work), `opus` (complex cross-file engineering; pass `escalate=true` for hard subproblems), `fable` (extreme bugs, core algorithms, long-horizon architecture).
- **Task quality**: Always send structured Task Packets (Goal, Verified Context/Files, Hard Constraints, Verification Commands, Expected Report). Never forward vague human chat verbatim.
- **Human handoff**: Translate dense or opaque GPT/Astra technical output into clear, concise human conclusions, modified files, verification evidence, and open decisions.
- **Unconfigured setup**: If any `gempt_*` tool reports missing config, load the `gempt` skill and run its Initial Setup flow (`gempt_discover` -> confirm user choices -> `gempt_configure`).
