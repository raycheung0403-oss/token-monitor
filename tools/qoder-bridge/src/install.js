'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const { writeFileAtomic } = require('./atomic-file');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = __dirname;
const TRAY_ICON_SOURCE = path.join(SOURCE_DIR, 'assets', 'tray-sigma.png');
const DESIGN_CSS_SOURCE = path.join(SOURCE_DIR, 'assets', 'design-polish.css');
const DESIGN_JS_SOURCE = path.join(SOURCE_DIR, 'assets', 'design-polish.js');
const INSIGHTS_CSS_SOURCE = path.join(SOURCE_DIR, 'assets', 'insights.css');
const INSIGHTS_JS_SOURCE = path.join(SOURCE_DIR, 'assets', 'insights.js');
const DOCK_FONT_STACK = '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif';
const ORIGINAL_BIN = '#!/usr/bin/env node\nawait import("@tokscale/cli");\n';
const BRIDGE_FILES = ['shim.cjs', 'qoder-usage.js', 'qoder-data.js', 'qoder-catalog.js', 'estimate.js', 'paths.js'];
const PATCHED_FILES = [
  'src/shared/clientCatalog.js',
  'src/shared/clientSources.js',
  'src/shared/clientHealth.js',
  'src/shared/collector.js',
  'src/shared/wslUsage.js',
  'src/shared/providers/qoder/limits.js',
  'src/electron/renderer/edgeDock/presentation.js',
  'src/electron/renderer/edgeDock/dock.css',
  'src/electron/renderer/app.js',
  'src/electron/main.js',
  'src/electron/runtimeConfig.js',
  'src/electron/renderer/styles.css',
  'src/shared/usage.js'
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function parseArgs(argv) {
  const options = { appDir: '', force: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--app-dir=')) options.appDir = arg.slice('--app-dir='.length);
    else if (arg === '--app-dir') options.appDir = argv[++index] || '';
    else fail(`Unknown option: ${arg}`);
  }
  return options;
}

function appCandidates() {
  const candidates = [];
  if (process.env.TOKEN_MONITOR_DIR) candidates.push(process.env.TOKEN_MONITOR_DIR);
  if (process.platform === 'win32') {
    candidates.push('D:\\Github\\Token Monitor');
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Token Monitor'));
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Token Monitor'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Token Monitor.app/Contents');
  }
  return candidates;
}

function isAppDir(dir) {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'resources', 'app.asar'));
}

function resolveAppDir(explicit) {
  if (explicit) {
    if (!isAppDir(explicit)) fail(`app.asar not found under ${explicit}\\resources`);
    return path.resolve(explicit);
  }
  for (const candidate of appCandidates()) {
    if (isAppDir(candidate)) return path.resolve(candidate);
  }
  fail('Token Monitor install not found. Pass --app-dir=<folder containing resources\\app.asar>.');
}

function readAsarJson(archive, file) {
  const buffer = asar.extractFile(archive, file.split('/').join(path.sep));
  return JSON.parse(buffer.toString('utf8'));
}

function readAsarText(archive, file) {
  return asar.extractFile(archive, file.split('/').join(path.sep)).toString('utf8');
}

function readAsarLayout(archive) {
  const header = asar.getRawHeader(archive).header;
  const unpackedFiles = [];
  const unpackedDirs = [];
  const walk = (files, prefix) => {
    for (const [name, node] of Object.entries(files)) {
      const full = prefix ? `${prefix}/${name}` : name;
      if (node.files) {
        if (node.unpacked) unpackedDirs.push(full);
        walk(node.files, full);
      } else if (node.unpacked) {
        unpackedFiles.push(full);
      }
    }
  };
  walk(header.files, '');
  return { unpackedFiles: unpackedFiles.sort(), unpackedDirs: unpackedDirs.sort() };
}

function ensureAppClosed(appDir) {
  if (process.platform !== 'win32') return;
  const exe = path.basename(readExeName(appDir));
  let output = '';
  try {
    output = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH'], { encoding: 'utf8' });
  } catch (_) {
    return;
  }
  if (output.toLowerCase().includes(exe.toLowerCase())) {
    fail(`Close ${exe} before installing the Qoder bridge (it also lives in the tray).`);
  }
}

function readExeName(appDir) {
  try {
    const entries = fs.readdirSync(appDir).filter((name) => name.toLowerCase().endsWith('.exe'));
    const exact = entries.find((name) => /^token monitor\.exe$/i.test(name));
    if (exact) return exact;
    const named = entries.find((name) => /token\s*monitor/i.test(name) && !/uninstall/i.test(name));
    return named || entries.find((name) => !/uninstall/i.test(name)) || 'Token Monitor.exe';
  } catch (_) {
    return 'Token Monitor.exe';
  }
}

function patchOnce(text, anchor, replacement, label) {
  const count = text.split(anchor).length - 1;
  if (count !== 1) fail(`Patch anchor ${label} matched ${count} times, expected 1.`);
  return text.replace(anchor, replacement);
}

function patchCatalog(text) {
  return patchOnce(
    text,
    "    { id: 'qodercn', label: 'Qoder CN', defaultTracked: false, forkOnly: true },\n",
    "    { id: 'qoder', label: 'Qoder', defaultTracked: true, forkOnly: true },\n"
      + "    { id: 'qodercn', label: 'Qoder CN', defaultTracked: false, forkOnly: true },\n",
    'clientCatalog.js'
  );
}

function patchSources(text) {
  const anchor = "  add(\n"
    + "    'qodercn',\n"
    + "    ...qoderCnPaths.dbPaths.map((dbPath) => ['qodercn-db', path.dirname(dbPath), dbPath]),\n"
    + "    ['qodercn-projects', qoderCnPaths.projectsDir]\n"
    + "  );\n";
  const replacement = anchor
    + "  // Qoder (global) — JSONL transcripts plus the two SQLite stores Qoder keeps\n"
    + "  // beside its caches. Usage itself is supplied by the qoder-bridge shim.\n"
    + "  const qoderDataDir = platform === 'win32'\n"
    + "    ? path.join(nonBlankEnvPath('APPDATA', path.join(home, 'AppData', 'Roaming'), env), 'com.qoder.app.stable')\n"
    + "    : platform === 'darwin'\n"
    + "      ? path.join(home, 'Library', 'Application Support', 'com.qoder.app.stable')\n"
    + "      : path.join(absoluteEnvPath('XDG_CONFIG_HOME', path.join(home, '.config'), env), 'com.qoder.app.stable');\n"
    + "  add(\n"
    + "    'qoder',\n"
    + "    ['qoder-projects', path.join(home, '.qoder', 'projects')],\n"
    + "    ['qoder-ide-db', qoderDataDir, path.join(qoderDataDir, 'main.sqlite')],\n"
    + "    ['qoder-turn-buffer', qoderDataDir, path.join(qoderDataDir, 'chat-session-turn-payload-buffer.sqlite')]\n"
    + "  );\n";
  return patchOnce(text, anchor, replacement, 'clientSources.js');
}

function patchHealth(text) {
  return patchOnce(
    text,
    "  'qodercn-db',\n  'qodercn-projects',\n",
    "  'qoder-ide-db',\n  'qoder-projects',\n  'qoder-turn-buffer',\n  'qodercn-db',\n  'qodercn-projects',\n",
    'clientHealth.js'
  );
}

function patchWsl(text) {
  // 0.93 ships native Qoder support and dropped the old qodercn exclusion.
  // Keep the bridge-owned Qoder data out of WSL scans in either layout.
  if (text.includes("new Set([REASONIX_CLIENT, 'catpaw']);")) {
    return patchOnce(
      text,
      "const WSL_EXCLUDED_CLIENTS = new Set([REASONIX_CLIENT, 'catpaw']);",
      "const WSL_EXCLUDED_CLIENTS = new Set([REASONIX_CLIENT, 'catpaw', 'qoder']);",
      'wslUsage.js native'
    );
  }
  return patchOnce(
    text,
    "const WSL_EXCLUDED_CLIENTS = new Set([REASONIX_CLIENT, 'catpaw', 'qodercn']);",
    "const WSL_EXCLUDED_CLIENTS = new Set([REASONIX_CLIENT, 'catpaw', 'qoder', 'qodercn']);",
    'wslUsage.js'
  );
}

