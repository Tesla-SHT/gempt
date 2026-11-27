import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isValidSessionId } from './state.mjs';
import { removeBranchWorkspace, removeShareWorktree } from './worktrees.mjs';
import { detectAvailableRunners, preferredRunnerForModel } from './runners/registry.mjs';
import { sweepSwarmMonitors } from './swarm-monitor.mjs';
import { SIDECAR_URI } from './mcp-app.mjs';
import { readJsonSafe, readMagpieStatus, resolveConfigPath, resolveSessionsDir } from '../magpie_plugin/lib/backend.mjs';
import { CLI_CHOICES, DEFAULT_UTILITY, TIER_ORDER, buildTierView, getExecutionConfig } from './config.mjs';
import { readHostContext } from './host-context.mjs';
import {
  ACTIVE_STATES, buildBoardWaitCommand, dispatchRun, interruptRun, readRun, replyToolCall, steerRun, validateExecTimeoutSec,
} from './runs.mjs';
import {
  addWorkerBriefs, archiveChannel, createChannel, listChannels, subscribeChannels, parkWorker, QUOTA_ERROR,
  ensureSwarm, getBoardHead, getSwarmOverview, getWorker, killWorkerRecord, listRoster,
  listUndeliveredForWorker, markDelivered, postBoardMessage, readBoardMessages, readWorkerTurnPosts, resolveSwarmId,
  setSwarmPlan, setSwarmTitle, updateWorker, validateWorkerName,
} from './swarm-bus.mjs';

import { ALL, MAIN, ROLE_WORKER_RE, effectiveChannels, homeChannelOf, validateChannelName } from './swarm-channels.mjs';

const VALID_SWARM_ACTIONS = ['title', 'plan', 'add', 'status', 'model', 'models', 'kill', 'channel'];
const VALID_BOARD_ACTIONS = ['post', 'read', 'wait', 'roster'];

function resolveEngineContext(args = {}, options = {}) {
  const env = options.env || process.env;
  const configPath = resolveConfigPath(options.configPath || env.GEMPT_CONFIG);
  const sessionsDir = resolveSessionsDir(options.sessionsDir || env.GEMPT_SESSIONS_DIR);
  const rawCwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined;
  const cwd = options.root && (rawCwd == null || typeof rawCwd === 'string')
    ? resolve(options.root, rawCwd || '.')
    : rawCwd;
  const hostCtx = readHostContext(configPath, cwd);
  const hostConversationId = (typeof args.host_conversation_id === 'string' && args.host_conversation_id.trim())
    || hostCtx.conversation_id || null;
  const geminiFamily = args.gemini_family || hostCtx.gemini_family || undefined;
  return {
    env,
    configPath,
    sessionsDir,
    cwd,
    hostConversationId,
    geminiFamily,
    dispatchRunImpl: options.dispatchRunImpl || dispatchRun,
    steerRunImpl: options.steerRunImpl || steerRun,
    interruptRunImpl: options.interruptRunImpl || interruptRun,
    replyToolCallImpl: options.replyToolCallImpl || replyToolCall,
    readRunImpl: options.readRunImpl || readRun,
    magpieConfigDir: options.magpieConfigDir || env.MAGPIE_CONFIG_DIR,
    probeTimeoutMs: options.probeTimeoutMs,
    agent: options.agent,
  };
}

export function buildWorkerInstructions({ swarmId, workerName, brief, seq, registry = [], channels, role, forkContext, nativeParent, shardInstruction, owner = 'coordinator' }) {
  const reporting = [
    `- Use \`board_post\` as the main channel for Swarm coordination and delivery. Before ending a completed assignment, you must post \`@${owner} [done] <concise summary>\`.`,
    '- For a direct handoff, tag only the next actor and use `@peer [handoff] <next action>`. After a doorbell, call `board_read` with the referenced #seq in `seqs`.',
    '- Handle routine companion edits within scope, including matching .h/.hpp files, local tests, and non-architectural edge cases. Record decisions in the final report.',
    '- Use `ask_gemini` only for high-risk or destructive actions that need a decision, or a product or requirements ambiguity the repository cannot resolve.',
  ];
  const protocol = [
    'Shared message board protocol:',
    ...reporting,
    '- Use `board_read` to inspect recent messages or specific `#seq` posts, and `board_roster` to see teammates and states.',
    '- To attach screenshots on the board, include lines formatted as: `Screenshot: /absolute/path/to/file.png | caption`.',
    '- CLI fallback (if needed): `gempt board post/read/roster` (GEMPT_SWARM_ID, GEMPT_AGENT_NAME, GEMPT_SESSIONS_DIR are set in env).',
    '- @name is a wakeup doorbell, never a CC. Label interim updates [progress].',
    '- Refer to earlier posts by #seq. Keep posts short, ignore your own posts, and never greet or acknowledge ("ready", "acknowledged").',
    '- When idle call board_wait with the highest seq you actually read. End the turn when parked. mentions_only defaults to true. Set it to false to wake on visible work.',
    '- Use board_swarm to add and manage your own helpers. Ownership is recorded in added_by. Kill your helpers when finished. Killing a parent leaves its helpers running.',
    '- Never poll the board.',
    '- Start your assigned slice immediately. Claim only unassigned work, and read the board before claiming it.',
    '- Without since, board_read gives recent posts oldest first. Use the highest seq you actually read for incremental reads and waits. Passing the head when you have not read the posts can suppress a doorbell.',
    '- A normal turn ending already parks you. board_wait is for idle time and ends your turn; do any board_post in the same turn first.',
    '- A new helper sees its public brief. Use fork only for needed context, and give each helper its own scope and workspace.',
    '- Leave model unspecified to inherit where possible. Model changes retain the logical session; use them for quota or user-directed changes.',
    '- Use @all for decisions or interface changes the whole team needs. Unaddressed posts are visible next time a peer wakes.',

  ];
  return [
    ...(role === 'narrator' ? [
      'Narrator role: observe only. Use board_read and board_wait. Publish Overview data through board_publish_view (view object and optional html). Never post on the board or take on worker work. Use feedback_ack.through_seq and feedback_ack.text to acknowledge feedback in the view.',
    ] : nativeParent ? [`Everything before this turn is @${nativeParent}'s context. Do not redo its work or answer its old requests.`] : protocol),
    '',
    '## Assignment',
    brief,
    ...(owner === 'coordinator' ? [] : [`- Report your result to @${owner} [done].`]),
    ...(registry.some((r) => !r.archived) || channels?.length ? [
      `The board is split into channels, one per work area. You see #main, ${effectiveChannels(role, channels, workerName).map((c) => c === ALL ? 'all channels' : '#' + c).join(', ') || 'your own posts'}, and any post that names you.`,
      `Post your area's work in #${homeChannelOf(role, channels, registry)} by default. Use #main for results, decisions and asks of other areas. @name reaches anyone across channels. board_read with channel reads another channel. @#channel calls on its members.`,
    ] : []),
    ...(forkContext ? [forkContext] : []),
    `Worker identity: @${workerName}`,
    `Swarm: ${swarmId}`,
    `Opening brief: #${seq}`,
    ...(shardInstruction ? [shardInstruction] : []),
    ...(nativeParent && role !== 'narrator' ? ['', 'Shared message board protocol:', ...reporting] : []),
  ].join('\n');
}

