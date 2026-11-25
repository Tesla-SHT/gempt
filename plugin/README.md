# GemPT — Antigravity Plugin (v0.10.1)

GemPT lets Gemini in Antigravity consult GPT models (`gpt_ask`), delegate repository inspection and coding tasks to Codex (`gpt_run`), and monitor or steer live runs in the **GemPT** side pane (`gpt_ctl`), routed through your local [Magpie](https://github.com/yetone/magpie) gateway.

Use **Plugins → GemPT** in Magpie to pair Hydrogen, Neon, and Carbon with any model listed by your Magpie gateway and set work split, reasoning effort, and execution permissions. Single tasks and workers share the conversation’s Swarm workbench. Manual AGY `/swarm` workers can run `gempt run` under the same work split.

## Prerequisites

1. **Node.js `>= 20.11.0`** available on `PATH`.
2. **Magpie `>= 0.1.1340`** running locally (default `http://127.0.0.1:3425`) with a signed-in ChatGPT/Codex subscription (or API fallback configured).
3. **Magpie-side GemPT plugin** installed — search for **GemPT** in the Magpie Plugin Marketplace or run `magpie plugin add github:yizhang-dream/gempt#v0.10.1` (`gempt` is not yet published on the npm registry) — and **Codex CLI** (`@openai/codex`) installed if you use `gpt_run` for repository execution.
4. **Git** on `PATH` if you use `workspace="share"` for parallel isolated worktrees.

## Install & Upgrade

- **Magpie side**: install or update **GemPT** from the Magpie Plugin Marketplace, or run `magpie plugin add github:yizhang-dream/gempt#v0.10.1`.
- **Antigravity side**: run `npx --yes github:yizhang-dream/gempt#v0.10.1 install-agy` (or build a portable bundle locally with `npm run build:agy-plugin`).

## What This Bundle Includes

- **MCP Server (`gempt_gempt`)**: `gpt_run`, `gpt_ask`, and `gpt_ctl`. Open [GemPT](sidecar://gempt/gempt_live/) in Antigravity to switch between Live, Overview (including settings), Requests, and Sessions.
- **Slash Skills**: `/gempt` for orchestration and `/gempt-chore` for summaries and other utility consultations.
- **Work-Split Hooks & Rules**: `hooks.json` (`SessionStart`, `PreInvocation`, `PreToolUse`) and `rules/AGENTS.md`.
  > **Note:** `rules/AGENTS.md` remains active for Antigravity conversations whenever this plugin is enabled. Disable the plugin in Customizations to turn it off.

## Security & Permissions

- `gpt_run(access="inspect")` runs read-only and rejects `workspace="share"`.
- `gpt_run(access="change")` uses the Codex sandbox configured in `~/.config/gempt/config.json` (default `workspace-write`) and may optionally be bounded with `GEMPT_WORKSPACE_ROOT`.
- Full documentation, English/Chinese quick starts, upgrade/uninstall steps, and third-party license notices (`THIRD_PARTY_LICENSES.txt`) are available in the [GemPT repository](https://github.com/yizhang-dream/gempt).
