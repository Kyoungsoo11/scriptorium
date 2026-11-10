'use strict';
// `scriptorium setup-claude`: registers `scriptorium mcp` in Claude Desktop's config so its chat
// can use Scriptorium. Other servers and settings in the file are kept, and the previous file is
// backed up next to it.
//
// Where the config lives depends on how Claude Desktop was installed:
//   regular installer         %APPDATA%\Claude\claude_desktop_config.json
//   Microsoft Store (MSIX)    %LOCALAPPDATA%\Claude-Data\<package>\claude_desktop_config.json
//                             (seen on 2026-11 builds; older ones used the package's LocalCache)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SERVER_NAME = 'scriptorium';
const CLI = path.join(__dirname, '..', 'bin', 'scriptorium.js');

function candidates() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const list = [path.join(appData, 'Claude', 'claude_desktop_config.json')];
  const dataRoot = path.join(local, 'Claude-Data');
  if (fs.existsSync(dataRoot)) {
    for (const d of fs.readdirSync(dataRoot)) list.push(path.join(dataRoot, d, 'claude_desktop_config.json'));
  }
  const packages = path.join(local, 'Packages');
  if (fs.existsSync(packages)) {
    for (const d of fs.readdirSync(packages).filter(n => /^Claude_/i.test(n))) {
      list.push(path.join(packages, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    }
  }
  return list;
}

/** The config file Claude Desktop uses: the most recently written existing one. */
function findConfig() {
  const existing = candidates()
    .filter(f => fs.existsSync(f))
    .map(f => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (existing.length) return { path: existing[0].f, others: existing.slice(1).map(e => e.f), created: false };
  // Nothing yet: a regular install reads %APPDATA%\Claude once that folder exists.
  const fallback = candidates()[0];
  if (fs.existsSync(path.dirname(fallback))) return { path: fallback, others: [], created: true };
  return null;
}

function serverEntry(env) {
  return {
    command: process.execPath,
    args: [CLI, 'mcp'],
    // Pinned so chat, terminal and Claude Code share one note store.
    env: { SCRIPTORIUM_HOME: env.dataDir },
  };
}

/**
 * @returns {object} what was done: { config, action: added|updated|unchanged|removed|absent, backup, entry }
 */
function setupClaude(env, { configPath, remove = false, dryRun = false } = {}) {
  const found = configPath ? { path: path.resolve(configPath), others: [], created: !fs.existsSync(configPath) } : findConfig();
  if (!found) {
    throw new Error(
      'Claude Desktop config not found. Install Claude Desktop and open it once, or pass --config <path to claude_desktop_config.json>.',
    );
  }
  let config = {};
  if (fs.existsSync(found.path)) {
    const text = fs.readFileSync(found.path, 'utf8').replace(/^﻿/, '');
    try {
      config = text.trim() ? JSON.parse(text) : {};
    } catch (e) {
      throw new Error(`${found.path} is not valid JSON (${e.message}); fix it or pass --config`);
    }
  }
  const servers = { ...(config.mcpServers || {}) };
  const before = servers[SERVER_NAME];
  let action;
  let entry = null;
  if (remove) {
    if (!before) return { config: found.path, action: 'absent' };
    delete servers[SERVER_NAME];
    action = 'removed';
  } else {
    entry = serverEntry(env);
    if (JSON.stringify(before) === JSON.stringify(entry)) return { config: found.path, action: 'unchanged', entry };
    servers[SERVER_NAME] = entry;
    action = before ? 'updated' : 'added';
  }
  const result = { config: found.path, action, entry, otherConfigs: found.others, restartClaude: true };
  if (dryRun) return { ...result, dryRun: true };
  if (fs.existsSync(found.path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    result.backup = `${found.path}.bak-${stamp}`;
    fs.copyFileSync(found.path, result.backup);
  } else {
    fs.mkdirSync(path.dirname(found.path), { recursive: true });
  }
  fs.writeFileSync(found.path, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`);
  return result;
}

module.exports = { setupClaude, findConfig, serverEntry, SERVER_NAME };
