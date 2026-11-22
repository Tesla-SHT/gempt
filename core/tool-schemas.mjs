import { APP_TOOLS, LIVE_META } from './mcp-app.mjs';

function tool(name, description, properties, required, meta) {
  return { name, description, inputSchema: { type: 'object', properties, additionalProperties: false,
    ...(required ? { required } : {}) }, ...(meta ? { _meta: meta } : {}) };
}

export const TOOLS = [
  tool('gpt_run',
    "Async-first headless Codex execution inside cwd. Returns immediately with run_id, session_id, and short wait_command (`gempt-wait <run_id>`). Execute wait_command via run_command(WaitMsBeforeAsync=500) for zero-poll wakeup; pass workspace='share' for parallel repo edits and session_id to resume.",
    {
      goal: { type: 'string', description: 'Task objective, constraints, and verification criteria.' },
      cwd: { type: 'string', description: 'Absolute path to the target workspace directory.' },
      access: { type: 'string', enum: ['change', 'inspect'], default: 'change',
        description: "'change' edits/tests workspace; 'inspect' runs read-only investigation." },
      workspace: { type: 'string', enum: ['inherit', 'share'], default: 'inherit',
        description: "'share' creates/reuses an isolated git worktree bound to session_id." },
      session_id: { type: 'string', description: 'Optional GPT session_id to continue.' },
    }, ['goal', 'cwd']),
  tool('gpt_ask',
    "Fast synchronous GPT HTTP consultation via Magpie (no Codex CLI overhead; receipt <= 3200 chars). Pass file_paths for GPT to read directly; use tier='chore' for free/fast summarization.",
    {
      goal: { type: 'string', description: 'Question, review, summary, or reasoning prompt.' },
      file_paths: { type: 'array', items: { type: 'string' }, description: 'Optional workspace file paths for GPT to read directly.' },
      cwd: { type: 'string', description: 'Optional base directory for relative file_paths.' },
      tier: { type: 'string', enum: ['chore', 'sonnet', 'opus', 'fable'], description: 'Optional tier (chore/sonnet/opus/fable).' },
      session_id: { type: 'string', description: 'Optional consult session_id to continue.' },
    }, ['goal']),
  tool('gpt_ctl',
    'Control runs (steer/interrupt/reply) or read a compact status snapshot (<=500B, no polling) and open GemPT Live. Call with {} to view current session runs in GemPT Live.',
    {
      action: { type: 'string', enum: ['status', 'steer', 'interrupt', 'reply'], default: 'status',
        description: 'Control action (default: status / open GemPT Live).' },
      run_id: { type: 'string', pattern: '^[0-9a-f]{32}$' },
      message: { type: 'string', description: 'Steering message (steer) or answer text (reply).' },
      call_id: { type: 'string', description: 'Pending ask_gemini call_id (reply only).' },
      scope: { type: 'string', enum: ['session', 'all'], default: 'session', description: 'Run listing scope for status / GemPT Live.' },
    }, undefined, LIVE_META),
  ...Object.values(APP_TOOLS),
];
