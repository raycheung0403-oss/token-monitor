'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { estimateContentTokens, estimateJsonTokens, estimateThinkingTokens } = require('./estimate');
const qoderCatalog = require('./qoder-catalog');
const { resolveQoderPaths } = require('./paths');

const KNOWN_MODEL_WINDOWS = Object.freeze({
  auto: 128000,
  qfmodel: 200000,
  qmodel_38max: 200000,
  dfmodel: 400000,
  kmodel_latest: 400000
});
// Qoder exposes internal model ids in its transcripts. These are the
// user-facing names from Qoder's own model picker; dfmodel uses the name the
// user asked for rather than the older DeepSeek-V4-Flash label.
//
// `*_latest` are rolling slots: Qoder keeps the id while the model behind it
// changes (qmodel_latest went from Qwen3.7-Max to Qwen4-Max-Preview, then to
// Qwen4-Max). The bundled dynamic-text bundle can lag behind that switch, so
// the catalog resolver treats these labels as a floor. The live display name is
// read from Qoder's own request logs, and each name change starts a new model
// row at the time it was first seen: Qwen4-Max-Preview usage stays on its row
// instead of being rewritten as Qwen4-Max.
const MODEL_LABELS = Object.freeze({
  auto: 'Auto',
  lite: 'Lite',
  efficient: 'Efficient',
  performance: 'Performance',
  ultimate: 'Ultimate',
  cmodel: 'Cantus',
  dmodel: 'DeepSeek-V4-Pro',
  dfmodel: 'DeepSeek-V4.1-Flash 1024',
  gmodel: 'GLM-5.3',
  gfmodel: 'GLM-5.3-Flash',
  kmodel: 'Kimi-K2.7-Code',
  kmodel_latest: 'Kimi-K3',
  mmodel: 'MiniMax-M3',
  qmodel: 'Qwen3.7-Plus',
  qfmodel: 'Qwen3.8-Flash',
  qmodel_38max: 'Qwen3.8-Max',
  qmodel_latest: 'Qwen4-Max'
});
const DEFAULT_CONTEXT_WINDOW = 200000;
const MIN_REQUEST_DURATION_MS = 250;
const MAX_REQUEST_DURATION_MS = 5 * 60 * 1000;
const ACTIVE_TURN_STALE_MS = 45 * 60 * 1000;
const ACTIVE_ITEM_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
// Qoder's server does prompt-prefix caching but reports every token counter as
// zero. Reuse the previous request's context when it is recent and monotonic;
// the gap is an estimate, not a tokenizer reading.
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;
const PROMPT_CACHE_MIN_GROWTH = 1;
// Token Monitor asks for today's report and the all-time graph in separate
// invocations. Reparsing every unchanged transcript each time was the largest
// avoidable cost of a Qoder scan, so completed files are reused until their
// size or mtime moves. The cache holds aggregates only, never file text.
const PARSE_CACHE_LIMIT = 128;
const parseCache = new Map();
let parseCacheDefaultsKey = null;

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+$/.test(value.trim())) return toMs(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function blockKey(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text') return `text:${block.text || ''}`;
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    return `${block.type}:${block.thinking || block.data || ''}`;
  }
  if (block.type === 'tool_use' || block.type === 'server_tool_use') {
    return `${block.type}:${block.id || ''}:${block.name || ''}:${stableJson(block.input)}`;
  }
  return `${block.type || 'unknown'}:${stableJson(block)}`;
}

function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function addContent(target, content) {
  let added = 0;
  for (const block of Array.isArray(content) ? content : []) {
    const key = blockKey(block);
    if (!key || target.seen.has(key)) continue;
    target.seen.add(key);
    if (target.blocks) target.blocks.push(block);
    const tokens = estimateContentTokens([block]);
    target.tokens += tokens;
    target.thinkingTokens += estimateThinkingTokens([block]);
    added += tokens;
  }
  return added;
}

function listTranscriptFiles(projectsDir, sinceMs) {
  const files = [];
  const threshold = sinceMs > 0 ? sinceMs - 24 * 60 * 60 * 1000 : 0;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'memory' || entry.name === 'node_modules') continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (stat.size <= 0 || stat.size > MAX_TRANSCRIPT_BYTES) continue;
      if (threshold && stat.mtimeMs < threshold) continue;
      files.push(full);
    }
  };
  walk(projectsDir, 0);
  return files.sort();
}

function modelDefaultsKey(defaults) {
  if (!defaults) return '';
  return Object.keys(defaults).sort().map((key) => `${key}:${defaults[key]}`).join(',');
}

function cachedTranscript(file, modelWindowDefaults, defaultsKey) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return null;
  }
  const hit = parseCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.defaultsKey === defaultsKey) {
    parseCache.delete(file);
    parseCache.set(file, hit);
    return hit.session;
  }
  const session = parseTranscript(file, modelWindowDefaults);
  if (!session) return null;
  parseCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, defaultsKey, session });
  while (parseCache.size > PARSE_CACHE_LIMIT) {
    parseCache.delete(parseCache.keys().next().value);
  }
  return session;
}

function userTextFromRow(row) {
  const message = row?.message;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ');
  if (text.trim()) return text.trim();
  if (typeof message?.content === 'string') return message.content.trim();
  if (typeof row?.lastPrompt === 'string') return row.lastPrompt.trim();
  return '';
}

