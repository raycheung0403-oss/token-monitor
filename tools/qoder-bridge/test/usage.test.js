'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyRequestMaxima, buildEntries, mergeGraphData } = require('../src/qoder-usage');
const {
  applyCacheEstimates,
  assignRequestCredits,
  calibrateContextRequests,
  creditEstimateFor,
  parseTranscript,
  resolveRequestModel
} = require('../src/qoder-data');

function request(overrides = {}) {
  return {
    sessionId: 'session-1',
    id: 'request-1',
    model: 'DeepSeek-V4.1-Flash 1024',
    inputTokens: 100,
    cacheReadTokens: 0,
    outputTokens: 10,
    durationMs: 1000,
    startedAtMs: 1000,
    endedAtMs: 2000,
    credits: 1,
    ...overrides
  };
}

const state = { requests: Object.create(null), changed: false };

const first = request();
applyRequestMaxima([first], state, 5000);
assert.equal(first.cacheReadTokens, 0);
assert.equal(state.requests['session-1\u0000request-1'].context, 100);

// A later scan can estimate a larger cached slice with a smaller fresh-input
// share. The pair must still describe the same, non-decreasing context.
const second = request({ inputTokens: 50, cacheReadTokens: 100, outputTokens: 12, endedAtMs: 3000 });
applyRequestMaxima([second], state, 5000);
assert.equal(second.inputTokens + second.cacheReadTokens, 150);
assert.equal(second.cacheReadTokens, 100);

// If a rescan revises the context downward, the stored maxima still wins, but
// input is recomputed from the merged context rather than added on top.
const third = request({ inputTokens: 80, cacheReadTokens: 40, endedAtMs: 3500 });
applyRequestMaxima([third], state, 5000);
assert.equal(third.inputTokens + third.cacheReadTokens, 150);
assert.equal(third.cacheReadTokens, 100);
assert.equal(third.inputTokens, 50);

const entries = buildEntries([first, second], {
  sessions: [{ sessionId: 'session-1', cwd: 'D:/Work/demo', title: 'Demo', firstActiveMs: 1000, lastActiveMs: 3000 }],
  sessionMeta: new Map()
}, { creditUsd: 40 / 3000 });
assert.equal(entries.length, 1);
assert.ok(Math.abs(entries[0].cost - (2 * 40 / 3000)) < 1e-12);
assert.equal(entries[0].input, 150);
assert.equal(entries[0].cacheRead, 100);
assert.equal(entries[0].output, 22);
assert.equal(entries[0].performance.timedTokens, 272);

// Qoder keeps the "auto" selector id in transcripts/buffers while the session
// row holds the model the server actually ran. Attribute Auto usage to that
// concrete model so it does not split into an "Auto" row and break the cache
// prefix chain; a real auto session (or an explicit model) is left alone.
assert.equal(resolveRequestModel('auto', 'dfmodel'), 'dfmodel');
assert.equal(resolveRequestModel('', 'dfmodel'), 'dfmodel');
assert.equal(resolveRequestModel('auto', 'auto'), 'auto');
assert.equal(resolveRequestModel('auto', ''), 'auto');
assert.equal(resolveRequestModel('dfmodel', 'qmodel_latest'), 'dfmodel');
// A transcript row with no model becomes the literal `unknown` before this
// resolver runs; it must still be able to fall back to the session model.
assert.equal(resolveRequestModel('unknown', 'dfmodel'), 'dfmodel');
assert.equal(resolveRequestModel('unknown', 'unknown'), 'unknown');
assert.equal(resolveRequestModel('unknown', ''), 'unknown');

