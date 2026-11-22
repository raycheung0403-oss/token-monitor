'use strict';

// Qoder ships the model picker's copy as a dynamic-text bundle next to the
// app: resources/dynamic-text/qoder.json. Each entry is model.<id>.label /
// .description, and the description often carries the exact upstream build
// (for example "DeepSeek-V4.1-Flash-1017"). Reading that file keeps the
// bridge's display names following Qoder instead of a hand-maintained table
// that goes stale (Kimi-K2.7-Code, MiniMax-M3, ...).
//
// The catalog is only a naming source: token estimates still come from the
// transcripts and the quota window, and cost still comes from Qoder's credits.
// If Qoder changes a model server-side without refreshing this bundle, no
// local file can know; the static labels in qoder-data.js remain the fallback.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stateDir } = require('./paths');

const FAMILY_PATTERN = /(?:DeepSeek|Qwen|Kimi|GLM|MiniMax)[A-Za-z0-9._-]*/g;
const VERSION_PATTERN = /(deepseek|qwen|kimi|glm|minimax)[^0-9]{0,4}(\d+(?:\.\d+)?)/i;
const INSTALL_CACHE_FILE = path.join(stateDir(), 'qoder-install.json');
const INSTALL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// Qoder's bundled dynamic-text catalog is not the whole story: for a rolling
// slot such as qmodel_latest it can keep saying Qwen3.7-Max while the server
// has already moved to Qwen4-Max. The CLI log, however, prints the live
// `model_config` for every request, including the display name Qoder's picker
// is using right now. Remember the first time each display name was seen so a
// renamed slot produces a new model row instead of rewriting older usage.
const MODEL_LABEL_STATE_FILE = path.join(stateDir(), 'qoder-model-labels.json');
const MODEL_LABEL_STATE_VERSION = 1;
const MODEL_LOG_SCAN_TTL_MS = 60 * 1000;

let catalogCache = null;
let resolvedRoot;
let labelStateCache = null;
let observationCache = null;

function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch (_) {
    return false;
  }
}

function isFile(value) {
  try {
    return fs.statSync(value).isFile();
  } catch (_) {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch (_) {
    // A read-only or locked state directory must never break a scan.
  }
}

function decodeRegistryText(buffer) {
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch (_) {
    return buffer.toString('utf8');
  }
}

function uninstallRootsFromRegistry() {
  if (process.platform !== 'win32') return [];
  const roots = [];
  for (const hive of ['HKCU', 'HKLM']) {
    let text;
    try {
      text = decodeRegistryText(execFileSync('reg', [
        'query',
        `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`,
        '/s',
        '/f',
        'Qoder',
        '/d'
      ], { encoding: null, timeout: 4000, windowsHide: true }));
    } catch (_) {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*(UninstallString|DisplayIcon)\s+REG_\w+\s+/i.test(line)) continue;
      const match = /REG_\w+\s+"?([^"\r\n]+?\.exe)/i.exec(line);
      if (!match) continue;
      const exe = match[1].trim();
      const root = path.dirname(exe);
      if (isDirectory(root)) roots.push(root);
    }
  }
  return [...new Set(roots)];
}

function normalizeRoot(root) {
  let value = String(root || '').trim();
  if (!value) return '';
  value = path.resolve(value);
  // Some uninstall entries point at a versioned directory. The model catalog
  // is looked up from the launcher root, which owns .qoder-versions.
  if (path.basename(path.dirname(value)) === '.qoder-versions') {
    value = path.dirname(path.dirname(value));
  }
  return value;
}

function looksLikeQoderRoot(root) {
  return Boolean(root)
    && (isDirectory(path.join(root, '.qoder-versions')) || isDirectory(path.join(root, 'resources')));
}

