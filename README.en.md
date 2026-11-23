# GemPT v0.4.1

[中文文档](./README.md) · [Antigravity Plugin README](./plugin/README.md) · [Third-Party Licenses](./THIRD_PARTY_LICENSES.txt)

GemPT enables Gemini to consult GPT models (`gpt_ask`), delegate repository inspection and coding tasks to Codex (`gpt_run`), and observe or steer runs in real time inside **GemPT Live** (`gpt_ctl`), routed through your local [Magpie](https://github.com/yetone/magpie) gateway.

Runtime code uses only Node.js built-in modules (`>= 20.11.0`). GemPT Live ships prebuilt with full third-party license notices in [THIRD_PARTY_LICENSES.txt](./THIRD_PARTY_LICENSES.txt).

## Prerequisites

- **Node.js `>= 20.11.0`**
- **Magpie `>= 0.1.1340`** ([yetone/magpie](https://github.com/yetone/magpie) / [usemagpie.ai](https://usemagpie.ai)), running locally (default `http://127.0.0.1:3425`) and signed in to ChatGPT/Codex (or configured with API fallback).
- **Magpie-side GemPT plugin**: hosts the `Plugins → GemPT` control page and manages the shared Codex `app-server` (installing Codex CLI alone cannot replace it).
- **Codex CLI** (`npm install -g @openai/codex`, tested with `0.164.0`): required for `gpt_run` repository execution (optional if you only use `gpt_ask`).
- **Git**: required when using `workspace="share"` for isolated worktrees.

## Quick Start (From Scratch)

### 1. Install the Magpie Plugin

Search for **GemPT** directly in the Magpie Plugin Marketplace (published at `v0.4.1` via `github:yizhang-dream/gempt`), or install from the CLI:

```bash
# Recommended: install from the published GitHub release tag (available now)
magpie plugin add github:yizhang-dream/gempt#v0.4.1
```

> **Note:** `gempt` is not yet published on the npm registry; do not run bare `magpie plugin add gempt` yet (it returns 404).

Open **Plugins → GemPT** in Magpie and click **Enable Subscription Config** (or run `gempt init`).

### 2. Install the Antigravity Plugin

```bash
# Recommended: one-command install from the GitHub release tag (available now)
npx --yes github:yizhang-dream/gempt#v0.4.1 install-agy
```

> **Note:** Since `gempt` is not yet published on the npm registry, use the GitHub tag above or install from a local checkout (bare `npx --yes gempt@0.4.1 install-agy` is not yet active).

From a local checkout:
- **Linux / macOS**: `bash install.sh`
- **Windows PowerShell**: `powershell -ExecutionPolicy Bypass -File .\install.ps1`
- **Build a portable Marketplace bundle**: `npm run build:agy-plugin` (outputs self-contained `dist/agy-plugin/`, supports `--out <dir>`, using `${PLUGIN_ROOT}` and relative hook paths)

If `~/bin` is not on your `PATH`, add it to invoke bare `gempt-wait`, or execute the exact `wait_command` returned by `gpt_run` (which includes a fully-quoted fallback).

> **Note:** When the Antigravity plugin is enabled, `rules/AGENTS.md` stays active for conversations. Disable the plugin in Customizations to turn it off.

### 3. Verify First Run

```bash
gempt discover
gempt init --non-interactive
```

Then verify in Antigravity:
1. Consultation: `gpt_ask(goal="Reply with OK")`
2. Read-only delegation: `gpt_run(goal="Summarize repository layout", cwd="/path/to/repo", access="inspect")`, then wait using the returned `wait_command`.

## MCP Tools

| Antigravity stdio (`gempt_gempt`) | Magpie HTTP | Purpose |
| --- | --- | --- |
| `gpt_run` | `gempt_run` | Async Codex execution. Use `access="inspect"` (read-only) or `access="change"` (edits/tests). For parallel edits on the same Git repo, pass `access="change"` + `workspace="share"` (checked out from committed `HEAD`; disallowed with `access="inspect"`). |
| `gpt_ask` | `gempt_ask` | Synchronous consultation with optional `cwd`, `file_paths`, and `session_id`. Use `tier="chore"` for utility tasks such as summarization. |
| `gpt_ctl` | `gempt_ctl` | `status`, `steer`, `interrupt`, or `reply` to `ask_gemini`. Call `gpt_ctl({})` in Antigravity to open **GemPT Live**. |

For new MCP threads, GemPT uses the current Gemini family. Pass `gemini_family` when you know it. Receipts report `paired:<family>` for a pairing or `mcp` when an unknown family uses the default model. Explicit `tier` values remain supported for legacy scripts.

## Control Panel

- **MCP orchestration for Antigravity.** In **Plugins → GemPT → MCP 编排**, pair Hydrogen, Neon, and Carbon with GPT/Codex models or select the default Codex subscription model. The panel also controls reasoning effort, execution permissions, Swarm, and failover, and shows actual token share. Work-split profiles are `0%` off, `15%` heavy-task hints, `35%` source-write gate, `60%` source-write plus a five-step read limit, and `80%` direct delegation plus a two-step read limit. Use `/gempt` for orchestration and `/gempt-chore` for utility consultations.
- **Direct routing groups for other agents and clients.** Use **路由组直连** to preview, create, and copy `group/gempt-sonnet`, `group/gempt-opus`, or `group/gempt-fable`, then select that ID in the client's model picker. The CLI equivalents are `gempt presets --preview` and `gempt presets --apply`.

## Security & Permissions

- Magpie HTTP MCP defaults to `exec: false` (read-only `inspect`, `ask`, and `ctl`). Enable `exec: true` explicitly to allow HTTP clients to write.
- Antigravity stdio `gpt_run` defaults to `access="change"` under the configured Codex sandbox (default `workspace-write`). Set `GEMPT_WORKSPACE_ROOT` to restrict allowed directories.
- `workspace="share"` is blocked for `access="inspect"`, disables target repository Git hooks during `git worktree add`, checks out committed `HEAD` (uncommitted edits stay in the source tree), and verifies worktree ownership. Reclaim clean merged worktrees safely with `gempt prune-worktrees <repo>`.
- GemPT Live defaults to `scope="session"` and does not leak other conversations' runs when unbound (pass `scope="all"` explicitly to list all workspace runs).

## Upgrade & Uninstall

- **Upgrade**: update **GemPT** in the Magpie Plugin Marketplace (or re-run `magpie plugin add github:yizhang-dream/gempt#<tag>`) and run `npx --yes github:yizhang-dream/gempt#<tag> install-agy`.
- **Uninstall**: remove `gempt` from Magpie Plugins, uninstall `gempt` from Antigravity Customizations (or delete `~/.gemini/config/plugins/gempt`), remove `~/bin/gempt-wait*`, and optionally delete `~/.config/gempt/`.

## Development & Verification

```sh
npm test
npm run build:agy-plugin
npm pack --dry-run
```
