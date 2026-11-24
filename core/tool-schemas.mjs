import { APP_TOOLS, LIVE_META } from './mcp-app.mjs';
import { WORKLOAD } from './assets.mjs';

function tool(name, description, properties, required, meta) {
  return { name, description, inputSchema: { type: 'object', properties, additionalProperties: false,
    ...(required ? { required } : {}) }, ...(meta ? { _meta: meta } : {}) };
}

export const TOOLS = [
  tool('gpt_run',
    "Run Codex in cwd using the current Gemini pairing. Returns run_id, session_id, and wait_command (`gempt-wait <run_id>`). Execute wait_command via run_command(WaitMsBeforeAsync=500) for zero-poll wakeup; pass workspace='share' for parallel repo edits and session_id to resume.",
    {
      goal: { type: 'string', description: 'Task objective, constraints, and verification criteria.' },
      cwd: { type: 'string', description: 'Target workspace directory. Required when the host provides no workspace root.' },
      gemini_family: WORKLOAD.schema.properties.gemini_family,
      host_conversation_id: { type: 'string', description: 'Optional Antigravity conversation ID.' },
      access: { type: 'string', enum: ['change', 'inspect'], default: 'change',
        description: "'change' edits/tests workspace; 'inspect' runs read-only investigation." },
      workspace: { type: 'string', enum: ['inherit', 'share'], default: 'inherit',
        description: "'share' creates/reuses an isolated git worktree bound to session_id." },
      session_id: { type: 'string', description: 'Optional GPT session_id to continue.' },
      title: { type: 'string', description: 'Optional short title for GemPT.' },
      tier: { type: 'string', description: 'Optional explicit Codex tier.' },
      timeout_sec: { type: 'number', minimum: 30, maximum: 7200,
        description: 'Execution timeout in seconds (30–7200, default 3600; excludes waiting_gemini time).' },
      background: { type: 'boolean' },
    }, ['goal']),
  tool('gpt_ask',
    "Fast synchronous GPT consultation through the current Gemini pairing. Pass file_paths for GPT to read directly; use tier='chore' for free/fast summarization.",
    {
      goal: { type: 'string', description: 'Question, review, summary, or reasoning prompt.' },
      file_paths: { type: 'array', items: { type: 'string' }, description: 'Optional workspace file paths for GPT to read directly.' },
      cwd: { type: 'string', description: 'Optional base directory for relative file_paths.' },
      gemini_family: WORKLOAD.schema.properties.gemini_family,
      host_conversation_id: { type: 'string', description: 'Optional Antigravity conversation ID.' },
      tier: { type: 'string', enum: ['chore', 'sonnet', 'opus', 'fable'], description: "Use 'chore' for the utility model. Other explicit tier values support legacy callers." },
      session_id: { type: 'string', description: 'Optional consult session_id to continue.' },
    }, ['goal']),
  tool('gpt_ctl',
    'Control runs (steer/interrupt/reply) or read a compact status snapshot (<=500B, no polling). Open the native GemPT panel at sidecar://gempt/gempt_live/.',
    {
      action: { type: 'string', enum: ['status', 'steer', 'interrupt', 'reply'], default: 'status',
        description: 'Control action (default: status).' },
      run_id: { type: 'string', pattern: '^[0-9a-f]{32}$' },
      message: { type: 'string', description: 'Steering message (steer) or answer text (reply).' },
      call_id: { type: 'string', description: 'Pending ask_gemini call_id (reply only).' },
      host_conversation_id: { type: 'string', description: 'Optional Antigravity conversation ID for status.' },
      scope: { type: 'string', enum: ['session', 'all'], default: 'session', description: 'Run listing scope for status / GemPT.' },
    }, undefined, LIVE_META),
  ...Object.values(APP_TOOLS),
];