function patchRuntimeConfig(text) {
  return patchOnce(
    text,
    "dailyHistoryArchiveEnabled: settings.sessionUsageArchiveEnabled !== false,",
    "// The daily history calendar is a separate surface from retained session\n"
      + "// usage: turning off the session archive must not freeze today's chart.\n"
      + "dailyHistoryArchiveEnabled: settings.historyEnabled !== false,",
    'runtimeConfig.js daily history coupling'
  );
}

function patchUsageEntryContext(text) {
  const withContext = patchOnce(
    text,
    "  session.startedAt = normalizeIsoTimestamp(firstString(row, STARTED_AT_KEYS));\n"
      + "  session.lastUsedAt = normalizeIsoTimestamp(firstString(row, LAST_USED_AT_KEYS));\n"
      + "  session.projectId = String(row.projectId || row.project_id || '').trim();\n",
    "  session.startedAt = normalizeIsoTimestamp(firstString(row, STARTED_AT_KEYS));\n"
      + "  session.lastUsedAt = normalizeIsoTimestamp(firstString(row, LAST_USED_AT_KEYS));\n"
      + "  // Carry a report entry's context snapshot into the session so the\n"
      + "  // session gauge and the dock's headroom can show it. A missing pair\n"
      + "  // stays zero and never overwrites provider metadata that measured it.\n"
      + "  session.contextTokens = Math.max(0, Math.round(asNumber(row.contextTokens ?? row.context_tokens ?? 0)));\n"
      + "  session.contextWindow = Math.max(0, Math.round(asNumber(row.contextWindow ?? row.context_window ?? 0)));\n"
      + "  // Estimates are useful, but they must not masquerade as measured\n"
      + "  // counters. Carry the bridge's marker through the session normalizer.\n"
      + "  session.estimated = row.estimated === true || row.estimatedTokens === true || row.estimatedCost === true;\n"
      + "  session.estimatedTokens = row.estimatedTokens === true;\n"
      + "  session.estimatedCost = row.estimatedCost === true;\n"
      + "  session.projectId = String(row.projectId || row.project_id || '').trim();\n",
    'usage.js entry context'
  );
  const withMerged = patchOnce(
    withContext,
    "  target.totalTokens += sourceTokens;\n"
      + "  target.costUsd += asNumber(source.costUsd);\n",
    "  target.totalTokens += sourceTokens;\n"
      + "  target.costUsd += asNumber(source.costUsd);\n"
      + "  if (source.estimated === true || source.estimatedTokens === true) target.estimatedTokens = true;\n"
      + "  if (source.estimatedCost === true) target.estimatedCost = true;\n"
      + "  if (target.estimatedTokens || target.estimatedCost) target.estimated = true;\n",
    'usage.js session estimated'
  );
  return patchOnce(
    withMerged,
    "  session.contextTokens = Math.max(0, Math.round(asNumber(input.contextTokens ?? input.context_tokens ?? 0)));\n"
      + "  session.contextWindow = Math.max(0, Math.round(asNumber(input.contextWindow ?? input.context_window ?? 0)));\n",
    "  session.contextTokens = Math.max(0, Math.round(asNumber(input.contextTokens ?? input.context_tokens ?? 0)));\n"
      + "  session.contextWindow = Math.max(0, Math.round(asNumber(input.contextWindow ?? input.context_window ?? 0)));\n"
      + "  session.estimated = input.estimated === true || input.estimatedTokens === true || input.estimatedCost === true;\n"
      + "  session.estimatedTokens = input.estimatedTokens === true;\n"
      + "  session.estimatedCost = input.estimatedCost === true;\n",
    'usage.js normalized estimated'
  );
}

const LOCAL_QODER_LIMITS = `const QODER_LOCAL_LOG_MAX_BYTES = 2 * 1024 * 1024;
const QODER_LOCAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function qoderAppDataDir(env = process.env) {
  if (process.platform === 'win32') {
    const roaming = String(env.APPDATA || '').trim() || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(roaming, 'com.qoder.app.stable');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'com.qoder.app.stable');
  }
  const configHome = String(env.XDG_CONFIG_HOME || '').trim() || path.join(os.homedir(), '.config');
  return path.join(configHome, 'com.qoder.app.stable');
}

function recentQoderMainLogs(env) {
  const logsDir = path.join(qoderAppDataDir(env), 'logs');
  let entries;
  try {
    entries = fs.readdirSync(logsDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(logsDir, entry.name, 'main.log');
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs <= QODER_LOCAL_MAX_AGE_MS) {
        files.push({ file, mtimeMs: stat.mtimeMs });
      }
    } catch (_) {}
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 10).map((entry) => entry.file);
}

function readLogTail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseQoderQuotaLine(line) {
  const marker = line.indexOf('{"operation":"account.getQuotaUsage"');
  if (marker < 0 || !line.includes('"qoderUsage"') || !line.includes('"userQuota"')) return null;
  const end = line.lastIndexOf('}');
  if (end <= marker) return null;
  let payload;
  try {
    payload = JSON.parse(line.slice(marker, end + 1));
  } catch (_) {
    return null;
  }
  const usage = payload && payload.qoderUsage;
  const quota = usage && usage.userQuota;
  if (!quota) return null;
  const total = Number(quota.total);
  const used = Number(quota.used);
  const remainingValue = Number(quota.remaining);
  if (!(Number.isFinite(total) && total > 0) || !(Number.isFinite(used) && used >= 0)) return null;
  const timestamp = /^\\[([^\\]]+)\\]/.exec(line);
  const updatedAt = timestamp && !Number.isNaN(Date.parse(timestamp[1]))
    ? new Date(Date.parse(timestamp[1])).toISOString()
    : '';
  const expiresAt = Number(usage.expiresAt);
  return {
    used,
    total,
    remaining: Math.max(0, Number.isFinite(remainingValue) ? remainingValue : total - used),
    updatedAt,
    resetsAt: Number.isFinite(expiresAt) && expiresAt > 0 ? new Date(expiresAt).toISOString() : '',
    userType: String(usage.userType || '').trim()
  };
}

function readQoderLocalUsage(env = process.env) {
  for (const file of recentQoderMainLogs(env)) {
    let text;
    try {
      text = readLogTail(file, QODER_LOCAL_LOG_MAX_BYTES);
    } catch (_) {
      continue;
    }
    const lines = text.split(/\\r?\\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const usage = parseQoderQuotaLine(lines[index]);
      if (usage) {
        if (!usage.updatedAt) usage.updatedAt = new Date().toISOString();
        return usage;
      }
    }
  }
  return null;
}

function qoderLocalProvider(usage, site) {
  const usedPercent = Math.max(0, Math.min(100, usage.used / usage.total * 100));
  const labels = { teams: 'Teams', team: 'Teams', enterprise: 'Enterprise', organization: 'Enterprise' };
  const accountLabel = labels[usage.userType.toLowerCase()] || '';
  return normalizeLimitProvider({
    provider: 'qoder',
    source: 'local',
    sourceDetail: 'app',
    status: 'ok',
    updatedAt: usage.updatedAt,
    accountLabel,
    windows: [{
      kind: 'billing',
      label: 'Credits',
      used: usage.used,
      limit: usage.total,
      remaining: usage.remaining,
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetsAt: usage.resetsAt,
      showMeter: true
    }],
    region: site === 'cn' ? 'cn' : 'global'
  });
}

`;