async function withHeadNudge(goal, swarmId, worker, sessionsDir) {
  const head = await getBoardHead(swarmId, { sessionsDir });
  if (head <= worker.last_read_seq) return goal;
  return goal + `\n\n[board] The latest message is #${head} (read through #${worker.last_read_seq}). Read any missed posts with board_read before parking.`;
}

function formatBoardMessagesForWorker(messages) {
  return messages.map((m) => `[Board #${m.seq} from @${m.from_agent} (${m.kind})]\n${m.text}`).join('\n\n');
}

function stripSummaryHeader(text) {
  const raw = String(text || '').trim();
  return raw.replace(/^\[mode=[^\]]+\]\s*/i, '').trim();
}

function compactRosterItem(worker) {
  return {
    name: worker.name,
    state: worker.state,
    cli: worker.cli,
    model: worker.model,
    desired_model: worker.desired_model,
    applied_model: worker.applied_model,
    tail_from_seq: worker.tail_from_seq,
    timeout_sec: worker.timeout_sec,
    conversation_id: worker.role === 'coordinator' ? worker.session_id : null,
    tier: worker.tier,
    implicit: worker.implicit,
    board_capable: worker.board_capable ?? false,
    access: worker.access,
    workspace: worker.workspace,
    worktree_path: worker.worktree_path,
    run_id: worker.run_id,
    session_id: worker.session_id,
    task_summary: worker.task_summary,
    role: worker.role,
    added_by: worker.added_by,
    fork_mode: worker.fork_mode,
    channels: effectiveChannels(worker.role, worker.channels, worker.name),
    wake_mode: worker.wake_mode,
    wait_since: worker.wait_since,
    last_read_seq: worker.last_read_seq,
    quota_paused_seq: worker.quota_paused_seq,
    unread: worker.unread,
    last_post_seq: worker.last_post_seq,
    last_post_time: worker.last_post_time,
    last_seq: worker.last_seq,
    parked_on: worker.parked_on,
    error: worker.error,
  };
}

function resolvePendingCallId(worker, sessionsDir, readRunImpl) {
  if (worker.run_id) {
    try {
      const rec = readRunImpl(worker.run_id, sessionsDir);
      if (rec?.state === 'waiting_gemini' && rec?.pending_tool_call?.call_id) {
        return rec.pending_tool_call.call_id;
      }
    } catch { /* Fall back to parked_on. */ }
  }
  if (typeof worker.parked_on === 'string' && worker.parked_on.trim()) {
    if (worker.parked_on.startsWith('board_ask:')) return null;
    return worker.parked_on.replace(/^ask_gemini:/, '').trim();
  }
  return null;
}

