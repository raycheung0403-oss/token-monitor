'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildModelTimeline,
  chooseDisplayName,
  extractVersionedName,
  isBuildAlias,
  nameTokens,
  parseModelConfigEvents,
  readModelObservations,
  resolveModelName,
  versionSignature
} = require('../src/qoder-catalog');

assert.equal(
  extractVersionedName("DeepSeek's production model (DeepSeek-V4.1-Flash-1017), with leading agent capabilities."),
  'DeepSeek-V4.1-Flash-1017'
);
assert.equal(
  extractVersionedName("Qwen's latest foundation model—Qwen3.8-Max-0902—, with 2.4T parameters."),
  'Qwen3.8-Max-0902'
);
assert.equal(extractVersionedName("Kimi's most powerful model: 3T-class parameters."), '');
assert.equal(extractVersionedName("MiniMax's latest Flash model with native multimodality."), '');

assert.equal(versionSignature('DeepSeek-V4.1-Flash 1024'), 'deepseek:4.1');
assert.equal(versionSignature('DeepSeek-V4.1-Flash-1017'), 'deepseek:4.1');
assert.equal(versionSignature('DeepSeek-V4.2-Flash-1103'), 'deepseek:4.2');
assert.equal(versionSignature('Kimi-K2.7-Code'), 'kimi:2.7');
assert.equal(versionSignature('Kimi-K2.8-Preview'), 'kimi:2.8');
assert.equal(versionSignature('DeepSeek-Flash'), '');

const catalog = {
  dfmodel: { label: 'DeepSeek-Flash', version: 'DeepSeek-V4.1-Flash-1017' },
  kmodel: { label: 'Kimi-K2.8-Preview', version: '' },
  smodel: { label: 'Sonus', version: '' }
};

// The hand-written build suffix survives while Qoder's catalog is on the same
// base version, including the local bundle still saying -1017.
assert.equal(
  chooseDisplayName('dfmodel', 'DeepSeek-V4.1-Flash 1024', catalog),
  'DeepSeek-V4.1-Flash 1024'
);
assert.equal(chooseDisplayName('kmodel', 'Kimi-K2.7-Code', catalog), 'Kimi-K2.8-Preview');
assert.equal(chooseDisplayName('smodel', '', catalog), 'Sonus');
assert.equal(chooseDisplayName('unknown', '', catalog), 'unknown');

// Rolling slots only move forward. Qoder's bundled catalog still says
// Qwen3.7-Max while the picker/current model is Qwen4-Max-Preview; the stale
// catalog must not downgrade the name.
assert.equal(
  chooseDisplayName('qmodel_latest', 'Qwen4-Max-Preview', {
    qmodel_latest: { label: 'Qwen3.7-Max', version: 'Qwen3.7-Max' }
  }),
  'Qwen4-Max-Preview'
);
assert.equal(
  chooseDisplayName('qmodel_latest', 'Qwen3.7-Max', {
    qmodel_latest: { label: 'Qwen4-Max-Preview', version: 'Qwen4-Max-Preview' }
  }),
  'Qwen4-Max-Preview'
);
assert.equal(
  chooseDisplayName('dfmodel', 'DeepSeek-V4.2-Flash', {
    dfmodel: { label: 'DeepSeek-Flash', version: 'DeepSeek-V4.1-Flash-1017' }
  }),
  'DeepSeek-V4.2-Flash'
);

// A real version move uses the catalog's specific name.
assert.equal(
  chooseDisplayName('dfmodel', 'DeepSeek-V4.1-Flash 1024', {
    dfmodel: { label: 'DeepSeek-Flash', version: 'DeepSeek-V4.2-Flash-1103' }
  }),
  'DeepSeek-V4.2-Flash-1103'
);

// ---------------------------------------------------------------------------
// Live display names from Qoder request logs
// ---------------------------------------------------------------------------
assert.equal(nameTokens('Qwen4-Max-Preview').join(' '), 'qwen 4 max preview');
assert.equal(isBuildAlias('DeepSeek-Flash', 'DeepSeek-V4.1-Flash 1024'), true);
assert.equal(isBuildAlias('Qwen4-Max', 'Qwen4-Max-Preview'), false);
assert.equal(isBuildAlias('Qwen3.8-Max', 'Qwen3.8-Max-0902'), true);