function patchQoderLimits(text) {
  let output = patchOnce(
    text,
    "'use strict';\n\nconst { normalizeLimitProvider } = require('../../limits/core');\n",
    "'use strict';\n\nconst fs = require('node:fs');\nconst os = require('node:os');\nconst path = require('node:path');\nconst { normalizeLimitProvider } = require('../../limits/core');\n",
    'limits.js requires'
  );
  output = patchOnce(
    output,
    "const QODER_FETCH_TIMEOUT_MS = 12_000;\n\nfunction qoderCookie(env = process.env, options = {}) {\n",
    "const QODER_FETCH_TIMEOUT_MS = 12_000;\n\n"
      + LOCAL_QODER_LIMITS
      + "function qoderCookie(env = process.env, options = {}) {\n",
    'limits.js local reader'
  );
  output = patchOnce(
    output,
    "  const cookie = qoderCookie(env, options);\n  const site = qoderSite(options, env);\n  if (!cookie) {\n",
    "  const cookie = qoderCookie(env, options);\n"
      + "  const site = qoderSite(options, env);\n"
      + "  const localUsage = deps.env === undefined || deps.env === process.env\n"
      + "    ? readQoderLocalUsage(env)\n"
      + "    : null;\n"
      + "  // A user-supplied cookie means live API first: the account page's\n"
      + "  // remaining credits are fresher than the desktop app's last log snapshot.\n"
      + "  // Without a cookie the bridge stays credential-free and uses the log.\n"
      + "  if (!cookie && localUsage) return qoderLocalProvider(localUsage, site);\n"
      + "  if (!cookie) {\n",
    'limits.js local first'
  );
  output = patchOnce(
    output,
    "  } catch (error) {\n"
      + "    return normalizeLimitProvider({\n"
      + "      provider: 'qoder',\n"
      + "      source: 'web',\n"
      + "      status: error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable',\n",
    "  } catch (error) {\n"
      + "    // The live API may be blocked, rate-limited, or signed out; keep the\n"
      + "    // desktop log's last reading rather than blanking the quota.\n"
      + "    if (localUsage) return qoderLocalProvider(localUsage, site);\n"
      + "    return normalizeLimitProvider({\n"
      + "      provider: 'qoder',\n"
      + "      source: 'web',\n"
      + "      status: error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable',\n",
    'limits.js api fallback'
  );
  return output;
}

function patchCollector(text) {
  let output = patchOnce(
    text,
    "const CHERRY_STUDIO_DB_WATCH_PATTERN = /^cherrystudio\\.sqlite(?:-(?:wal|shm))?$/;\n",
    "const CHERRY_STUDIO_DB_WATCH_PATTERN = /^cherrystudio\\.sqlite(?:-(?:wal|shm))?$/;\n"
      + "const QODER_DB_WATCH_PATTERN = /^(?:main\\.sqlite|chat-session-turn-payload-buffer\\.sqlite)(?:-(?:wal|shm))?$/;\n",
    'collector.js pattern'
  );
  const anchor = "  bound('zcode', withBasename('zcode', 'db'), directChildOnly((name) => ZCODE_DB_WATCH_PATTERN.test(name)));\n";
  output = patchOnce(
    output,
    anchor,
    anchor
      + "  // Qoder keeps its IDE databases beside caches in the Application Support\n"
      + "  // root, so only those two database names (and their sidecars) may be\n"
      + "  // watched there. Transcripts live under ~/.qoder/projects; keep every\n"
      + "  // directory and JSONL file (including <session>/subagents/) but prune the\n"
      + "  // memory and compression caches, which hold no request records.\n"
      + "  bound('qoder', withBasename('qoder', 'com.qoder.app.stable'), directChildOnly((name) => QODER_DB_WATCH_PATTERN.test(name)));\n"
      + "  bound('qoder', withBasename('qoder', 'projects'), (_parts, resolved) => {\n"
      + "    const name = path.basename(resolved);\n"
      + "    if (name.endsWith('.jsonl')) return false;\n"
      + "    if (name === 'memory' || name === 'node_modules' || name === 'compression-v2') return true;\n"
      + "    try {\n"
      + "      if (fs.statSync(resolved).isDirectory()) return false;\n"
      + "    } catch (_) {\n"
      + "      // Removed JSONL files were kept by the suffix check above; other\n"
      + "      // removed paths need no invalidation.\n"
      + "    }\n"
      + "    return true;\n"
      + "  });\n",
    'collector.js watch policy'
  );
  output = patchOnce(
    output,
    "const SELF_WATCHED_SQLITE_SIDECAR_CLIENTS = Object.freeze(['antigravity', 'catpaw', 'cherrystudio', 'cursor', 'goose', 'qodercn', 'zcode']);",
    "const SELF_WATCHED_SQLITE_SIDECAR_CLIENTS = Object.freeze(['antigravity', 'catpaw', 'cherrystudio', 'cursor', 'goose', 'qoder', 'qodercn', 'zcode']);",
    'collector.js sidecar list'
  );
  return output;
}