function installCandidates() {
  const env = process.env;
  const candidates = [];
  const add = (value) => {
    if (value) candidates.push(value);
  };
  add(env.QODER_INSTALL_DIR);
  if (process.platform === 'win32') {
    if (env.LOCALAPPDATA) add(path.join(env.LOCALAPPDATA, 'Programs', 'Qoder'));
    if (env.ProgramFiles) add(path.join(env.ProgramFiles, 'Qoder'));
    if (env['ProgramFiles(x86)']) add(path.join(env['ProgramFiles(x86)'], 'Qoder'));
    add('C:\\Qoder');
  } else if (process.platform === 'darwin') {
    add('/Applications/Qoder.app/Contents');
  }
  return candidates.map(normalizeRoot).filter(Boolean);
}

function readCachedRoot() {
  try {
    const cached = readJson(INSTALL_CACHE_FILE);
    if (!cached || !Number.isFinite(Number(cached.checkedAt))) return null;
    if (Date.now() - Number(cached.checkedAt) > INSTALL_CACHE_TTL_MS) return null;
    const root = normalizeRoot(cached.root);
    return looksLikeQoderRoot(root) ? root : null;
  } catch (_) {
    return null;
  }
}

function writeCachedRoot(root) {
  writeJson(INSTALL_CACHE_FILE, { root: root || '', checkedAt: Date.now() });
}

function findInstallRoot() {
  if (resolvedRoot !== undefined) return resolvedRoot;
  resolvedRoot = '';
  const cached = readCachedRoot();
  if (cached) {
    resolvedRoot = cached;
    return resolvedRoot;
  }
  for (const candidate of installCandidates()) {
    if (looksLikeQoderRoot(candidate)) {
      resolvedRoot = candidate;
      writeCachedRoot(candidate);
      return resolvedRoot;
    }
  }
  for (const candidate of uninstallRootsFromRegistry()) {
    const root = normalizeRoot(candidate);
    if (looksLikeQoderRoot(root)) {
      resolvedRoot = root;
      writeCachedRoot(root);
      return resolvedRoot;
    }
  }
  // Cache the miss briefly as well, so a machine without Qoder does not run a
  // registry walk on every scan.
  writeCachedRoot('');
  return resolvedRoot;
}