export async function routeBoardDeliveries(swarmId, options = {}) {
  const ctx = resolveEngineContext({}, options);
  const overview = await getSwarmOverview(swarmId, { sessionsDir: ctx.sessionsDir, messageLimit: 0 });
  if (!overview) return [];
  const { swarm, roster } = overview;
  const deliveries = [];

  for (let worker of roster) {
    if (worker.implicit || worker.role === 'monitor' || worker.state === 'killed' || (worker.state === 'working' && worker.parked_on?.startsWith('board_wait'))) continue;
    const unread = await listUndeliveredForWorker(swarmId, worker.name, { since: 0, sessionsDir: ctx.sessionsDir });
    if (!unread.length) continue;

    let currentState = worker.state;
    let remainingUnread = unread;

    // 1. If worker is waiting for coordinator/human reply to ask_gemini, answer it directly.
    if (currentState === 'waiting_reply') {
      const replyMsgs = remainingUnread.filter((m) => m.from_agent === 'coordinator' || m.from_agent === 'human');
      if (replyMsgs.length) {
        const callId = resolvePendingCallId(worker, ctx.sessionsDir, ctx.readRunImpl);
        if (worker.run_id && callId) {
          const answer = replyMsgs.map((m) => m.text).join('\n\n');
          const seqs = replyMsgs.map((m) => m.seq);
          try {
            await ctx.replyToolCallImpl(worker.run_id, callId, answer, { sessionsDir: ctx.sessionsDir });
            await markDelivered(swarmId, seqs, worker.name, { sessionsDir: ctx.sessionsDir });
            await updateWorker(swarmId, worker.name, { state: 'working', parked_on: null, error: null }, { sessionsDir: ctx.sessionsDir });
            deliveries.push({ worker: worker.name, mode: 'reply', seqs, run_id: worker.run_id, call_id: callId });
            currentState = 'working';
            remainingUnread = remainingUnread.filter((m) => !seqs.includes(m.seq));
          } catch (err) {
            deliveries.push({ worker: worker.name, mode: 'reply_failed', seqs, error: String(err?.message || err) });
            continue;
          }
        } else if (worker.parked_on?.startsWith('board_ask:')) {
          // board_ask is non-blocking; deliver via steer if still active, or warm-wake below.
          let stillActive = false;
          if (worker.run_id) {
            try {
              const rec = ctx.readRunImpl(worker.run_id, ctx.sessionsDir);
              stillActive = Boolean(rec && ACTIVE_STATES.has(rec.state));
            } catch {
              stillActive = false;
            }
          }
          if (stillActive) {
            const resumed = await updateWorker(swarmId, worker.name, { state: 'working', parked_on: null, error: null },
              { sessionsDir: ctx.sessionsDir, expectedState: 'waiting_reply', expectedRun: worker.run_id });
            if (resumed) {
              worker = resumed;
            } else {
              worker = await getWorker(swarmId, worker.name, { sessionsDir: ctx.sessionsDir });
              // A concurrent delivery may already own the active run.
              if (worker?.state !== 'waiting' && worker?.state !== 'stopped') continue;
              remainingUnread = await listUndeliveredForWorker(swarmId, worker.name, { since: 0, sessionsDir: ctx.sessionsDir });
            }
            currentState = worker.state;
          } else {
            currentState = 'waiting';
          }
        }
      }
      if (!remainingUnread.length) continue;
    }

    // 2. If worker is currently working with an active run, try steering it.
    if (currentState === 'working' && worker.run_id) {
      const seqs = remainingUnread.map((m) => m.seq);
      const formatted = formatBoardMessagesForWorker(remainingUnread);
      try {
        await ctx.steerRunImpl(worker.run_id, formatted, {
          configPath: ctx.configPath,
          sessionsDir: ctx.sessionsDir,
          env: ctx.env,
        });
        await markDelivered(swarmId, seqs, worker.name, { sessionsDir: ctx.sessionsDir });
        deliveries.push({ worker: worker.name, mode: 'steer', seqs, run_id: worker.run_id });
        continue;
      } catch (err) {
        let stillActive = false;
        try {
          const rec = ctx.readRunImpl(worker.run_id, ctx.sessionsDir);
          stillActive = Boolean(rec && ACTIVE_STATES.has(rec.state));
        } catch {
          stillActive = false;
        }
        if (stillActive) {
          deliveries.push({
            worker: worker.name,
            mode: 'deferred',
            seqs,
            run_id: worker.run_id,
            reason: String(err?.message || err),
          });
          continue;
        }
        currentState = 'waiting';
      }
    }

    // 3. If worker is waiting or stopped, warm-wake reusing its session_id & worktree.
    if (currentState === 'waiting' || currentState === 'stopped') {
      const seqs = remainingUnread.map((m) => m.seq);
      const wakeCwd = (worker.workspace === 'branch' ? worker.source_cwd : worker.worktree_path)
        || worker.source_cwd || swarm.cwd;
      if (!wakeCwd) {
        deliveries.push({ worker: worker.name, mode: 'wake_skipped', seqs, reason: 'Worker has no recorded cwd.' });
        continue;
      }
      const desired = worker.desired_runtime;
      const runtime = desired ?? worker;
      const wakeGoal = [
        formatBoardMessagesForWorker(remainingUnread),
        '',
        `Read the referenced #seqs with \`board_read\`. Reply via \`board_post\` (tag only the next actor for a handoff, or \`@${worker.added_by} [done] ...\` when finished).`,
      ].join('\n');
      const prevState = currentState;
      const runId = randomUUID().replaceAll('-', '');
      const claimed = await updateWorker(swarmId, worker.name, {
        state: 'working', parked_on: null, error: null, run_id: runId,
      }, { sessionsDir: ctx.sessionsDir, expectedState: worker.state, expectedRun: worker.run_id });
      if (!claimed) continue;
      try {
        const run = await ctx.dispatchRunImpl({
          run_id: runId, goal: await withHeadNudge(wakeGoal, swarmId, worker, ctx.sessionsDir),
          cwd: wakeCwd,
          timeout_sec: worker.timeout_sec,
          access: worker.access || 'change',
          workspace: worker.worktree_path ? 'inherit' : (worker.workspace || 'inherit'),
          cli: runtime.cli || 'auto',
          ...(runtime.model ? { model: runtime.model } : {}),
          ...(runtime.tier ? { tier: runtime.tier } : {}),
          ...(worker.session_id ? { session_id: worker.session_id } : {}),
          title: `${worker.name}: board #${seqs[seqs.length - 1]}`,
          host_conversation_id: swarm.host_conversation_id || undefined,
          background: true,
          mcp: true,
          sandbox: worker.access === 'inspect' ? 'read-only' : undefined,
          swarm_id: swarmId,
          swarm_agent: worker.name,
        }, {
          swarmWake: true,
          configPath: ctx.configPath,
          sessionsDir: ctx.sessionsDir,
          magpieConfigDir: ctx.magpieConfigDir,
          probeTimeoutMs: ctx.probeTimeoutMs,
          agent: ctx.agent,
          env: {
            ...ctx.env,
            GEMPT_SWARM_ID: swarmId,
            GEMPT_AGENT_NAME: worker.name,
            GEMPT_SESSIONS_DIR: ctx.sessionsDir,
          },
        });
        await markDelivered(swarmId, seqs, worker.name, { sessionsDir: ctx.sessionsDir });
        await updateWorker(swarmId, worker.name, {
          run_id: run.run_id,
          session_id: run.session_id || worker.session_id,
          worktree_path: run.worktree_path || worker.worktree_path,
          ...(desired ? { model: run.model || desired.model, cli: run.cli || desired.cli, tier: run.tier || desired.tier,
            desired_model: run.model || desired.model, applied_model: run.model || desired.model, desired_runtime: null } : {}),
        }, { sessionsDir: ctx.sessionsDir, expectedRun: runId });
        deliveries.push({
          worker: worker.name,
          mode: 'wake',
          seqs,
          run_id: run.run_id,
          session_id: run.session_id || worker.session_id,
        });
      } catch (err) {
        await updateWorker(swarmId, worker.name, {
          state: prevState, run_id: worker.run_id, parked_on: worker.parked_on,
          error: String(err?.message || err),
        }, { sessionsDir: ctx.sessionsDir, expectedRun: runId, expectedState: 'working' });
        deliveries.push({ worker: worker.name, mode: 'wake_failed', seqs, error: String(err?.message || err) });
      }
    }
  }

  return deliveries;
}

