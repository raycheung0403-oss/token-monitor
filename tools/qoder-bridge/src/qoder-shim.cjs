'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildQoderGraphData, buildUsage, mergeGraphData } = require('./qoder-usage');

const PLATFORM_PACKAGES = {
  win32: {
    x64: '@tokscale/cli-win32-x64-msvc',
    arm64: '@tokscale/cli-win32-arm64-msvc'
  },
  darwin: {
    arm64: '@tokscale/cli-darwin-arm64',
    x64: '@tokscale/cli-darwin-x64'
  },
  linux: {
    x64: '@tokscale/cli-linux-x64-gnu',
    arm64: '@tokscale/cli-linux-arm64-gnu'
  }
};

const VALUE_FLAGS = new Set([
  '--client', '-c', '--group-by', '--since', '--until', '--year', '--home', '--theme', '-t',
  '--refresh', '-r', '--bucket-timezone'
]);

function debug(message) {
  if (process.env.QODER_TOKEN_MONITOR_DEBUG === '1') {
    process.stderr.write(`[qoder-shim] ${message}\n`);
  }
}

function splitClients(value) {
  return String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function parseInvocation(argv) {
  const rawArgs = [...argv];
  const realArgs = [];
  const clients = [];
  let sawClient = false;
  let hasQoder = false;
  let json = false;
  let home = false;
  let testData = false;
  let command = null;
  let commandSeen = false;
  let groupBy = '';
  const periodArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    const inlineValue = equals > 0 ? arg.slice(equals + 1) : null;

    if (name === '--client' || name === '-c') {
      const value = inlineValue !== null ? inlineValue : argv[index + 1];
      if (inlineValue === null) index += 1;
      sawClient = true;
      for (const client of splitClients(value)) {
        if (client.toLowerCase() === 'qoder') hasQoder = true;
        else clients.push(client);
      }
      continue;
    }
    if (name === '--group-by') {
      groupBy = inlineValue !== null ? inlineValue : argv[index + 1] || '';
      if (inlineValue === null) index += 1;
      realArgs.push('--group-by', groupBy);
      continue;
    }
    if (name === '--since' || name === '--until' || name === '--year') {
      const value = inlineValue !== null ? inlineValue : argv[index + 1] || '';
      if (inlineValue === null) index += 1;
      periodArgs[name.slice(2)] = value;
      realArgs.push(name, value);
      continue;
    }
    if (name === '--home') {
      home = true;
      const value = inlineValue !== null ? inlineValue : argv[index + 1] || '';
      if (inlineValue === null) index += 1;
      realArgs.push('--home', value);
      continue;
    }
    if (name === '--json') {
      json = true;
      realArgs.push(arg);
      continue;
    }
    if (name === '--test-data') {
      testData = true;
      realArgs.push(arg);
      continue;
    }
    if (name === '--today' || name === '--yesterday' || name === '--week' || name === '--month') {
      periodArgs[name.slice(2)] = true;
      realArgs.push(arg);
      continue;
    }
    if (!commandSeen && !arg.startsWith('-')) {
      command = arg;
      commandSeen = true;
      realArgs.push(arg);
      continue;
    }
    if (!arg.startsWith('-')) commandSeen = true;
    realArgs.push(...(VALUE_FLAGS.has(name) && inlineValue === null ? [arg, argv[++index] || ''] : [arg]));
  }

  // qoder is answered by this shim; the native binary must only ever see the
  // remaining clients, or it rejects the whole CSV with exit code 2.
  if (sawClient && clients.length > 0) realArgs.push('--client', clients.join(','));

  return {
    rawArgs,
    realArgs,
    clients,
    sawClient,
    hasQoder,
    json,
    home,
    testData,
    command,
    groupBy,
    periodArgs
  };
}

function realBinaryPath() {
  const override = String(process.env.QODER_TOKEN_MONITOR_TOKSCALE_BIN || '').trim();
  if (override) {
    try {
      if (fs.statSync(override).isFile()) return override;
    } catch (_) {
      return null;
    }
  }
  const packages = PLATFORM_PACKAGES[process.platform];
  const packageName = packages && packages[process.arch];
  if (!packageName) return null;
  const base = path.resolve(__dirname, '..', '..', packageName, 'bin');
  const names = process.platform === 'win32'
    ? ['tokscale-real.exe', 'tokscale.exe']
    : ['tokscale-real', 'tokscale'];
  for (const name of names) {
    const candidate = path.join(base, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {
      // Try the next name.
    }
  }
  return null;
}

function runProcess(bin, args, { captureStdout }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', captureStdout ? 'pipe' : 'inherit', 'inherit'],
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    if (captureStdout) {
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));

    const forward = (signal) => {
      try { child.kill(signal); } catch (_) {}
    };
    process.once('SIGTERM', () => forward('SIGTERM'));
    process.once('SIGINT', () => forward('SIGINT'));
  });
}

function emptyReport() {
  return {
    groupBy: 'client,model',
    entries: [],
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalMessages: 0,
    totalCost: 0,
    processingTimeMs: 0,
    undatedTokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0
    }
  };
}

