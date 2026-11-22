'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { collectQoderData } = require('./qoder-data');
const { stateDir } = require('./paths');

const STATE_VERSION = 2;
const STATE_RETENTION_MS = 21 * 24 * 60 * 60 * 1000;
// Qoder bills in credits. Individual plans price a credit at USD 0.01
// (Pro is USD 20 for 2,000 credits). Teams is USD 40 per seat for 3,000
// credits, so its effective credit is 1.333 cents. The plan is read from
// Qoder's own quota snapshot; unknown plans keep the conservative 1-cent rate.
const CREDIT_USD = 0.01;
const TEAMS_CREDIT_USD = 40 / 3000;
const CREDIT_RATE_TTL_MS = 10 * 60 * 1000;
const CREDIT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const CREDIT_LOG_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
let creditRateCache = null;

function startOfLocalDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addLocalDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function parseDateValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : startOfLocalDay(parsed);
}

function parsePeriod(args, now = new Date()) {
  let since = null;
  let until = null;
  let label = 'all';
  let explicit = false;

  const sinceArg = args.since;
  const untilArg = args.until;
  if (sinceArg || untilArg) {
    explicit = true;
    label = sinceArg && untilArg ? `${sinceArg}..${untilArg}` : sinceArg ? `since ${sinceArg}` : `until ${untilArg}`;
    const sinceDate = parseDateValue(sinceArg);
    if (sinceDate) since = startOfLocalDay(sinceDate).getTime();
    const untilDate = parseDateValue(untilArg);
    if (untilDate) until = addLocalDays(startOfLocalDay(untilDate), 1).getTime();
    return { sinceMs: since ?? 0, untilMs: until ?? Number.POSITIVE_INFINITY, label, activeAllowed: !until || Date.now() < until };
  }

  if (args.year) {
    explicit = true;
    const year = Number(args.year);
    if (Number.isInteger(year) && year > 1970) {
      return {
        sinceMs: new Date(year, 0, 1).getTime(),
        untilMs: new Date(year + 1, 0, 1).getTime(),
        label: String(year),
        activeAllowed: new Date().getFullYear() === year
      };
    }
  }
  if (args.today) {
    explicit = true;
    const start = startOfLocalDay(now);
    return { sinceMs: start.getTime(), untilMs: addLocalDays(start, 1).getTime(), label: 'today', activeAllowed: true };
  }
  if (args.yesterday) {
    explicit = true;
    const start = addLocalDays(startOfLocalDay(now), -1);
    return { sinceMs: start.getTime(), untilMs: addLocalDays(start, 1).getTime(), label: 'yesterday', activeAllowed: false };
  }
  if (args.week) {
    explicit = true;
    const start = addLocalDays(startOfLocalDay(now), -6);
    return { sinceMs: start.getTime(), untilMs: addLocalDays(startOfLocalDay(now), 1).getTime(), label: 'week', activeAllowed: true };
  }
  if (args.month) {
    explicit = true;
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
      sinceMs: start.getTime(),
      untilMs: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
      label: 'month',
      activeAllowed: true
    };
  }
  return { sinceMs: 0, untilMs: Number.POSITIVE_INFINITY, label, activeAllowed: true, explicit };
}

function loadState() {
  const file = path.join(stateDir(), 'state.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version === STATE_VERSION && parsed.requests && typeof parsed.requests === 'object') {
      return { file, requests: parsed.requests, changed: false };
    }
  } catch (_) {
    // Missing or unreadable state is the normal first-run path.
  }
  return { file, requests: Object.create(null), changed: false };
}