function versionParts(name) {
  return String(name || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function compareVersionDirs(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (b[index] || 0) - (a[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function catalogPathForRoot(root) {
  if (!root) return '';
  const versionsRoot = path.join(root, '.qoder-versions');
  let versions = [];
  try {
    versions = fs.readdirSync(versionsRoot).filter((name) => isDirectory(path.join(versionsRoot, name)));
  } catch (_) {
    versions = [];
  }
  versions.sort(compareVersionDirs);
  for (const version of versions) {
    const file = path.join(versionsRoot, version, 'resources', 'dynamic-text', 'qoder.json');
    if (isFile(file)) return file;
  }
  const fallback = path.join(root, 'resources', 'dynamic-text', 'qoder.json');
  return isFile(fallback) ? fallback : '';
}

function extractVersionedName(description) {
  const text = String(description || '');
  const matches = text.match(FAMILY_PATTERN) || [];
  const named = matches
    .map((match) => match.replace(/[.,;:，。；：]+$/g, ''))
    .filter((match) => /\d/.test(match))
    .sort((left, right) => right.length - left.length);
  return named[0] || '';
}

function versionSignature(name) {
  const match = VERSION_PATTERN.exec(String(name || ''));
  if (!match) return '';
  return `${match[1].toLowerCase()}:${match[2]}`;
}

// Compare two `family:version` signatures. A different family is not
// comparable; a missing numeric part is treated as older. This is deliberately
// one-way: a rolling slot such as qmodel_latest may be *upgraded* when Qoder
// publishes a newer catalog label, but an older catalog label must never
// downgrade the name already on screen (Qoder's dynamic-text bundle can lag
// behind the model picker).
function compareModelVersions(left, right) {
  if (!left || !right) return 0;
  const [leftFamily, leftVersion = ''] = left.split(':');
  const [rightFamily, rightVersion = ''] = right.split(':');
  if (!leftFamily || leftFamily !== rightFamily) return 0;
  const toParts = (value) => String(value).split('.').map((part) => Number(part) || 0);
  const a = toParts(leftVersion);
  const b = toParts(rightVersion);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseCatalog(file) {
  if (!file) return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return null;
  }
  if (catalogCache && catalogCache.file === file && catalogCache.mtimeMs === stat.mtimeMs) {
    return catalogCache.models;
  }
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object') return null;
  const table = raw.en && typeof raw.en === 'object' ? raw.en : raw.zh;
  if (!table || typeof table !== 'object') return null;
  const models = Object.create(null);
  for (const [key, value] of Object.entries(table)) {
    const match = /^model\.(.+)\.(label|description)$/.exec(key);
    if (!match) continue;
    const id = match[1];
    if (!id || typeof value !== 'string') continue;
    if (!models[id]) models[id] = { label: '', description: '' };
    models[id][match[2]] = value;
  }
  for (const entry of Object.values(models)) {
    entry.version = extractVersionedName(entry.description);
  }
  catalogCache = { file, mtimeMs: stat.mtimeMs, models };
  return models;
}

function readCatalog() {
  const root = findInstallRoot();
  if (!root) return null;
  return parseCatalog(catalogPathForRoot(root));
}

// Keep a label while it already names the same upstream version. This is what
// lets a hand-written "DeepSeek-V4.1-Flash 1024" survive a catalog that still
// says ...-1017, while a real 4.1 -> 4.2 move switches to the catalog's name.
// Unknown ids get the catalog's label immediately, so a new slot such as
// `smodel` never leaks into the model list as a raw id.
//
// Names only move forward. Qoder's catalog is a bundled fallback and trails the
// model picker; trusting it blindly made qmodel_latest (Qwen4-Max-Preview in
// the picker) regress to Qwen3.7-Max. A newer catalog version still upgrades a
// label, an older one is ignored.
function chooseDisplayName(id, current, models = readCatalog()) {
  const entry = models && models[id];
  if (!entry) return current || id || 'unknown';
  const candidate = entry.version || entry.label || '';
  if (!candidate) return current || id || 'unknown';
  if (!current) return candidate;
  const currentSignature = versionSignature(current);
  const candidateSignature = versionSignature(candidate);
  if (!currentSignature && candidateSignature) return candidate;
  if (currentSignature && !candidateSignature) return current;
  if (currentSignature && candidateSignature) {
    if (currentSignature === candidateSignature) return current;
    return compareModelVersions(candidateSignature, currentSignature) > 0 ? candidate : current;
  }
  return current;
}

function catalogInfo() {
  const root = findInstallRoot();
  const file = catalogPathForRoot(root);
  return { root, file };
}

// ---------------------------------------------------------------------------
// Live model names from Qoder CLI logs
// ---------------------------------------------------------------------------
// Every inference request writes a line like
//   ... model_config={"key":"qmodel_latest","display_name":"Qwen4-Max",...}
// That is Qoder's server-provided name, so it is newer than the bundled
// dynamic-text catalog. We keep a persisted timeline per model id instead of a
// single "current name": when qmodel_latest switches from Qwen4-Max-Preview to
// Qwen4-Max, requests before the first Qwen4-Max log line must stay on the old
// row and later requests must land on a new one.

function modelLogsRoot() {
  return path.join(os.homedir(), '.qoder', 'logs', 'runs');
}

function nameTokens(name) {
  const text = String(name || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
  if (!text) return [];
  const tokens = [];
  for (const part of text.split(/\s+/)) {
    for (const chunk of part.split('.')) {
      // Split Qwen4 / 4Max / K3 so "Qwen4-Max" and "Qwen 4 Max" compare equal.
      for (const piece of chunk.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/)) {
        // A bare version marker ("V4.1") carries no identity of its own.
        if (piece && piece !== 'v') tokens.push(piece);
      }
    }
  }
  return tokens;
}

function tokenSet(name) {
  return new Set(nameTokens(name));
}

function sameDisplayName(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || a.size !== b.size) return false;
  for (const token of a) {
    if (!b.has(token)) return false;
  }
  return true;
}

function nameFamily(name) {
  const signature = versionSignature(name);
  if (signature) return signature.split(':')[0];
  for (const token of nameTokens(name)) {
    if (/^[a-z]{3,}$/.test(token)) return token;
  }
  return nameTokens(name)[0] || '';
}

// A shorter live name can be the same model as a hand-written detailed label:
// "DeepSeek-Flash" is Qoder's generic picker name for the local
// "DeepSeek-V4.1-Flash 1024" build. The extra tokens in the detailed name are
// only build/date numbers, so keep the detailed label rather than starting a
// new row every time Qoder logs the generic alias.
function isBuildAlias(alias, detailed) {
  const aliasTokens = nameTokens(alias);
  const detailedTokens = nameTokens(detailed);
  if (!aliasTokens.length || !detailedTokens.length) return false;
  const family = nameFamily(alias);
  if (family && family !== nameFamily(detailed)) return false;
  const detailedSet = new Set(detailedTokens);
  if (!aliasTokens.every((token) => detailedSet.has(token))) return false;
  const aliasSet = new Set(aliasTokens);
  const extras = detailedTokens.filter((token) => !aliasSet.has(token));
  return extras.length > 0 && extras.every((token) => /^\d+$/.test(token));
}

function isSameModelVariant(left, right) {
  if (sameDisplayName(left, right)) return true;
  if (isBuildAlias(left, right) || isBuildAlias(right, left)) return true;
  const leftSignature = versionSignature(left);
  const rightSignature = versionSignature(right);
  if (!leftSignature || !rightSignature || leftSignature !== rightSignature) return false;
  // Same upstream version, differing only in numeric build/date tokens
  // (...-1017 vs 1024). "Preview" is not numeric, so Qwen4-Max-Preview and
  // Qwen4-Max stay separate.
  const coreTokens = (name) => new Set(nameTokens(name).filter((token) => !/^\d+$/.test(token)));
  const leftCore = coreTokens(left);
  const rightCore = coreTokens(right);
  if (leftCore.size !== rightCore.size) return false;
  for (const token of leftCore) {
    if (!rightCore.has(token)) return false;
  }
  return true;
}

function buildModelTimeline(base, observations) {
  const entries = [];
  let last = String(base || '').trim();
  const sorted = (Array.isArray(observations) ? observations : [])
    .map((item) => ({
      name: String(item && item.name || '').trim(),
      since: Number(item && item.since)
    }))
    .filter((item) => item.name && Number.isFinite(item.since))
    .sort((left, right) => left.since - right.since);
  for (const item of sorted) {
    if (!last) {
      entries.push(item);
      last = item.name;
      continue;
    }
    if (isSameModelVariant(item.name, last)) continue;
    entries.push(item);
    last = item.name;
  }
  return entries;
}

function resolveModelName(id, base, atMs, observations) {
  const fallback = base || id || 'unknown';
  const timeline = buildModelTimeline(fallback, observations && observations[id]);
  if (!timeline.length) return fallback;
  const time = Number(atMs);
  if (!Number.isFinite(time) || time <= 0) return timeline[timeline.length - 1].name || fallback;
  let chosen = fallback;
  for (const entry of timeline) {
    if (entry.since <= time) chosen = entry.name;
    else break;
  }
  return chosen || fallback;
}

function jsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseModelConfigEvents(text) {
  const events = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const marker = line.indexOf('model_config=');
    if (marker < 0) continue;
    const start = line.indexOf('{', marker);
    if (start < 0) continue;
    const end = jsonObjectEnd(line, start);
    if (end < 0) continue;
    let config;
    try {
      config = JSON.parse(line.slice(start, end + 1));
    } catch (_) {
      continue;
    }
    const key = typeof config.key === 'string' ? config.key.trim() : '';
    const name = typeof config.display_name === 'string' ? config.display_name.trim() : '';
    if (!key || !name) continue;
    const stamp = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))/.exec(line);
    const since = stamp ? Date.parse(stamp[1]) : NaN;
    events.push({ key, name, since: Number.isFinite(since) ? since : 0 });
  }
  return events;
}

function loadLabelState(file) {
  if (labelStateCache && labelStateCache.file === file) return labelStateCache;
  const parsed = readJson(file);
  let state;
  if (parsed && parsed.version === MODEL_LABEL_STATE_VERSION
    && parsed.observations && typeof parsed.observations === 'object') {
    state = {
      version: MODEL_LABEL_STATE_VERSION,
      lastScanAt: Number(parsed.lastScanAt) || 0,
      files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
      observations: parsed.observations
    };
  } else {
    state = {
      version: MODEL_LABEL_STATE_VERSION,
      lastScanAt: 0,
      files: Object.create(null),
      observations: Object.create(null)
    };
  }
  labelStateCache = { file, state };
  return labelStateCache;
}

function saveLabelState(entry) {
  const file = entry.file;
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(entry.state, null, 2)}\n`);
    fs.renameSync(temp, file);
  } catch (_) {
    try { fs.unlinkSync(temp); } catch (__) {}
  }
}

function recordObservation(state, event) {
  const list = state.observations[event.key] || (state.observations[event.key] = []);
  const existing = list.find((item) => item.name === event.name);
  if (!existing) {
    list.push({ name: event.name, since: event.since });
    list.sort((left, right) => left.since - right.since);
    return true;
  }
  if (event.since && (!existing.since || event.since < existing.since)) {
    existing.since = event.since;
    return true;
  }
  return false;
}

function scanModelLogs(state, logsDir) {
  let changed = false;
  let entries;
  try {
    entries = fs.readdirSync(logsDir, { withFileTypes: true });
  } catch (_) {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(logsDir, entry.name, 'qodercli.log');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;
    const seen = state.files[file];
    if (seen && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    for (const event of parseModelConfigEvents(text)) {
      if (recordObservation(state, event)) changed = true;
    }
    state.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size };
    changed = true;
  }
  return changed;
}

function readModelObservations(options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const ttlMs = options.ttlMs === undefined ? MODEL_LOG_SCAN_TTL_MS : Number(options.ttlMs) || 0;
  const stateFile = options.stateFile || MODEL_LABEL_STATE_FILE;
  const logsDir = options.logsDir || modelLogsRoot();
  if (observationCache && observationCache.file === stateFile
    && Math.abs(nowMs - observationCache.at) < ttlMs) {
    return observationCache.observations;
  }
  const entry = loadLabelState(stateFile);
  const lastScanAt = Number(entry.state.lastScanAt) || 0;
  const due = !lastScanAt || nowMs < lastScanAt || nowMs - lastScanAt >= ttlMs;
  if (due) {
    try {
      scanModelLogs(entry.state, logsDir);
    } catch (_) {
      // Naming is enrichment; a broken log directory must not fail a scan.
    }
    entry.state.lastScanAt = nowMs;
    saveLabelState(entry);
  }
  observationCache = { file: stateFile, at: nowMs, observations: entry.state.observations };
  return entry.state.observations;
}

module.exports = {
  buildModelTimeline,
  catalogInfo,
  chooseDisplayName,
  extractVersionedName,
  findInstallRoot,
  isBuildAlias,
  isSameModelVariant,
  nameTokens,
  parseModelConfigEvents,
  readModelObservations,
  resolveModelName,
  versionSignature
};
