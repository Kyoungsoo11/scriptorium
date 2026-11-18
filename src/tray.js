'use strict';
// Keeps the tray app (Scriptorium.exe) running while this process records or transcribes, so the
// tray icon is there whether the work was started from the app, the command line or Claude (MCP).
//
// The app writes <data>/run/app.json ({pid}) while it runs. Every few seconds this checks that the
// pid is alive and starts `Scriptorium.exe --background` otherwise: a background app shows only the
// tray icon and quits by itself once nothing runs. Starting it twice is harmless (one app per data
// folder), so a race between two recorders costs a process start, nothing more.
//
// SCRIPTORIUM_NO_GUI=1 turns this off (tests, servers without a desktop).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHECK_MS = 5000;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** True when the tray app for this data folder says it runs and its process exists. */
function trayAppRunning(env) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(env.runDir, 'app.json'), 'utf8'));
    return Number.isInteger(pid) && alive(pid);
  } catch {
    return false;
  }
}

function launchTrayApp(env) {
  const child = spawn(env.appExe, ['--background', '--data-dir', env.dataDir], { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // e.g. blocked by policy: the work goes on without an icon
  child.unref();
}

/**
 * Starts the watch; returns a function that ends it. `launch` and `running` are for tests.
 */
function keepTrayApp(env, { launch = launchTrayApp, running = trayAppRunning, intervalMs = CHECK_MS } = {}) {
  if (process.env.SCRIPTORIUM_NO_GUI === '1' || process.platform !== 'win32' || !env.appExe || !fs.existsSync(env.appExe)) {
    return () => {};
  }
  const check = () => {
    try {
      if (!running(env)) launch(env);
    } catch {
      // never let the icon get in the way of the recording
    }
  };
  check();
  const timer = setInterval(check, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { keepTrayApp, trayAppRunning };