export async function onWorkerTurnFinished({
  swarmId, swarmAgent, runId, sessionId, startedAt, outcome, result, error, recovered = false,
  sessionsDir, configPath, env = process.env, dispatchRunImpl, steerRunImpl, replyToolCallImpl, readRunImpl, beforeDelivery,
}) {
  if (!swarmId || !swarmAgent) return null;
  const resolvedSessions = resolveSessionsDir(sessionsDir || env.GEMPT_SESSIONS_DIR);
  const worker = await getWorker(swarmId, swarmAgent, { sessionsDir: resolvedSessions });
  if (!worker) return null;
  if (worker.state === 'killed') return { skipped: true, reason: 'killed' };
  if (runId && (recovered || worker.run_id) && runId !== worker.run_id) return { skipped: true, reason: 'superseded' };

  const finishedOk = outcome?.state === 'finished';
  const nextState = finishedOk ? 'waiting' : 'stopped';
  const errText = finishedOk ? null : String(error?.message || error || outcome?.error?.message || outcome?.error || outcome?.state || 'failed');

  const implicit = outcome?.implicit_swarm_worker === true || worker.implicit;
  const posts = implicit ? [] : await readWorkerTurnPosts(swarmId, swarmAgent, {
    runId, startedAt, sessionsDir: resolvedSessions,
  });
  const authored = posts.filter((msg) => !msg.meta?.auto_summary);
  const lastReport = authored.findLast((msg) => ['message', 'summary', 'handoff'].includes(msg.kind)
    && !/\[progress\]/i.test(msg.text));
  const reported = lastReport && (/\[done\]/i.test(lastReport.text) || lastReport.kind === 'summary'
    || (lastReport.mentions.length > 0 && (lastReport.kind === 'handoff' || /\[handoff\]/i.test(lastReport.text))));

  let autoPost = null;
  if (!implicit && !['monitor', 'narrator'].includes(worker.role) && !reported && !(finishedOk && worker.parked_on?.startsWith('board_wait'))
      && !posts.some((msg) => msg.meta?.auto_summary && msg.kind === (finishedOk ? 'summary' : 'error'))) {
    const summaryText = finishedOk
      ? `@${worker.added_by} [done] ${stripSummaryHeader(result?.text) || 'Turn finished.'}`
      : `@${worker.added_by} [${outcome?.state || 'failed'}] ${errText}`;
    autoPost = await postBoardMessage(swarmId, {
      from: swarmAgent,
      kind: finishedOk ? 'summary' : 'error',
      text: summaryText,
      requestId: runId ? 'turn-finished/' + runId + '/' + nextState : null,
      meta: { run_id: runId || worker.run_id, auto_summary: true },
    }, { sessionsDir: resolvedSessions, skipRateLimit: true });
  }

  const boardStats = {
    board_posts_worker: authored.length,
    board_posts_auto: posts.length - authored.length + Number(Boolean(autoPost)),
  };
  await beforeDelivery?.(boardStats);
  const finished = await updateWorker(swarmId, swarmAgent, {
    state: nextState,
    ...(result?.fork_mode ? { fork_mode: result.fork_mode } : {}),
    cli: result?.cli || outcome?.cli, model: result?.model || outcome?.model, tier: result?.tier || outcome?.tier,
    applied_model: result?.model || outcome?.model || worker.applied_model,
    session_id: result?.session_id || sessionId || worker.session_id,
    parked_on: !recovered && finishedOk && worker.parked_on?.startsWith('board_wait') ? worker.parked_on : null,
    quota_paused_seq: QUOTA_ERROR.test(errText || '') ? await getBoardHead(swarmId, { sessionsDir: resolvedSessions }) : 0,
    error: errText,
  }, { sessionsDir: resolvedSessions, expectedState: worker.state, expectedRun: worker.run_id });
  if (!finished) return { skipped: true, reason: 'state changed' };

  const deliveryOptions = {
    sessionsDir: resolvedSessions,
    configPath,
    env,
    dispatchRunImpl,
    steerRunImpl,
    replyToolCallImpl,
    readRunImpl,
  };
  if (finished.desired_runtime && nextState === 'waiting') {
    const runtime = finished.desired_runtime;
    try {
      await handleSwarmAction({ action: 'model', swarm_id: swarmId, name: swarmAgent, ...runtime }, deliveryOptions);
      const deliveries = !implicit && autoPost ? await routeBoardDeliveries(swarmId, deliveryOptions) : [];
      return { state: nextState, auto_post: autoPost, deliveries, ...boardStats };
    } catch {
      // The queued selection survives a failed dispatch and can apply on a later wake.
    }
  }
  let deliveries = [];
  if (!implicit) {
    const pending = nextState === 'waiting'
      ? await listUndeliveredForWorker(swarmId, swarmAgent, { since: 0, sessionsDir: resolvedSessions })
      : [];
    if (pending.length) {
      await updateWorker(swarmId, swarmAgent, { last_park_blocked_seq: pending.at(-1).seq }, { sessionsDir: resolvedSessions });
    }
    if (pending.length || autoPost) {
      deliveries = await routeBoardDeliveries(swarmId, deliveryOptions);
    }
  }
  return { state: nextState, auto_post: autoPost, deliveries, ...boardStats };
}

function expandWorkerSpecs(args) {
  const baseName = String(args.name || '').trim();
  const brief = String(args.brief || '').trim();
  if (!baseName) throw new Error('`name` is required for swarm add.');
  if (!brief) throw new Error('`brief` is required for swarm add.');

  const tasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : null;
  const count = args.n !== undefined && args.n !== null ? Number(args.n) : 1;
  if (tasks && args.n !== undefined && args.n !== null) {
    throw new Error('Specify either `tasks` or `n`, not both.');
  }
  if (!tasks && (!Number.isInteger(count) || count < 1 || count > 32)) {
    throw new Error('`n` must be an integer between 1 and 32.');
  }
  if (tasks) {
    if (tasks.length > 32) throw new Error('At most 32 sharded tasks are supported.');
    return tasks.map((slice, idx) => {
      const name = validateWorkerName(`${baseName}-${idx + 1}`);
      const cleanSlice = String(slice || '').trim();
      if (!cleanSlice) throw new Error(`Task slice #${idx + 1} must be non-empty.`);
      const shardInstruction = `Assigned slice (${idx + 1}/${tasks.length}): ${cleanSlice}`;
      return {
        name,
        fullBrief: `${brief}\n\n${shardInstruction}`,
        shardInstruction,
        taskSummary: cleanSlice.slice(0, 120),
      };
    });
  }
  if (count > 1) {
    return Array.from({ length: count }, (_, idx) => ({
      name: validateWorkerName(`${baseName}-${idx + 1}`),
      fullBrief: brief,
      shardInstruction: `(copy ${idx + 1} of ${count} in the @${baseName} group; when sharding a directory, list, or stream of @${baseName} posts without per-worker assignments, take items where 0-based index mod ${count} == ${idx} unless directed otherwise)`,
      taskSummary: brief.slice(0, 120),
    }));
  }
  return [{
    name: validateWorkerName(baseName),
    fullBrief: brief,
    taskSummary: brief.slice(0, 120),
  }];
}

