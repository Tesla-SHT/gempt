/**
 * Pure analytics aggregations for GemPT's Requests and Sessions dashboards.
 * Mirrors Magpie's Usage -> Requests & Sessions analytics cards without any external deps.
 */

const WEEKDAYS_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function requestElapsedSec(row) {
  if (typeof row?.elapsed_sec === 'number' && Number.isFinite(row.elapsed_sec) && row.elapsed_sec >= 0) {
    return row.elapsed_sec;
  }
  const start = Date.parse(row?.started_at || '');
  const end = Date.parse(row?.finished_at || row?.timestamp || '');
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    const sec = (end - start) / 1000;
    if (sec <= 86400) return sec;
  }
  return null;
}

export function shortProjectName(cwd) {
  const cleaned = String(cwd || '').replace(/[/\\]+$/, '');
  if (!cleaned) return '未记录目录';
  const parts = cleaned.split(/[/\\]+/).filter(Boolean);
  return parts.at(-1) || cleaned;
}

function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localHourKey(date) {
  return `${localDateKey(date)}T${String(date.getHours()).padStart(2, '0')}`;
}

function monthDayLabel(dateKey) {
  const [, m, d] = dateKey.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function mondayIndex(date) {
  return (date.getDay() + 6) % 7;
}

function reqTotalTokens(row) {
  const u = row?.usage || {};
  if (typeof u.total_tokens === 'number' && Number.isFinite(u.total_tokens)) return u.total_tokens;
  const sum = (u.input_tokens || 0) + (u.output_tokens || 0);
  return sum > 0 ? sum : 0;
}

function reqCacheInput(row) {
  if (typeof row?.cacheInput === 'number' && Number.isFinite(row.cacheInput) && row.cacheInput > 0) {
    return row.cacheInput;
  }
  const u = row?.usage || {};
  if (u.cache_hit_rate != null && u.cache_hit_rate > 0 && u.cache_read_tokens != null) {
    return u.cache_read_tokens / u.cache_hit_rate;
  }
  if (u.cache_read_tokens != null && u.input_tokens != null) {
    return Math.max(u.input_tokens, u.cache_read_tokens);
  }
  return 0;
}

function extractCommandName(entry) {
  const raw = (typeof entry === 'string' ? entry : entry?.command) || '';
  let text = String(raw).trim();
  if (!text) return '';
  // Unwrap quoted or unquoted full-path shell wrappers (including paths with spaces like "C:\Program Files\PowerShell\7\pwsh.exe")
  text = text
    .replace(/^(?:"[^"]*(?:powershell|pwsh)(?:\.exe)?"|'[^']*(?:powershell|pwsh)(?:\.exe)?'|(?:[^\s'"]+[/\\])?(?:powershell|pwsh)(?:\.exe)?)\s+(?:-\w+\s+)*-(?:Command|c)\s+['"]?/i, '')
    .replace(/^(?:"[^"]*cmd(?:\.exe)?"|'[^']*cmd(?:\.exe)?'|(?:[^\s'"]+[/\\])?cmd(?:\.exe)?)\s+\/c\s+['"]?/i, '')
    .replace(/^(?:"[^"]*(?:bash|sh|zsh)(?:\.exe)?"|'[^']*(?:bash|sh|zsh)(?:\.exe)?'|(?:[^\s'"]+[/\\])?(?:bash|sh|zsh)(?:\.exe)?)\s+-(?:lc|c)\s+['"]?/i, '')
    .replace(/^(?:\$env:[A-Za-z0-9_]+\s*=\s*[^;\n]+;\s*)+/i, '')
    .replace(/^(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)+/, '')
    .replace(/^(?:cd|Set-Location)\s+[^;&\n]+(?:&&|;)\s*/i, '')
    .replace(/^&\s+/, '')
    .trim();
  let firstToken = '';
  const psAssign = /^\$[A-Za-z0-9_]+\s*=\s*([A-Za-z][A-Za-z0-9_-]*)/.exec(text);
  const quotedExe = /^['"]([^'"]+)['"]/.exec(text);
  if (psAssign) {
    firstToken = psAssign[1];
  } else if (quotedExe) {
    firstToken = quotedExe[1];
  } else {
    firstToken = text.split(/[\s|;&]+/)[0]?.replace(/^['"`(]+|['"`)]+$/g, '') || '';
  }
  if (!firstToken) return '';
  const base = firstToken.split(/[/\\]/).pop() || firstToken;
  const clean = base.replace(/\.(?:exe|cmd|bat|ps1|py|mjs|js)$/i, '').toLowerCase();
  if (!clean || clean.length > 36 || !/^[a-z][a-z0-9_.-]*$/.test(clean)) return '';
  if (['if', 'for', 'foreach', 'while', 'try', 'catch', 'else', 'function', 'return', 'exit', 'true', 'false'].includes(clean)) return '';
  return clean;
}

function collectRequestCommands(row) {
  const seen = new Set();
  const out = [];
  const add = (entry) => {
    const raw = (typeof entry === 'string' ? entry : entry?.command) || '';
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    out.push(raw);
  };
  for (const c of Array.isArray(row?.commands) ? row.commands : []) add(c);
  for (const c of Array.isArray(row?.progress?.recent_commands) ? row.progress.recent_commands : []) add(c);
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function dimensionValue(row, dim) {
  const model = row.model || row.requested_model || '未知模型';
  const provider = row.provider || (model.includes('/') ? model.split('/')[0] : '未知供应商');
  if (dim === 'model') return model;
  if (dim === 'provider') return provider;
  if (dim === 'model_provider') return `${model} · ${provider}`;
  if (dim === 'tier') return row.tier ? (row.tier.charAt(0).toUpperCase() + row.tier.slice(1)) : '未分档';
  return model;
}

function buildBreakdown(requests, dim) {
  const map = new Map();
  for (const row of requests) {
    const key = dimensionValue(row, dim);
    let acc = map.get(key);
    if (!acc) {
      acc = {
        name: key,
        requests: 0,
        failed: 0,
        retried: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_input_sum: 0,
        cost_usd: null,
        unpriced_count: 0,
        speed_sum: 0,
        timed_speed_count: 0,
        ttft_sum: 0,
        timed_ttft_count: 0,
      };
      map.set(key, acc);
    }
    acc.requests += 1;
    if (row.status === 'failed') acc.failed += 1;
    if (row.retried) acc.retried += 1;
    const u = row.usage || {};
    acc.total_tokens += reqTotalTokens(row);
    acc.input_tokens += u.input_tokens || 0;
    acc.output_tokens += u.output_tokens || 0;
    if (u.cache_read_tokens != null) {
      acc.cache_read_tokens += u.cache_read_tokens;
      acc.cache_input_sum += reqCacheInput(row);
    }
    if (row.cost_usd != null) {
      acc.cost_usd = (acc.cost_usd ?? 0) + row.cost_usd;
    } else {
      acc.unpriced_count += 1;
    }
    const spd = row.tokens_per_sec ?? row.output_tokens_per_sec;
    if (typeof spd === 'number' && Number.isFinite(spd) && spd > 0) {
      acc.speed_sum += spd;
      acc.timed_speed_count += 1;
    }
    if (typeof row.ttft_ms === 'number' && Number.isFinite(row.ttft_ms) && row.ttft_ms >= 0) {
      acc.ttft_sum += row.ttft_ms;
      acc.timed_ttft_count += 1;
    }
  }
  return [...map.values()].map((acc) => ({
    name: acc.name,
    requests: acc.requests,
    failed: acc.failed,
    retried: acc.retried,
    total_tokens: acc.total_tokens,
    input_tokens: acc.input_tokens,
    output_tokens: acc.output_tokens,
    cache_read_tokens: acc.cache_read_tokens,
    cache_hit_rate: acc.cache_input_sum > 0 ? Math.min(1, acc.cache_read_tokens / acc.cache_input_sum) : null,
    cost_usd: acc.cost_usd,
    unpriced_count: acc.unpriced_count,
    avg_speed: acc.timed_speed_count > 0 ? acc.speed_sum / acc.timed_speed_count : null,
    timed_speed_count: acc.timed_speed_count,
    avg_ttft_ms: acc.timed_ttft_count > 0 ? acc.ttft_sum / acc.timed_ttft_count : null,
    timed_ttft_count: acc.timed_ttft_count,
  }));
}

function buildRequestBuckets(requests, range, now) {
  const hourly = range === 'today' || range === '24h';
  const slots = [];
  const slotMap = new Map();

  const makeSlot = (key, label) => {
    const slot = {
      key,
      label,
      requests: 0,
      tokens: 0,
      cost_usd: 0,
      speed_sum: 0,
      speed_count: 0,
      by_dim: {
        model: {},
        model_provider: {},
        provider: {},
        tier: {},
      },
    };
    slots.push(slot);
    slotMap.set(key, slot);
    return slot;
  };

  if (range === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    for (let h = 0; h < 24; h += 1) {
      const d = new Date(start.getTime() + h * 3_600_000);
      makeSlot(localHourKey(d), `${String(h).padStart(2, '0')}:00`);
    }
  } else if (range === '24h') {
    const endHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
    for (let i = 23; i >= 0; i -= 1) {
      const d = new Date(endHour.getTime() - i * 3_600_000);
      makeSlot(localHourKey(d), `${String(d.getHours()).padStart(2, '0')}:00`);
    }
  } else {
    let dayCount = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 0;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
    if (!dayCount) {
      const times = requests.map((r) => Date.parse(r.timestamp || '')).filter(Number.isFinite);
      if (times.length) {
        const oldest = new Date(Math.min(...times));
        const oldestMid = new Date(oldest.getFullYear(), oldest.getMonth(), oldest.getDate(), 12, 0, 0, 0);
        const span = Math.round((todayStart - oldestMid) / 86_400_000) + 1;
        dayCount = Math.min(60, Math.max(7, span));
      } else {
        dayCount = 7;
      }
    }
    for (let i = dayCount - 1; i >= 0; i -= 1) {
      const d = new Date(todayStart.getTime() - i * 86_400_000);
      const k = localDateKey(d);
      makeSlot(k, monthDayLabel(k));
    }
  }

  const dims = ['model', 'model_provider', 'provider', 'tier'];
  for (const row of requests) {
    const ms = Date.parse(row.timestamp || '');
    if (!Number.isFinite(ms)) continue;
    const d = new Date(ms);
    const key = hourly ? localHourKey(d) : localDateKey(d);
    const slot = slotMap.get(key);
    if (!slot) continue;
    const tok = reqTotalTokens(row);
    const cost = row.cost_usd || 0;
    const spd = row.tokens_per_sec ?? row.output_tokens_per_sec;
    slot.requests += 1;
    slot.tokens += tok;
    slot.cost_usd += cost;
    if (typeof spd === 'number' && Number.isFinite(spd) && spd > 0) {
      slot.speed_sum += spd;
      slot.speed_count += 1;
    }
    for (const dim of dims) {
      const name = dimensionValue(row, dim);
      let entry = slot.by_dim[dim][name];
      if (!entry) {
        entry = { tokens: 0, cost_usd: 0, requests: 0, speed_sum: 0, speed_count: 0 };
        slot.by_dim[dim][name] = entry;
      }
      entry.tokens += tok;
      entry.cost_usd += cost;
      entry.requests += 1;
      if (typeof spd === 'number' && Number.isFinite(spd) && spd > 0) {
        entry.speed_sum += spd;
        entry.speed_count += 1;
      }
    }
  }

  return {
    bucket_kind: hourly ? 'hour' : 'day',
    buckets: slots.map((slot) => {
      const dimsOut = {};
      for (const dim of dims) {
        const out = {};
        for (const [name, entry] of Object.entries(slot.by_dim[dim])) {
          out[name] = {
            tokens: entry.tokens,
            cost_usd: entry.cost_usd,
            requests: entry.requests,
            avg_speed: entry.speed_count > 0 ? entry.speed_sum / entry.speed_count : null,
          };
        }
        dimsOut[dim] = out;
      }
      return {
        key: slot.key,
        label: slot.label,
        requests: slot.requests,
        tokens: slot.tokens,
        cost_usd: slot.cost_usd,
        avg_speed: slot.speed_count > 0 ? slot.speed_sum / slot.speed_count : null,
        by_dim: dimsOut,
      };
    }),
  };
}

function buildHeatmap53w(requests, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  // End on Sunday of current week so columns are clean 53 full weeks (or end today and pad? Magpie ends at today, aligned Mon..Sun)
  const dow = mondayIndex(today); // 0=Mon..6=Sun
  const totalDays = 52 * 7 + dow + 1;
  const start = new Date(today.getTime() - (totalDays - 1) * 86_400_000);
  const byDay = new Map();
  const days = [];
  for (let i = 0; i < totalDays; i += 1) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const key = localDateKey(d);
    const item = { date: key, tokens: 0, requests: 0, cost_usd: 0 };
    byDay.set(key, item);
    days.push(item);
  }
  for (const row of requests) {
    const ms = Date.parse(row.timestamp || '');
    if (!Number.isFinite(ms)) continue;
    const key = localDateKey(new Date(ms));
    const cell = byDay.get(key);
    if (!cell) continue;
    cell.requests += 1;
    cell.tokens += reqTotalTokens(row);
    cell.cost_usd += row.cost_usd || 0;
  }
  return {
    start_date: days[0]?.date || localDateKey(today),
    end_date: days.at(-1)?.date || localDateKey(today),
    days,
  };
}

export function buildRequestAnalytics(filteredRequests, unclippedRequests, { range = 'all', now = new Date() } = {}) {
  let failed = 0;
  let retried = 0;
  let interrupted = 0;
  let unpricedCount = 0;
  let speedSum = 0;
  let timedSpeedCount = 0;
  let ttftSum = 0;
  let timedTtftCount = 0;
  let elapsedSec = null;
  const workspaces = new Set();

  for (const row of filteredRequests) {
    if (row.status === 'failed') failed += 1;
    if (row.retried) retried += 1;
    if (row.status === 'interrupted') interrupted += 1;
    if (row.cost_usd == null) unpricedCount += 1;
    const spd = row.tokens_per_sec ?? row.output_tokens_per_sec;
    if (typeof spd === 'number' && Number.isFinite(spd) && spd > 0) {
      speedSum += spd;
      timedSpeedCount += 1;
    }
    if (typeof row.ttft_ms === 'number' && Number.isFinite(row.ttft_ms) && row.ttft_ms >= 0) {
      ttftSum += row.ttft_ms;
      timedTtftCount += 1;
    }
    const el = requestElapsedSec(row);
    if (el != null) elapsedSec = (elapsedSec ?? 0) + el;
    if (row.cwd) workspaces.add(row.cwd);
  }

  const total = filteredRequests.length;
  const nonCancelled = Math.max(0, total - interrupted);
  const successRate = nonCancelled > 0 ? Math.max(0, (nonCancelled - failed) / nonCancelled) : null;

  const { bucket_kind, buckets } = buildRequestBuckets(filteredRequests, range, now);
  const breakdowns = {
    model: buildBreakdown(filteredRequests, 'model'),
    model_provider: buildBreakdown(filteredRequests, 'model_provider'),
    provider: buildBreakdown(filteredRequests, 'provider'),
    tier: buildBreakdown(filteredRequests, 'tier'),
  };

  const toSpeedList = (list) => list
    .filter((item) => item.avg_speed != null && item.timed_speed_count > 0)
    .sort((a, b) => (b.avg_speed || 0) - (a.avg_speed || 0) || b.timed_speed_count - a.timed_speed_count)
    .map((item) => ({
      name: item.name,
      avg_speed: item.avg_speed,
      avg_ttft_ms: item.avg_ttft_ms,
      timed_count: item.timed_speed_count,
      requests: item.requests,
    }));

  return {
    extra_summary: {
      failed,
      retried,
      interrupted,
      success_rate: successRate,
      unpriced_count: unpricedCount,
      avg_speed: timedSpeedCount > 0 ? speedSum / timedSpeedCount : null,
      timed_speed_count: timedSpeedCount,
      avg_ttft_ms: timedTtftCount > 0 ? ttftSum / timedTtftCount : null,
      timed_ttft_count: timedTtftCount,
      elapsed_sec: elapsedSec,
      workspaces: workspaces.size,
    },
    bucket_kind,
    buckets,
    breakdowns,
    speed_board: {
      model: toSpeedList(breakdowns.model),
      provider: toSpeedList(breakdowns.provider),
    },
    heatmap_53w: buildHeatmap53w(unclippedRequests || filteredRequests, now),
  };
}

export function buildSessionAnalytics(filteredSessions) {
  const tokenValues = [];
  const activeDays = new Set();
  const projectMap = new Map();
  const modelMap = new Map();
  const unpricedModels = new Set();
  const hourMatrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  const hourCounts = Array.from({ length: 7 }, () => Array(24).fill(0));
  const toolMap = new Map();
  let totalActiveSec = 0;
  let totalTokensAll = 0;
  let totalToolCalls = 0;

  const turnBins = [
    { label: '1 轮', min: 0, max: 1, count: 0 },
    { label: '2–3 轮', min: 2, max: 3, count: 0 },
    { label: '4–7 轮', min: 4, max: 7, count: 0 },
    { label: '8–15 轮', min: 8, max: 15, count: 0 },
    { label: '16+ 轮', min: 16, max: Infinity, count: 0 },
  ];
  const durationBins = [
    { label: '<1 分', min: 0, max: 60, count: 0 },
    { label: '1–5 分', min: 60, max: 300, count: 0 },
    { label: '5–15 分', min: 300, max: 900, count: 0 },
    { label: '15–60 分', min: 900, max: 3600, count: 0 },
    { label: '60+ 分', min: 3600, max: Infinity, count: 0 },
  ];
  const commandBins = [
    { label: '0 次', min: 0, max: 0, count: 0 },
    { label: '1–2 次', min: 1, max: 2, count: 0 },
    { label: '3–5 次', min: 3, max: 5, count: 0 },
    { label: '6–15 次', min: 6, max: 15, count: 0 },
    { label: '16+ 次', min: 16, max: Infinity, count: 0 },
  ];

  const sessionSummaries = [];

  for (const session of filteredSessions) {
    const reqs = Array.isArray(session.requests) ? session.requests : [];
    const sessTokens = session.usage?.total_tokens ?? 0;
    totalTokensAll += sessTokens;
    if (sessTokens > 0) tokenValues.push(sessTokens);

    let sessElapsed = 0;
    let sessCmdCount = 0;
    const sessToolsSeen = new Set();

    for (const r of reqs) {
      const el = requestElapsedSec(r);
      if (el != null) sessElapsed += el;
      const ms = Date.parse(r.timestamp || '');
      if (Number.isFinite(ms)) {
        const d = new Date(ms);
        activeDays.add(localDateKey(d));
        const di = mondayIndex(d);
        const hi = d.getHours();
        hourMatrix[di][hi] += reqTotalTokens(r) || 1;
        hourCounts[di][hi] += 1;
      }
      if (r.cost_usd == null && (r.model || r.requested_model)) {
        unpricedModels.add(r.model || r.requested_model);
      }
      const cmds = collectRequestCommands(r);
      sessCmdCount += cmds.length;
      for (const rawCmd of cmds) {
        const toolName = extractCommandName(rawCmd);
        if (!toolName) continue;
        totalToolCalls += 1;
        let tAcc = toolMap.get(toolName);
        if (!tAcc) {
          tAcc = { name: toolName, calls: 0, sessions: new Set(), projects: new Set(), last_used: '' };
          toolMap.set(toolName, tAcc);
        }
        tAcc.calls += 1;
        tAcc.sessions.add(session.id);
        tAcc.projects.add(shortProjectName(session.cwd));
        if ((r.timestamp || '') > tAcc.last_used) tAcc.last_used = r.timestamp || '';
        sessToolsSeen.add(toolName);
      }
      if (r.pending_tool_call?.tool === 'ask_gemini') {
        totalToolCalls += 1;
        let tAcc = toolMap.get('ask_gemini');
        if (!tAcc) {
          tAcc = { name: 'ask_gemini', calls: 0, sessions: new Set(), projects: new Set(), last_used: '' };
          toolMap.set('ask_gemini', tAcc);
        }
        tAcc.calls += 1;
        tAcc.sessions.add(session.id);
        tAcc.projects.add(shortProjectName(session.cwd));
        if ((r.timestamp || '') > tAcc.last_used) tAcc.last_used = r.timestamp || '';
      }
    }

    if (!reqs.length && session.updated_at) {
      const ms = Date.parse(session.updated_at);
      if (Number.isFinite(ms)) activeDays.add(localDateKey(new Date(ms)));
    }
    if (sessElapsed === 0 && typeof session.elapsed_sec === 'number' && session.elapsed_sec > 0) {
      sessElapsed = session.elapsed_sec;
    }
    totalActiveSec += sessElapsed;

    const projName = shortProjectName(session.cwd);
    let pAcc = projectMap.get(projName);
    if (!pAcc) {
      pAcc = { name: projName, cwd: session.cwd || '', sessions: 0, total_tokens: 0, cost_usd: null };
      projectMap.set(projName, pAcc);
    }
    pAcc.sessions += 1;
    pAcc.total_tokens += sessTokens;
    if (session.cost_usd != null) pAcc.cost_usd = (pAcc.cost_usd ?? 0) + session.cost_usd;

    const modName = session.model || reqs.at(-1)?.model || '未知模型';
    let mAcc = modelMap.get(modName);
    if (!mAcc) {
      mAcc = { name: modName, sessions: 0, total_tokens: 0, cost_usd: null };
      modelMap.set(modName, mAcc);
    }
    mAcc.sessions += 1;
    mAcc.total_tokens += sessTokens;
    if (session.cost_usd != null) mAcc.cost_usd = (mAcc.cost_usd ?? 0) + session.cost_usd;

    const turns = session.turn_count || reqs.length || 1;
    for (const bin of turnBins) {
      if (turns >= bin.min && turns <= bin.max) { bin.count += 1; break; }
    }
    for (const bin of durationBins) {
      if (sessElapsed >= bin.min && sessElapsed < bin.max) { bin.count += 1; break; }
    }
    for (const bin of commandBins) {
      if (sessCmdCount >= bin.min && sessCmdCount <= bin.max) { bin.count += 1; break; }
    }

    sessionSummaries.push({
      id: session.id,
      title: session.title || 'GPT 任务',
      project: projName,
      mode: session.mode,
      model: modName,
      tier: session.tier || '',
      updated_at: session.updated_at || null,
      total_tokens: sessTokens,
      cost_usd: session.cost_usd ?? null,
      active_sec: sessElapsed,
      turn_count: turns,
    });
  }

  tokenValues.sort((a, b) => a - b);
  const medianTokens = percentile(tokenValues, 0.5);
  const p90Tokens = percentile(tokenValues, 0.9);

  const projects = [...projectMap.values()]
    .sort((a, b) => b.total_tokens - a.total_tokens || (b.cost_usd || 0) - (a.cost_usd || 0) || b.sessions - a.sessions)
    .map((p) => ({ ...p, share: totalTokensAll > 0 ? p.total_tokens / totalTokensAll : 0 }));
  const models = [...modelMap.values()]
    .sort((a, b) => b.total_tokens - a.total_tokens || (b.cost_usd || 0) - (a.cost_usd || 0) || b.sessions - a.sessions)
    .map((m) => ({ ...m, share: totalTokensAll > 0 ? m.total_tokens / totalTokensAll : 0 }));

  let maxVal = 0;
  let busiestDay = -1;
  let busiestHour = -1;
  for (let d = 0; d < 7; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      if (hourMatrix[d][h] > maxVal) {
        maxVal = hourMatrix[d][h];
        busiestDay = d;
        busiestHour = h;
      }
    }
  }
  const busiestLabel = busiestDay >= 0
    ? `${WEEKDAYS_ZH[busiestDay]} ${String(busiestHour).padStart(2, '0')}:00`
    : '';

  const topBy = (key) => [...sessionSummaries]
    .sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || b.total_tokens - a.total_tokens)
    .slice(0, 8);

  const topTools = [...toolMap.values()]
    .sort((a, b) => b.calls - a.calls || b.sessions.size - a.sessions.size)
    .slice(0, 10)
    .map((item) => ({
      name: item.name,
      calls: item.calls,
      sessions: item.sessions.size,
      projects: [...item.projects].slice(0, 3),
      last_used: item.last_used,
      share: totalToolCalls > 0 ? item.calls / totalToolCalls : 0,
    }));

  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }

  return {
    extra_summary: {
      sessions: filteredSessions.length,
      median_tokens: medianTokens,
      p90_tokens: p90Tokens,
      unpriced_models: unpricedModels.size,
      active_sec: totalActiveSec,
      active_days: activeDays.size,
      projects: projects.length,
      top_project: projects[0]?.name || '',
      top_project_share: projects[0]?.share || 0,
    },
    projects,
    models,
    hour_matrix: {
      tz,
      matrix: hourMatrix,
      counts: hourCounts,
      max: maxVal,
      busiest_label: busiestLabel,
    },
    top_sessions: {
      by_tokens: topBy('total_tokens'),
      by_cost: topBy('cost_usd'),
      by_active: topBy('active_sec'),
    },
    shapes: {
      total_sessions: filteredSessions.length,
      turns: turnBins.map(({ label, count }) => ({ label, count })),
      duration: durationBins.map(({ label, count }) => ({ label, count })),
      commands: commandBins.map(({ label, count }) => ({ label, count })),
    },
    top_tools: {
      total_calls: totalToolCalls,
      unique_count: toolMap.size,
      items: topTools,
    },
  };
}
