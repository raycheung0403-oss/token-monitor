'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const { writeFileAtomic } = require('./atomic-file');

const ORIGINAL_BIN = '#!/usr/bin/env node\nawait import("@tokscale/cli");\n';

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

function resolveAppDir(explicit) {
  if (explicit) {
    if (!fs.existsSync(path.join(explicit, 'resources', 'app.asar'))) {
      fail(`app.asar not found under ${explicit}\\resources`);
    }
    return path.resolve(explicit);
  }
  for (const candidate of appCandidates()) {
    if (fs.existsSync(path.join(candidate, 'resources', 'app.asar'))) return path.resolve(candidate);
  }
  fail('Token Monitor install not found. Pass --app-dir=<folder containing resources\\app.asar>.');
}

function readAsarText(archive, file) {
  return asar.extractFile(archive, file.split('/').join(path.sep)).toString('utf8');
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
    fail(`Close ${exe} before uninstalling the Qoder bridge (it also lives in the tray).`);
  }
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

function readSettingsPath() {
  const folder = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Token Monitor');
  return path.join(folder, 'settings.json');
}

function removeQoderFromSettings(settingsPath) {
  const settings = readJson(settingsPath);
  if (!settings) return false;
  const before = String(settings.clients || '');
  const ids = before.split(',').map((value) => value.trim()).filter(Boolean);
  if (!ids.includes('qoder')) return false;
  settings.clients = ids.filter((id) => id !== 'qoder').join(',');
  writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log('Usage: node src/uninstall.js [--app-dir=<dir>] [--force]');
    log('Restores the pristine app.asar and removes the Qoder bridge.');
    return;
  }

  const appDir = resolveAppDir(options.appDir);
  const resources = path.join(appDir, 'resources');
  const asarPath = path.join(resources, 'app.asar');
  const packed = path.join(resources, 'app.asar.unpacked');
  const bridgeDir = path.join(packed, 'node_modules', 'tokscale', 'qoder-bridge');
  const loaderPath = path.join(packed, 'node_modules', 'tokscale', 'bin.js');
  const backupDir = path.join(resources, 'qoder-bridge-backup');
  const manifestPath = path.join(backupDir, 'manifest.json');
  const backupAsar = path.join(backupDir, 'app.asar.original');
  const manifest = readJson(manifestPath);
  if (!manifest) fail(`No Qoder bridge manifest at ${manifestPath}.`);

  ensureAppClosed(appDir);

  const currentAsarHash = sha256File(asarPath);
  const asarIsOurs = currentAsarHash === manifest.patchedAsarSha256;
  const currentCatalog = readAsarText(asarPath, 'src/shared/clientCatalog.js');
  const catalogHasQoder = currentCatalog.includes("id: 'qoder'");

  if (!asarIsOurs && catalogHasQoder) {
    fail('app.asar was modified after this bridge was installed. Reinstall Token Monitor instead of restoring an old archive.');
  }
  if (asarIsOurs && !fs.existsSync(backupAsar)) {
    fail('The pristine app.asar backup is missing. Reinstall Token Monitor.');
  }

  const problems = [];
  if (fs.existsSync(loaderPath) && sha256File(loaderPath) !== manifest.loaderSha256) {
    problems.push('node_modules/tokscale/bin.js');
  }
  if (fs.existsSync(bridgeDir)) {
    for (const [name, hash] of Object.entries(manifest.bridgeSha256 || {})) {
      const file = path.join(bridgeDir, name);
      if (fs.existsSync(file) && sha256File(file) !== hash) problems.push(`qoder-bridge/${name}`);
    }
  }
  if (problems.length && !options.force) {
    fail(`These bridge files were modified: ${problems.join(', ')}. Rerun with --force to remove them anyway.`);
  }

  if (asarIsOurs) {
    const original = fs.readFileSync(backupAsar);
    if (manifest.originalAsarSha256 && sha256(original) !== manifest.originalAsarSha256) {
      fail('The pristine app.asar backup is corrupt; reinstall Token Monitor.');
    }
    writeFileAtomic(asarPath, original);
    if (manifest.originalAsarSha256 && sha256File(asarPath) !== manifest.originalAsarSha256) {
      fail('app.asar does not match the pristine backup after restoring.');
    }
    log('Restored the pristine app.asar.');
  } else {
    log('app.asar is not the archived patched build; leaving it untouched.');
  }

  fs.rmSync(bridgeDir, { recursive: true, force: true });
  fs.writeFileSync(loaderPath, ORIGINAL_BIN);
  log('Removed the Qoder bridge and restored the tokscale entry script.');

  const real = findFile(packed, 'tokscale-real.exe');
  const physical = findFile(packed, 'tokscale.exe');
  if (!physical && real) {
    const target = path.join(path.dirname(real), 'tokscale.exe');
    fs.renameSync(real, target);
    log('Restored the bundled tokscale.exe.');
  } else if (!physical && !real) {
    log('Warning: neither tokscale.exe nor tokscale-real.exe was found.');
  }

  const settingsPath = readSettingsPath();
  if (removeQoderFromSettings(settingsPath)) log('Removed qoder from the tracked clients.');
  else log('qoder was not in the tracked clients.');

  fs.rmSync(backupDir, { recursive: true, force: true });
  log('');
  log('Qoder bridge uninstalled.');
}

main().catch((error) => {
  process.stderr.write(`uninstall failed: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