// Preview -> Max is a real name change: earlier requests keep the preview row,
// new requests start a Qwen4-Max row.
const qwenObservations = [
  { name: 'Qwen4-Max-Preview', since: 1000 },
  { name: 'Qwen4-Max', since: 2000 }
];
assert.deepEqual(
  buildModelTimeline('Qwen4-Max', qwenObservations).map((entry) => entry.name),
  ['Qwen4-Max-Preview', 'Qwen4-Max']
);
assert.equal(resolveModelName('qmodel_latest', 'Qwen4-Max', 1500, { qmodel_latest: qwenObservations }), 'Qwen4-Max-Preview');
assert.equal(resolveModelName('qmodel_latest', 'Qwen4-Max', 2500, { qmodel_latest: qwenObservations }), 'Qwen4-Max');
assert.equal(resolveModelName('qmodel_latest', 'Qwen4-Max', 500, { qmodel_latest: qwenObservations }), 'Qwen4-Max');

// Qoder logs the generic DeepSeek-Flash alias for the hand-written build name;
// that must not create a new row or replace the detailed label.
const deepseekObservations = [{ name: 'DeepSeek-Flash', since: 1000 }];
assert.deepEqual(buildModelTimeline('DeepSeek-V4.1-Flash 1024', deepseekObservations), []);
assert.equal(
  resolveModelName('dfmodel', 'DeepSeek-V4.1-Flash 1024', 2000, { dfmodel: deepseekObservations }),
  'DeepSeek-V4.1-Flash 1024'
);

// A build suffix difference is still the same model.
assert.deepEqual(
  buildModelTimeline('DeepSeek-V4.1-Flash 1024', [{ name: 'DeepSeek-V4.1-Flash-1017', since: 1000 }]),
  []
);

// A real version/name move starts at its first log sighting.
const kimiObservations = [{ name: 'Kimi-K3.1-Pro', since: 1000 }];
assert.deepEqual(
  buildModelTimeline('Kimi-K3', kimiObservations).map((entry) => entry.name),
  ['Kimi-K3.1-Pro']
);
assert.equal(resolveModelName('kmodel_latest', 'Kimi-K3', 500, { kmodel_latest: kimiObservations }), 'Kimi-K3');
assert.equal(resolveModelName('kmodel_latest', 'Kimi-K3', 1500, { kmodel_latest: kimiObservations }), 'Kimi-K3.1-Pro');

const logLine = '2026-11-16T15:00:31.250+08:00 INFO  debug.message [QoderInferRequest details] '
  + 'model_config={"key":"qmodel_latest","display_name":"Qwen4-Max","model":"","format":"openai",'
  + '"max_input_tokens":1000000}, custom_model=';
const events = parseModelConfigEvents(logLine);
assert.equal(events.length, 1);
assert.equal(events[0].key, 'qmodel_latest');
assert.equal(events[0].name, 'Qwen4-Max');
assert.equal(events[0].since, Date.parse('2026-11-16T15:00:31.250+08:00'));

// The persisted observation cache survives between scans and only picks up the
// new display name when the log grows.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-labels-'));
try {
  const runDir = path.join(tempRoot, 'logs', 'runs', '2026-11-11T12-00-00');
  fs.mkdirSync(runDir, { recursive: true });
  const logFile = path.join(runDir, 'qodercli.log');
  fs.writeFileSync(logFile, '2026-11-11T12:30:28.000+08:00 INFO debug model_config='
    + '{"key":"qmodel_latest","display_name":"Qwen4-Max-Preview"}, custom_model=\n');
  const stateFile = path.join(tempRoot, 'labels.json');
  const first = readModelObservations({ logsDir: path.join(tempRoot, 'logs', 'runs'), stateFile, ttlMs: 0, nowMs: 1 });
  assert.deepEqual(first.qmodel_latest, [{
    name: 'Qwen4-Max-Preview',
    since: Date.parse('2026-11-11T12:30:28.000+08:00')
  }]);

  fs.appendFileSync(logFile, '2026-11-16T15:00:31.250+08:00 INFO debug model_config='
    + '{"key":"qmodel_latest","display_name":"Qwen4-Max"}, custom_model=\n');
  const second = readModelObservations({ logsDir: path.join(tempRoot, 'logs', 'runs'), stateFile, ttlMs: 0, nowMs: 2 });
  assert.deepEqual(second.qmodel_latest.map((item) => item.name), ['Qwen4-Max-Preview', 'Qwen4-Max']);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('catalog tests passed');