export async function handleSwarmAction(args = {}, options = {}) {
  const action = String(args.action || 'status').trim();
  if (!VALID_SWARM_ACTIONS.includes(action)) {
    throw new Error(`Invalid swarm action '${action}'. Choose one of: ${VALID_SWARM_ACTIONS.join(', ')}.`);
  }
  const ctx = resolveEngineContext(args, options);
  const swarmId = await resolveSwarmId({
    swarmId: args.swarm_id,
    hostConversationId: ctx.hostConversationId,
    cwd: ctx.cwd,
    sessionsDir: ctx.sessionsDir,
  });

  const actor = options.actor || args.actor || 'coordinator';
  const storage = { sessionsDir: ctx.sessionsDir, ...(actor === 'coordinator' ? { cwd: ctx.cwd, hostConversationId: ctx.hostConversationId } : {}) };
  let parent;
  if (actor !== 'coordinator') {
    parent = await getWorker(swarmId, actor, storage);
    if (!parent || parent.state === 'killed') throw new Error('Actor must be a live swarm member.');
    if (['title', 'plan'].includes(action)) throw new Error('Only coordinator may edit the title or plan.');
    if (parent.role === 'narrator' && !['status', 'models'].includes(action)) throw new Error('Narrator is read-only.');
  }
  if (action === 'models') {
    const cfg = readJsonSafe(ctx.configPath) || {};
    const detected = detectAvailableRunners(cfg, ctx.env);
    const tiers = TIER_ORDER.map((id) => buildTierView(id, cfg.tiers?.[id], cfg.routing_policy?.default_tier || 'sonnet'));
    const models = new Map();
    const add = (id, tier) => {
      if (!id || typeof id !== 'string') return;
      const item = models.get(id) || { id, model: id, cli: preferredRunnerForModel(id), tiers: [] };
      if (tier && !item.tiers.includes(tier)) item.tiers.push(tier);
      models.set(id, item);
    };
    for (const tier of tiers) {
      add(tier.exec_model || tier.consult_model, tier.id);
      if (args.all) for (const id of [tier.consult_model, tier.escalate_model, ...tier.fallback_models]) add(id, tier.id);
    }
    let gatewayReachable;
    if (args.all) {
      add(cfg.utility?.model || DEFAULT_UTILITY.model, 'chore');
      const catalog = await readMagpieStatus({ configPath: ctx.configPath, probeTimeoutMs: ctx.probeTimeoutMs });
      gatewayReachable = catalog.reachable;
      for (const id of catalog.models || []) add(id);
    }
    const runners = args.all ? detected : detected.filter((runner) => runner.available);
    return { ok: true, swarm_id: swarmId, models: [...models.values()], runners, tiers: tiers.map(({ id }) => id),
      default_cli: getExecutionConfig(cfg).default_cli, ...(args.all ? { gateway_reachable: gatewayReachable } : {}) };
  }
  if (action === 'channel') {
    const { op, channel, topic } = args;
    let message;
    if (op === 'create') message = await createChannel(swarmId, { actor, channel, topic }, storage);
    else if (op === 'archive') message = await archiveChannel(swarmId, { actor, channel }, storage);
    else if (op === 'subscribe' || op === 'unsubscribe') {
      const targets = args.targets || (args.name ? [args.name] : [actor]);
      message = await subscribeChannels(swarmId, { actor, op, channel, targets }, storage);
    } else if (op !== 'list') throw new Error('Invalid channel operation.');
    return { ok: true, swarm_id: swarmId, channels: await listChannels(swarmId, storage), ...(message ? { message } : {}) };
  }
  if (action === 'title') {
    const swarm = await setSwarmTitle(swarmId, args.title, {
      hostConversationId: ctx.hostConversationId,
      cwd: ctx.cwd,
      sessionsDir: ctx.sessionsDir,
    });
    return { ok: true, swarm_id: swarm.id, title: swarm.title };
  }

  if (action === 'plan') {
    const { swarm, updated_tasks } = await setSwarmPlan(
      swarmId,
      { goal: args.goal, tasks: args.tasks, threads: args.threads },
      { hostConversationId: ctx.hostConversationId, cwd: ctx.cwd, sessionsDir: ctx.sessionsDir },
    );
    return {
      ok: true,
      swarm_id: swarm.id,
      goal: { title: swarm.goal_title, line: swarm.goal_line },
      threads: swarm.threads,
      updated_tasks,
    };
  }

  if (action === 'status') {
    const overview = await getSwarmOverview(swarmId, { sessionsDir: ctx.sessionsDir, messageLimit: 0, analytics: true, includeCoordinator: true });
    if (!overview) {
      return {
        ok: true,
        swarm_id: swarmId,
        title: null, open_board: '',
        goal: { title: null, line: null },
        threads: [],
        head: 0,
        roster: [], channels: [], system_attention: [],
      };
    }
    return {
      ok: true,
      swarm_id: overview.swarm.id,
      title: overview.swarm.title, open_board: SIDECAR_URI,
      goal: { title: overview.swarm.goal_title, line: overview.swarm.goal_line },
      threads: overview.swarm.threads,
      head: overview.head,
      channels: overview.channels,
      system_attention: overview.system_attention,
      roster: overview.roster.map(compactRosterItem),
    };
  }

  if (action === 'add') {
    const specs = expandWorkerSpecs(args);
    if (parent?.access === 'inspect' && args.access === 'change') throw new Error('An inspect-only worker can add only inspect helpers.');
    const forkWorker = args.fork && args.fork !== 'coordinator' ? await getWorker(swarmId, args.fork, storage) : null;
    if (args.fork && args.fork !== 'coordinator' && !forkWorker) throw new Error(`Cannot fork unknown member '${args.fork}'.`);
    const isNarrator = args.role === 'narrator' || (!args.role && /^narrator(?:-\d+)?$/.test(args.name || ''));
    const access = isNarrator ? 'inspect' : String(args.access || parent?.access || forkWorker?.access || 'change').trim();
    if (!['change', 'inspect'].includes(access)) throw new Error(`Invalid access '${access}'.`);
    const workspace = String(args.workspace || 'inherit').trim();
    if (!['inherit', 'share', 'branch'].includes(workspace)) throw new Error(`Invalid workspace '${workspace}'.`);
    if (access === 'inspect' && workspace !== 'inherit') {
      throw new Error(`workspace='${workspace}' is not allowed with read-only access ('inspect'); use workspace='inherit'.`);
    }
    const timeoutSec = validateExecTimeoutSec(args.timeout_sec);
    const cfg = readJsonSafe(ctx.configPath) || {};
    const defaultCli = getExecutionConfig(cfg).default_cli;
    const cli = String(args.cli || forkWorker?.cli || parent?.cli || defaultCli || 'auto').trim().toLowerCase() || 'auto';
    if (!CLI_CHOICES.includes(cli)) {
      throw new Error(`Invalid cli '${args.cli}'. Expected one of: ${CLI_CHOICES.join(', ')}.`);
    }
    const inheritedModel = (forkWorker && cli === forkWorker.cli)
      ? forkWorker.model
      : (parent && cli === parent.cli ? parent.model : null);
    const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : inheritedModel || null;
    const tier = typeof args.tier === 'string' && args.tier.trim() ? args.tier.trim() : null;

    await ensureSwarm({ swarmId, ...storage });

    const registry = await listChannels(swarmId, storage);
    if (args.channels !== undefined && (!Array.isArray(args.channels) || args.channels.some((c) => typeof c !== 'string'))) {
      throw new Error('channels must be a list of active channels.');
    }
    const channels = args.channels ? [...new Set(args.channels)] : null;
    if (channels?.includes(ALL) && channels.length > 1) throw new Error('Use * by itself.');
    if (args.role && !['worker', 'monitor', 'narrator'].includes(args.role)) throw new Error('Invalid worker role.');
    const owner = parent ? actor : args.added_by || actor;
    const roleOf = (name) => args.role || (ROLE_WORKER_RE.test(name) ? name.split('-')[0] : 'worker');
    let forkContext;
    let forkSource;
    if (args.fork) {
      const source = forkWorker;
      let session = isValidSessionId(source?.session_id)
        ? readJsonSafe(join(ctx.sessionsDir, `${source.session_id}.json`)) : null;
      if (!session && source?.run_id) {
        try { session = ctx.readRunImpl(source.run_id, ctx.sessionsDir, { readonly: true }); }
        catch { /* The parent may still be starting or its run may have been pruned. */ }
      }
      if (session) {
        const cli = session.cli || 'codex';
        const id = cli === 'codex' ? session.codex_thread_id : session.runner_session_id;
        if (id && session.model) forkSource = { cli, model: session.model, id,
          ...(cli === 'codex' ? { dynamic_board_tools: session.codex_dynamic_board_tools === true } : {}) };
      }
      const recent = await readBoardMessages(swarmId, { ...storage, limit: Infinity });
      const memory = recent.filter((m) => m.from_agent === args.fork || m.meta?.worker === args.fork);
      const lastReply = session?.turns?.findLast((turn) => turn.role === 'assistant')?.content || session?.result?.text;
      forkContext = [source?.brief || source?.task_summary, !memory.length && lastReply, ...memory.map((m) => `#${m.seq} ${m.text}`),
        `Everything before this turn is @${args.fork}'s memory. Do not redo its work or answer its old requests. Follow your own assignment.`].filter(Boolean).join('\n');
    }
    const runIds = specs.map(() => randomUUID().replaceAll('-', ''));
    const briefs = await addWorkerBriefs(swarmId, specs.map((spec, index) => ({
      channel: homeChannelOf(roleOf(spec.name), channels, registry),
      worker: { name: spec.name, run_id: runIds[index], cli, model, tier, access, workspace, source_cwd: ctx.cwd || null, state: 'working',
        timeout_sec: timeoutSec,
        fork_mode: args.fork ? 'summary_fallback' : null,
        role: roleOf(spec.name), channels, added_by: owner, brief: spec.fullBrief, task_summary: spec.taskSummary, parked_on: null, error: null },
    })), storage);
    const spawned = [];
    let lastBriefSeq = 0;
    for (const [index, spec] of specs.entries()) {
      const msg = briefs[index];
      lastBriefSeq = msg.seq;
      const instructions = { swarmId, workerName: spec.name, brief: String(args.brief).trim(), seq: msg.seq, owner,
        role: roleOf(spec.name), registry, channels, shardInstruction: spec.shardInstruction };
      try {
        if (instructions.role === 'monitor') {
          const saved = await updateWorker(swarmId, spec.name, { state: 'waiting', run_id: null, parked_on: 'board_wait' },
            { ...storage, expectedRun: runIds[index] });
          spawned.push({ ...compactRosterItem(saved), brief_seq: msg.seq });
          continue;
        }
        const sourceCwd = ctx.cwd || forkWorker?.worktree_path || forkWorker?.source_cwd;
        const openingWorker = await getWorker(swarmId, spec.name, storage);
        const run = await ctx.dispatchRunImpl({
          run_id: runIds[index], goal: await withHeadNudge(buildWorkerInstructions({ ...instructions, forkContext }), swarmId, openingWorker, ctx.sessionsDir),
          cwd: sourceCwd,
          access,
          workspace: workspace === 'branch' ? 'share' : workspace,
          cli,
          ...(model ? { model } : {}),
          ...(tier ? { tier } : {}),
          ...(timeoutSec !== undefined ? { timeout_sec: timeoutSec } : {}),
          title: `${spec.name}: ${spec.taskSummary.slice(0, 48)}`,
          host_conversation_id: ctx.hostConversationId || undefined,
          gemini_family: ctx.geminiFamily,
          background: true,
          mcp: true,
          sandbox: access === 'inspect' ? 'read-only' : undefined,
          swarm_id: swarmId,
          swarm_agent: spec.name,
          expected_report: `Post your final result via board_post mentioning @${owner} with [done] prefix, listing changed files and verification results.`,
        }, {
          swarmFork: args.fork ? { source: forkSource, parentRunId: forkWorker?.run_id, parentWorker: args.fork,
            prompt: buildWorkerInstructions({ ...instructions, nativeParent: args.fork }) } : undefined,
          configPath: ctx.configPath,
          sessionsDir: ctx.sessionsDir,
          magpieConfigDir: ctx.magpieConfigDir,
          probeTimeoutMs: ctx.probeTimeoutMs,
          agent: ctx.agent,
          env: {
            ...ctx.env,
            GEMPT_SWARM_WORKSPACE_MODE: workspace === 'branch' ? 'branch' : '',
            GEMPT_SWARM_ID: swarmId,
            GEMPT_AGENT_NAME: spec.name,
            GEMPT_SESSIONS_DIR: ctx.sessionsDir,
          },
        });
        const saved = await updateWorker(swarmId, spec.name, {
          run_id: run.run_id,
          session_id: run.session_id,
          cli: run.cli || cli,
          worktree_path: run.worktree_path || null,
          source_cwd: run.source_cwd || run.cwd || ctx.cwd || forkWorker?.source_cwd || null,
          model: run.model || model, desired_model: run.model || model, applied_model: run.model || model,
        }, { sessionsDir: ctx.sessionsDir, expectedRun: runIds[index] });
        spawned.push({ ...compactRosterItem(saved || await getWorker(swarmId, spec.name, storage)), brief_seq: msg.seq });
      } catch (err) {
        for (const remaining of specs.slice(index)) {
          await updateWorker(swarmId, remaining.name, { state: 'stopped', error: String(err?.message || err) }, storage);
        }
        throw err;
      }
    }

    const head = await getBoardHead(swarmId, { sessionsDir: ctx.sessionsDir });
    return {
      ok: true,
      swarm_id: swarmId,
      workers: spawned,
      head, open_board: SIDECAR_URI,
      wait_command: buildBoardWaitCommand(swarmId, { since: lastBriefSeq, env: ctx.env }),
    };
  }

  if (action === 'model') {
    const workerName = validateWorkerName(args.name || actor);
    const overview = await getSwarmOverview(swarmId, { sessionsDir: ctx.sessionsDir, messageLimit: 0 });
    const worker = overview?.roster.find((w) => w.name === workerName);
    if (!worker) throw new Error(`Worker '${workerName}' not found in swarm '${swarmId}'.`);
    if (parent && worker.name !== actor && worker.added_by !== actor) throw new Error('Cannot switch the model of another worker’s helper.');
    if (worker.state === 'killed') throw new Error(`Worker '${workerName}' has been killed and cannot switch models.`);
    if (worker.state !== 'waiting' && worker.state !== 'stopped' && worker.name !== actor) {
      throw new Error(`Worker '${workerName}' must be in 'waiting' or 'stopped' state to switch model (current: ${worker.state}).`);
    }
    const nextModel = args.model !== undefined ? (String(args.model || '').trim() || null) : worker.model;
    const nextTier = args.tier !== undefined ? (String(args.tier || '').trim() || null) : worker.tier;
    const nextCli = args.cli !== undefined ? (String(args.cli || '').trim().toLowerCase() || worker.cli) : worker.cli;
    if (nextCli && !CLI_CHOICES.includes(nextCli)) {
      throw new Error(`Invalid cli '${args.cli}'. Expected one of: ${CLI_CHOICES.join(', ')}.`);
    }
    if (worker.state === 'stopped' || (worker.name === actor && worker.state !== 'waiting')) {
      const queued = await updateWorker(swarmId, workerName, { desired_model: nextModel,
        desired_runtime: { model: nextModel, tier: nextTier, cli: nextCli } },
      { ...storage, expectedState: worker.state, expectedRun: worker.run_id });
      if (!queued) throw new Error('Worker state changed concurrently; retry model switch.');
      return { ok: true, swarm_id: swarmId, worker: compactRosterItem(queued), pending: true };
    }
    const runId = randomUUID().replaceAll('-', '');
    const claimed = await updateWorker(swarmId, workerName, {
      model: nextModel,
      desired_model: nextModel,
      tier: nextTier,
      cli: nextCli,
      state: 'working',
      run_id: runId,
      parked_on: null,
      error: null,
    }, { sessionsDir: ctx.sessionsDir, expectedState: worker.state, expectedRun: worker.run_id });
    if (!claimed) {
      throw new Error(`Worker '${workerName}' state changed concurrently; retry model switch.`);
    }
    const reason = typeof args.reason === 'string' && args.reason.trim() ? ` Reason: ${args.reason.trim()}.` : '';
    let notice;
    let run;
    try {
      notice = await postBoardMessage(swarmId, {
        from: actor,
        kind: 'system',
        text: `@${workerName} Switching runtime to ${nextModel || nextTier || nextCli}.${reason} Resume any unfinished work.`,
        meta: { model_switch: { model: nextModel, tier: nextTier, cli: nextCli } },
      }, { sessionsDir: ctx.sessionsDir });
      await markDelivered(swarmId, [notice.seq], workerName, { sessionsDir: ctx.sessionsDir });
      const resumeCwd = (worker.workspace === 'branch' ? worker.source_cwd : worker.worktree_path)
        || worker.source_cwd || overview.swarm.cwd || ctx.cwd;
      run = await ctx.dispatchRunImpl({
        run_id: runId,
        goal: await withHeadNudge(`[Board #${notice.seq} from @${actor}]\n${notice.text}`, swarmId, worker, ctx.sessionsDir),
        cwd: resumeCwd,
        timeout_sec: worker.timeout_sec,
        access: worker.access || 'change',
        workspace: worker.worktree_path ? 'inherit' : (worker.workspace || 'inherit'),
        cli: nextCli,
        ...(nextModel ? { model: nextModel } : {}),
        ...(nextTier ? { tier: nextTier } : {}),
        ...(worker.session_id ? { session_id: worker.session_id } : {}),
        title: `${workerName}: model switch`,
        host_conversation_id: overview.swarm.host_conversation_id || ctx.hostConversationId || undefined,
        background: true,
        mcp: true,
        sandbox: worker.access === 'inspect' ? 'read-only' : undefined,
        swarm_id: swarmId,
        swarm_agent: workerName,
      }, {
        configPath: ctx.configPath,
        sessionsDir: ctx.sessionsDir,
        magpieConfigDir: ctx.magpieConfigDir,
        probeTimeoutMs: ctx.probeTimeoutMs,
        agent: ctx.agent,
        env: {
          ...ctx.env,
          GEMPT_SWARM_ID: swarmId,
          GEMPT_AGENT_NAME: workerName,
          GEMPT_SESSIONS_DIR: ctx.sessionsDir,
        },
      });
    } catch (err) {
      await updateWorker(swarmId, workerName, {
        state: worker.state,
        run_id: worker.run_id,
        model: worker.model,
        desired_model: worker.desired_model,
        tier: worker.tier,
        cli: worker.cli,
        parked_on: worker.parked_on,
        error: String(err?.message || err),
      }, { sessionsDir: ctx.sessionsDir, expectedRun: runId, expectedState: 'working' });
      throw err;
    }
    const updated = await updateWorker(swarmId, workerName, {
      run_id: run.run_id,
      session_id: run.session_id || worker.session_id,
      worktree_path: run.worktree_path || worker.worktree_path,
      applied_model: run.model || nextModel, desired_runtime: null,
    }, { sessionsDir: ctx.sessionsDir, expectedRun: runId }) || await getWorker(swarmId, workerName, storage);
    return {
      ok: true,
      swarm_id: swarmId,
      worker: compactRosterItem(updated),
      seq: notice.seq,
      run_id: run.run_id,
    };
  }

  if (action === 'kill') {
    const workerName = validateWorkerName(args.name);
    const roster = await listRoster(swarmId, storage);
    const exact = roster.find((w) => w.name === workerName);
    const group = new RegExp('^' + workerName + '-\\d+$');
    const targets = exact ? [exact] : roster.filter((w) => w.state !== 'killed' && group.test(w.name));
    if (!targets.length) throw new Error(`Worker '${workerName}' not found in swarm '${swarmId}'.`);
    if (parent && targets.some((w) => w.added_by !== actor)) throw new Error('Cannot kill a helper added by another member.');
    let interrupted = false;
    const workers = [];
    const cleaned_workspaces = [];
    for (const worker of targets) {
      const killed = await killWorkerRecord(swarmId, worker.name, {
        ...storage, expectedState: worker.state, expectedRun: worker.run_id,
      });
      if (!killed) throw new Error(`Worker '${worker.name}' changed state concurrently; retry kill.`);
      let safeToClean = !['working', 'waiting_reply'].includes(worker.state);
      if (worker.run_id && ['working', 'waiting_reply'].includes(worker.state)) {
        try {
          const result = await ctx.interruptRunImpl(worker.run_id, { configPath: ctx.configPath, sessionsDir: ctx.sessionsDir, env: ctx.env });
          let settled = result;
          if (result?.cleared_unconfirmed) {
            try { settled = ctx.readRunImpl(worker.run_id, ctx.sessionsDir, { readonly: true }); }
            catch { /* Remote acknowledgement alone cannot prove that the workspace is idle. */ }
          }
          safeToClean = settled && !settled.remote_turn_unconfirmed && ['finished', 'failed', 'interrupted', 'stopped'].includes(settled.state);
          interrupted = true;
        } catch { /* A completed run can still be marked killed. */ }
      }
      if (safeToClean && worker.worktree_path && worker.source_cwd && ['share', 'branch'].includes(worker.workspace)) {
        try {
          const clean = worker.workspace === 'branch' ? removeBranchWorkspace : removeShareWorktree;
          if (clean(worker.source_cwd, worker.worktree_path, ctx.env, storage)) {
            cleaned_workspaces.push(worker.worktree_path);
            killed.worktree_path = null;
            await updateWorker(swarmId, worker.name, { worktree_path: null }, storage);
          }
        } catch { /* Keep isolation data when ownership or Git cleanliness cannot be verified. */ }
      }
      workers.push(compactRosterItem(killed));
    }
    return { ok: true, swarm_id: swarmId, worker: workers[0], workers, interrupted, cleaned_workspaces };
  }
}