function parseTranscript(file, modelWindowDefaults = null) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  const groups = new Map();
  const windowTimeline = [];
  const modelWindows = Object.create(null);
  const contextSegments = [{
    index: 0,
    startTs: 0,
    endTs: 0,
    baseline: 0,
    rawAtEnd: 0,
    compactPre: 0,
    compactPost: 0,
    scale: 1
  }];
  const compactionRows = [];
  const contextUserRows = new Set();
  const contextAttachmentRows = new Set();
  let contextRaw = 0;
  let contextSegment = 0;
  let sessionId = path.basename(file, '.jsonl');
  let cwd = '';
  let titleHint = '';
  let lastCompletedTs = 0;
  let sessionModel = '';
  let firstTs = 0;
  let lastTs = 0;

  function addContextTokens(tokens) {
    const amount = Math.max(0, Math.round(Number(tokens) || 0));
    if (!amount) return 0;
    contextRaw += amount;
    const segment = contextSegments[contextSegment];
    if (segment) segment.rawAtEnd = contextRaw;
    return amount;
  }

  function addUserContext(row, ts) {
    if (!ts) return;
    const key = String(row.uuid || row.message?.id || '').trim();
    if (key && contextUserRows.has(key)) return;
    if (key) contextUserRows.add(key);
    const content = row.message?.content;
    let added = Array.isArray(content)
      ? estimateContentTokens(content)
      : typeof content === 'string' ? estimateJsonTokens(content) : 0;
    if (row.toolUseResult) added += estimateJsonTokens(row.toolUseResult);
    addContextTokens(added);
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const rowSessionId = String(row.sessionId || row.session_id || '').trim();
    if (rowSessionId) sessionId = rowSessionId;
    if (row.type === 'runtime-config') {
      const ts = toMs(row.timestamp);
      if (ts) {
        firstTs = firstTs ? Math.min(firstTs, ts) : ts;
        lastTs = Math.max(lastTs, ts);
        if (!contextSegments[0].startTs) contextSegments[0].startTs = ts;
      }
      const model = String(row.model || row.message?.model || '').trim();
      if (model) sessionModel = model;
      const window = positiveNumber(row.contextWindow);
      if (model && window) {
        modelWindows[model] = window;
        windowTimeline.push({ ts: ts || 0, model, window });
      }
      continue;
    }

    const ts = toMs(row.timestamp);
    if (ts) {
      firstTs = firstTs ? Math.min(firstTs, ts) : ts;
      lastTs = Math.max(lastTs, ts);
      if (!contextSegments[0].startTs) contextSegments[0].startTs = ts;
    }
    if (row.cwd && !cwd) cwd = String(row.cwd);
    if (!titleHint && row.type === 'user') {
      const text = userTextFromRow(row);
      if (text && !text.startsWith('<')) titleHint = text.slice(0, 120);
    }

    // Compaction is a real billed request with exact usage. It resets the
    // prompt context, so keep it as a boundary and as a request of its own.
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      const usage = row.compactUsage && typeof row.compactUsage === 'object'
        ? row.compactUsage
        : null;
      const segment = contextSegments[contextSegment];
      if (segment) {
        segment.endTs = ts || segment.endTs;
        segment.rawAtEnd = contextRaw;
        segment.compactPre = usage
          ? positiveNumber(usage.input_tokens ?? usage.inputTokens ?? usage.context_tokens ?? usage.contextTokens)
          : 0;
      }
      const post = positiveNumber(row.compactMetadata?.postTokens);
      contextRaw = post;
      contextSegment += 1;
      contextSegments.push({
        index: contextSegment,
        startTs: ts || 0,
        endTs: 0,
        baseline: post,
        rawAtEnd: post,
        compactPre: 0,
        compactPost: post,
        scale: 1
      });
      if (usage) {
        compactionRows.push({
          id: `compact:${String(row.uuid || ts || contextSegment)}`,
          ts: ts || 0,
          segment: contextSegment - 1,
          usage,
          model: sessionModel,
          durationMs: positiveNumber(row.compactMetadata?.durationMs)
        });
      }
      if (ts) lastCompletedTs = Math.max(lastCompletedTs, ts);
      continue;
    }

    if (row.type === 'user') {
      addUserContext(row, ts);
      if (ts) lastCompletedTs = Math.max(lastCompletedTs, ts);
      continue;
    }

    if (row.type === 'attachment') {
      const key = String(row.uuid || '').trim();
      if (key && !contextAttachmentRows.has(key)) {
        contextAttachmentRows.add(key);
        addContextTokens(estimateJsonTokens(row.attachment));
      }
      continue;
    }

    if (row.type === 'assistant') {
      const message = row.message || {};
      const groupId = String(message.id || row.messageId || row.uuid || '').trim();
      if (!groupId) continue;
      let group = groups.get(groupId);
      if (!group) {
        group = {
          id: groupId,
          startTs: lastCompletedTs && lastCompletedTs <= ts ? lastCompletedTs : ts,
          endTs: ts,
          blocks: [],
          seen: new Set(),
          tokens: 0,
          thinkingTokens: 0,
          usage: null,
          model: '',
          completed: false,
          // The prompt for this request is what existed before its own
          // output. Capturing here keeps the request's own tokens out of its
          // context estimate (which would otherwise inflate every turn).
          contextRaw,
          contextSegment
        };
        groups.set(groupId, group);
      }
      if (ts) group.endTs = Math.max(group.endTs, ts);
      if (message.model) group.model = String(message.model);
      const content = Array.isArray(message.content)
        ? message.content
        : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [];
      const added = addContent(group, content);
      addContextTokens(added);
      if (message.usage && typeof message.usage === 'object') group.usage = message.usage;
      if (ts) lastCompletedTs = Math.max(lastCompletedTs, ts);
      continue;
    }
  }

  const finalSegment = contextSegments[contextSegment];
  if (finalSegment) {
    finalSegment.endTs = lastTs || finalSegment.endTs;
    finalSegment.rawAtEnd = contextRaw;
  }

  const requests = [];
  const streamId = file.split(path.sep).includes('subagents') ? file : '';
  const resolvedWindows = modelWindowDefaults
    ? { ...modelWindowDefaults, ...modelWindows }
    : modelWindows;
  for (const group of groups.values()) {
    // Qoder's Auto mode (and newer CLI builds) commits assistant content
    // without a message.usage object. The content blocks are still there and
    // are the only token signal for those turns, so estimate output from them
    // instead of dropping the whole request. Auto turns also carry a
    // calibrated context estimate; explicit turns keep their measured usage.
    const usage = group.usage && typeof group.usage === 'object' ? group.usage : null;
    const outputTokens = Math.max(0, Math.round(group.tokens));
    if (!usage && outputTokens <= 0 && group.thinkingTokens <= 0) continue;
    const ratio = usage ? Number(usage.context_usage_ratio ?? usage.contextUsageRatio) : 0;
    const measuredContext = usage
      ? positiveNumber(usage.input_tokens ?? usage.inputTokens ?? usage.context_tokens ?? usage.contextTokens)
      : 0;
    const measuredCache = usage
      ? positiveNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens)
      : 0;
    const credits = usage ? Number(usage.credits ?? usage.credit ?? 0) : 0;
    const model = String(group.model || sessionModel || 'unknown').trim() || 'unknown';
    // Qoder writes occasional synthetic assistant notes that are not API
    // requests; they have no usage and would otherwise become a bogus model row.
    if (/^<synthetic>$/i.test(model)) continue;
    const window = resolveWindow(model, group.endTs, windowTimeline, resolvedWindows);
    const ratioContext = Number.isFinite(ratio) && ratio > 0
      ? Math.min(window, Math.round(ratio * window))
      : 0;
    const contextTokens = measuredContext > 0 ? measuredContext : ratioContext;
    const cacheRead = Math.min(contextTokens, measuredCache);
    const endTs = group.endTs || group.startTs;
    let durationMs = endTs > group.startTs ? endTs - group.startTs : 0;
    if (!(durationMs >= MIN_REQUEST_DURATION_MS)) {
      durationMs = outputTokens > 0 ? Math.round(outputTokens / 40 * 1000) : MIN_REQUEST_DURATION_MS;
    }
    durationMs = Math.min(MAX_REQUEST_DURATION_MS, Math.max(MIN_REQUEST_DURATION_MS, Math.round(durationMs)));
    const estimated = !usage;
    requests.push({
      id: group.id,
      source: 'transcript',
      streamId,
      model,
      window,
      inputTokens: measuredCache > 0
        ? Math.max(0, contextTokens - cacheRead)
        : estimated ? (group.contextRaw || 0) : contextTokens,
      cacheReadTokens: measuredCache > 0 ? cacheRead : 0,
      outputTokens,
      thinkingTokens: Math.min(outputTokens, Math.max(0, Math.round(group.thinkingTokens))),
      credits: Number.isFinite(credits) && credits > 0 ? credits : 0,
      durationMs,
      startedAtMs: group.startTs,
      endedAtMs: endTs,
      estimatedInput: estimated,
      estimatedContext: estimated && (group.contextRaw || 0) > 0,
      measuredCache: measuredCache > 0,
      contextRaw: estimated ? (group.contextRaw || 0) : contextTokens,
      contextSegment: group.contextSegment || 0
    });
  }

  for (const compaction of compactionRows) {
    const usage = compaction.usage;
    const contextTokens = positiveNumber(
      usage.input_tokens ?? usage.inputTokens ?? usage.context_tokens ?? usage.contextTokens
    );
    const cacheRead = Math.min(contextTokens, positiveNumber(
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens
    ));
    const outputTokens = Math.round(positiveNumber(usage.output_tokens ?? usage.outputTokens));
    if (!(contextTokens > 0 || outputTokens > 0)) continue;
    const model = String(compaction.model || sessionModel || 'unknown').trim() || 'unknown';
    const window = resolveWindow(model, compaction.ts, windowTimeline, resolvedWindows);
    const credits = Number(usage.credits ?? usage.credit ?? 0);
    const durationMs = Math.min(
      MAX_REQUEST_DURATION_MS,
      Math.max(MIN_REQUEST_DURATION_MS, Math.round(compaction.durationMs || MIN_REQUEST_DURATION_MS))
    );
    requests.push({
      id: compaction.id,
      source: 'compaction',
      streamId,
      model,
      window,
      inputTokens: Math.max(0, contextTokens - cacheRead),
      cacheReadTokens: cacheRead,
      outputTokens,
      thinkingTokens: 0,
      credits: Number.isFinite(credits) && credits > 0 ? credits : 0,
      durationMs,
      startedAtMs: Math.max(0, (compaction.ts || 0) - durationMs),
      endedAtMs: compaction.ts || 0,
      estimatedInput: false,
      estimatedContext: false,
      measuredCache: cacheRead > 0,
      contextRaw: contextTokens,
      contextSegment: compaction.segment
    });
  }

  return {
    sessionId,
    file,
    cwd,
    titleHint,
    firstTs,
    lastTs,
    modelWindows,
    contextSegments,
    requests: requests.sort((a, b) => a.endedAtMs - b.endedAtMs)
  };
}

