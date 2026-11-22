# GemPT — Antigravity Plugin (v0.3.1)

GemPT lets Gemini in Antigravity consult GPT models (`gpt_ask`), delegate repository inspection and coding tasks to Codex (`gpt_run`), and monitor or steer live runs in the **GemPT Live** side pane (`gpt_ctl`), routed through your local [Magpie](https://github.com/yetone/magpie) gateway.

## Prerequisites

1. **Node.js `>= 20.11.0`** available on `PATH`.
2. **Magpie `>= 0.1.1340`** running locally (default `http://127.0.0.1:3425`) with a signed-in ChatGPT/Codex subscription (or API fallback configured).
3. **Magpie-side GemPT plugin** installed (`magpie plugin add gempt` or `magpie plugin add github:yizhang-dream/gempt`) and **Codex CLI** (`@openai/codex`) installed if you use `gpt_run` for repository execution.
4. **Git** on `PATH` if you use `workspace="share"` for parallel isolated worktrees.

## What This Bundle Includes

- **MCP Server (`gempt_gempt`)**: `gpt_run`, `gpt_ask`, `gpt_ctl`, plus the prebuilt **GemPT Live** MCP App (`ui://gempt/live.html`).
- **Slash Skills**: `/gempt`, `/gempt-sonnet`, `/gempt-opus`, `/gempt-fable`, `/gempt-chore`.
- **Subagent**: `gempt-worker`.
- **Work-Split Hooks & Rules**: `hooks.json` (`SessionStart`, `PreInvocation`, `PreToolUse`) and `rules/AGENTS.md`.
  > **Note:** `rules/AGENTS.md` remains active for Antigravity conversations whenever this plugin is enabled. Disable the plugin in Customizations to turn it off.

## Security & Permissions

- `gpt_run(access="inspect")` runs read-only and rejects `workspace="share"`.
- `gpt_run(access="change")` uses the Codex sandbox configured in `~/.config/gempt/config.json` (default `workspace-write`) and may optionally be bounded with `GEMPT_WORKSPACE_ROOT`.
- Full documentation, English/Chinese quick starts, upgrade/uninstall steps, and third-party license notices (`THIRD_PARTY_LICENSES.txt`) are available in the [GemPT repository](https://github.com/yizhang-dream/gempt).