function patchEdgeDock(text) {
  let output = patchOnce(
    text,
    "  const windows = { peek: null, rail: null, bubble: null };\n"
      + "  const ready = { peek: false, rail: false, bubble: false };\n",
    "  const windows = { peek: null, rail: null, bubble: null };\n"
      + "  const ready = { peek: false, rail: false, bubble: false };\n"
      + "  // Only the peek handle exists while the dock rests. The rail and the\n"
      + "  // detail card are two extra renderer processes, so they are created on\n"
      + "  // first use and released after a long idle spell.\n"
      + "  const releaseTimers = { peek: null, rail: null, bubble: null };\n"
      + "  const SURFACE_IDLE_RELEASE_MS = 5 * 60 * 1000;\n",
    'controller.js surface state'
  );
  output = patchOnce(
    output,
    "  function createSurface(surface, materialKey) {\n",
    "  function cancelSurfaceRelease(surface) {\n"
      + "    if (releaseTimers[surface]) {\n"
      + "      clearTimeout(releaseTimers[surface]);\n"
      + "      releaseTimers[surface] = null;\n"
      + "    }\n"
      + "  }\n"
      + "\n"
      + "  function scheduleSurfaceRelease(surface) {\n"
      + "    if (surface === 'peek') return;\n"
      + "    // Stats pushes can re-run a hide path (for example when the card is\n"
      + "    // already hidden); restarting the timer on each push would postpone\n"
      + "    // the release forever while the dock is in use.\n"
      + "    if (releaseTimers[surface]) return;\n"
      + "    releaseTimers[surface] = setTimeout(() => {\n"
      + "      releaseTimers[surface] = null;\n"
      + "      const win = windows[surface];\n"
      + "      if (!alive(win)) return;\n"
      + "      if (surface === 'rail' && (railVisible || bubbleVisible)) return;\n"
      + "      if (surface === 'bubble' && bubbleVisible) return;\n"
      + "      backdrops.get(win)?.dispose();\n"
      + "      backdrops.delete(win);\n"
      + "      windows[surface] = null;\n"
      + "      ready[surface] = false;\n"
      + "      visibleTargets[surface] = false;\n"
      + "      lastSent[surface] = '';\n"
      + "      shapes[surface] = null;\n"
      + "      nativeMaterial[surface] = false;\n"
      + "      if (surface === 'bubble') {\n"
      + "        bubblePlaced = null;\n"
      + "        bubbleHeight = 0;\n"
      + "        if (!railVisible) bubbleCell = null;\n"
      + "        if (!railVisible && alive(windows.rail)) scheduleSurfaceRelease('rail');\n"
      + "      }\n"
      + "      cancelFade(win);\n"
      + "      disposeGlass(surface);\n"
      + "      win.destroy();\n"
      + "    }, SURFACE_IDLE_RELEASE_MS);\n"
      + "  }\n"
      + "\n"
      + "  function ensureSurface(surface) {\n"
      + "    if (alive(windows[surface])) return windows[surface];\n"
      + "    cancelSurfaceRelease(surface);\n"
      + "    windows[surface] = createSurface(surface, builtMaterial || 'none');\n"
      + "    return windows[surface];\n"
      + "  }\n"
      + "\n"
      + "  function createSurface(surface, materialKey) {\n",
    'controller.js lazy surfaces'
  );
  output = patchOnce(
    output,
    "    win.on('closed', () => {\n      cancelFade(win);\n",
    "    win.on('closed', () => {\n      cancelSurfaceRelease(surface);\n      cancelFade(win);\n",
    'controller.js close cleanup'
  );
  output = patchOnce(
    output,
    "  function destroyWindows() {\n    for (const surface of SURFACES) {\n      const win = windows[surface];\n",
    "  function destroyWindows() {\n    for (const surface of SURFACES) cancelSurfaceRelease(surface);\n    for (const surface of SURFACES) {\n      const win = windows[surface];\n",
    'controller.js destroy timers'
  );
  output = patchOnce(
    output,
    "    if (builtMaterial === materialKey && SURFACES.every((surface) => alive(windows[surface]))) return;\n"
      + "    destroyWindows();\n"
      + "    builtMaterial = materialKey;\n"
      + "    builtGlass = materialKey !== 'none';\n"
      + "    for (const surface of SURFACES) windows[surface] = createSurface(surface, materialKey);\n",
    "    if (builtMaterial === materialKey && alive(windows.peek)) return;\n"
      + "    destroyWindows();\n"
      + "    builtMaterial = materialKey;\n"
      + "    builtGlass = materialKey !== 'none';\n"
      + "    windows.peek = createSurface('peek', materialKey);\n",
    'controller.js build only peek'
  );
  output = patchOnce(
    output,
    "  function revealRail(withHaptic = false) {\n    const rail = windows.rail;\n    if (!alive(rail)) return;\n",
    "  function revealRail(withHaptic = false) {\n    const rail = ensureSurface('rail');\n    if (!alive(rail)) return;\n",
    'controller.js ensure rail'
  );
  output = patchOnce(
    output,
    "    if (entering) {\n      setVisible('rail', true, FADE_IN_MS);\n      if (withHaptic) hapticTick('generic');\n    }\n",
    "    if (entering) {\n      // A rail created for this reveal becomes visible from its load handler;\n"
      + "      // showing the empty window first would flash before the first paint.\n"
      + "      if (ready.rail) setVisible('rail', true, FADE_IN_MS);\n"
      + "      if (withHaptic) hapticTick('generic');\n"
      + "    }\n",
    'controller.js rail load reveal'
  );
  output = patchOnce(
    output,
    "    if (!alive(rail) || !railVisible) {\n      showPeek();\n      return;\n    }\n"
      + "    railVisible = false;\n"
      + "    hapticTarget = null;\n"
      + "    setVisible('rail', false, FADE_OUT_MS);\n"
      + "    showPeek();\n"
      + "  }\n",
    "    if (!alive(rail) || !railVisible) {\n      showPeek();\n      if (alive(rail)) scheduleSurfaceRelease('rail');\n      return;\n    }\n"
      + "    railVisible = false;\n"
      + "    hapticTarget = null;\n"
      + "    setVisible('rail', false, FADE_OUT_MS);\n"
      + "    showPeek();\n"
      + "    scheduleSurfaceRelease('rail');\n"
      + "  }\n",
    'controller.js rail release'
  );
  output = patchOnce(
    output,
    "  function showBubble(cellIndex) {\n    bubbleCell = cellIndex;\n",
    "  function showBubble(cellIndex) {\n    ensureSurface('bubble');\n    bubbleCell = cellIndex;\n",
    'controller.js ensure bubble'
  );
  output = patchOnce(
    output,
    "    if (!bubbleVisible) return;\n    bubbleVisible = false;\n    setVisible('bubble', false, 0);\n  }\n",
    "    if (!bubbleVisible) {\n      if (alive(windows.bubble)) scheduleSurfaceRelease('bubble');\n      return;\n    }\n"
      + "    bubbleVisible = false;\n"
      + "    setVisible('bubble', false, 0);\n"
      + "    scheduleSurfaceRelease('bubble');\n"
      + "  }\n",
    'controller.js bubble invalidate release'
  );
  output = patchOnce(
    output,
    "    if (!alive(bubble) || !bubbleVisible) return;\n    bubbleVisible = false;\n    setVisible('bubble', false, FADE_OUT_MS);\n  }\n",
    "    if (!alive(bubble) || !bubbleVisible) {\n      if (alive(bubble)) scheduleSurfaceRelease('bubble');\n      return;\n    }\n"
      + "    bubbleVisible = false;\n"
      + "    setVisible('bubble', false, FADE_OUT_MS);\n"
      + "    scheduleSurfaceRelease('bubble');\n"
      + "  }\n",
    'controller.js bubble release'
  );
  return output;
}

function patchEdgeDockPresentation(text) {
  let output = patchOnce(
    text,
    "    const selection = trayText.compactLimitSelection(provider);\n",
    "    // A stale provider still has a usable last reading. Qoder is the normal\n"
      + "    // case: it only logs its quota when its own account panel refreshes, so\n"
      + "    // the snapshot can be hours old while the plan percentage barely moves.\n"
      + "    // Keep the card and ring populated; `status` stays stale so the ring is\n"
      + "    // dimmed instead of pretending the reading is current.\n"
      + "    // The same applies to a transient failure (boot before the proxy is up):\n"
      + "    // the runtime retains the last-good windows on the row, so keep showing\n"
      + "    // them instead of blanking the ring until a retry succeeds.\n"
      + "    const selection = trayText.compactLimitSelection(provider)\n"
      + "      || (provider?.status === 'ok' && provider?.stale\n"
      + "        ? trayText.compactLimitSelection({ ...provider, stale: false })\n"
      + "        : null)\n"
      + "      || (Array.isArray(provider?.windows) && provider.windows.length\n"
      + "        ? trayText.compactLimitSelection({ ...provider, status: 'ok', stale: false })\n"
      + "        : null);\n",
    'presentation.js stale selection'
  );
  return output;
}

function patchModelCachePercentages(text) {
  let output = patchOnce(
    text,
    "function appendAccordionMetricRow(content, labelText, valueText, percent = null, className = '') {\n",
    "function decimalPercentLabel(value) {\n"
      + "  const percent = Number(value);\n"
      + "  const clamped = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;\n"
      + "  return `${clamped.toFixed(1)}%`;\n"
      + "}\n"
      + "\n"
      + "function appendAccordionMetricRow(content, labelText, valueText, percent = null, className = '') {\n",
    'app.js decimal percent helper'
  );
  output = patchOnce(
    output,
    "    share.textContent = toolDetailsApi.detailPercentLabel(percent);\n",
    "    share.textContent = typeof percent === 'string'\n"
      + "      ? percent\n"
      + "      : toolDetailsApi.detailPercentLabel(percent);\n",
    'app.js percent label string'
  );
  output = patchOnce(
    output,
    "    appendAccordionMetricRow(content, labels.cacheHit, formatNumber(tokenParts.cacheRead), inputPercentages.hit);\n"
      + "    appendAccordionMetricRow(content, labels.cacheMiss, formatNumber(tokenParts.cacheMiss), inputPercentages.miss);\n",
    "    appendAccordionMetricRow(content, labels.cacheHit, formatNumber(tokenParts.cacheRead), decimalPercentLabel(inputPercentages.hit));\n"
      + "    appendAccordionMetricRow(content, labels.cacheMiss, formatNumber(tokenParts.cacheMiss), decimalPercentLabel(inputPercentages.miss));\n",
    'app.js cache percentages'
  );
  return output;
}