function resolveWindow(model, ts, timeline, modelWindows) {
  let bestSame = null;
  let bestAny = null;
  for (const entry of timeline) {
    if (ts && entry.ts > ts) continue;
    if (!bestAny || entry.ts >= bestAny.ts) bestAny = entry;
    if (entry.model === model && (!bestSame || entry.ts >= bestSame.ts)) bestSame = entry;
  }
  return (bestSame && bestSame.window)
    || positiveNumber(modelWindows[model])
    || (bestAny && bestAny.model === model ? bestAny.window : 0)
    || (bestAny && model === 'auto' ? bestAny.window : 0)
    || KNOWN_MODEL_WINDOWS[model]
    || DEFAULT_CONTEXT_WINDOW;
}

function openSqlite(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file, { readOnly: true, timeout: 1500 });
  } catch (_) {
    return null;
  }
}

function readSessionMetadata(paths) {
  const map = new Map();
  const db = openSqlite(paths.mainDb);
  if (!db) return map;
  try {
    const rows = db.prepare('SELECT session_id, title, cwd, model, workspace_id FROM chat_sessions').all();
    for (const row of rows) {
      const id = String(row.session_id || '').trim();
      if (!id) continue;
      map.set(id, {
        title: String(row.title || '').trim(),
        cwd: String(row.cwd || '').trim(),
        model: String(row.model || '').trim(),
        workspaceId: String(row.workspace_id || '').trim()
      });
    }
  } catch (_) {
    // Older Qoder builds may not have the same columns; transcript data still works.
  } finally {
    try { db.close(); } catch (_) {}
  }
  return map;
}