export async function handleBoardAction(args = {}, options = {}) {
  const action = String(args.action || 'read').trim();
  if (!VALID_BOARD_ACTIONS.includes(action)) {
    throw new Error(`Invalid board action '${action}'. Choose one of: ${VALID_BOARD_ACTIONS.join(', ')}.`);
  }
  const ctx = resolveEngineContext(args, options);
  const swarmId = await resolveSwarmId({
    swarmId: args.swarm_id,
    hostConversationId: ctx.hostConversationId,
    cwd: ctx.cwd,
    sessionsDir: ctx.sessionsDir,
  });

  if (action === 'post') {
    const from = String(args.from || options.defaultFrom || 'coordinator').trim().toLowerCase() || 'coordinator';
    const worker = !args.channel && !['coordinator', 'human'].includes(from) && await getWorker(swarmId, from, { sessionsDir: ctx.sessionsDir });
    const channel = args.channel || (worker && homeChannelOf(worker.role, worker.channels, await listChannels(swarmId, { sessionsDir: ctx.sessionsDir }))) || MAIN;
    const message = await postBoardMessage(swarmId, {
      from, channel, requestId: args.request_id,
      kind: args.kind || 'message',
      text: args.text,
      mentions: args.mentions,
      screenshots: args.screenshots,
      replyToSeq: args.reply_to_seq,
      meta: args.meta,
    }, { sessionsDir: ctx.sessionsDir,
      ...(!options.actor || options.actor === 'coordinator' ? { hostConversationId: ctx.hostConversationId, cwd: ctx.cwd } : {}) });
    const deliveryOptions = { ...options, configPath: ctx.configPath, sessionsDir: ctx.sessionsDir, env: ctx.env };
    const deliveries = await routeBoardDeliveries(swarmId, deliveryOptions);
    // A dormant monitor has no live model turn or daemon tick. An incoming
    // post still lets its persisted state wake immediately.
    await sweepSwarmMonitors({ swarmId, sessionsDir: ctx.sessionsDir, env: ctx.env,
      dispatchAlert: async (id) => { deliveries.push(...await routeBoardDeliveries(id, deliveryOptions)); } });
    return { ok: true, swarm_id: swarmId, message, head: message.seq, deliveries, ...(message.warnings ? { warnings: message.warnings } : {}) };
  }

  if ((action === 'read' && args.status) || action === 'roster') {
    const status = await handleSwarmAction({ action: 'status', swarm_id: swarmId }, options);
    return { ok: true, swarm_id: swarmId, head: status.head, roster: status.roster };
  }
  if (action === 'read') {
    const messages = await readBoardMessages(swarmId, {
      since: args.since,
      channel: args.channel,
      viewer: args.viewer || args.from || 'coordinator',
      seqs: args.seqs,
      limit: args.limit ?? 20,
      sessionsDir: ctx.sessionsDir,
    });
    const head = await getBoardHead(swarmId, { sessionsDir: ctx.sessionsDir });
    return { ok: true, swarm_id: swarmId, head, messages };
  }

  if (action === 'wait') {
    const head = await getBoardHead(swarmId, { sessionsDir: ctx.sessionsDir });
    if (args.since != null && (!Number.isSafeInteger(args.since) || args.since < 0 || args.since > head)) {
      throw new Error('Pass a sequence actually read, at or below the current board head.');
    }
    const since = args.since !== undefined && args.since !== null
      ? Math.max(0, Math.trunc(Number(args.since) || 0))
      : head;
    const mentionsOnly = args.mentions_only !== false;
    const channel = args.channel;
    if (channel && ![MAIN, ALL].includes(channel)) validateChannelName(channel);
    const viewer = args.viewer || args.from;
    if (viewer && !['coordinator', 'human'].includes(viewer)) {
      const storage = { sessionsDir: ctx.sessionsDir };
      const parked = await parkWorker(swarmId, viewer, { ...storage, since: args.since, mentionsOnly, channel });
      if (!parked) throw new Error('Unknown worker.');
      const messages = await listUndeliveredForWorker(swarmId, viewer, { ...storage, since, channel, includeDelivered: true });
      if (messages.length) {
        const seq = messages.at(-1).seq;
        await updateWorker(swarmId, viewer, { last_park_blocked_seq: seq, parked_on: null }, storage);
      }
      return { ok: true, swarm_id: swarmId, head, since, mentions_only: mentionsOnly, parked: !messages.length,
        park_blocked: !!messages.length, messages };
    }
    await updateWorker(swarmId, 'coordinator', { state: 'waiting', wake_mode: mentionsOnly ? 'mentions' : 'anything', wait_since: since },
      { sessionsDir: ctx.sessionsDir });
    const wait_command = buildBoardWaitCommand(swarmId, { since, mentionsOnly, env: ctx.env })
      + (channel ? ` --channel "${channel}"` : '');
    return { ok: true, swarm_id: swarmId, since, head, mentions_only: mentionsOnly, wait_command };
  }
}