function patchStartupStatsCache(text) {
  let output = patchOnce(
    text,
    'let latestStats = null;\n',
    'let latestStats = null;\n'
      + 'const STARTUP_STATS_CACHE_FILE = path.join(sharedDataDir(), \'last-stats-cache.json\');\n'
      + 'const STARTUP_STATS_CACHE_VERSION = 1;\n'
      + 'const STARTUP_STATS_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;\n'
      + 'let startupStatsCache = null;\n'
      + 'let startupStatsCacheWriteTimer = null;\n'
      + 'let startupCacheSeededAt = 0;\n'
      + '\n'
      + 'function startupStatsCacheHasUsage(stats) {\n'
      + '  return Number(stats?.periods?.allTime?.totalTokens) > 0;\n'
      + '}\n'
      + '\n'
      + 'function readStartupStatsCache() {\n'
      + '  if (startupStatsCache !== null) return startupStatsCache;\n'
      + '  startupStatsCache = false;\n'
      + '  try {\n'
      + '    const parsed = JSON.parse(fs.readFileSync(STARTUP_STATS_CACHE_FILE, \'utf8\'));\n'
      + '    const savedAt = Date.parse(parsed?.savedAt || \'\');\n'
      + '    if (parsed?.version !== STARTUP_STATS_CACHE_VERSION\n'
      + '      || parsed?.appVersion !== app.getVersion()\n'
      + '      || !parsed.stats\n'
      + '      || !startupStatsCacheHasUsage(parsed.stats)\n'
      + '      || !Number.isFinite(savedAt)\n'
      + '      || Date.now() - savedAt > STARTUP_STATS_CACHE_MAX_AGE_MS) return startupStatsCache;\n'
      + '    startupStatsCache = parsed;\n'
      + '  } catch (_) {}\n'
      + '  return startupStatsCache;\n'
      + '}\n'
      + '\n'
      + 'function scheduleStartupStatsCacheWrite(stats) {\n'
      + '  if (!stats || !startupStatsCacheHasUsage(stats) || startupStatsCacheWriteTimer) return;\n'
      + '  startupStatsCacheWriteTimer = setTimeout(() => {\n'
      + '    startupStatsCacheWriteTimer = null;\n'
      + '    try {\n'
      + '      const tmp = `${STARTUP_STATS_CACHE_FILE}.${process.pid}.tmp`;\n'
      + '      fs.writeFileSync(tmp, JSON.stringify({\n'
      + '        version: STARTUP_STATS_CACHE_VERSION,\n'
      + '        appVersion: app.getVersion(),\n'
      + '        savedAt: new Date().toISOString(),\n'
      + '        stats\n'
      + '      }));\n'
      + '      fs.renameSync(tmp, STARTUP_STATS_CACHE_FILE);\n'
      + '    } catch (_) {}\n'
      + '  }, 1500);\n'
      + '  if (typeof startupStatsCacheWriteTimer.unref === \'function\') startupStatsCacheWriteTimer.unref();\n'
      + '}\n'
      + '\n'
      + 'const STARTUP_LIMITS_CACHE_FILE = path.join(sharedDataDir(), \'last-limits-cache.json\');\n'
      + 'const STARTUP_LIMITS_CACHE_VERSION = 1;\n'
      + 'const STARTUP_LIMITS_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;\n'
      + 'let startupLimitsCache = null;\n'
      + 'let startupLimitsCacheWriteTimer = null;\n'
      + '\n'
      + 'function readStartupLimitsCache() {\n'
      + '  if (startupLimitsCache !== null) return startupLimitsCache;\n'
      + '  startupLimitsCache = false;\n'
      + '  try {\n'
      + '    const parsed = JSON.parse(fs.readFileSync(STARTUP_LIMITS_CACHE_FILE, \'utf8\'));\n'
      + '    const savedAt = Date.parse(parsed?.savedAt || \'\');\n'
      + '    if (parsed?.version !== STARTUP_LIMITS_CACHE_VERSION\n'
      + '      || parsed?.appVersion !== app.getVersion()\n'
      + '      || !parsed.limits\n'
      + '      || !Array.isArray(parsed.limits.providers)\n'
      + '      || !Number.isFinite(savedAt)\n'
      + '      || Date.now() - savedAt > STARTUP_LIMITS_CACHE_MAX_AGE_MS) return startupLimitsCache;\n'
      + '    startupLimitsCache = parsed;\n'
      + '  } catch (_) {}\n'
      + '  return startupLimitsCache;\n'
      + '}\n'
      + '\n'
      + '// The limits runtime only retains last-good readings within a session;\n'
      + '// previousLimits is empty on a fresh start. Seed it from the persisted\n'
      + '// cache so the dock shows the last known quota immediately, even when\n'
      + '// the first live probe fails (e.g. the proxy is not up yet at boot).\n'
      + 'function startupInitialLimits() {\n'
      + '  const live = lastCollectedDevice?.limits;\n'
      + '  if (live) return live;\n'
      + '  const cached = readStartupLimitsCache();\n'
      + '  return cached ? cached.limits : undefined;\n'
      + '}\n'
      + '\n'
      + 'function startupLimitRowKey(row) {\n'
      + '  return `${row?.provider || \'\'}|${row?.accountKey || row?.accountEmail || row?.accountName || \'\'}`;\n'
      + '}\n'
      + '\n'
      + '// A transient empty reading must never erase a known-good quota from the\n'
      + '// cache: keep the prior windows whenever the fresh row has none.\n'
      + 'function mergeStartupLimitRows(previous, next) {\n'
      + '  const good = new Map();\n'
      + '  for (const row of previous || []) {\n'
      + '    if (Array.isArray(row?.windows) && row.windows.length) good.set(startupLimitRowKey(row), row);\n'
      + '  }\n'
      + '  return (next || []).map((row) => {\n'
      + '    if (Array.isArray(row?.windows) && row.windows.length) return row;\n'
      + '    const prior = good.get(startupLimitRowKey(row));\n'
      + '    if (!prior) return row;\n'
      + '    return { ...row, windows: prior.windows, updatedAt: prior.updatedAt };\n'
      + '  });\n'
      + '}\n'
      + '\n'
      + 'function scheduleStartupLimitsCacheWrite(limits) {\n'
      + '  if (!limits || !Array.isArray(limits.providers) || startupLimitsCacheWriteTimer) return;\n'
      + '  startupLimitsCacheWriteTimer = setTimeout(() => {\n'
      + '    startupLimitsCacheWriteTimer = null;\n'
      + '    try {\n'
      + '      const cached = readStartupLimitsCache();\n'
      + '      const merged = { ...limits, providers: mergeStartupLimitRows(cached?.limits?.providers, limits.providers) };\n'
      + '      const tmp = `${STARTUP_LIMITS_CACHE_FILE}.${process.pid}.tmp`;\n'
      + '      fs.writeFileSync(tmp, JSON.stringify({\n'
      + '        version: STARTUP_LIMITS_CACHE_VERSION,\n'
      + '        appVersion: app.getVersion(),\n'
      + '        savedAt: new Date().toISOString(),\n'
      + '        limits: merged\n'
      + '      }));\n'
      + '      fs.renameSync(tmp, STARTUP_LIMITS_CACHE_FILE);\n'
      + '      startupLimitsCache = null;\n'
      + '    } catch (_) {}\n'
      + '  }, 1500);\n'
      + '  if (typeof startupLimitsCacheWriteTimer.unref === \'function\') startupLimitsCacheWriteTimer.unref();\n'
      + '}\n',
    'main.js startup stats cache'
  );
  output = patchOnce(
    output,
    '    latestStats = payload.data.stats;\n',
    '    latestStats = payload.data.stats;\n'
      + '    scheduleStartupStatsCacheWrite(latestStats);\n'
      + '    scheduleStartupLimitsCacheWrite(latestStats?.limits);\n',
    'main.js cache write hook'
  );
  output = patchOnce(
    output,
    'function statsHistoryRevision(stats) {\n',
    'function sendStartupStatsSeed(win) {\n'
      + '  if (!win || win.isDestroyed()) return;\n'
      + '  const currentHasUsage = Number(latestStats?.periods?.allTime?.totalTokens) > 0;\n'
      + '  const cached = currentHasUsage ? null : readStartupStatsCache();\n'
      + '  const seedStats = currentHasUsage ? latestStats : cached?.stats;\n'
      + '  if (!seedStats) return;\n'
      + '  try {\n'
      + '    const visibleStats = electronPresentationStats(seedStats);\n'
      + '    win.webContents.send(\'stats:push\', {\n'
      + '      event: \'stats\',\n'
      + '      data: {\n'
      + '        type: \'stats\',\n'
      + '        reason: \'read\',\n'
      + '        cache: true,\n'
      + '        at: currentHasUsage ? new Date().toISOString() : cached.savedAt,\n'
      + '        stats: rendererSnapshots.stamp(seedStats, rendererStats(visibleStats))\n'
      + '      }\n'
      + '    });\n'
      + '  } catch (_) {}\n'
      + '}\n'
      + '\n'
      + 'function statsHistoryRevision(stats) {\n',
    'main.js startup stats seed'
  );
  output = patchOnce(
    output,
    "  if (!options.previousWindow) win.webContents.on('did-finish-load', () => {\n    sendFloatingBubbleState();\n",
    "  if (!options.previousWindow) win.webContents.on('did-finish-load', () => {\n"
      + "    // The app's stats listener is registered after the page's first paint;\n"
      + "    // send the cached snapshot once it has had time to attach, then again\n"
      + "    // later in case a slow load missed the first delivery. The renderer\n"
      + "    // ignores a seed once it already has usage on screen.\n"
      + "    setTimeout(() => sendStartupStatsSeed(win), 1500);\n"
      + "    setTimeout(() => sendStartupStatsSeed(win), 4000);\n"
      + "    sendFloatingBubbleState();\n",
    'main.js seed on load'
  );
  output = patchOnce(
    output,
    '  return edgeDockController;\n}\n',
    '  const currentHasUsage = Number(latestStats?.periods?.allTime?.totalTokens) > 0;\n'
      + '  const cachedForDock = currentHasUsage ? null : readStartupStatsCache();\n'
      + '  const seedStats = currentHasUsage ? latestStats : cachedForDock?.stats;\n'
      + '  if (seedStats) {\n'
      + '    try {\n'
      + '      pushEdgeDockCells(edgeDockCellsFor(electronPresentationStats(seedStats)));\n'
      + '      if (!currentHasUsage) startupCacheSeededAt = Date.now();\n'
      + '    } catch (_) {}\n'
      + '  }\n'
      + '  return edgeDockController;\n}\n',
    'main.js dock startup seed'
  );
  output = patchOnce(
    output,
    'function updateEdgeDockCells(visibleStats) {\n'
      + '  if ((!edgeDockController?.isRunning() && !notchController?.isRunning()) || !visibleStats) return;\n',
    'function updateEdgeDockCells(visibleStats) {\n'
      + '  if ((!edgeDockController?.isRunning() && !notchController?.isRunning()) || !visibleStats) return;\n'
      + '  // A cold-start seed outranks the collector\'s first all-zero placeholder.\n'
      + '  // Keep the cached cells until a reading with actual usage lands.\n'
      + '  if (startupCacheSeededAt && Number(visibleStats?.periods?.allTime?.totalTokens) <= 0\n'
      + '    && Date.now() - startupCacheSeededAt < 5 * 60 * 1000) return;\n'
      + '  if (Number(visibleStats?.periods?.allTime?.totalTokens) > 0) startupCacheSeededAt = 0;\n',
    'main.js dock cache guard'
  );
  // Every collector mode (local/sync/host/icloud) seeds its runtime the same way.
  const initialLimitsAnchor = '    initialLimits: lastCollectedDevice?.limits,\n';
  const initialLimitsCount = output.split(initialLimitsAnchor).length - 1;
  if (initialLimitsCount !== 4) fail(`Patch anchor main.js initialLimits matched ${initialLimitsCount} times, expected 4.`);
  output = output.split(initialLimitsAnchor).join('    initialLimits: startupInitialLimits(),\n');
  return output;
}