function readModelPreferenceWindows(paths) {
  const map = Object.create(null);
  const db = openSqlite(paths.mainDb);
  if (!db) return map;
  try {
    const rows = db.prepare(
      'SELECT model_key, context_window FROM chat_model_preferences WHERE context_window IS NOT NULL'
    ).all();
    for (const row of rows) {
      const model = String(row.model_key || '').trim();
      const window = positiveNumber(row.context_window);
      if (model && window) map[model] = window;
    }
  } catch (_) {
    // Older Qoder builds may not expose model preferences.
  } finally {
    try { db.close(); } catch (_) {}
  }
  return map;
}

function readContextSnapshots(paths) {
  const map = new Map();
  const db = openSqlite(paths.mainDb);
  if (!db) return map;
  try {
    const rows = db.prepare('SELECT session_id, snapshot_json, updated_at FROM chat_session_context_usage').all();
    for (const row of rows) {
      let snapshot;
      try { snapshot = JSON.parse(row.snapshot_json || '{}'); } catch (_) { continue; }
      const percentage = Number(snapshot.percentage);
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 1.5) continue;
      map.set(String(row.session_id || ''), {
        percentage,
        model: String(snapshot.model || '').trim(),
        updatedAtMs: Number(row.updated_at) || 0
      });
    }
  } catch (_) {
    // Optional live enrichment only.
  } finally {
    try { db.close(); } catch (_) {}
  }
  return map;
}

function readTurnCredits(paths) {
  const map = new Map();
  const db = openSqlite(paths.mainDb);
  if (!db) return map;
  try {
    const rows = db.prepare(
      'SELECT session_id, turn_id, created_at, updated_at, turn_credits '
      + 'FROM chat_session_messages WHERE role = ? AND turn_credits > 0'
    ).all('assistant');
    for (const row of rows) {
      const sessionId = String(row.session_id || '').trim();
      const credits = positiveNumber(row.turn_credits);
      const startMs = toMs(row.created_at);
      const endMs = toMs(row.updated_at);
      if (!sessionId || !(credits > 0) || !(endMs > 0)) continue;
      const list = map.get(sessionId) || [];
      list.push({
        turnId: String(row.turn_id || '').trim(),
        startMs: startMs > 0 ? startMs : endMs,
        endMs,
        credits
      });
      map.set(sessionId, list);
    }
  } catch (_) {
    // Older Qoder builds may not expose turn_credits yet.
  } finally {
    try { db.close(); } catch (_) {}
  }
  for (const list of map.values()) list.sort((a, b) => a.startMs - b.startMs);
  return map;
}

