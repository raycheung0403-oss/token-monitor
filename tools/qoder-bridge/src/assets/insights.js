'use strict';

// A persistent "what is happening right now" strip under the total. It follows
// the patterns users already keep in Claude Code / Codex / ccusage status lines
// (model, context headroom, spend, cache) and the per-session spend cards from
// dsh-spend, but it is renderer-only: one IPC listener, one DOM subtree, and no
// timers or extra windows.
//
// The strip always describes the latest session, independent of the selected
// period. Opening it shows the same numbers the app already trusts: session
// totals, the per-model component split and the active provider's quota
// windows. Nothing here writes state or starts collection.
(function usageInsights() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const bridge = window.tokenMonitor;
  if (!bridge?.onStatsPush) return;

  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canAnimate = () => !reduceQuery.matches
    && document.documentElement.dataset.reduceMotion !== 'on';

  const COPY = {
    en: {
      ctx: 'ctx',
      cache: 'cache',
      calls: 'calls',
      quota: 'quota',
      quotaOk: 'on track',
      quotaWatch: 'fast',
      quotaTight: 'low',
      quotaRate: 'At the last 7-day pace, about {left} days left',
      quotaLasts: 'lasts to reset',
      quotaRunsOut: 'runs out before reset',
      quotaIdeal: 'Even burn would leave {ideal} now; actual {actual}',
      quotaAhead: 'ahead by',
      quotaBehind: 'behind by',
      quotaPoint: ' pts',
      unpriced: 'unpriced',
      ctxHigh: 'high',
      ctxLow: 'low',
      cacheWarm: 'warm',
      cacheCold: 'cold',
      todayFrom: 'since 00:00',
      yesterday: 'yesterday',
      costUnpriced: 'cost unpriced',
      estimated: 'est.',
      estimatedLong: 'estimated',
      estimatedHint: '≈ from context and Qoder credits',
      tokens: 'Tokens',
      input: 'Input',
      cached: 'Cached input',
      output: 'Output',
      reasoning: 'Reasoning',
      callsLabel: 'Calls',
      avgSpeed: 'Avg output',
      cost: 'Session cost',
      perMillion: 'Cost / 1M tokens',
      contextLabel: 'Context',
      used: 'used',
      remaining: 'remaining',
      started: 'Started',
      updated: 'Updated',
      models: 'Models',
      limits: 'Limits',
      currentSession: 'Current session',
      fullSession: 'full session',
      stale: 'stale',
      reset: 'resets',
      now: 'now',
      ago: 'ago',
      minute: 'm',
      hour: 'h',
      day: 'd',
      noSession: 'No session yet',
      close: 'Close',
      cachedShort: 'cached',
      more: 'more'
    },
    zh: {
      ctx: '上下文',
      cache: '缓存',
      calls: '调用',
      quota: '额度',
      quotaOk: '够用',
      quotaWatch: '偏快',
      quotaTight: '将尽',
      quotaRate: '按近 7 天速度，约 {left} 天用量',
      quotaLasts: '够用到重置',
      quotaRunsOut: '重置前会用完',
      quotaIdeal: '均衡消耗此刻应剩 {ideal}，实际 {actual}',
      quotaAhead: '领先',
      quotaBehind: '落后',
      quotaPoint: ' 个点',
      unpriced: '未定价',
      ctxHigh: '偏高',
      ctxLow: '将满',
      cacheWarm: '热',
      cacheCold: '冷',
      todayFrom: '今日 00:00 起',
      yesterday: '昨日',
      costUnpriced: '费用未定价',
      estimated: '估',
      estimatedLong: '估算',
      estimatedHint: '≈ 按上下文与 Qoder credits 估算',
      tokens: 'Tokens',
      input: '输入',
      cached: '缓存输入',
      output: '输出',
      reasoning: '推理',
      callsLabel: '调用次数',
      avgSpeed: '平均输出',
      cost: '会话花费',
      perMillion: '每百万 token',
      contextLabel: '上下文',
      used: '已用',
      remaining: '剩余',
      started: '开始于',
      updated: '更新于',
      models: '模型',
      limits: '额度',
      currentSession: '当前会话',
      fullSession: '全会话',
      stale: '快照',
      reset: '重置',
      now: '刚刚',
      ago: '前',
      minute: '分',
      hour: '小时',
      day: '天',
      noSession: '暂无会话',
      close: '关闭',
      cachedShort: '缓存',
      more: '个'
    }
  };

  const CLIENT_LABELS = {
    qoder: 'Qoder',
    qodercn: 'Qoder CN',
    claude: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
    dsh: 'DeepSeek Harness',
    deepseek: 'DeepSeek',
    opencode: 'OpenCode',
    workbuddy: 'WorkBuddy',
    antigravity: 'Antigravity',
    copilot: 'Copilot',
    kimi: 'Kimi',
    zai: 'Z.ai',
    minimax: 'MiniMax',
    volcengine: 'Volcengine',
    unknown: 'Other'
  };

  const state = {
    stats: null,
    settings: null,
    open: false,
    row: null,
    dayKey: '',
    cacheSeed: false
  };
  const refs = {};
  let status = null;
  let card = null;
  let renderFrame = 0;
  let homeBadgeFrame = 0;
  let formatterKey = '';
  let formatter = null;
  let lastSessionKey = '';
  let lastDayRefreshAt = 0;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const QUOTA_HISTORY_KEY = 'tm.quota-history.v1';
  const QUOTA_MAX_POINTS = 120;
  const QUOTA_PERSIST_MS = 60 * 1000;
  let quotaHistory = null;
  let quotaPersistAt = 0;

  function localDayKey(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function previousDayKey() {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return localDayKey(date);
  }

  function activePeriod() {
    return document.querySelector('.tab.active')?.dataset.period || 'today';
  }

  function quotaHistoryStore() {
    if (quotaHistory) return quotaHistory;
    try {
      quotaHistory = JSON.parse(window.localStorage.getItem(QUOTA_HISTORY_KEY) || '{}') || {};
    } catch (_) {
      quotaHistory = {};
    }
    if (!quotaHistory.series || typeof quotaHistory.series !== 'object') quotaHistory.series = {};
    return quotaHistory;
  }

  function quotaSeriesKey(provider, window) {
    return [
      String(provider?.provider || 'unknown'),
      String(window?.kind || ''),
      String(window?.label || ''),
      String(window?.resetsAt || '')
    ].join('|');
  }

  // Persist only real quota moves, and at most once a minute. The series is
  // capped and pruned to the current reset cycle, so it stays a few kilobytes.
  function rememberQuotaHistory(stats) {
    const providers = Array.isArray(stats?.limits?.providers) ? stats.limits.providers : [];
    if (!providers.length) return;
    const store = quotaHistoryStore();
    const now = Date.now();
    let changed = false;
    for (const provider of providers) {
      for (const window of Array.isArray(provider?.windows) ? provider.windows : []) {
        const percent = Number(window?.remainingPercent);
        if (!Number.isFinite(percent)) continue;
        const key = quotaSeriesKey(provider, window);
        const points = Array.isArray(store.series[key]) ? store.series[key] : [];
        const last = points[points.length - 1];
        const resetAt = timeValue(window.resetsAt);
        const cycleStart = resetAt ? resetAt - 32 * DAY_MS : 0;
        if (!last || Math.abs(last.p - percent) >= 0.05 || now - last.t >= 6 * 60 * 60 * 1000) {
          points.push({
            t: now,
            p: Math.round(percent * 100) / 100,
            r: Number(window.remaining) || 0,
            l: Number(window.limit) || 0
          });
          while (points.length > QUOTA_MAX_POINTS) points.shift();
          store.series[key] = points.filter((point) => point.t >= cycleStart && now - point.t <= 40 * DAY_MS);
          changed = true;
        }
      }
    }
    if (changed && now - quotaPersistAt >= QUOTA_PERSIST_MS) {
      quotaPersistAt = now;
      try {
        window.localStorage.setItem(QUOTA_HISTORY_KEY, JSON.stringify(store));
      } catch (_) {
        // Storage can be disabled; the in-memory series still serves this run.
      }
    }
  }

  function quotaPointsFor(provider, window) {
    const store = quotaHistoryStore();
    return store.series[quotaSeriesKey(provider, window)] || [];
  }

  function quotaHealth(provider, window) {
    const c = copy();
    const percent = Number(window?.remainingPercent);
    if (!Number.isFinite(percent)) return null;
    const now = Date.now();
    const resetAt = timeValue(window.resetsAt);
    const hasReset = resetAt > now;
    const daysToReset = hasReset ? (resetAt - now) / DAY_MS : 0;
    const windowMinutes = Number(window?.windowMinutes);
    const cycleMs = windowMinutes > 0 ? windowMinutes * 60 * 1000 : 30 * DAY_MS;
    const ideal = hasReset
      ? Math.max(0, Math.min(100, 100 * (resetAt - now) / cycleMs))
      : null;
    const ahead = ideal == null ? 0 : percent - ideal;
    const points = quotaPointsFor(provider, window)
      .filter((point) => !resetAt || point.t >= resetAt - cycleMs - DAY_MS)
      .slice()
      .sort((left, right) => left.t - right.t);

    let rate = null;
    let daysLeft = null;
    const recent = points.filter((point) => point.t >= now - 7 * DAY_MS);
    if (recent.length >= 2) {
      const first = recent[0];
      const last = recent[recent.length - 1];
      const spanDays = (last.t - first.t) / DAY_MS;
      const drop = first.p - last.p;
      if (spanDays >= 0.25 && drop > 0.05) {
        rate = drop / spanDays;
        daysLeft = last.p / rate;
      }
    }

    let tone = 'ok';
    if (percent < 20) tone = 'tight';
    else if (percent < 50) tone = 'watch';
    if (daysLeft != null) {
      if (daysLeft < daysToReset * 0.85) tone = 'tight';
      else if (daysLeft < daysToReset * 1.15) tone = 'watch';
    } else if (ahead < -10 && tone === 'ok') {
      tone = 'watch';
    }

    const short = tone === 'tight' ? c.quotaTight : tone === 'watch' ? c.quotaWatch : c.quotaOk;
    let detail;
    if (daysLeft != null) {
      const leftText = daysLeft >= 45 ? '45+' : String(Math.max(1, Math.round(daysLeft)));
      detail = c.quotaRate.replace('{left}', leftText);
      if (daysToReset > 0) detail += ` · ${daysLeft >= daysToReset ? c.quotaLasts : c.quotaRunsOut}`;
    } else if (ideal != null) {
      detail = c.quotaIdeal
        .replace('{ideal}', `${Math.round(ideal)}%`)
        .replace('{actual}', `${Math.round(percent)}%`);
      detail += ` · ${ahead >= 0 ? c.quotaAhead : c.quotaBehind} ${Math.abs(Math.round(ahead))}${c.quotaPoint}`;
    } else {
      detail = '';
    }
    return { tone, short, detail, ideal, ahead, daysLeft, daysToReset, rate, points, hasReset };
  }

  function locale() {
    const language = state.settings?.language;
    if (language && language !== 'auto') return language;
    return navigator.language || 'en';
  }

  function copy() {
    return /^zh\b/i.test(locale()) ? COPY.zh : COPY.en;
  }

  function numberFormatter() {
    const key = locale();
    if (formatter && formatterKey === key) return formatter;
    formatterKey = key;
    formatter = new Intl.NumberFormat(key, {
      notation: 'compact',
      maximumFractionDigits: 1
    });
    return formatter;
  }

  function exactFormatter() {
    const key = locale();
    return new Intl.NumberFormat(key, { maximumFractionDigits: 0 });
  }

  function compact(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    const safe = Math.max(0, number);
    return safe >= 1000 ? numberFormatter().format(safe) : exactFormatter().format(Math.round(safe));
  }

  function currencyApi() {
    return window.TokenMonitorCurrency;
  }

  function currencyCode() {
    return currencyApi()?.normalizeCurrency?.(state.settings?.currency) || 'USD';
  }

  function configureCurrency() {
    const api = currencyApi();
    if (api?.configureRates && state.settings?.currencyRatesEffective) {
      api.configureRates(state.settings.currencyRatesEffective);
    }
  }

  function money(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '';
    if (amount === 0) {
      try {
        return new Intl.NumberFormat(locale(), {
          style: 'currency',
          currency: currencyCode(),
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(0);
      } catch (_) {
        return '$0.00';
      }
    }
    try {
      if (currencyApi()?.formatCurrencyFromUsd) {
        return currencyApi().formatCurrencyFromUsd(amount, currencyCode());
      }
    } catch (_) {
      // Fall through to the plain USD form.
    }
    return `$${amount.toFixed(2)}`;
  }

  function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function displayCost(value, unpricedTokens) {
    const amount = Number(value);
    const safe = Number.isFinite(amount) ? amount : 0;
    if (positive(unpricedTokens) > 0 && !(safe > 0)) return copy().unpriced;
    return money(safe);
  }

  function timeValue(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clientLabel(client) {
    const id = String(client || '').trim().toLowerCase();
    if (CLIENT_LABELS[id]) return CLIENT_LABELS[id];
    return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Other';
  }

  // Session rows are normalized to lowercase ids by the collector; history can
  // also carry Qoder's own display names. Keep a display-ready name as-is and
  // build the common ids back into their public casing.
  function modelLabel(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    if (/^(?:DeepSeek|Qwen|Kimi|GLM|MiniMax|Sonus|Cantus|Auto|Lite|Efficient|Performance|Ultimate)\b/.test(raw)) return raw;
    let out = raw;
    if (/^deepseek/i.test(out)) out = out.replace(/^deepseek/i, 'DeepSeek');
    else if (/^qwen/i.test(out)) out = out.replace(/^qwen/i, 'Qwen');
    else if (/^kimi/i.test(out)) out = out.replace(/^kimi/i, 'Kimi');
    else if (/^glm/i.test(out)) out = out.replace(/^glm/i, 'GLM');
    else if (/^minimax/i.test(out)) out = out.replace(/^minimax/i, 'MiniMax');
    else if (/^sonus/i.test(out)) out = out.replace(/^sonus/i, 'Sonus');
    else if (/^cantus/i.test(out)) out = out.replace(/^cantus/i, 'Cantus');
    return out.replace(/(^|[-\s])([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
  }

  function sessionModels(row) {
    const models = row?.models && typeof row.models === 'object' ? row.models : {};
    return Object.entries(models)
      .map(([name, tokens]) => [name, positive(tokens)])
      .filter(([name, tokens]) => name && tokens > 0)
      .sort((left, right) => right[1] - left[1]);
  }

  function topModel(row) {
    const latest = modelLabel(row?.latestModel);
    if (latest) return latest;
    const models = sessionModels(row);
    return models.length ? modelLabel(models[0][0]) : '';
  }

  function sessionKey(row) {
    return `${row?.client || ''}:${row?.sessionId || ''}`;
  }

  function findSession(stats, periodName, row) {
    const sessions = stats?.periods?.[periodName]?.sessions;
    if (!sessions || !row?.sessionId) return null;
    const direct = sessions[sessionKey(row)];
    if (direct) return direct;
    for (const candidate of Object.values(sessions)) {
      if (candidate?.client === row.client && candidate?.sessionId === row.sessionId) return candidate;
    }
    return null;
  }

  function pickSession(stats) {
    let latest = null;
    for (const periodName of ['today', 'month', 'allTime']) {
      const sessions = stats?.periods?.[periodName]?.sessions;
      if (!sessions || typeof sessions !== 'object') continue;
      for (const key of Object.keys(sessions)) {
        const row = sessions[key];
        if (!row || !row.sessionId) continue;
        const last = timeValue(row.lastUsedAt);
        if (!latest || last > latest.last) latest = { row, last };
      }
      if (latest) break;
    }
    if (!latest) return null;
    // Today's row carries only today's slice of a session that can span days.
    // A status line describes the session, so take the largest same-session row
    // (month or all-time) and borrow the freshest live fields from today.
    const candidates = [latest.row];
    for (const periodName of ['month', 'allTime']) {
      const row = findSession(stats, periodName, latest.row);
      if (row && !candidates.includes(row)) candidates.push(row);
    }
    const base = candidates.reduce((best, row) => (
      positive(row.totalTokens) > positive(best.totalTokens) ? row : best
    ), latest.row);
    return {
      ...base,
      lastUsedAt: latest.row.lastUsedAt || base.lastUsedAt,
      turnEnded: latest.row.turnEnded !== undefined ? latest.row.turnEnded : base.turnEnded,
      liveActivity: latest.row.liveActivity || base.liveActivity,
      contextTokens: positive(latest.row.contextTokens) > 0 ? latest.row.contextTokens : base.contextTokens,
      contextWindow: positive(latest.row.contextWindow) > 0 ? latest.row.contextWindow : base.contextWindow
    };
  }

  function isLive(row) {
    if (!row) return false;
    if (row.turnEnded === false) return true;
    const activity = String(row.liveActivity?.state || '').toLowerCase();
    if (activity === 'running' || activity === 'waiting') return true;
    const last = timeValue(row.lastUsedAt);
    return last > 0 && Date.now() - last < 90 * 1000;
  }

  function quotaFor(client) {
    const wanted = String(client || '').trim().toLowerCase();
    if (!wanted) return null;
    const providers = Array.isArray(state.stats?.limits?.providers) ? state.stats.limits.providers : [];
    const matches = providers.filter((provider) => (
      String(provider?.provider || '').trim().toLowerCase() === wanted
      && Array.isArray(provider.windows)
      && provider.windows.length > 0
    ));
    if (!matches.length) return null;
    let best = null;
    for (const provider of matches) {
      for (const window of provider.windows) {
        const percent = Number(window.remainingPercent);
        if (!Number.isFinite(percent)) continue;
        if (!best || percent < best.percent) best = { provider, window, percent };
      }
    }
    return best;
  }

  function duration(ms) {
    const c = copy();
    const total = Math.max(0, Number(ms) || 0);
    if (total < 60 * 1000) return c.now;
    const minutes = Math.round(total / 60000);
    if (minutes < 60) return `${minutes}${c.minute}`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return rest ? `${hours}${c.hour} ${rest}${c.minute}` : `${hours}${c.hour}`;
    const days = Math.floor(hours / 24);
    const hourRest = hours % 24;
    return hourRest ? `${days}${c.day} ${hourRest}${c.hour}` : `${days}${c.day}`;
  }

  function agoText(ms) {
    const c = copy();
    const value = duration(ms);
    return value === c.now ? c.now : `${value} ${c.ago}`;
  }

  function tokenPair(row) {
    const window = positive(row?.contextWindow);
    const used = positive(row?.contextTokens);
    if (!(window > 0) || !(used > 0)) return null;
    const usedPercent = Math.max(0, Math.min(100, Math.round(used / window * 100)));
    return { window, used, usedPercent };
  }

  function cachePercent(row) {
    const cacheRead = positive(row?.cacheReadTokens);
    const input = positive(row?.inputTokens);
    const total = cacheRead + input;
    if (!(total > 0)) return null;
    return Math.max(0, Math.min(100, Math.round(cacheRead / total * 100)));
  }

  function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function chip(kind) {
    const wrap = element('span', `session-status-chip session-status-${kind}`);
    const label = element('span', 'session-status-chip-label');
    const value = element('span', 'session-status-chip-value');
    wrap.append(label, value);
    wrap.hidden = true;
    return { wrap, label, value };
  }

  function buildStatus(panel) {
    status = document.createElement('button');
    status.type = 'button';
    status.className = 'session-status hidden';
    status.setAttribute('aria-haspopup', 'dialog');
    status.setAttribute('aria-expanded', 'false');

    refs.dot = element('span', 'session-status-dot');
    const identity = element('span', 'session-status-identity');
    refs.client = element('span', 'session-status-client');
    refs.model = element('span', 'session-status-model');
    identity.append(refs.client, refs.model);
    refs.project = element('span', 'session-status-project');

    const metrics = element('span', 'session-status-metrics');
    refs.context = chip('context');
    refs.contextBar = element('span', 'session-status-context-bar');
    refs.contextFill = element('i');
    refs.contextBar.append(refs.contextFill);
    refs.context.wrap.insertBefore(refs.contextBar, refs.context.value);
    refs.contextNote = element('span', 'session-status-chip-note');
    refs.context.wrap.append(refs.contextNote);
    refs.cache = chip('cache');
    refs.cacheNote = element('span', 'session-status-chip-note');
    refs.cache.wrap.append(refs.cacheNote);
    refs.quota = chip('quota');
    refs.quotaNote = element('span', 'session-status-chip-note');
    refs.quota.wrap.append(refs.quotaNote);
    refs.calls = chip('calls');
    metrics.append(refs.context.wrap, refs.cache.wrap, refs.quota.wrap, refs.calls.wrap);

    status.append(refs.dot, identity, refs.project, metrics);

    const anchor = panel.querySelector('.total-cost-row') || document.getElementById('cost') || panel.lastElementChild;
    if (anchor) anchor.insertAdjacentElement('afterend', status);
    else panel.append(status);

    // The period label row has spare room on the right. A day-start note makes
    // the tiny post-midnight DAY reading legible instead of looking broken.
    refs.periodNote = element('span', 'tm-period-note hidden');
    const labelRow = panel.querySelector('.label-row');
    if (labelRow) labelRow.append(refs.periodNote);

    card = element('div', 'session-insight-card hidden');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.tabIndex = -1;
    panel.append(card);

    status.addEventListener('click', () => setOpen(!state.open));
    status.addEventListener('animationend', (event) => {
      if (event.animationName === 'session-status-in') {
        status.classList.remove('is-session-entering');
      }
    });
    card.addEventListener('animationend', (event) => {
      if (event.target !== card) return;
      if (event.animationName === 'session-insight-in') {
        card.classList.remove('is-opening');
      } else if (event.animationName === 'session-insight-out') {
        card.classList.add('hidden');
        card.classList.remove('is-closing');
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!state.open) return;
      if (card.contains(event.target) || status.contains(event.target)) return;
      setOpen(false);
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !state.open) return;
      setOpen(false);
      status.focus();
    });
  }

  function setOpen(open) {
    state.open = Boolean(open) && Boolean(state.row);
    status.setAttribute('aria-expanded', String(state.open));
    if (!state.open) {
      if (card.classList.contains('hidden')) {
        card.classList.remove('is-opening', 'is-closing');
        return;
      }
      if (!canAnimate()) {
        card.classList.add('hidden');
        card.classList.remove('is-opening', 'is-closing');
        return;
      }
      // Let the card finish leaving before display:none. The CSS animation
      // owns the timing; animationend keeps this layer free of timers.
      if (card.classList.contains('is-closing')) return;
      card.classList.remove('is-opening');
      card.classList.add('is-closing');
      return;
    }
    card.classList.remove('hidden');
    card.classList.remove('is-closing');
    card.classList.remove('is-opening');
    renderCard();
    if (canAnimate()) {
      void card.offsetWidth;
      card.classList.add('is-opening');
    }
  }

  function setChip(target, labelText, valueText, description) {
    target.label.textContent = labelText;
    target.value.textContent = valueText;
    // Native title tooltips are forbidden in the renderer; keep the extra
    // reading as an accessible description instead.
    target.wrap.setAttribute('aria-label', [labelText, valueText, description || ''].filter(Boolean).join(' '));
    target.wrap.hidden = !valueText;
  }

  function markSessionEntering(row) {
    const key = sessionKey(row);
    if (!canAnimate()) {
      status.classList.remove('is-session-entering');
    } else if (lastSessionKey && lastSessionKey !== key) {
      status.classList.remove('is-session-entering');
      // Restart the keyframes when the latest session changes, not on every
      // value push from the same session.
      void status.offsetWidth;
      status.classList.add('is-session-entering');
    }
    lastSessionKey = key;
  }

  // Home's quota module is repainted by the app itself. Stamp the same health
  // reading beside each provider name, and keep the stamp keyed by its text so
  // the decoration's own mutation cannot start a loop.
  function decorateHomeHealth() {
    homeBadgeFrame = 0;
    const home = document.getElementById('homePanel');
    if (!home) return;
    const providers = Array.isArray(state.stats?.limits?.providers) ? state.stats.limits.providers : [];
    for (const row of home.querySelectorAll('.home-limit-account')) {
      const nameEl = row.querySelector('.home-list-name');
      if (!nameEl) continue;
      const nameClone = nameEl.cloneNode(true);
      nameClone.querySelectorAll('.tm-home-health').forEach((node) => node.remove());
      const name = (nameClone.textContent || '').trim();
      if (!name) continue;
      const provider = providers.find((candidate) => (
        String(candidate?.provider || '').toLowerCase() === name.toLowerCase()
        || clientLabel(candidate?.provider) === name
      ));
      if (!provider) continue;
      let best = null;
      for (const window of Array.isArray(provider.windows) ? provider.windows : []) {
        const health = quotaHealth(provider, window);
        if (!health) continue;
        const percent = Number(window.remainingPercent);
        if (!best || percent < best.percent) best = { health, percent };
      }
      if (!best) continue;
      const signature = `${best.health.tone}|${best.health.short}|${best.health.detail}`;
      const existing = nameEl.querySelector('.tm-home-health');
      if (row.dataset.tmHealth === signature && existing) continue;
      row.dataset.tmHealth = signature;
      existing?.remove();
      const badge = element('span', 'tm-home-health', best.health.short);
      badge.dataset.health = best.health.tone;
      badge.setAttribute('aria-description', best.health.detail);
      nameEl.append(badge);
    }
  }

  function scheduleHomeHealth() {
    if (homeBadgeFrame) return;
    homeBadgeFrame = window.requestAnimationFrame(decorateHomeHealth);
  }

  function checkDayBoundary() {
    const next = localDayKey();
    if (!state.dayKey) {
      state.dayKey = next;
      return;
    }
    if (next === state.dayKey) return;
    state.dayKey = next;
    updatePeriodNote();
    maybeRefreshDay();
  }

  // A local-day rollover leaves the DAY tab showing a near-empty bucket until
  // the app's own five-minute fallback read lands. One explicit refresh at the
  // boundary makes the new day appear immediately; it is skipped when the tab
  // is hidden or when a user-triggered refresh is still in flight.
  function maybeRefreshDay() {
    if (activePeriod() !== 'today') return;
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastDayRefreshAt < 60 * 1000) return;
    const button = document.getElementById('refreshButton');
    if (!button || button.disabled) return;
    lastDayRefreshAt = Date.now();
    button.click();
  }

  function updatePeriodNote() {
    const note = refs.periodNote;
    if (!note) return;
    const c = copy();
    if (activePeriod() !== 'today') {
      note.textContent = '';
      note.classList.add('hidden');
      return;
    }
    const daily = Array.isArray(state.stats?.historyPreview?.daily) ? state.stats.historyPreview.daily : [];
    const yesterday = daily.find((entry) => entry?.date === previousDayKey());
    const parts = [c.todayFrom];
    if (yesterday && positive(yesterday.tokens) > 0) {
      parts.push(`${c.yesterday} ${compact(yesterday.tokens)}`);
    }
    note.textContent = parts.join(' · ');
    note.classList.remove('hidden');
  }

  // A rate history is sampled from the value the footer already renders, so it
  // adds no second collector and no timer. The buffer lives in memory only.
  function initRateSpark() {
    const host = document.getElementById('liveTokenRate');
    const valueEl = document.getElementById('liveTokenRateValue');
    if (!host || !valueEl) return;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'tm-rate-spark is-empty');
    svg.setAttribute('viewBox', '0 0 46 14');
    svg.setAttribute('aria-hidden', 'true');
    const area = document.createElementNS(NS, 'path');
    area.setAttribute('class', 'tm-rate-area');
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('class', 'tm-rate-line');
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('class', 'tm-rate-dot');
    dot.setAttribute('r', '1.6');
    svg.append(area, line, dot);
    host.append(svg);

    const samples = [];
    let lastText = '';
    let lastAt = 0;
    let frame = 0;

    function parseRate(text) {
      const match = String(text).match(/([\d.,]+)\s*(k|m)?/i);
      if (!match) return null;
      const number = Number(match[1].replace(/,/g, ''));
      if (!Number.isFinite(number)) return null;
      const unit = (match[2] || '').toLowerCase();
      return number * (unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1);
    }

    function renderSpark() {
      frame = 0;
      if (samples.length < 2) {
        svg.classList.add('is-empty');
        return;
      }
      const newest = samples[samples.length - 1];
      if (Date.now() - newest.t > 2 * 60 * 1000) {
        svg.classList.add('is-empty');
        return;
      }
      const values = samples.map((sample) => sample.v);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = Math.max(1, max - min);
      const width = 46;
      const height = 14;
      const padX = 1.5;
      const padY = 2;
      const points = samples.map((sample, index) => [
        padX + (width - 2 * padX) * index / (samples.length - 1),
        height - padY - (height - 2 * padY) * (sample.v - min) / range
      ]);
      const pathData = points
        .map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)} ${point[1].toFixed(1)}`)
        .join(' ');
      const first = points[0];
      const last = points[points.length - 1];
      line.setAttribute('d', pathData);
      area.setAttribute('d', `${pathData} L${last[0].toFixed(1)} ${height} L${first[0].toFixed(1)} ${height} Z`);
      dot.setAttribute('cx', last[0].toFixed(1));
      dot.setAttribute('cy', last[1].toFixed(1));
      svg.classList.remove('is-empty');
    }

    function sample() {
      const text = (valueEl.textContent || '').trim();
      if (!text || text === '—' || !/tok/i.test(text)) {
        svg.classList.add('is-empty');
        return;
      }
      const value = parseRate(text);
      if (value == null) return;
      const now = Date.now();
      if (text === lastText && now - lastAt < 3000) {
        if (!frame) frame = window.requestAnimationFrame(renderSpark);
        return;
      }
      lastText = text;
      lastAt = now;
      if (samples.length && now - samples[samples.length - 1].t < 2500) {
        samples[samples.length - 1] = { t: now, v: value };
      } else {
        samples.push({ t: now, v: value });
      }
      while (samples.length > 28) samples.shift();
      svg.classList.remove('is-fresh');
      void svg.getBoundingClientRect();
      svg.classList.add('is-fresh');
      if (!frame) frame = window.requestAnimationFrame(renderSpark);
    }

    new MutationObserver(sample).observe(valueEl, {
      subtree: true,
      childList: true,
      characterData: true
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') sample();
    });
    sample();
  }

  function render() {
    renderFrame = 0;
    rememberQuotaHistory(state.stats);
    checkDayBoundary();
    // A cold start just after midnight can seed yesterday's cache before the
    // first real scan. Treat that snapshot as stale for the DAY view and ask
    // the app's refresh path once, rather than leaving an unexplained 41M→2K
    // drop on screen.
    const updatedAt = timeValue(state.stats?.updatedAt);
    if (state.cacheSeed && updatedAt && state.dayKey
      && localDayKey(new Date(updatedAt)) !== state.dayKey) {
      maybeRefreshDay();
    }
    updatePeriodNote();
    scheduleHomeHealth();
    const row = pickSession(state.stats);
    state.row = row;
    if (!row) {
      status.classList.add('hidden');
      status.classList.remove('is-session-entering');
      lastSessionKey = '';
      if (state.open) setOpen(false);
      return;
    }
    const c = copy();
    const estimated = row.estimated === true || row.estimatedTokens === true || row.estimatedCost === true;
    status.classList.remove('hidden');
    status.classList.toggle('is-live', isLive(row));

    refs.client.textContent = clientLabel(row.client);
    refs.model.textContent = topModel(row);
    refs.project.textContent = row.projectLabel || '';
    refs.project.hidden = !refs.project.textContent;

    const context = tokenPair(row);
    if (context) {
      const remainingMode = state.settings?.sessionContextMetric === 'remaining';
      const percent = remainingMode ? 100 - context.usedPercent : context.usedPercent;
      refs.contextFill.style.width = `${percent}%`;
      const contextHealth = context.usedPercent >= 80 ? 'critical' : context.usedPercent >= 60 ? 'low' : '';
      refs.context.wrap.dataset.tone = contextHealth;
      refs.context.wrap.dataset.health = contextHealth;
      refs.contextNote.textContent = contextHealth === 'critical'
        ? c.ctxLow
        : contextHealth === 'low' ? c.ctxHigh : '';
      refs.contextNote.hidden = !refs.contextNote.textContent;
      setChip(
        refs.context,
        c.ctx,
        `${percent}%`,
        `${c.contextLabel}: ${compact(context.used)} / ${compact(context.window)} · ${context.usedPercent}% ${c.used}${refs.contextNote.textContent ? ` · ${refs.contextNote.textContent}` : ''}`
      );
    } else {
      refs.context.wrap.hidden = true;
      refs.context.wrap.dataset.health = '';
      refs.contextNote.textContent = '';
    }

    const cached = cachePercent(row);
    if (cached != null) {
      const lastUsed = timeValue(row.lastUsedAt);
      const cold = lastUsed > 0 && Date.now() - lastUsed > 5 * 60 * 1000;
      refs.cache.wrap.dataset.health = cold ? 'cold' : '';
      refs.cache.wrap.dataset.estimated = estimated ? 'true' : '';
      refs.cache.wrap.dataset.tone = cached >= 85 ? 'good' : cached < 50 ? 'low' : '';
      const cacheNote = [estimated ? c.estimated : '', cold ? c.cacheCold : ''].filter(Boolean).join(' · ');
      refs.cacheNote.textContent = cacheNote;
      refs.cacheNote.hidden = !cacheNote;
      setChip(
        refs.cache,
        c.cache,
        `${cached}%`,
        `${compact(positive(row.cacheReadTokens))} ${c.cachedShort} / ${compact(positive(row.cacheReadTokens) + positive(row.inputTokens))}${cacheNote ? ` · ${cacheNote}` : ''}`
      );
    } else {
      refs.cache.wrap.hidden = true;
      refs.cache.wrap.dataset.health = '';
      refs.cache.wrap.dataset.tone = '';
      refs.cache.wrap.dataset.estimated = '';
      refs.cacheNote.textContent = '';
    }

    const messages = positive(row.messageCount);
    if (messages > 0) setChip(refs.calls, c.calls, compact(messages), `${c.callsLabel}: ${exactFormatter().format(messages)}`);
    else refs.calls.wrap.hidden = true;

    const quota = quotaFor(row.client);
    if (quota) {
      const health = quotaHealth(quota.provider, quota.window);
      refs.quota.wrap.dataset.tone = quota.percent < 20 ? 'critical' : quota.percent < 50 ? 'low' : '';
      refs.quota.wrap.dataset.health = health?.tone || '';
      refs.quota.wrap.classList.toggle('is-stale', Boolean(quota.provider.stale));
      refs.quotaNote.textContent = health?.short || '';
      refs.quotaNote.hidden = !refs.quotaNote.textContent;
      const resetAt = timeValue(quota.window.resetsAt);
      const resetText = resetAt ? `${c.reset} ${duration(Math.max(0, resetAt - Date.now()))}` : '';
      setChip(
        refs.quota,
        c.quota,
        `${Math.round(quota.percent)}%`,
        [quota.provider.accountLabel, quota.window.label || quota.window.kind, `${Math.round(quota.percent)}% ${c.remaining}`, health?.short, health?.detail, resetText, quota.provider.stale ? c.stale : '']
          .filter(Boolean).join(' · ')
      );
    } else {
      refs.quota.wrap.hidden = true;
      refs.quota.wrap.dataset.health = '';
      refs.quotaNote.textContent = '';
    }

    const last = timeValue(row.lastUsedAt);
    const titleParts = [row.title, row.projectLabel, last ? `${c.updated} ${agoText(Date.now() - last)}` : ''].filter(Boolean);
    status.setAttribute('aria-description', titleParts.join(' · '));
    status.setAttribute('aria-label', [
      clientLabel(row.client),
      topModel(row),
      context ? `${c.ctx} ${context.usedPercent}%` : '',
      cached != null ? `${c.cache} ${cached}%${estimated ? ` ${c.estimatedLong}` : ''}` : '',
      messages > 0 ? `${exactFormatter().format(messages)} ${c.calls}` : ''
    ].filter(Boolean).join(', '));
    markSessionEntering(row);

    if (state.open) renderCard();
  }

  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = window.requestAnimationFrame(render);
  }

  function addStat(grid, label, value, description = '', note = '') {
    if (!value) return;
    const item = element('div', 'session-insight-stat');
    if (description) item.setAttribute('aria-description', description);
    item.append(element('span', 'session-insight-stat-label', label), element('strong', 'session-insight-stat-value', value));
    if (note) item.append(element('span', 'session-insight-stat-note', note));
    grid.append(item);
  }

  function quotaSparkline(points, tone) {
    if (!Array.isArray(points) || points.length < 3) return null;
    const first = points[0];
    const last = points[points.length - 1];
    if (!(last.t - first.t > 60 * 60 * 1000)) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'session-insight-quota-spark');
    svg.setAttribute('viewBox', '0 0 132 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.dataset.health = tone;
    const values = points.map((point) => point.p);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(1, max - min);
    const width = 132;
    const height = 20;
    const padX = 2;
    const padY = 3;
    const coords = points.map((point, index) => [
      padX + (width - 2 * padX) * index / (points.length - 1),
      height - padY - (height - 2 * padY) * (point.p - min) / range
    ]);
    const pathData = coords
      .map((coord, index) => `${index ? 'L' : 'M'}${coord[0].toFixed(1)} ${coord[1].toFixed(1)}`)
      .join(' ');
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('d', pathData);
    line.setAttribute('class', 'session-insight-quota-spark-line');
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', coords[coords.length - 1][0].toFixed(1));
    dot.setAttribute('cy', coords[coords.length - 1][1].toFixed(1));
    dot.setAttribute('r', '1.7');
    dot.setAttribute('class', 'session-insight-quota-spark-dot');
    svg.append(line, dot);
    return svg;
  }

  function renderCard() {
    if (!card || !state.row) return;
    const row = state.row;
    const c = copy();
    const estimated = row.estimated === true || row.estimatedTokens === true || row.estimatedCost === true;
    const estimatedTokens = row.estimatedTokens === true
      || (estimated && row.estimatedCost !== true);
    const estimatedCost = row.estimatedCost === true
      || (estimated && row.estimatedTokens !== true);
    card.replaceChildren();

    const head = element('div', 'session-insight-head');
    const headText = element('div', 'session-insight-head-text');
    headText.append(
      element('div', 'session-insight-title', row.title || c.currentSession),
      element('div', 'session-insight-sub', [
        c.fullSession,
        clientLabel(row.client),
        topModel(row),
        row.projectLabel
      ].filter(Boolean).join(' · '))
    );
    if (estimated) {
      const badges = element('div', 'session-insight-badges');
      badges.append(
        element('span', 'session-insight-estimated', `≈ ${c.estimatedLong}`),
        element('span', 'session-insight-estimated-hint', c.estimatedHint)
      );
      headText.append(badges);
    }
    const close = element('button', 'session-insight-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', c.close);
    close.addEventListener('click', () => setOpen(false));
    head.append(headText, close);
    card.append(head);

    const context = tokenPair(row);
    const cached = cachePercent(row);
    const grid = element('div', 'session-insight-grid');
    addStat(grid, c.tokens, compact(row.totalTokens), exactFormatter().format(positive(row.totalTokens)));
    addStat(grid, c.input, compact(row.inputTokens));
    addStat(grid, c.cached, compact(row.cacheReadTokens));
    addStat(grid, c.output, compact(row.outputTokens));
    addStat(grid, c.reasoning, compact(row.reasoningTokens));
    addStat(grid, c.callsLabel, exactFormatter().format(positive(row.messageCount)));
    const tps = positive(row.timedDurationMs) > 0
      ? Math.round(positive(row.timedOutputTokens) / (positive(row.timedDurationMs) / 1000))
      : 0;
    addStat(grid, c.avgSpeed, tps > 0 ? `${tps} tok/s` : '');
    const cost = positive(row.costUsd);
    const costText = displayCost(row.costUsd, row.unpricedTokens);
    addStat(
      grid,
      c.cost,
      cost > 0 && estimatedCost ? `≈ ${costText}` : costText
    );
    const tokens = positive(row.totalTokens);
    addStat(
      grid,
      c.perMillion,
      cost > 0 && tokens > 0 ? `${estimatedCost ? '≈ ' : ''}${money(cost / tokens * 1000000)}` : ''
    );
    if (context) {
      addStat(
        grid,
        c.contextLabel,
        `${context.usedPercent}% ${c.used} · ${compact(context.used)} / ${compact(context.window)}`,
        `${compact(context.window - context.used)} ${c.remaining}`,
        `${compact(context.window - context.used)} ${c.remaining}`
      );
    }
    if (cached != null) {
      const lastUsed = timeValue(row.lastUsedAt);
      const cold = lastUsed > 0 && Date.now() - lastUsed > 5 * 60 * 1000;
      const cacheNote = [estimatedTokens ? c.estimated : '', cold ? c.cacheCold : c.cacheWarm]
        .filter(Boolean).join(' · ');
      addStat(grid, c.cache, `${cached}%`, '', cacheNote);
    }
    card.append(grid);

    const models = sessionModels(row);
    if (models.length) {
      card.append(element('div', 'session-insight-section-title', c.models));
      const list = element('div', 'session-insight-rows');
      const components = row.modelTokenComponents && typeof row.modelTokenComponents === 'object'
        ? row.modelTokenComponents
        : {};
      const costs = row.modelCosts && typeof row.modelCosts === 'object' ? row.modelCosts : {};
      for (const [name, tokensValue] of models.slice(0, 6)) {
        const item = element('div', 'session-insight-row');
        const component = components[name] && typeof components[name] === 'object' ? components[name] : null;
        const read = positive(component?.cacheReadTokens);
        const fresh = positive(component?.inputTokens);
        const hit = read + fresh > 0 ? Math.round(read / (read + fresh) * 100) : null;
        item.append(
          element('span', 'session-insight-row-name', modelLabel(name)),
          element('span', 'session-insight-row-meta', hit != null ? `${hit}% ${c.cachedShort}` : ''),
          element('span', 'session-insight-row-value', compact(tokensValue)),
          element('span', 'session-insight-row-cost', (
            estimatedCost && positive(costs[name]) > 0 ? '≈ ' : ''
          ) + displayCost(costs[name], row.unpricedTokens))
        );
        list.append(item);
      }
      if (models.length > 6) {
        list.append(element('div', 'session-insight-row-more', `+${models.length - 6} ${c.more}`));
      }
      card.append(list);
    }

    const quota = quotaFor(row.client);
    if (quota) {
      const providers = (state.stats?.limits?.providers || []).filter((provider) => (
        String(provider?.provider || '').trim().toLowerCase() === String(row.client || '').trim().toLowerCase()
        && Array.isArray(provider.windows)
        && provider.windows.length
      ));
      if (providers.length) {
        card.append(element('div', 'session-insight-section-title', c.limits));
        const list = element('div', 'session-insight-limits');
        for (const provider of providers) {
          for (const window of provider.windows) {
            const percent = Number(window.remainingPercent);
            if (!Number.isFinite(percent)) continue;
            const item = element('div', 'session-insight-limit');
            const line = element('div', 'session-insight-limit-line');
            line.append(
              element('span', 'session-insight-row-name', [
                clientLabel(provider.provider),
                provider.accountLabel,
                window.label || window.kind
              ].filter(Boolean).join(' · ')),
              element('span', 'session-insight-row-value', `${Math.round(percent)}%`)
            );
            const health = quotaHealth(provider, window);
            const meter = element('div', 'session-insight-meter');
            const fill = element('i');
            fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
            meter.dataset.tone = percent < 20 ? 'critical' : percent < 50 ? 'low' : '';
            if (health && health.ideal != null) {
              meter.dataset.health = health.tone;
              const marker = element('span', 'session-insight-pace-marker');
              marker.style.left = `${Math.max(0, Math.min(100, health.ideal))}%`;
              marker.setAttribute('aria-hidden', 'true');
              meter.append(marker);
            }
            meter.append(fill);
            item.append(line, meter);
            if (health && health.detail) {
              const pace = element('div', 'session-insight-limit-pace');
              pace.dataset.health = health.tone;
              pace.append(
                element('span', 'session-insight-pace-label', health.short),
                element('span', 'session-insight-pace-detail', health.detail)
              );
              item.append(pace);
              const spark = quotaSparkline(health.points, health.tone);
              if (spark) item.append(spark);
            }
            const resetAt = timeValue(window.resetsAt);
            const notes = [
              resetAt ? `${c.reset} ${duration(Math.max(0, resetAt - Date.now()))}` : '',
              provider.stale ? c.stale : ''
            ].filter(Boolean);
            if (notes.length) item.append(element('div', 'session-insight-limit-note', notes.join(' · ')));
            list.append(item);
          }
        }
        card.append(list);
      }
    }

    const started = timeValue(row.startedAt);
    const last = timeValue(row.lastUsedAt);
    const footer = element('div', 'session-insight-footer');
    const parts = [];
    if (started) parts.push(`${c.started} ${duration(Math.max(0, last - started))} ${c.ago}`);
    if (last) parts.push(`${c.updated} ${agoText(Date.now() - last)}`);
    footer.textContent = parts.join(' · ');
    card.append(footer);
  }

  function applySettings(next) {
    state.settings = next || state.settings;
    configureCurrency();
    scheduleRender();
  }

  function init() {
    const panel = document.querySelector('.total-panel');
    if (!panel) return;
    state.dayKey = localDayKey();
    buildStatus(panel);
    initRateSpark();
    updatePeriodNote();
    const home = document.getElementById('homePanel');
    if (home) {
      new MutationObserver(scheduleHomeHealth).observe(home, { childList: true, subtree: true });
    }
    const syncVisibility = () => {
      document.documentElement.classList.toggle('tm-window-hidden', document.visibilityState !== 'visible');
      if (document.visibilityState === 'visible') {
        checkDayBoundary();
        updatePeriodNote();
      }
    };
    document.addEventListener('visibilitychange', syncVisibility);
    syncVisibility();
    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.tab, [data-fixed-period]')) return;
      window.setTimeout(() => {
        updatePeriodNote();
        if (activePeriod() === 'today') {
          checkDayBoundary();
          if (state.cacheSeed) maybeRefreshDay();
        }
      }, 0);
    }, true);
    bridge.onSettingsPush?.((next) => applySettings(next));
    bridge.onStatsPush((payload) => {
      const stats = payload?.data?.stats;
      if (!stats) return;
      state.stats = stats;
      state.cacheSeed = payload.data?.cache === true;
      scheduleRender();
    });
    // The settings push is change-only; seed the formatter and the
    // used/remaining preference for the first paint.
    if (typeof bridge.getSettings === 'function') {
      bridge.getSettings().then((settings) => {
        if (settings) applySettings(settings);
      }).catch(() => {});
    }
    // The app's own startup read and cache seed both arrive as stats pushes;
    // listening is enough and avoids a second fetch from this layer.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