function patchRendererApp(text) {
  let output = patchModelCachePercentages(text);
  output = patchOnce(
    output,
    "  const obscured = !els.toolDetailFooter?.classList.contains('hidden')\n"
      + "    || !els.projectBreakdownFooter?.classList.contains('hidden')\n"
      + "    || !els.appUpdatePill?.classList.contains('hidden');\n",
    "  // An available update used to hide the centred live-rate readout even though\n"
      + "  // the update control is a 34px icon at the right; keep the rate visible and\n"
      + "  // only let the full-width drill-down footers suppress it.\n"
      + "  const obscured = !els.toolDetailFooter?.classList.contains('hidden')\n"
      + "    || !els.projectBreakdownFooter?.classList.contains('hidden');\n",
    'app.js live rate obscured'
  );
  output = patchOnce(
    output,
    "  const burn = state.settings?.tokenRateMode === 'burn';\n"
      + "  const sample = liveTokenRateTracker.getSample();\n"
      + "  const unit = burn ? 'TPM' : 'tok/s';\n"
      + "  const rate = sample ? (burn ? sample.burn : sample.speed) : null;\n",
    "  const burn = state.settings?.tokenRateMode === 'burn';\n"
      + "  const sample = liveTokenRateTracker.getSample();\n"
      + "  const unit = burn ? 'TPM' : 'tok/s';\n"
      + "  // The delta tracker only has a sample for a few seconds after an increment,\n"
      + "  // and Qoder's timed counters advance when a turn commits. Fall back to the\n"
      + "  // selected period, then today, so the footer never reverts to an em dash\n"
      + "  // while the month/all-time graph scan is still filling its counters.\n"
      + "  const periodRate = sample ? 0 : (currentTokenRateValue().rate\n"
      + "    || (burn\n"
      + "      ? tokenBurnPerMinute(state.stats?.periods?.today)\n"
      + "      : tokenRatePerSecond(state.stats?.periods?.today)));\n"
      + "  const rate = sample\n"
      + "    ? (burn ? sample.burn : sample.speed)\n"
      + "    : (periodRate > 0 ? periodRate : null);\n",
    'app.js live rate fallback'
  );
  output = patchOnce(
    output,
    "window.tokenMonitor.onStatsPush?.((payload) => {\n  if (!payload) return;\n",
    "window.tokenMonitor.onStatsPush?.((payload) => {\n"
      + "  if (!payload) return;\n"
      + "  // A startup cache seed only fills an empty surface; a live snapshot with\n"
      + "  // usage already on screen must never be walked back to the previous session.\n"
      + "  // An initial all-zero read is not usage, so the cached snapshot may replace it.\n"
      + "  if (payload.data?.cache === true\n"
      + "    && Number(state.stats?.periods?.allTime?.totalTokens) > 0) return;\n"
      + "  const incomingAllTime = Number(payload.data?.stats?.periods?.allTime?.totalTokens) || 0;\n"
      + "  const visibleAllTime = Number(state.stats?.periods?.allTime?.totalTokens) || 0;\n"
      + "  // The first collector read can land as an all-zero placeholder before the\n"
      + "  // real scan finishes. While a seeded snapshot is on screen, keep it until\n"
      + "  // a reading with actual usage inside the cache window arrives.\n"
      + "  if (payload.event === 'stats' && !incomingAllTime && visibleAllTime\n"
      + "    && payload.data?.cache !== true && state.startupCacheSeededAt\n"
      + "    && Date.now() - state.startupCacheSeededAt < 5 * 60 * 1000) return;\n"
      + "  if (payload.data?.cache === true) state.startupCacheSeededAt = Date.now();\n"
      + "  else if (incomingAllTime) state.startupCacheSeededAt = 0;\n",
    'app.js startup cache guard'
  );
  // An em dash for a period with usage but no priced requests read as a failed
  // DAY load. Name the state instead; the adjacent info control still carries
  // the token count and the reason.
  output = patchOnce(
    output,
    "  label.textContent = available\n"
      + "    ? (hasUnpriced && !(cost > 0) ? '—' : formatCost(cost)) : '';\n",
    "  label.textContent = available\n"
      + "    ? (hasUnpriced && !(cost > 0)\n"
      + "      ? (/^zh\\b/i.test(currentLocale()) ? '未定价' : 'unpriced')\n"
      + "      : formatCost(cost)) : '';\n",
    'app.js total cost unpriced label'
  );
  output = patchOnce(
    output,
    "    : unpricedTokens > 0 ? (cost > 0 ? `${formatCost(cost)} + ?` : '—') : costLabelText;\n",
    "    : unpricedTokens > 0\n"
      + "      ? (cost > 0 ? `${formatCost(cost)} + ?` : (/^zh\\b/i.test(currentLocale()) ? '未定价' : 'unpriced'))\n"
      + "      : costLabelText;\n",
    'app.js row cost unpriced label'
  );
  output += `\n/* design polish */\n${fs.readFileSync(DESIGN_JS_SOURCE, 'utf8')}\n`;
  output += `\n/* usage insights */\n${fs.readFileSync(INSIGHTS_JS_SOURCE, 'utf8')}\n`;
  return output;
}