function emptyGraph() {
  return {
    meta: { generatedAt: new Date().toISOString(), version: '4.20.0+qoder', dateRange: { start: null, end: null } },
    summary: {
      totalTokens: 0,
      totalCost: 0,
      totalDays: 0,
      activeDays: 0,
      averagePerDay: 0,
      maxCostInSingleDay: 0,
      clients: [],
      models: []
    },
    years: [],
    contributions: []
  };
}

function mergeUsageReports(real, qoder) {
  const base = real && typeof real === 'object' ? real : emptyReport();
  const entries = [
    ...(Array.isArray(base.entries) ? base.entries : []).filter((entry) => String(entry?.client || '').toLowerCase() !== 'qoder'),
    ...qoder.entries
  ];
  const totals = {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalMessages: 0,
    totalCost: 0
  };
  for (const entry of entries) {
    totals.totalInput += Number(entry.input) || 0;
    totals.totalOutput += Number(entry.output) || 0;
    totals.totalCacheRead += Number(entry.cacheRead) || 0;
    totals.totalCacheWrite += Number(entry.cacheWrite) || 0;
    totals.totalMessages += Number(entry.messageCount) || 0;
    totals.totalCost += Number(entry.cost) || 0;
  }
  return {
    ...base,
    groupBy: base.groupBy || qoder.groupBy || 'client,model',
    entries,
    ...totals,
    processingTimeMs: (Number(base.processingTimeMs) || 0) + (Number(qoder.processingTimeMs) || 0),
    undatedTokens: base.undatedTokens && typeof base.undatedTokens === 'object'
      ? base.undatedTokens
      : emptyReport().undatedTokens
  };
}

async function spawnReal(invocation, captureStdout) {
  const bin = realBinaryPath();
  if (!bin) {
    process.stderr.write('qoder-shim: tokscale native binary not found\n');
    return { code: 1, stdout: '' };
  }
  return runProcess(bin, invocation.realArgs, { captureStdout });
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

async function run(argv) {
  const invocation = parseInvocation(argv);
  const { command } = invocation;
  const isScan = !command;
  const isGraph = command === 'graph';
  const supportedCommand = isScan || isGraph;
  const qoderRequested = invocation.hasQoder || !invocation.sawClient;
  const realClientsRemain = invocation.clients.length > 0;

  // Only scan and graph carry per-client usage that can be merged. Every other
  // command (models, pricing, tui, ...) must see the original argv untouched.
  if (!supportedCommand || !qoderRequested) {
    return (await spawnReal({ ...invocation, realArgs: invocation.rawArgs }, false)).code;
  }

  // --test-data reads tokscale's bundled fixtures, which have no Qoder rows and
  // must not be mixed with a live home directory.
  if (invocation.testData) {
    return (await spawnReal({ ...invocation, realArgs: invocation.rawArgs }, false)).code;
  }

  // A --home scan is how Token Monitor probes whether a binary accepts a
  // fork-only client over a foreign (usually empty) home. Qoder lives in the
  // real home, so it cannot answer that probe. Answer the whole probe with an
  // empty report instead of forwarding it to the native binary: the native
  // pricing fetch can take 30s on a cold cache, while the capability probe
  // gives up after 10s and then falls back to a scan that rejects `qoder`.
  if (invocation.home) {
    if (isScan || isGraph) writeJson(isGraph ? emptyGraph() : emptyReport());
    return 0;
  }

  // Interactive scans (including --help and the TUI) render from the native
  // binary and have no merge point. Qoder rows simply cannot be injected there.
  if (isScan && !invocation.json) {
    if (!invocation.hasQoder) return (await spawnReal({ ...invocation, realArgs: invocation.rawArgs }, false)).code;
    if (!realClientsRemain) {
      process.stderr.write('qoder-shim: Qoder data is only available in --json scans\n');
      return 1;
    }
    return (await spawnReal(invocation, false)).code;
  }

  const hasRealClients = !invocation.sawClient || realClientsRemain;
  let realResult = null;
  if (hasRealClients) {
    realResult = await spawnReal(invocation, true);
    if (realResult.code !== 0) return realResult.code;
  }

  let qoder;
  try {
    if (isGraph) {
      qoder = buildQoderGraphData();
    } else {
      qoder = buildUsage({ args: invocation.periodArgs }).report;
    }
  } catch (error) {
    debug(`qoder data unavailable: ${error?.stack || error}`);
    process.stderr.write(`qoder-shim: failed to read Qoder data: ${error?.message || error}\n`);
    if (realResult) {
      process.stdout.write(realResult.stdout.trim() || '{}');
      return 0;
    }
    writeJson(isGraph ? emptyGraph() : emptyReport());
    return 0;
  }

  if (!realResult) {
    writeJson(qoder);
    return 0;
  }

  let realJson;
  try {
    realJson = JSON.parse(realResult.stdout.trim() || '{}');
  } catch (error) {
    process.stderr.write(`qoder-shim: tokscale returned invalid JSON: ${error.message}\n`);
    return 1;
  }

  writeJson(isGraph ? mergeGraphData(realJson, qoder) : mergeUsageReports(realJson, qoder));
  return 0;
}

module.exports = {
  emptyReport,
  mergeUsageReports,
  parseInvocation,
  realBinaryPath,
  run
};

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`qoder-shim: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