// The transcript contains every message, so its content is a proportional
// signal for how large the prompt was. Qoder sometimes exposes an exact
// context snapshot or a compaction usage object; those anchor the estimate to
// real tokens without pretending every message count is a tokenizer reading.
function calibrateContextRequests(requests, segmentsBySession, snapshots, sessionMeta, globalWindows) {
  const bySession = new Map();
  for (const request of requests) {
    if (request.estimatedInput !== true || request.measuredCache === true) continue;
    if (!(positiveNumber(request.contextRaw) > 0)) continue;
    const sessionId = String(request.sessionId || '');
    const list = bySession.get(sessionId) || [];
    list.push(request);
    bySession.set(sessionId, list);
  }
  for (const [sessionId, list] of bySession) {
    const segments = Array.isArray(segmentsBySession.get(sessionId))
      ? segmentsBySession.get(sessionId)
      : [];
    const snapshot = snapshots.get(sessionId);
    const meta = sessionMeta.get(sessionId) || {};
    const snapshotModel = resolveRequestModel(snapshot?.model || meta.model || '', meta.model);
    const snapshotWindow = resolveWindow(snapshotModel, snapshot?.updatedAtMs || 0, [], globalWindows);
    const snapshotTokens = snapshot
      ? Math.min(snapshotWindow, Math.max(0, Math.round(snapshot.percentage * snapshotWindow)))
      : 0;
    const ordered = [...list].sort((a, b) => (a.endedAtMs || 0) - (b.endedAtMs || 0));
    for (const segment of segments) {
      const rawAtEnd = positiveNumber(segment.rawAtEnd);
      let scale = 1;
      if (positiveNumber(segment.compactPre) > 0 && rawAtEnd > 0) {
        scale = segment.compactPre / rawAtEnd;
      } else if (snapshotTokens > 0 && (snapshot?.updatedAtMs || 0) >= (segment.startTs || 0)) {
        const anchor = ordered
          .filter((request) => (request.contextSegment || 0) === segment.index
            && positiveNumber(request.contextRaw) > 0
            && (request.endedAtMs || 0) <= (snapshot?.updatedAtMs || 0))
          .pop();
        const raw = anchor ? positiveNumber(anchor.contextRaw) : rawAtEnd;
        if (raw > 0) scale = snapshotTokens / raw;
      }
      segment.scale = Math.min(20, Math.max(0.05, scale || 1));
    }
    const fallbackScale = segments.length ? (segments[0].scale || 1) : 1;
    for (const request of ordered) {
      const segment = segments.find((entry) => entry.index === (request.contextSegment || 0));
      const scale = segment ? (segment.scale || 1) : fallbackScale;
      const raw = positiveNumber(request.contextRaw);
      const window = positiveNumber(request.window) || DEFAULT_CONTEXT_WINDOW;
      const context = Math.max(1, Math.min(window, Math.round(raw * scale)));
      request.inputTokens = context;
      request.cacheReadTokens = 0;
      request.estimatedContext = true;
    }
  }
}

function creditEstimateFor(request) {
  const input = Math.max(0, positiveNumber(request.inputTokens));
  const cache = Math.max(0, positiveNumber(request.cacheReadTokens));
  const output = Math.max(0, positiveNumber(request.outputTokens));
  return (input * 0.5 + cache * 0.1 + output * 100) / 1000000;
}

// chat_session_messages.turn_credits is the only exact billing figure Qoder
// keeps locally. It is per user turn, while this bridge reports per request;
// distribute a turn's credits over its zero-credit requests by output weight.
// New terminal turns may not have a turn_credits row yet, so those fall back to
// a conservative token-price estimate and are marked as estimated.
function assignRequestCredits(requests, creditsBySession) {
  const bySession = new Map();
  for (const request of requests) {
    const sessionId = String(request.sessionId || '');
    const list = bySession.get(sessionId) || [];
    list.push(request);
    bySession.set(sessionId, list);
  }
  for (const [sessionId, turns] of creditsBySession) {
    const list = bySession.get(sessionId);
    if (!Array.isArray(list) || !turns.length) continue;
    for (const turn of turns) {
      const start = (turn.startMs || 0) - 1000;
      const end = (turn.endMs || 0) + 1000;
      const inTurn = list.filter((request) => (request.endedAtMs || 0) >= start
        && (request.endedAtMs || 0) <= end);
      if (!inTurn.length) continue;
      const existing = inTurn.reduce((sum, request) => sum + positiveNumber(request.credits), 0);
      const pool = Math.max(0, turn.credits - existing);
      if (!(pool > 0)) continue;
      const candidates = inTurn.filter((request) => !(positiveNumber(request.credits) > 0));
      if (!candidates.length) continue;
      const weights = candidates.map((request) => Math.max(1, positiveNumber(request.outputTokens)));
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      let assigned = 0;
      for (let index = 0; index < candidates.length; index += 1) {
        const request = candidates[index];
        const share = index === candidates.length - 1
          ? pool - assigned
          : Math.round(pool * weights[index] / totalWeight * 1e6) / 1e6;
        assigned += share;
        request.credits = Math.max(0, share);
        // The turn total is exact. Only its split across requests is inferred,
        // so do not mark the session/model cost as estimated.
        request.creditSource = 'turn';
      }
    }
  }
  for (const request of requests) {
    if (positiveNumber(request.credits) > 0) continue;
    if (request.estimatedInput !== true || request.source === 'compaction') continue;
    const estimate = creditEstimateFor(request);
    if (!(estimate > 0)) continue;
    request.credits = Math.round(estimate * 1e6) / 1e6;
    request.estimatedCredits = true;
    request.creditSource = 'estimate';
  }
}