// Context occupancy is a per-session snapshot: every model row carries the
// latest measured pair so the renderer's freshest-wins merge stays stable.
const contextEntries = buildEntries([
  request({ id: 'ctx-1', inputTokens: 120, cacheReadTokens: 980, window: 1000000, endedAtMs: 1000 }),
  request({ id: 'ctx-2', inputTokens: 20, cacheReadTokens: 1020, window: 1000000, endedAtMs: 2000 })
], {
  sessions: [{ sessionId: 'session-1', cwd: 'D:/Work/demo', title: 'Demo', firstActiveMs: 1000, lastActiveMs: 2000 }],
  sessionMeta: new Map()
}, { creditUsd: 40 / 3000 });
assert.equal(contextEntries.length, 1);
assert.equal(contextEntries[0].contextTokens, 1040);
assert.equal(contextEntries[0].contextWindow, 1000000);

// Token Monitor 0.93+ natively scans Qoder. The graph path has no per-client
// replacement like the scan path, so the bridge must remove the native rows
// before adding its own day; otherwise messages/tokens are counted twice.
const realGraph = {
  meta: { version: '4.23.0' },
  summary: {
    totalTokens: 160,
    totalCost: 1.5,
    totalDays: 1,
    activeDays: 1,
    averagePerDay: 160,
    maxCostInSingleDay: 1.5,
    clients: ['claude', 'qoder'],
    models: ['claude-4', 'qwen-native']
  },
  contributions: [{
    date: '2026-11-19',
    totals: { tokens: 160, cost: 1.5, messages: 3 },
    intensity: 3,
    tokenBreakdown: { input: 110, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    clients: [
      {
        client: 'claude',
        modelId: 'claude-4',
        tokens: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 1.2,
        messages: 1
      },
      {
        client: 'qoder',
        modelId: 'qwen-native',
        tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0.3,
        messages: 2
      }
    ],
    activeTimeMs: 1000
  }]
};
const bridgeGraph = {
  contributions: [{
    date: '2026-11-19',
    totals: { tokens: 200, cost: 0.2, messages: 4 },
    intensity: 0,
    tokenBreakdown: { input: 20, output: 180, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    clients: [{
      client: 'qoder',
      modelId: 'DeepSeek-V4.1-Flash 1024',
      providerId: 'qoder',
      tokens: { input: 20, output: 180, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: 0.2,
      messages: 4,
      unpricedTokens: 0
    }],
    activeTimeMs: 2000
  }]
};
const mergedGraph = mergeGraphData(realGraph, bridgeGraph);
assert.equal(mergedGraph.contributions.length, 1);
const mergedDay = mergedGraph.contributions[0];
assert.equal(mergedDay.clients.filter((client) => client.client === 'qoder').length, 1);
assert.equal(mergedDay.clients.find((client) => client.client === 'qoder').modelId, 'DeepSeek-V4.1-Flash 1024');
assert.equal(mergedDay.totals.tokens, 340);
assert.equal(mergedDay.totals.cost, 1.4);
assert.equal(mergedDay.totals.messages, 5);
assert.equal(mergedDay.tokenBreakdown.input, 120);
assert.equal(mergedDay.tokenBreakdown.output, 220);
assert.equal(mergedGraph.summary.totalTokens, 340);
assert.equal(mergedGraph.summary.models.includes('qwen-native'), false);
assert.equal(mergedGraph.summary.models.includes('DeepSeek-V4.1-Flash 1024'), true);


// Auto-mode transcripts carry no message.usage. The parser must still emit an
// estimated request from content, and the maxima guard must not let a stored
// full-context snapshot turn that estimate into fresh input.
const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-auto-'));
const autoFile = path.join(autoDir, 'auto-session.jsonl');
const autoNow = Date.now();
fs.writeFileSync(autoFile, [
  JSON.stringify({ type: 'runtime-config', sessionId: 'auto-session', model: 'dfmodel', contextWindow: 1000000, timestamp: autoNow - 5000 }),
  JSON.stringify({ type: 'user', sessionId: 'auto-session', timestamp: autoNow - 4000, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
  JSON.stringify({
    type: 'assistant',
    sessionId: 'auto-session',
    timestamp: autoNow - 3000,
    message: { id: 'auto-message-1', role: 'assistant', model: 'auto', content: [{ type: 'text', text: 'A concise answer with enough text to estimate output tokens.' }] },
    requestTokenAnchor: { requestId: 'auto-request-1' },
    responseGroupId: 'auto-group-1'
  }),
  JSON.stringify({
    type: 'assistant',
    sessionId: 'auto-session',
    timestamp: autoNow - 2500,
    message: { id: 'synthetic-note', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'not a real request' }] }
  })
].join(String.fromCharCode(10)) + String.fromCharCode(10));
const autoParsed = parseTranscript(autoFile);
assert.equal(autoParsed.requests.length, 1);
assert.equal(autoParsed.requests[0].id, 'auto-message-1');
assert.equal(autoParsed.requests[0].estimatedInput, true);
assert.ok(autoParsed.requests[0].outputTokens > 0);
assert.equal(autoParsed.requests[0].estimatedContext, true);
assert.ok(autoParsed.requests[0].contextRaw > 0);
assert.ok(autoParsed.requests[0].inputTokens > 0);

const autoState = {
  requests: {
    'auto-session\u0000auto-message-1': {
      model: 'DeepSeek-V4.1-Flash 1024',
      input: 437310,
      output: 1,
      cacheRead: 0,
      context: 437310,
      duration: 1,
      endedAt: autoNow - 3000,
      startedAt: autoNow - 4000,
      credits: 0
    }
  },
  changed: false
};
const autoRequest = {
  ...request({
    sessionId: 'auto-session',
    id: 'auto-message-1',
    model: 'DeepSeek-V4.1-Flash 1024',
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: autoParsed.requests[0].outputTokens,
    estimatedInput: true
  })
};
applyRequestMaxima([autoRequest], autoState, autoNow);
assert.equal(autoRequest.inputTokens, 0);
assert.equal(autoRequest.cacheReadTokens, 0);
assert.ok(autoRequest.outputTokens > 0);
assert.equal(autoState.requests['auto-session\u0000auto-message-1'].input, 437310);
// An estimate must not survive as a maximum once Qoder reports the exact turn
// credit; otherwise the card would keep an inflated session price forever.
const exactCreditState = {
  requests: {
    'session-1\u0000credit-request': {
      model: 'DeepSeek-V4.1-Flash 1024',
      input: 100,
      output: 10,
      cacheRead: 0,
      context: 100,
      duration: 1000,
      endedAt: 2000,
      startedAt: 1000,
      credits: 5,
      estimatedCredits: true
    }
  },
  changed: false
};
const exactCreditRequest = request({ id: 'credit-request', credits: 3 });
applyRequestMaxima([exactCreditRequest], exactCreditState, 5000);
assert.equal(exactCreditRequest.credits, 3);
const exactAfterEstimateState = {
  requests: {
    'session-1\u0000measured-request': {
      model: 'DeepSeek-V4.1-Flash 1024',
      input: 400000,
      output: 10,
      cacheRead: 37310,
      context: 437310,
      duration: 1000,
      endedAt: 2000,
      startedAt: 1000,
      credits: 0,
      estimatedContext: true
    }
  },
  changed: false
};
const measuredRequest = request({
  id: 'measured-request',
  inputTokens: 100,
  cacheReadTokens: 0,
  outputTokens: 10
});
applyRequestMaxima([measuredRequest], exactAfterEstimateState, 5000);
assert.equal(measuredRequest.inputTokens, 100);
assert.equal(measuredRequest.cacheReadTokens, 0);

const estimatedCreditRequest = request({ id: 'credit-request', credits: 4, estimatedCredits: true });
const exactState = {
  requests: {
    'session-1\u0000credit-request': {
      ...exactCreditState.requests['session-1\u0000credit-request'],
      credits: 3,
      estimatedCredits: false
    }
  },
  changed: false
};
applyRequestMaxima([estimatedCreditRequest], exactState, 5000);
assert.equal(estimatedCreditRequest.credits, 3);

fs.rmSync(autoDir, { recursive: true, force: true });

// Content volume is calibrated to a real compaction figure, then the cache
// split uses the resulting context. This is what turns an Auto turn from an
// output-only reading into a priced, cache-aware request.
const calibrated = [
  request({
    sessionId: 'calibrated-session',
    id: 'calibrated-1',
    inputTokens: 0,
    outputTokens: 10,
    endedAtMs: 1000,
    estimatedInput: true,
    credits: 0,
    contextRaw: 1000,
    contextSegment: 0,
    window: 10000
  }),
  request({
    sessionId: 'calibrated-session',
    id: 'calibrated-2',
    inputTokens: 0,
    outputTokens: 10,
    endedAtMs: 2000,
    estimatedInput: true,
    credits: 0,
    contextRaw: 2000,
    contextSegment: 0,
    window: 10000
  })
];
calibrateContextRequests(
  calibrated,
  new Map([['calibrated-session', [{
    index: 0,
    startTs: 0,
    endTs: 2000,
    baseline: 0,
    rawAtEnd: 2000,
    compactPre: 1000,
    compactPost: 0,
    scale: 1
  }]]]),
  new Map(),
  new Map([['calibrated-session', { model: 'dfmodel' }]]),
  { dfmodel: 10000 }
);
assert.equal(calibrated[0].inputTokens, 500);
assert.equal(calibrated[1].inputTokens, 1000);
assert.equal(calibrated[0].estimatedContext, true);
applyCacheEstimates(calibrated);
assert.equal(calibrated[0].cacheReadTokens, 0);
assert.equal(calibrated[0].inputTokens, 500);
assert.equal(calibrated[1].cacheReadTokens, 500);
assert.equal(calibrated[1].inputTokens, 500);
assignRequestCredits(calibrated, new Map([['calibrated-session', [{
  turnId: 'turn-1',
  startMs: 0,
  endMs: 2000,
  credits: 2
}]]]));
assert.ok(Math.abs(calibrated[0].credits - 1) < 1e-9);
assert.ok(Math.abs(calibrated[1].credits - 1) < 1e-9);
assert.equal(calibrated[0].creditSource, 'turn');
assert.equal(calibrated[0].estimatedCredits, undefined);
const estimatedCostRequest = request({
  sessionId: 'estimated-session',
  id: 'estimated-1',
  inputTokens: 1000000,
  cacheReadTokens: 0,
  outputTokens: 0,
  estimatedInput: true,
  credits: 0,
  endedAtMs: 3000
});
assignRequestCredits([estimatedCostRequest], new Map());
assert.ok(Math.abs(estimatedCostRequest.credits - 0.5) < 1e-9);
assert.equal(estimatedCostRequest.estimatedCredits, true);
assert.ok(Math.abs(creditEstimateFor({
  inputTokens: 1000000,
  cacheReadTokens: 0,
  outputTokens: 0
}) - 0.5) < 1e-9);
assert.ok(Math.abs(creditEstimateFor({
  inputTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 100000
}) - 10) < 1e-9);

// A snapshot anchors a session that never compacted: raw content is scaled to
// the real context occupancy at the snapshot time.
const snapshotCalibrated = [request({
  sessionId: 'snapshot-session',
  id: 'snapshot-1',
  inputTokens: 0,
  outputTokens: 10,
  endedAtMs: 1000,
  estimatedInput: true,
  contextRaw: 2000,
  contextSegment: 0,
  window: 10000
})];
calibrateContextRequests(
  snapshotCalibrated,
  new Map([['snapshot-session', [{
    index: 0,
    startTs: 0,
    endTs: 2000,
    baseline: 0,
    rawAtEnd: 2000,
    compactPre: 0,
    compactPost: 0,
    scale: 1
  }]]]),
  new Map([['snapshot-session', {
    percentage: 0.5,
    model: 'dfmodel',
    updatedAtMs: 1500
  }]]),
  new Map([['snapshot-session', { model: 'dfmodel' }]]),
  { dfmodel: 10000 }
);
assert.equal(snapshotCalibrated[0].inputTokens, 5000);
assert.equal(snapshotCalibrated[0].estimatedContext, true);

console.log('usage tests passed');