// The main window keeps its original monospace/default-display type. The
// right-side rail keeps the Windows Chinese face so its labels stay legible.
function patchDockFontCss(text) {
  return `${text}
/* Qoder side rail: keep the Windows CJK face for labels and numbers. */
`
    + `:root, html, body { --ui-font: ${DOCK_FONT_STACK} !important; --display-font: ${DOCK_FONT_STACK} !important; }
`;
}

function patchLiveRateCss(text) {
  const output = patchOnce(
    text,
    ".token-rate-reveal {\n  display: inline-block;\n",
    "/* The live rate is the centred footer readout. The title-bar hover reveal\n"
      + "   put a second copy beside the Σ icon, visible only when the pointer found\n"
      + "   it; keep the element for the renderer but never reveal it there. */\n"
      + ".token-rate-reveal {\n  display: none;\n",
    'styles.css title rate reveal'
  );
  return `${output}\n\n${fs.readFileSync(DESIGN_CSS_SOURCE, 'utf8')}\n${fs.readFileSync(INSIGHTS_CSS_SOURCE, 'utf8')}\n`;
}

function installTrayIcon(extractDir) {
  // Windows draws the default notification-area icon from icon-win.png. The
  // app's blue squircle is replaced with a bare black sigma so the tray reads
  // as Token Monitor's own mark; the executable's embedded icon is untouched.
  const target = path.join(extractDir, 'assets', 'icon-win.png');
  if (!fs.existsSync(target)) fail('assets/icon-win.png is missing from this Token Monitor build.');
  fs.copyFileSync(TRAY_ICON_SOURCE, target);
}

function hasNativeQoder(extractDir) {
  try {
    return fs.readFileSync(path.join(extractDir, 'src', 'shared', 'clientCatalog.js'), 'utf8')
      .includes("id: 'qoder'");
  } catch (_) {
    return false;
  }
}

function applyPatches(extractDir) {
  const nativeQoder = hasNativeQoder(extractDir);
  const patches = {
    'src/shared/clientCatalog.js': patchCatalog,
    'src/shared/clientSources.js': patchSources,
    'src/shared/clientHealth.js': patchHealth,
    'src/shared/collector.js': patchCollector,
    'src/shared/wslUsage.js': patchWsl,
    'src/shared/providers/qoder/limits.js': patchQoderLimits,
    'src/electron/renderer/edgeDock/presentation.js': patchEdgeDockPresentation,
    'src/electron/renderer/edgeDock/dock.css': patchDockFontCss,
    'src/electron/renderer/app.js': patchRendererApp,
    'src/electron/main.js': patchStartupStatsCache,
    'src/electron/runtimeConfig.js': patchRuntimeConfig,
    'src/electron/renderer/styles.css': patchLiveRateCss,
    'src/shared/usage.js': patchUsageEntryContext
  };
  if (nativeQoder) {
    // 0.93 already tracks Qoder (catalog, project source, health and watch
    // paths) and carries context through usage.js. Only apply the bridge's
    // extra surface: limits fallback, renderer/cold-start/design, history
    // decoupling and the WSL exclusion.
    for (const file of [
      'src/shared/clientCatalog.js',
      'src/shared/clientSources.js',
      'src/shared/clientHealth.js',
      'src/shared/collector.js'
    ]) delete patches[file];
    log('Native Qoder support detected; skipping duplicate collection patches.');
  }
  for (const [file, apply] of Object.entries(patches)) {
    const full = path.join(extractDir, file);
    const before = fs.readFileSync(full, 'utf8');
    const after = apply(before);
    if (after === before) fail(`Patch made no change to ${file}.`);
    fs.writeFileSync(full, after);
  }
  return Object.keys(patches);
}

async function loadAsarInternal(name) {
  const lib = path.dirname(require.resolve('@electron/asar'));
  return import(pathToFileURL(path.join(lib, name)).href);
}

// asar's own unpack glob is matched against absolute Windows paths, where
// backslashes (and dot directories such as .work) never satisfy minimatch, so the
// pristine archive's unpacked set is replayed file by file instead.
async function packAsar(extractDir, dest, layout) {
  const { Filesystem } = await loadAsarInternal('filesystem.js');
  const { writeFilesystem } = await loadAsarInternal('disk.js');
  const unpackedFiles = new Set(layout.unpackedFiles);
  const unpackedDirs = new Set(layout.unpackedDirs);
  const inUnpackedDir = (rel) => {
    let dir = path.posix.dirname(rel);
    while (dir !== '.') {
      if (unpackedDirs.has(dir)) return true;
      dir = path.posix.dirname(dir);
    }
    return false;
  };

  const filesystem = new Filesystem(extractDir);
  const files = [];
  const links = [];
  const metadata = {};
  const walk = async (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(extractDir, full).split(path.sep).join('/');
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        filesystem.insertDirectory(full, unpackedDirs.has(rel));
        await walk(full);
      } else if (stat.isSymbolicLink()) {
        const unpack = unpackedFiles.has(rel) || inUnpackedDir(rel);
        links.push({ filename: full, unpack });
        filesystem.insertLink(full, unpack);
      } else {
        const unpack = unpackedFiles.has(rel) || inUnpackedDir(rel);
        metadata[full] = { type: 'file', stat };
        const duplicate = await filesystem.insertFile(full, () => fs.createReadStream(full), unpack, { type: 'file', stat });
        files.push({ filename: full, unpack, duplicate });
      }
    }
  };
  await walk(extractDir);
  await writeFilesystem(dest, filesystem, { files, links }, metadata);
}

