/**
 * Deterministic, auditable effort routing, timeout floors, and escalation hints.
 * Kept 1:1 with src/gempt/routing.py.
 */

export const AUTO_EFFORT_CANDIDATES = Object.freeze(['low', 'medium', 'high', 'xhigh']);

export const EFFORT_EXEC_TIMEOUT_SEC = Object.freeze({
  none: 300,
  minimal: 300,
  low: 450,
  medium: 600,
  high: 900,
  xhigh: 1200,
  max: 1200,
  ultra: 1200,
});

export const EFFORT_CONSULT_TIMEOUT_SEC = Object.freeze({
  none: 120,
  minimal: 120,
  low: 150,
  medium: 180,
  high: 240,
  xhigh: 300,
  max: 300,
  ultra: 300,
});

export const TIER_DEFAULT_EFFORTS = Object.freeze({
  sonnet: 'medium',
  opus: 'high',
  fable: 'xhigh',
});

const TIER_BASE_SCORES = Object.freeze({
  sonnet: 1,
  opus: 3,
  fable: 6,
});

const SIGNAL_RULES = [
  [
    3,
    'architecture_concurrency',
    /(?:architect(?:ure|ural)?|migration|state machine|concurren(?:cy|t)|deadlock|race condition|distributed|consensus|架构|状态机|并发|死锁|竞态|迁移)/i,
  ],
  [
    3,
    'math_algorithm',
    /(?:algorithm|proof|theorem|optimi[zs](?:e|ation)|convergen(?:ce|t)|gradient|solver|invariant|math(?:ematic)?|complexity|算法|数学|推导|证明|收敛|求解|不变量)/i,
  ],
  [
    2,
    'security_boundary',
    /(?:security|auth(?:entication|orization)?|sandbox|crypto|permission|privilege|traversal|bypass|vulnerabilit(?:y|ies)|安全|权限|沙箱|鉴权|漏洞)/i,
  ],
  [
    2,
    'deep_debugging',
    /(?:debug(?:ging)?|root cause|flaky|regression|memory leak|oom|segfault|traceback|stack trace|根因|疑难|偶现|内存泄漏|回归)/i,
  ],
  [
    2,
    'multi_file_refactor',
    /(?:refactor|cross-file|cross-module|across files|multi-file|重构|跨文件|跨模块|全链路)/i,
  ],
  [
    1,
    'performance',
    /(?:performance|latency|throughput|benchmark|bottleneck|性能|延迟|吞吐)/i,
  ],
  [
    -2,
    'trivial_routine',
    /(?:typo|rename|comment|docstring|format(?:ting)?|lint|readme|changelog|translat(?:e|ion)|boilerplate|trivial|注释|改名|拼写|格式化|翻译|文档|模板代码)/i,
  ],
  [
    -1,
    'simple_small',
    /(?:simple|quick|minor|small fix|one-line|status check|简单|微调|小修)/i,
  ],
];

export function isAstraModel(modelId) {
  return String(modelId || '').toLowerCase().includes('astra');
}

export function effortTimeoutFloor(effort, { mode = 'exec' } = {}) {
  const key = String(effort || 'medium').trim().toLowerCase();
  const table = mode === 'consult' ? EFFORT_CONSULT_TIMEOUT_SEC : EFFORT_EXEC_TIMEOUT_SEC;
  const fallback = mode === 'consult' ? 180 : 600;
  return table[key] ?? fallback;
}

export function classifyTaskEffort({
  tier,
  tierDefaultEffort,
  modelId = '',
  escalate = false,
  goal = '',
  context = '',
  constraints = '',
  fileCount = 0,
  isResume = false,
} = {}) {
  const cleanTier = String(tier || 'sonnet').trim().toLowerCase() || 'sonnet';
  const baseEffort = String(tierDefaultEffort || TIER_DEFAULT_EFFORTS[cleanTier] || 'medium').trim().toLowerCase();

  if (cleanTier === 'chore') {
    return {
      tier: 'chore',
      effort: baseEffort || 'low',
      score: 0,
      base_score: 0,
      signals: ['chore_fixed'],
      auto_applied: false,
      clamped: false,
      reason: 'chore_tier_fixed',
    };
  }

  if (isResume) {
    return {
      tier: cleanTier,
      effort: baseEffort,
      score: 0,
      base_score: TIER_BASE_SCORES[cleanTier] ?? 1,
      signals: ['resume_locked'],
      auto_applied: false,
      clamped: false,
      reason: 'resume_preserves_thread_effort',
    };
  }

  const baseScore = TIER_BASE_SCORES[cleanTier] ?? 1;
  let score = baseScore;
  const signals = [`tier:${cleanTier}(${baseScore >= 0 ? `+${baseScore}` : baseScore})`];
  const haystack = `${goal}\n${context}\n${constraints}`;

  for (const [delta, name, regex] of SIGNAL_RULES) {
    if (regex.test(haystack)) {
      score += delta;
      signals.push(`${delta >= 0 ? `+${delta}` : delta}:${name}`);
    }
  }

  if (fileCount >= 5) {
    score += 2;
    signals.push('+2:files>=5');
  } else if (fileCount >= 3) {
    score += 1;
    signals.push('+1:files>=3');
  }

  if (String(goal || '').trim().length >= 260) {
    score += 1;
    signals.push('+1:long_goal');
  }

  if (escalate) {
    score += 2;
    signals.push('+2:escalate_requested');
  }

  let candidate;
  if (score <= 0) candidate = 'low';
  else if (score <= 2) candidate = 'medium';
  else if (score <= 5) candidate = 'high';
  else candidate = 'xhigh';

  let clamped = false;
  if ((isAstraModel(modelId) || cleanTier === 'fable') && ['none', 'minimal', 'low', 'medium'].includes(candidate)) {
    candidate = 'high';
    clamped = true;
    signals.push('astra_floor:high');
  }

  return {
    tier: cleanTier,
    effort: candidate,
    score,
    base_score: baseScore,
    signals,
    auto_applied: true,
    clamped,
    reason: 'classified',
  };
}

export function buildEscalationSuggestion({
  mode = 'exec',
  tier = 'sonnet',
  effort = 'medium',
  verificationStatus = '',
  timedOut = false,
  errorMessage = '',
} = {}) {
  const needsHelp = Boolean(
    timedOut || errorMessage || (mode === 'exec' && (verificationStatus === 'failed' || verificationStatus === 'unverified')),
  );
  if (!needsHelp) return '';

  const cleanTier = String(tier || 'sonnet').trim().toLowerCase();
  const cleanEffort = String(effort || 'medium').trim().toLowerCase();

  if (cleanTier === 'sonnet') {
    return (
      "Retry in a fresh thread (omit session_id) with tier='opus' (Sol @ high) "
      + "or tier='opus', escalate=true (Astra @ xhigh). Do not bump effort mid-thread on resume and avoid ultra."
    );
  }
  if (cleanTier === 'opus' && cleanEffort !== 'xhigh') {
    return (
      "Retry in a fresh thread (omit session_id) with tier='opus', escalate=true "
      + "(or tier='fable') for Astra @ xhigh. Do not bump effort mid-thread on resume and avoid ultra."
    );
  }
  return (
    'Already at xhigh/fable; decompose into smaller verified steps or isolate root cause via gempt_consult '
    + 'before starting a fresh thread (omit session_id; avoid ultra).'
  );
}
