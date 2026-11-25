import { claudeRunner } from './claude.mjs';
import { codexRunner } from './codex.mjs';
import { declarativeRunners } from './declarative.mjs';
import { geminiRunner } from './gemini.mjs';
import { opencodeRunner } from './opencode.mjs';

const ALL_RUNNERS = [
  codexRunner,
  opencodeRunner,
  claudeRunner,
  geminiRunner,
  ...declarativeRunners,
];

const RUNNER_MAP = new Map(ALL_RUNNERS.map((runner) => [runner.id, runner]));

export const RUNNER_IDS = Object.freeze(ALL_RUNNERS.map((runner) => runner.id));
export const CLI_CHOICES = Object.freeze(['auto', ...RUNNER_IDS]);

export function getRunner(id) {
  const key = String(id || '').trim().toLowerCase();
  return RUNNER_MAP.get(key) || null;
}

export function listRunners() {
  return ALL_RUNNERS.map((runner) => ({
    id: runner.id,
    label: runner.label,
    binary_names: [...runner.binaryNames],
    install_hint: runner.installHint,
    capabilities: { ...runner.capabilities },
  }));
}

export function detectAvailableRunners(cfg = {}, env = process.env, opts = {}) {
  return ALL_RUNNERS.map((runner) => runner.detect(cfg, env, opts));
}

export function preferredRunnerForModel(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return 'codex';
  if (id.startsWith('codex/') || id.startsWith('openai/')) return 'codex';
  if (id.startsWith('claude/') || id.startsWith('anthropic/')) return 'claude';
  if (id.startsWith('gemini/') || id.startsWith('google/')) return 'gemini';
  return 'opencode';
}

export function buildZeroCliError(detected = []) {
  const hints = (detected.length ? detected : listRunners())
    .slice(0, 4)
    .map((r) => `${r.id}: ${r.install_hint}`)
    .join(' | ');
  return {
    ok: false,
    cli: null,
    zero_cli: true,
    error: `未检测到任何已安装的执行 CLI（支持 ${RUNNER_IDS.join(' / ')}）。`
      + `咨询（gpt_ask）仍可正常使用。如需自主执行代码或启动 Swarm，请安装任一受支持 CLI（例如：${hints}）。`,
    install_hints: Object.fromEntries(ALL_RUNNERS.map((r) => [r.id, r.installHint])),
  };
}

export function resolveRunnerId({ requested = '', model = '', cfg = {}, env = process.env, opts = {} } = {}) {
  const rawRequested = String(requested || '').trim().toLowerCase();
  const configuredDefault = String(cfg?.execution?.default_cli || 'auto').trim().toLowerCase() || 'auto';
  const target = rawRequested || configuredDefault || 'auto';

  if (target !== 'auto') {
    const runner = getRunner(target);
    if (!runner) {
      return {
        ok: false,
        cli: null,
        error: `Invalid execution CLI '${target}'. Expected one of: ${CLI_CHOICES.join(', ')}.`,
      };
    }
    const info = runner.detect(cfg, env, opts);
    if (!info.available) {
      return {
        ok: false,
        cli: target,
        runner,
        not_installed: true,
        install_hint: runner.installHint,
        error: `Execution CLI '${runner.label}' (${target}) is not installed. Install with: ${runner.installHint}`,
      };
    }
    return {
      ok: true,
      cli: target,
      runner,
      path: info.path,
      reason: rawRequested ? 'explicit' : 'configured_default',
      info,
    };
  }

  const detected = detectAvailableRunners(cfg, env, opts);
  const installed = detected.filter((entry) => entry.available);
  if (!installed.length) {
    return buildZeroCliError(detected);
  }

  const preferred = preferredRunnerForModel(model);
  const matched = installed.find((entry) => entry.id === preferred);
  if (matched) {
    return {
      ok: true,
      cli: matched.id,
      runner: getRunner(matched.id),
      path: matched.path,
      reason: 'model_affinity',
      info: matched,
    };
  }

  const fallback = installed[0];
  return {
    ok: true,
    cli: fallback.id,
    runner: getRunner(fallback.id),
    path: fallback.path,
    reason: 'priority_fallback',
    info: fallback,
  };
}