function verifyRepack(originalAsar, rebuiltAsar) {
  const before = readAsarLayout(originalAsar).unpackedFiles;
  const after = readAsarLayout(rebuiltAsar).unpackedFiles;
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const missing = before.filter((file) => !afterSet.has(file));
  const extra = after.filter((file) => !beforeSet.has(file));
  if (missing.length || extra.length) {
    fail(`Unpacked file set changed. missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
  }
  const listBefore = asar.listPackage(originalAsar).map((file) => file.split(path.sep).join('/')).sort();
  const listAfter = asar.listPackage(rebuiltAsar).map((file) => file.split(path.sep).join('/')).sort();
  if (listBefore.length !== listAfter.length || listBefore.some((file, index) => file !== listAfter[index])) {
    fail('Repacked archive file list differs from the original.');
  }
  if (!readAsarText(rebuiltAsar, 'src/shared/clientCatalog.js').includes("id: 'qoder'")) {
    fail('Repacked archive is missing the Qoder catalog entry.');
  }
}

function installBridgeFiles(packedDir) {
  const bridgeDir = path.join(packedDir, 'node_modules', 'tokscale', 'qoder-bridge');
  fs.rmSync(bridgeDir, { recursive: true, force: true });
  fs.mkdirSync(bridgeDir, { recursive: true });
  const hashes = {};
  for (const name of BRIDGE_FILES) {
    const target = name === 'shim.cjs' ? 'qoder-shim.cjs' : name;
    const source = path.join(SOURCE_DIR, target);
    const destination = path.join(bridgeDir, name);
    const data = fs.readFileSync(source);
    fs.writeFileSync(destination, data);
    hashes[name] = sha256(data);
  }
  const bridgePackage = { name: 'qoder-bridge', private: true, type: 'commonjs' };
  fs.writeFileSync(path.join(bridgeDir, 'package.json'), `${JSON.stringify(bridgePackage, null, 2)}\n`);
  hashes['package.json'] = sha256File(path.join(bridgeDir, 'package.json'));

  const loader = [
    '#!/usr/bin/env node',
    "import { createRequire } from 'node:module';",
    "const require = createRequire(import.meta.url);",
    "const { run } = require('./qoder-bridge/shim.cjs');",
    'try {',
    '  process.exitCode = await run(process.argv.slice(2));',
    '} catch (error) {',
    "  process.stderr.write(`qoder-shim: ${error?.stack || error}\\n`);",
    '  process.exitCode = 1;',
    '}',
    ''
  ].join('\n');
  const loaderPath = path.join(packedDir, 'node_modules', 'tokscale', 'bin.js');
  fs.writeFileSync(loaderPath, loader);
  return { hashes, loader, loaderPath };
}

function renameBundledBinary(packedDir) {
  const original = findFile(packedDir, 'tokscale.exe');
  const existingReal = findFile(packedDir, 'tokscale-real.exe');
  if (original && existingReal) {
    // A leftover physical binary would win over bin.js and bypass the bridge.
    const disabled = `${original}.disabled-${Date.now()}`;
    fs.renameSync(original, disabled);
    log(`Disabled stray bundled binary -> ${path.basename(disabled)}`);
    return { binary: '', real: existingReal };
  }
  if (original) {
    const target = path.join(path.dirname(original), 'tokscale-real.exe');
    fs.renameSync(original, target);
    return { binary: original, real: target };
  }
  if (existingReal) return { binary: '', real: existingReal };
  fail('Bundled tokscale.exe / tokscale-real.exe not found.');
}

function findFile(dir, name) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return '';
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return '';
}

// extractAll() reads unpacked entries from the directory beside the archive, which
// only exists for the installed app.asar; a rebuild from the backup therefore gets
// a temporary copy, and the renamed bundled binary is put back under its asar name
// so that extraction sees the files the header describes.
function prepareUnpackedSource(sourceAsar, packed) {
  const adjacent = `${sourceAsar}.unpacked`;
  const renameBack = (dir) => {
    if (findFile(dir, 'tokscale.exe')) return;
    const real = findFile(dir, 'tokscale-real.exe');
    if (real) fs.renameSync(real, path.join(path.dirname(real), 'tokscale.exe'));
  };
  if (path.resolve(adjacent) === path.resolve(packed)) {
    renameBack(packed);
    return () => {};
  }
  fs.rmSync(adjacent, { recursive: true, force: true });
  fs.cpSync(packed, adjacent, { recursive: true });
  renameBack(adjacent);
  return () => fs.rmSync(adjacent, { recursive: true, force: true });
}

function readSettingsPath(appDir) {
  const folder = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Token Monitor');
  return path.join(folder, 'settings.json');
}

function enableQoderInSettings(settingsPath) {
  const settings = readJson(settingsPath);
  if (!settings) return { changed: false, before: '', after: '' };
  const before = String(settings.clients || '');
  const ids = before.split(',').map((value) => value.trim()).filter(Boolean);
  if (ids.includes('qoder')) return { changed: false, before, after: before };
  ids.push('qoder');
  settings.clients = ids.join(',');
  writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { changed: true, before, after: settings.clients };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log('Usage: node src/install.js [--app-dir=<dir>] [--force]');
    log('Patches Token Monitor (app.asar + tokscale entry) so Qoder appears as a tracked client.');
    return;
  }

  const appDir = resolveAppDir(options.appDir);
  const resources = path.join(appDir, 'resources');
  const asarPath = path.join(resources, 'app.asar');
  const packed = path.join(resources, 'app.asar.unpacked');
  const backupDir = path.join(resources, 'qoder-bridge-backup');
  const manifestPath = path.join(backupDir, 'manifest.json');
  const backupAsar = path.join(backupDir, 'app.asar.original');
  const settingsPath = readSettingsPath(appDir);

  for (const name of fs.readdirSync(resources)) {
    if (/^app\.asar\.\d+\.tmp$/.test(name)) fs.rmSync(path.join(resources, name), { force: true });
  }

  ensureAppClosed(appDir);

  const packageJson = readAsarJson(asarPath, 'package.json');
  if (packageJson.name !== 'token-monitor') fail(`Unexpected app.asar package: ${packageJson.name}`);
  const appVersion = String(packageJson.version || '0.0.0');
  log(`Token Monitor ${appVersion} at ${appDir}`);

  // 0.93 ships `id: 'qoder'` natively, so the catalog can no longer identify a
  // bridge install. The limits fallback marker is bridge-only in every version.
  const currentLimits = readAsarText(asarPath, 'src/shared/providers/qoder/limits.js');
  const alreadyPatched = currentLimits.includes('QODER_LOCAL_LOG_MAX_BYTES');
  let manifest = readJson(manifestPath);
  let sourceAsar = asarPath;

  if (alreadyPatched) {
    if (!manifest || !fs.existsSync(backupAsar)) {
      fail('app.asar already contains a Qoder patch but no pristine backup exists. Reinstall Token Monitor first.');
    }
    if (manifest.appVersion !== appVersion) {
      fail(`Backup is for Token Monitor ${manifest.appVersion}, installed app is ${appVersion}. Reinstall Token Monitor, then rerun.`);
    }
    if (manifest.originalAsarSha256 && sha256File(backupAsar) !== manifest.originalAsarSha256) {
      fail('The pristine app.asar backup no longer matches its manifest. Reinstall Token Monitor first.');
    }
    log('Existing Qoder patch detected; rebuilding from the pristine backup.');
    sourceAsar = backupAsar;
  } else if (manifest && !options.force) {
    fail('A previous qoder-bridge-backup exists for a different app.asar. Rerun with --force to replace it, or delete resources\\qoder-bridge-backup.');
  } else if (manifest) {
    const stale = `${backupDir}.stale-${Date.now()}`;
    fs.renameSync(backupDir, stale);
    log(`Moved stale backup to ${stale}`);
    manifest = null;
  }

  if (!fs.existsSync(backupAsar)) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(sourceAsar, backupAsar);
    log(`Backed up app.asar -> ${backupAsar}`);
  }

  const tempRoot = path.join(PROJECT_ROOT, '.work', 'install');
  const extractDir = path.join(tempRoot, 'extract');
  const rebuiltAsar = path.join(tempRoot, 'app.asar.new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  log('Extracting app.asar...');
  const releaseUnpacked = prepareUnpackedSource(sourceAsar, packed);
  try {
    asar.extractAll(sourceAsar, extractDir);
  } finally {
    releaseUnpacked();
  }

  log('Applying Token Monitor patches...');
  const appliedFiles = applyPatches(extractDir);
  installTrayIcon(extractDir);
  for (const relative of PATCHED_FILES) {
    if (!relative.endsWith('.js')) continue;
    execFileSync(process.execPath, ['--check', path.join(extractDir, relative)], { stdio: 'pipe' });
  }

  log('Repacking app.asar...');
  await packAsar(extractDir, rebuiltAsar, readAsarLayout(sourceAsar));
  verifyRepack(sourceAsar, rebuiltAsar);

  log('Installing tokscale loader and Qoder bridge...');
  const bridge = installBridgeFiles(packed);
  const renamed = renameBundledBinary(packed);
  const settings = enableQoderInSettings(settingsPath);

  const patchedBytes = fs.readFileSync(rebuiltAsar);
  writeFileAtomic(asarPath, patchedBytes);
  const patchedHash = sha256(patchedBytes);
  if (sha256File(asarPath) !== patchedHash) {
    fail('app.asar does not match the rebuilt archive after writing.');
  }

  const manifestData = {
    format: 1,
    appVersion,
    appDir,
    installedAt: new Date().toISOString(),
    originalAsarSha256: sha256File(backupAsar),
    patchedAsarSha256: patchedHash,
    loaderSha256: sha256(Buffer.from(bridge.loader)),
    bridgeSha256: bridge.hashes,
    originalBinSha256: sha256(Buffer.from(ORIGINAL_BIN)),
    bundledBinary: { original: path.basename(renamed.binary), renamed: path.basename(renamed.real) },
    settingsPath,
    settingsClientsBefore: settings.before,
    patchedFiles: appliedFiles
  };
  writeFileAtomic(manifestPath, `${JSON.stringify(manifestData, null, 2)}\n`);

  fs.rmSync(tempRoot, { recursive: true, force: true });
  log('');
  log('Qoder bridge installed.');
  log(`  app.asar: ${patchedHash.slice(0, 12)}...`);
  log(`  loader:   ${bridge.loaderPath}`);
  log(`  bridge:   ${path.join(packed, 'node_modules', 'tokscale', 'qoder-bridge')}`);
  log(`  backup:   ${backupDir}`);
  if (settings.changed) log('  settings: added qoder to the tracked clients');
  else log('  settings: qoder was already tracked (or settings.json does not exist yet)');
  log('Start Token Monitor, then enable Qoder under Settings → tools if it is unticked.');
}

main().catch((error) => {
  process.stderr.write(`install failed: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
