'use strict';

const os = require('node:os');
const path = require('node:path');

function resolveQoderPaths({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  const projectsDir = path.join(homeDir, '.qoder', 'projects');
  const absoluteEnvPath = (name, fallback) => {
    const value = env[name];
    return typeof value === 'string' && path.isAbsolute(value) ? value : fallback;
  };
  let appDataDir;
  if (platform === 'win32') {
    const roaming = typeof env.APPDATA === 'string' && env.APPDATA.trim() ? env.APPDATA : path.join(homeDir, 'AppData', 'Roaming');
    appDataDir = path.join(roaming, 'com.qoder.app.stable');
  } else if (platform === 'darwin') {
    appDataDir = path.join(homeDir, 'Library', 'Application Support', 'com.qoder.app.stable');
  } else {
    appDataDir = path.join(absoluteEnvPath('XDG_CONFIG_HOME', path.join(homeDir, '.config')), 'com.qoder.app.stable');
  }
  return {
    homeDir,
    projectsDir,
    appDataDir,
    mainDb: path.join(appDataDir, 'main.sqlite'),
    bufferDb: path.join(appDataDir, 'chat-session-turn-payload-buffer.sqlite')
  };
}

function stateDir({ env = process.env, homeDir = os.homedir() } = {}) {
  return env.QODER_MONITOR_STATE_DIR || path.join(homeDir, '.qoder-token-monitor');
}

module.exports = { resolveQoderPaths, stateDir };