function readActiveRequests(paths, { nowMs, committedIdsBySession, lastCommittedBySession, sessionMeta, snapshots, globalWindows }) {
  const db = openSqlite(paths.bufferDb);
  if (!db) return { requests: [], sessions: [] };
  const requests = [];
  const sessions = [];
  try {
    const since = nowMs - ACTIVE_ITEM_LOOKBACK_MS;
    const rows = db.prepare(
      'SELECT session_id, turn_id, turn_started_at, request_set_id, item_id, ordinal, item_type, item_json, created_at '
      + 'FROM active_turn_projection_items WHERE created_at >= ? ORDER BY session_id, turn_id, ordinal'
    ).all(since);
    if (!rows.length) return { requests: [], sessions };

    const turns = new Map();
    for (const row of rows) {
      const key = `${row.session_id}\u0000${row.turn_id}`;
      let turn = turns.get(key);
      if (!turn) {
        turn = {
          sessionId: String(row.session_id || ''),
          turnId: String(row.turn_id || ''),
          turnStartedAt: row.turn_started_at,
          lastAt: 0,
          items: []
        };
        turns.set(key, turn);
      }
      turn.lastAt = Math.max(turn.lastAt, Number(row.created_at) || 0);
      turn.items.push(row);
    }

    const latestBySession = new Map();
    for (const turn of turns.values()) {
      if (turn.lastAt < nowMs - ACTIVE_TURN_STALE_MS) continue;
      const latest = latestBySession.get(turn.sessionId);
      if (!latest || turn.lastAt > latest.lastAt) latestBySession.set(turn.sessionId, turn);
    }

    for (const turn of latestBySession.values()) {
      const committed = committedIdsBySession.get(turn.sessionId) || new Set();
      const meta = sessionMeta.get(turn.sessionId) || {};
      const snapshot = snapshots.get(turn.sessionId);
      const turnStartMs = toMs(turn.turnStartedAt) || Number(turn.items[0]?.created_at) || nowMs;
      let lastBoundaryMs = turnStartMs;
      const groups = new Map();

      for (const item of turn.items) {
        const created = Number(item.created_at) || 0;
        let payload;
        try { payload = JSON.parse(item.item_json || '{}'); } catch (_) { continue; }
        if (item.item_type !== 'assistant') {
          if (created) lastBoundaryMs = Math.max(lastBoundaryMs, created);
          continue;
        }
        const message = payload.message || {};
        const groupId = String(message.id || item.item_id || '').trim();
        if (!groupId || committed.has(groupId)) continue;
        let group = groups.get(groupId);
        if (!group) {
          group = {
            id: groupId,
            model: String(message.model || '').trim(),
            startMs: lastBoundaryMs,
            endMs: created || lastBoundaryMs,
            blocks: [],
            seen: new Set(),
            tokens: 0,
            thinkingTokens: 0
          };
          groups.set(groupId, group);
        }
        if (created) group.endMs = Math.max(group.endMs, created);
        if (message.model) group.model = String(message.model);
        const content = Array.isArray(message.content)
          ? message.content
          : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [];
        addContent(group, content);
      }

      // A session can have older uncommitted groups plus the group currently
      // streaming. Only the newest group receives the live snapshot input; the
      // rest use the last committed context size so they cannot inflate totals.
      const ordered = [...groups.values()].sort((a, b) => a.endMs - b.endMs);
      const newest = ordered[ordered.length - 1];
      const lastCommitted = lastCommittedBySession.get(turn.sessionId) || null;
      const transcriptInput = lastCommitted?.inputTokens || 0;
      const lastCommittedModel = lastCommitted?.model || '';
      const transcriptWindow = lastCommitted?.window || 0;
      const model = (newest && newest.model) || lastCommittedModel || meta.model || 'unknown';
      // Resolve the selector id before picking the window. A buffer snapshot
      // can still say `auto` after chat_sessions.model has been upgraded to the
      // concrete model; the Auto fallback window (128k) would then under-count
      // a live turn whose real window is several times larger.
      const snapshotModel = resolveRequestModel(snapshot?.model || meta.model || lastCommittedModel || model, meta.model);
      const snapshotWindow = resolveWindow(snapshotModel, nowMs, [], globalWindows);
      const snapshotInput = snapshot
        ? Math.max(0, Math.round(snapshot.percentage * snapshotWindow))
        : 0;

      for (const group of ordered) {
        const outputTokens = Math.max(0, Math.round(group.tokens));
        const duration = Math.min(
          MAX_REQUEST_DURATION_MS,
          Math.max(
            MIN_REQUEST_DURATION_MS,
            group.endMs > group.startMs
              ? Math.round(group.endMs - group.startMs)
              : outputTokens > 0 ? Math.round(outputTokens / 40 * 1000) : MIN_REQUEST_DURATION_MS
          )
        );
        const liveInput = group === newest
          ? Math.max(transcriptInput, snapshotInput)
          : transcriptInput;
        const groupModel = resolveRequestModel(group.model || model, meta.model);
        const groupWindow = transcriptWindow || resolveWindow(groupModel, nowMs, [], globalWindows);
        requests.push({
          id: group.id,
          sessionId: turn.sessionId,
          source: 'active',
          model: groupModel,
          window: groupWindow,
          inputTokens: liveInput,
          outputTokens,
          thinkingTokens: Math.min(outputTokens, Math.max(0, Math.round(group.thinkingTokens))),
          credits: 0,
          durationMs: duration,
          startedAtMs: group.startMs,
          endedAtMs: group.endMs
        });
      }
      sessions.push({
        sessionId: turn.sessionId,
        firstActiveMs: Math.min(turnStartMs, ...turn.items.map((item) => Number(item.created_at) || turnStartMs)),
        lastActiveMs: Math.max(turn.lastAt, nowMs)
      });
    }
  } catch (_) {
    // Buffer is an enrichment; a locked or partially-migrated DB must not break scans.
  } finally {
    try { db.close(); } catch (_) {}
  }
  return { requests, sessions };
}