function saveState(state) {
  if (!state.changed) return;
  try {
    fs.mkdirSync(path.dirname(state.file), { recursive: true });
    const temp = `${state.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: STATE_VERSION, requests: state.requests }));
    fs.renameSync(temp, state.file);
  } catch (_) {
    // A failed cache write must never fail a scan.
  }
}

function readLogTail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function recentQoderMainLogs(logsDir, limit = 10) {
  const files = [];
  const cutoff = Date.now() - CREDIT_LOG_MAX_AGE_MS;
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name === 'main.log') {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs >= cutoff) files.push({ file: full, mtimeMs: stat.mtimeMs });
        } catch (_) {
          // A log rotating under us is not a reason to lose the plan reading.
        }
      }
    }
  };
  walk(logsDir, 0);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((entry) => entry.file);
}

function readQoderPlanFromLogs(appDataDir) {
  for (const file of recentQoderMainLogs(path.join(appDataDir, 'logs'))) {
    let text;
    try {
      text = readLogTail(file, CREDIT_LOG_MAX_BYTES);
    } catch (_) {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.includes('"qoderUsage"') || !line.includes('"userType"')) continue;
      const start = line.indexOf('{"operation":"account.getQuotaUsage"');
      const end = line.lastIndexOf('}');
      if (start < 0 || end <= start) continue;
      try {
        const payload = JSON.parse(line.slice(start, end + 1));
        const userType = String(payload?.qoderUsage?.userType || '').trim().toLowerCase();
        if (userType) return userType;
      } catch (_) {
        // Keep walking older log files.
      }
    }
  }
  return '';
}

function creditUsdRate(appDataDir) {
  const now = Date.now();
  if (creditRateCache && now - creditRateCache.at < CREDIT_RATE_TTL_MS) return creditRateCache.rate;
  const userType = appDataDir ? readQoderPlanFromLogs(appDataDir) : '';
  const rate = /team|enterprise|organization/.test(userType) ? TEAMS_CREDIT_USD : CREDIT_USD;
  creditRateCache = { at: now, rate, userType };
  return rate;
}

// Qoder commits a request in several steps: the buffer projection appears
// first, then JSONL rows, and a half-written transcript can be read between
// them. Counters for one request must never move backwards, or the widget's
// live-rate tracker treats the drop as a new baseline and blanks the rate.
function applyRequestMaxima(requests, state, nowMs) {
  for (const request of requests) {
    const key = `${request.sessionId || ''}\u0000${request.id}`;
    const previous = state.requests[key];
    const sameModel = Boolean(previous && previous.model === request.model);
    const estimatedInput = request.estimatedInput === true;
    const previousEstimatedContext = Boolean(previous && previous.estimatedContext === true);
    if (sameModel) {
      if (!estimatedInput) {
        // Keep the context and its cached slice consistent. Taking separate
        // maxima for input and cacheRead could add up to more than the context a
        // request ever had when the cache estimate moved between scans.
        const context = Math.max(0, (request.inputTokens || 0) + (request.cacheReadTokens || 0));
        // A measured context must never inherit a larger estimate from an
        // earlier scan. Once Qoder exposes real usage, the measurement wins.
        const previousContext = !previousEstimatedContext && Number.isFinite(previous.context)
          ? previous.context
          : 0;
        const previousCache = previousEstimatedContext ? 0 : Math.max(0, previous.cacheRead || 0);
        const mergedContext = Math.max(context, previousContext);
        const cacheRead = Math.min(
          mergedContext,
          Math.max(request.cacheReadTokens || 0, previousCache)
        );
        request.cacheReadTokens = cacheRead;
        request.inputTokens = Math.max(0, mergedContext - cacheRead);
      }
      request.outputTokens = Math.max(request.outputTokens, previous.output || 0);
      request.durationMs = Math.max(request.durationMs, previous.duration || 0);
      request.endedAtMs = Math.max(request.endedAtMs, previous.endedAt || 0);
      const currentStart = request.startedAtMs || previous.startedAt || nowMs;
      request.startedAtMs = previous.startedAt && previous.startedAt > 0
        ? Math.min(currentStart, previous.startedAt)
        : currentStart;
      const previousCredits = Number(previous.credits) || 0;
      if (request.estimatedCredits === true) {
        // A later estimate may rise as the turn grows, but never overwrite an
        // exact turn credit that was already observed.
        request.credits = previous.estimatedCredits === true
          ? Math.max(request.credits || 0, previousCredits)
          : (previousCredits > 0 && previous.estimatedCredits !== true
            ? previousCredits
            : Math.max(request.credits || 0, previousCredits));
      } else if (previous.estimatedCredits === true) {
        // Exact billing replaces an earlier token-based estimate.
        request.credits = request.credits || 0;
      } else {
        request.credits = Math.max(request.credits || 0, previousCredits);
      }
    }
    // Auto-mode requests have no measured input slice. Keep the historical
    // context in state for a future estimator, but never project it into the
    // visible DAY total as if it were this request's fresh input.
    const stateInput = estimatedInput && sameModel ? (previous.input || 0) : request.inputTokens;
    const stateCache = estimatedInput && sameModel ? (previous.cacheRead || 0) : (request.cacheReadTokens || 0);
    const next = {
      model: request.model,
      input: stateInput,
      output: request.outputTokens,
      cacheRead: stateCache,
      context: estimatedInput && sameModel
        ? (Number.isFinite(previous.context) ? previous.context : stateInput + stateCache)
        : (request.inputTokens || 0) + (request.cacheReadTokens || 0),
      duration: request.durationMs,
      endedAt: request.endedAtMs,
      startedAt: request.startedAtMs,
      credits: request.credits || 0,
      estimatedCredits: request.estimatedCredits === true,
      estimatedContext: estimatedInput && request.estimatedContext === true
    };
    if (!previous || previous.input !== next.input || previous.output !== next.output
      || previous.cacheRead !== next.cacheRead || previous.context !== next.context
      || previous.duration !== next.duration || previous.endedAt !== next.endedAt
      || previous.startedAt !== next.startedAt || previous.credits !== next.credits
      || previous.estimatedCredits !== next.estimatedCredits
      || previous.estimatedContext !== next.estimatedContext
      || previous.model !== next.model) {
      state.requests[key] = next;
      state.changed = true;
    }
  }
  const cutoff = nowMs - STATE_RETENTION_MS;
  for (const key of Object.keys(state.requests)) {
    const record = state.requests[key];
    if (!record || !(Number(record.endedAt) >= cutoff)) {
      delete state.requests[key];
      state.changed = true;
    }
  }
}

function sessionIndex(data) {
  const byId = new Map();
  for (const session of data.sessions || []) byId.set(session.sessionId, session);
  for (const [sessionId, meta] of data.sessionMeta || []) {
    if (!byId.has(sessionId)) {
      byId.set(sessionId, {
        sessionId,
        cwd: meta.cwd || '',
        title: meta.title || '',
        firstActiveMs: 0,
        lastActiveMs: 0
      });
    }
  }
  return byId;
}

function isoOrEmpty(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

function projectFields(session) {
  const cwd = String(session?.cwd || '').trim();
  if (!cwd) return { projectId: '', projectLabel: '' };
  return {
    projectId: cwd,
    projectLabel: path.basename(cwd) || cwd
  };
}

function buildEntries(requests, data, options = {}) {
  const creditUsd = Number.isFinite(options.creditUsd) ? options.creditUsd : CREDIT_USD;
  const sessions = sessionIndex(data);
  // Context occupancy is a per-session snapshot, not a per-model sum. The most
  // recent request that measured context wins, and every model row of that
  // session carries the same pair so the renderer's freshest-wins merge cannot
  // flip between rows.
  const sessionContext = new Map();
  for (const request of requests) {
    const sessionId = request.sessionId || '';
    const window = Number(request.window) || 0;
    const tokens = Math.max(0, (Number(request.inputTokens) || 0) + (Number(request.cacheReadTokens) || 0));
    if (!sessionId || !(window > 0) || !(tokens > 0)) continue;
    const endedAt = Number(request.endedAtMs) || 0;
    const previous = sessionContext.get(sessionId);
    if (!previous || endedAt >= previous.endedAt) {
      sessionContext.set(sessionId, { tokens, window, endedAt });
    }
  }
  const groups = new Map();
  for (const request of requests) {
    const sessionId = request.sessionId || '';
    const model = request.model || 'unknown';
    const key = `${sessionId}\u0000${model}`;
    let group = groups.get(key);
    if (!group) {
      const session = sessions.get(sessionId) || {};
      group = {
        sessionId,
        model,
        input: 0,
        output: 0,
        cacheRead: 0,
        thinking: 0,
        duration: 0,
        credits: 0,
        messages: 0,
        startedAtMs: Number.POSITIVE_INFINITY,
        lastUsedMs: 0,
        contextTokens: 0,
        contextWindow: 0,
        lastContextMs: 0,
        estimatedTokens: false,
        estimatedCost: false,
        session
      };
      groups.set(key, group);
    }
    if (request.estimatedInput || request.estimatedContext) group.estimatedTokens = true;
    if (request.estimatedCredits) group.estimatedCost = true;
    group.input += request.inputTokens || 0;
    group.output += request.outputTokens || 0;
    group.cacheRead += request.cacheReadTokens || 0;
    group.thinking += Math.min(request.outputTokens || 0, request.thinkingTokens || 0);
    group.duration += request.durationMs || 0;
    group.credits += request.credits || 0;
    group.messages += 1;
    if (request.startedAtMs) group.startedAtMs = Math.min(group.startedAtMs, request.startedAtMs);
    if (request.endedAtMs) group.lastUsedMs = Math.max(group.lastUsedMs, request.endedAtMs);
    // The session gauge needs the latest request's context, not the sum of
    // every request. Keep the newest pair so a committed turn can still show
    // its prompt-cache/context reading in the session summary.
    if ((request.endedAtMs || 0) >= group.lastContextMs) {
      group.contextTokens = Math.max(0, (request.inputTokens || 0) + (request.cacheReadTokens || 0));
      group.contextWindow = Math.max(0, Number(request.window) || 0);
      group.lastContextMs = request.endedAtMs || 0;
    }
  }

  return [...groups.values()]
    .sort((a, b) => (a.sessionId || '').localeCompare(b.sessionId || '') || a.model.localeCompare(b.model))
    .map((group) => {
      const times = group.session || {};
      const startedAt = Number.isFinite(group.startedAtMs) ? group.startedAtMs : times.firstActiveMs;
      const lastUsedAt = group.lastUsedMs || times.lastActiveMs;
      const tokens = group.input + group.cacheRead + group.output;
      const duration = Math.max(0, Math.round(group.duration));
      const cost = group.credits > 0 ? group.credits * creditUsd : 0;
      const project = projectFields(times);
      return {
        client: 'qoder',
        mergedClients: null,
        model: group.model,
        provider: 'qoder',
        input: Math.max(0, Math.round(group.input)),
        output: Math.max(0, Math.round(group.output)),
        cacheRead: Math.max(0, Math.round(group.cacheRead)),
        cacheWrite: 0,
        reasoning: Math.max(0, Math.round(group.thinking)),
        messageCount: group.messages,
        cost,
        unpricedTokens: cost > 0 ? 0 : tokens,
        performance: {
          msPer1KTokens: tokens > 0 && duration > 0 ? duration * 1000 / tokens : null,
          totalDurationMs: duration,
          timedDurationMs: duration,
          timedTokens: tokens,
          timedOutputTokens: Math.max(0, Math.round(group.output)),
          timedReasoningTokens: Math.max(0, Math.round(group.thinking)),
          sampleCount: group.messages,
          tokenCoverage: tokens > 0 ? 1 : 0
        },
        ...(group.sessionId ? { sessionId: group.sessionId } : {}),
        ...(group.sessionId && sessionContext.has(group.sessionId)
          ? {
            contextTokens: sessionContext.get(group.sessionId).tokens,
            contextWindow: sessionContext.get(group.sessionId).window
          }
          : {}),
        ...(times.title ? { sessionTitle: String(times.title).slice(0, 200) } : {}),
        ...(project.projectId ? { projectId: project.projectId, projectLabel: project.projectLabel } : {}),
        contextTokens: Math.max(0, Math.round(group.contextTokens)),
        contextWindow: Math.max(0, Math.round(group.contextWindow)),
        ...(group.estimatedTokens || group.estimatedCost ? { estimated: true } : {}),
        ...(group.estimatedTokens ? { estimatedTokens: true } : {}),
        ...(group.estimatedCost ? { estimatedCost: true } : {}),
        startedAt: isoOrEmpty(startedAt),
        lastUsedAt: isoOrEmpty(lastUsedAt)
      };
    });
}

function sumEntries(entries) {
  const totals = {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalMessages: 0,
    totalCost: 0
  };
  for (const entry of entries) {
    totals.totalInput += entry.input || 0;
    totals.totalOutput += entry.output || 0;
    totals.totalCacheRead += entry.cacheRead || 0;
    totals.totalCacheWrite += entry.cacheWrite || 0;
    totals.totalMessages += entry.messageCount || 0;
    totals.totalCost += entry.cost || 0;
  }
  return totals;
}

function buildUsage(options = {}) {
  const started = Date.now();
  const nowMs = options.nowMs || Date.now();
  const period = options.period || parsePeriod(options.args || {}, new Date(nowMs));
  const data = collectQoderData({
    sinceMs: period.sinceMs,
    untilMs: period.untilMs,
    nowMs,
    active: Boolean(period.activeAllowed)
  });
  const state = loadState();
  const requests = data.requests
    .map((request) => ({ ...request }))
    .filter((request) => request.endedAtMs >= period.sinceMs && request.endedAtMs < period.untilMs);
  applyRequestMaxima(requests, state, nowMs);
  saveState(state);

  const entries = buildEntries(requests, data, { creditUsd: creditUsdRate(data.paths.appDataDir) });
  const totals = sumEntries(entries);
  return {
    report: {
      groupBy: 'client,session,model',
      entries,
      ...totals,
      processingTimeMs: Date.now() - started,
      undatedTokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        reasoning: 0
      }
    },
    period,
    credits: requests.reduce((sum, request) => sum + (request.credits || 0), 0)
  };
}

function localDateKey(ms) {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildQoderGraphData(nowMs = Date.now()) {
  const data = collectQoderData({ sinceMs: 0, nowMs, active: true });
  const creditUsd = creditUsdRate(data.paths.appDataDir);
  const state = loadState();
  const requests = data.requests.map((request) => ({ ...request }));
  applyRequestMaxima(requests, state, nowMs);
  saveState(state);
  const days = new Map();
  for (const request of requests) {
    const date = localDateKey(request.endedAtMs || request.startedAtMs || nowMs);
    let day = days.get(date);
    if (!day) {
      day = { date, input: 0, output: 0, cacheRead: 0, thinking: 0, credits: 0, messages: 0, duration: 0, models: new Map() };
      days.set(date, day);
    }
    const model = request.model || 'unknown';
    let modelEntry = day.models.get(model);
    if (!modelEntry) {
      modelEntry = { model, input: 0, output: 0, cacheRead: 0, thinking: 0, credits: 0, messages: 0 };
      day.models.set(model, modelEntry);
    }
    const input = Math.max(0, Math.round(request.inputTokens || 0));
    const output = Math.max(0, Math.round(request.outputTokens || 0));
    const cacheRead = Math.max(0, Math.round(request.cacheReadTokens || 0));
    const thinking = Math.min(output, Math.max(0, Math.round(request.thinkingTokens || 0)));
    const credits = Math.max(0, Number(request.credits) || 0);
    day.input += input;
    day.output += output;
    day.cacheRead += cacheRead;
    day.thinking += thinking;
    day.credits += credits;
    day.messages += 1;
    day.duration += Math.max(0, Math.round(request.durationMs || 0));
    modelEntry.input += input;
    modelEntry.output += output;
    modelEntry.cacheRead += cacheRead;
    modelEntry.thinking += thinking;
    modelEntry.credits += credits;
    modelEntry.messages += 1;
  }
  const contributions = [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => {
      const tokens = day.input + day.cacheRead + day.output;
      const cost = day.credits > 0 ? day.credits * creditUsd : 0;
      return {
        date: day.date,
        totals: { tokens, cost, messages: day.messages },
        intensity: 0,
        tokenBreakdown: {
          input: day.input,
          output: day.output,
          cacheRead: day.cacheRead,
          cacheWrite: 0,
          reasoning: day.thinking
        },
        clients: [...day.models.values()]
          .sort((a, b) => a.model.localeCompare(b.model))
          .map((model) => ({
            client: 'qoder',
            modelId: model.model,
            providerId: 'qoder',
            tokens: {
              input: model.input,
              output: model.output,
              cacheRead: model.cacheRead,
              cacheWrite: 0,
              reasoning: model.thinking
            },
            cost: model.credits > 0 ? model.credits * creditUsd : 0,
            messages: model.messages,
            unpricedTokens: model.credits > 0 ? 0 : model.input + model.cacheRead + model.output
          })),
        activeTimeMs: day.duration
      };
    });
  const models = [...new Set(contributions.flatMap((day) => day.clients.map((client) => client.modelId)))].sort();
  return {
    meta: {
      generatedAt: new Date(nowMs).toISOString(),
      version: '4.20.0+qoder',
      dateRange: contributions.length
        ? { start: contributions[0].date, end: contributions[contributions.length - 1].date }
        : { start: null, end: null }
    },
    summary: {
      totalTokens: contributions.reduce((sum, day) => sum + day.totals.tokens, 0),
      totalCost: contributions.reduce((sum, day) => sum + day.totals.cost, 0),
      totalDays: contributions.length,
      activeDays: contributions.length,
      averagePerDay: contributions.length
        ? contributions.reduce((sum, day) => sum + day.totals.tokens, 0) / contributions.length
        : 0,
      maxCostInSingleDay: contributions.reduce((max, day) => Math.max(max, day.totals.cost), 0),
      clients: contributions.length ? ['qoder'] : [],
      models
    },
    years: [],
    contributions
  };
}

function graphClientId(client) {
  return String(client?.client || client?.providerId || '').trim().toLowerCase();
}

// Token Monitor 0.93+ ships its own Qoder transcript scanner. Its report
// surface (tokens/messages) can overlap the estimates this bridge injects, and
// the scan path already replaces the native `qoder` entries outright. The graph
// has no such replacement point, so strip native Qoder rows from each real day
// before adding the bridge's own day. Otherwise upgrading Token Monitor would
// double-count Qoder messages and any tokens its native parser can read.
function stripNativeQoderFromGraphDay(day) {
  if (!day || typeof day !== 'object' || !Array.isArray(day.clients)) return day;
  const removed = [];
  const kept = day.clients.filter((client) => {
    if (graphClientId(client) !== 'qoder') return true;
    removed.push(client);
    return false;
  });
  if (!removed.length) return day;
  const amount = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  let tokens = 0;
  let cost = 0;
  let messages = 0;
  const breakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const client of removed) {
    const parts = client?.tokens && typeof client.tokens === 'object' ? client.tokens : {};
    tokens += amount(parts.input) + amount(parts.output) + amount(parts.cacheRead) + amount(parts.cacheWrite);
    cost += amount(client?.cost);
    messages += amount(client?.messages);
    for (const field of Object.keys(breakdown)) breakdown[field] += amount(parts[field]);
  }
  const next = { ...day, clients: kept };
  if (day.totals && typeof day.totals === 'object') {
    next.totals = {
      ...day.totals,
      tokens: Math.max(0, Number(day.totals.tokens || 0) - tokens),
      cost: Math.max(0, Number(day.totals.cost || 0) - cost),
      messages: Math.max(0, Number(day.totals.messages || 0) - messages)
    };
  }
  if (day.tokenBreakdown && typeof day.tokenBreakdown === 'object') {
    const breakdownNext = { ...day.tokenBreakdown };
    for (const [field, value] of Object.entries(breakdown)) {
      if (value > 0) breakdownNext[field] = Math.max(0, Number(breakdownNext[field] || 0) - value);
    }
    next.tokenBreakdown = breakdownNext;
  }
  return next;
}

function mergeGraphData(real, qoder) {
  const merged = {
    ...real,
    contributions: [...(real?.contributions || [])].map(stripNativeQoderFromGraphDay)
  };
  const byDate = new Map(merged.contributions.map((day) => [day.date, day]));
  for (const qoderDay of qoder.contributions) {
    let day = byDate.get(qoderDay.date);
    if (!day) {
      day = { ...qoderDay };
      merged.contributions.push(day);
      byDate.set(day.date, day);
      continue;
    }
    day.totals = day.totals && typeof day.totals === 'object' ? day.totals : { tokens: 0, cost: 0, messages: 0 };
    day.totals.tokens = Number(day.totals.tokens || 0) + qoderDay.totals.tokens;
    day.totals.cost = Number(day.totals.cost || 0) + Number(qoderDay.totals.cost || 0);
    day.totals.messages = Number(day.totals.messages || 0) + qoderDay.totals.messages;
    day.tokenBreakdown = day.tokenBreakdown && typeof day.tokenBreakdown === 'object' ? day.tokenBreakdown : {};
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
      if (qoderDay.tokenBreakdown[field]) {
        day.tokenBreakdown[field] = Number(day.tokenBreakdown[field] || 0) + qoderDay.tokenBreakdown[field];
      }
    }
    day.clients = [...(Array.isArray(day.clients) ? day.clients : []), ...qoderDay.clients];
    day.activeTimeMs = Number(day.activeTimeMs || 0) + qoderDay.activeTimeMs;
  }
  merged.contributions.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const summary = merged.summary && typeof merged.summary === 'object' ? merged.summary : {};
  summary.totalTokens = merged.contributions.reduce((sum, day) => sum + Number(day.totals?.tokens || 0), 0);
  summary.totalCost = merged.contributions.reduce((sum, day) => sum + Number(day.totals?.cost || 0), 0);
  summary.totalDays = merged.contributions.length;
  summary.activeDays = merged.contributions.filter((day) => Number(day.totals?.tokens || 0) > 0).length;
  summary.averagePerDay = summary.totalDays ? summary.totalTokens / summary.totalDays : 0;
  summary.maxCostInSingleDay = merged.contributions.reduce((max, day) => Math.max(max, Number(day.totals?.cost || 0)), 0);
  const clients = new Set(summary.clients || []);
  if (qoder.contributions.length) clients.add('qoder');
  summary.clients = [...clients];
  // Rebuild from the surviving client rows: a model that only existed on a
  // native Qoder row must disappear with that row.
  const models = new Set();
  for (const day of merged.contributions) {
    for (const client of Array.isArray(day.clients) ? day.clients : []) {
      if (client?.modelId) models.add(client.modelId);
    }
  }
  summary.models = [...models];
  merged.summary = summary;
  if (!merged.meta || typeof merged.meta !== 'object') merged.meta = {};
  merged.meta.dateRange = merged.contributions.length
    ? { start: merged.contributions[0].date, end: merged.contributions[merged.contributions.length - 1].date }
    : { start: null, end: null };
  merged.meta.generatedAt = new Date().toISOString();
  return merged;
}

module.exports = {
  applyRequestMaxima,
  buildEntries,
  buildQoderGraphData,
  buildUsage,
  creditUsdRate,
  mergeGraphData,
  parseDateValue,
  parsePeriod,
  sumEntries
};