// Qoder's "Auto" picker entry is resolved server-side to a concrete model. The
// transcript and the live buffer keep the selector id (`auto`) while
// chat_sessions.model already holds the model that actually ran (for example
// `dfmodel`). Attribute selector usage to that model, otherwise DeepSeek turns
// show up as a separate "Auto" row and the cache-prefix estimate is reset at
// every selector/concrete boundary. A missing `message.model` becomes the
// literal `unknown` earlier in the pipeline, so it has to be treated as absent
// here too; otherwise those rows can never fall back to the session model.
function resolveRequestModel(model, sessionModel) {
  const id = String(model || '').trim();
  const actual = String(sessionModel || '').trim();
  const missing = !id || /^(?:auto|unknown)$/i.test(id);
  const usableActual = actual && !/^(?:auto|unknown)$/i.test(actual);
  if (missing && usableActual) return actual;
  return id || actual || 'unknown';
}

function displayModelName(model, atMs) {
  const id = String(model || '').trim();
  if (!id) return 'unknown';
  const base = qoderCatalog.chooseDisplayName(id, MODEL_LABELS[id] || '');
  if (!base) return id;
  const observations = qoderCatalog.readModelObservations();
  return qoderCatalog.resolveModelName(id, base, atMs, observations) || base;
}

function applyCacheEstimates(requests) {
  const lastBySession = new Map();
  const ordered = [...requests].sort((a, b) => (a.endedAtMs || 0) - (b.endedAtMs || 0));
  for (const request of ordered) {
    const sessionKey = `${request.sessionId || ''}\u0000${request.streamId || ''}`;
    if (request.measuredCache === true) {
      const contextTokens = Math.max(0, (Number(request.inputTokens) || 0)
        + (Number(request.cacheReadTokens) || 0));
      if (contextTokens > 0) {
        lastBySession.set(sessionKey, {
          endedAtMs: request.endedAtMs || 0,
          model: request.model,
          contextTokens
        });
      }
      continue;
    }
    const contextTokens = Math.max(0, Number(request.inputTokens) || 0);
    const previous = lastBySession.get(sessionKey);
    let cacheRead = 0;
    if (previous && contextTokens > 0 && previous.contextTokens > 0
      && previous.model === request.model
      && request.endedAtMs >= previous.endedAtMs
      && request.endedAtMs - previous.endedAtMs <= PROMPT_CACHE_TTL_MS
      && contextTokens >= previous.contextTokens * PROMPT_CACHE_MIN_GROWTH) {
      cacheRead = Math.min(previous.contextTokens, contextTokens);
    }
    request.cacheReadTokens = cacheRead;
    request.inputTokens = Math.max(0, contextTokens - cacheRead);
    if (contextTokens > 0) {
      lastBySession.set(sessionKey, {
        endedAtMs: request.endedAtMs || 0,
        model: request.model,
        contextTokens
      });
    }
  }
}

function collectQoderData({ sinceMs = 0, untilMs = Number.POSITIVE_INFINITY, nowMs = Date.now(), active = true } = {}) {
  const paths = resolveQoderPaths();
  const files = listTranscriptFiles(paths.projectsDir, sinceMs);
  const parsed = [];
  const globalWindows = Object.create(null);
  const modelWindowDefaults = readModelPreferenceWindows(paths);
  const defaultsKey = modelDefaultsKey(modelWindowDefaults);
  if (defaultsKey !== parseCacheDefaultsKey) {
    parseCache.clear();
    parseCacheDefaultsKey = defaultsKey;
  }
  const committedIdsBySession = new Map();
  const segmentsBySession = new Map();
  const seenFiles = new Set();

  for (const file of files) {
    const session = cachedTranscript(file, modelWindowDefaults, defaultsKey);
    if (!session) continue;
    seenFiles.add(file);
    parsed.push(session);
    Object.assign(globalWindows, session.modelWindows);
    segmentsBySession.set(session.sessionId, session.contextSegments || []);
    const set = committedIdsBySession.get(session.sessionId) || new Set();
    for (const request of session.requests) set.add(request.id);
    committedIdsBySession.set(session.sessionId, set);
  }
  if (sinceMs <= 0) {
    for (const file of parseCache.keys()) {
      if (!seenFiles.has(file)) parseCache.delete(file);
    }
  }

  Object.assign(globalWindows, modelWindowDefaults);
  const sessionMeta = readSessionMetadata(paths);
  const snapshots = readContextSnapshots(paths);
  const creditsBySession = readTurnCredits(paths);

  // Parse every request in the reachable transcripts, not only the ones inside
  // the requested period. The warm-up requests are what let a DAY scan see the
  // prompt-cache prefix that was written shortly before local midnight.
  const allCommitted = [];
  for (const session of parsed) {
    const meta = sessionMeta.get(session.sessionId) || {};
    for (const request of session.requests) {
      const resolvedModel = resolveRequestModel(request.model, meta.model);
      const originalWindow = positiveNumber(request.window);
      const needsResolvedWindow = /^(?:auto|unknown)$/i.test(String(request.model || ''))
        || !(originalWindow > 0);
      allCommitted.push({
        ...request,
        model: resolvedModel,
        window: needsResolvedWindow
          ? resolveWindow(resolvedModel, request.endedAtMs, [], globalWindows)
          : originalWindow,
        sessionId: session.sessionId
      });
    }
  }
  calibrateContextRequests(allCommitted, segmentsBySession, snapshots, sessionMeta, globalWindows);

  const lastCommittedBySession = new Map();
  for (const request of allCommitted) {
    if (request.streamId) continue;
    const previous = lastCommittedBySession.get(request.sessionId);
    if (!previous || request.endedAtMs >= previous.endedAtMs) {
      lastCommittedBySession.set(request.sessionId, request);
    }
  }

  let activeRequests = [];
  let activeSessions = [];
  if (active && nowMs >= sinceMs && nowMs < untilMs) {
    const activeResult = readActiveRequests(paths, {
      nowMs,
      committedIdsBySession,
      lastCommittedBySession,
      sessionMeta,
      snapshots,
      globalWindows
    });
    activeRequests = activeResult.requests;
    activeSessions = activeResult.sessions;
    for (const request of activeRequests) {
      const previous = lastCommittedBySession.get(request.sessionId || '');
      const previousContext = previous
        ? Math.max(0, (previous.inputTokens || 0) + (previous.cacheReadTokens || 0))
        : 0;
      if (previousContext > 0 && (request.inputTokens || 0) < previousContext) {
        request.inputTokens = previousContext;
        request.cacheReadTokens = 0;
        request.estimatedContext = true;
      }
      request.estimatedInput = true;
    }
  }

  const allRequests = [...allCommitted, ...activeRequests];
  applyCacheEstimates(allRequests);
  assignRequestCredits(allRequests, creditsBySession);
  // Resolve by the request's own end time: a rolling slot can be renamed
  // between two turns, and old turns must keep the name they ran under.
  for (const request of allRequests) request.model = displayModelName(request.model, request.endedAtMs);

  const requests = allRequests.filter((request) => request.endedAtMs >= sinceMs && request.endedAtMs < untilMs);
  const sessions = new Map();
  const parsedById = new Map(parsed.map((session) => [session.sessionId, session]));
  for (const request of requests) {
    const sessionId = request.sessionId || '';
    if (!sessionId || sessions.has(sessionId)) continue;
    const meta = sessionMeta.get(sessionId) || {};
    const source = parsedById.get(sessionId) || {};
    const cwd = meta.cwd || source.cwd || '';
    const title = meta.title || source.titleHint || (cwd ? path.basename(cwd) : '');
    sessions.set(sessionId, {
      sessionId,
      cwd,
      title,
      firstActiveMs: source.firstTs || request.startedAtMs || request.endedAtMs,
      lastActiveMs: source.lastTs || request.endedAtMs
    });
  }
  for (const session of activeSessions) {
    if (!sessions.has(session.sessionId)) {
      const meta = sessionMeta.get(session.sessionId) || {};
      sessions.set(session.sessionId, {
        sessionId: session.sessionId,
        cwd: meta.cwd || '',
        title: meta.title || (meta.cwd ? path.basename(meta.cwd) : ''),
        firstActiveMs: session.firstActiveMs,
        lastActiveMs: session.lastActiveMs
      });
    } else {
      const existing = sessions.get(session.sessionId);
      existing.firstActiveMs = Math.min(existing.firstActiveMs || session.firstActiveMs, session.firstActiveMs);
      existing.lastActiveMs = Math.max(existing.lastActiveMs || 0, session.lastActiveMs);
    }
  }

  return {
    paths,
    requests,
    sessions: [...sessions.values()],
    sessionMeta,
    activeCount: activeRequests.filter((request) => request.endedAtMs >= sinceMs && request.endedAtMs < untilMs).length
  };
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW,
  KNOWN_MODEL_WINDOWS,
  applyCacheEstimates,
  assignRequestCredits,
  calibrateContextRequests,
  collectQoderData,
  creditEstimateFor,
  displayModelName,
  listTranscriptFiles,
  parseTranscript,
  resolveRequestModel,
  resolveWindow,
  toMs
};
