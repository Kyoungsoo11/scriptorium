'use strict';
// `app`, `devices`, `doctor`, and keeping the tray app running while work runs.

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { checkRequired } = require('../env');
const { listDevices } = require('../native');
const { keepTrayApp } = require('../tray');
const { outputDir } = require('../output');
const { printJson } = require('./common');

const VERSION = require('../../package.json').version;

/** Runs work with the tray app kept running, so its icon shows however the work was started. */
async function withTrayApp(env, work) {
  const stop = keepTrayApp(env);
  try {
    return await work();
  } finally {
    stop();
  }
}

/**
 * Starts the tray app, or brings the running one forward (it allows one instance per session).
 * The app watches env.dataDir, so a --data-dir given here reaches it too.
 */
async function cmdApp(env) {
  if (!fs.existsSync(env.appExe)) {
    throw new Error(`The tray app is missing: ${env.appExe}. Build it with scripts\\build-app.cmd.`);
  }
  const child = spawn(env.appExe, ['--data-dir', env.dataDir], { detached: true, stdio: 'ignore' });
  // e.g. blocked by an application control policy: report it rather than print a pid
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', e => reject(new Error(`Could not start the tray app ${env.appExe}: ${e.message}`)));
  });
  child.unref();
  printJson({ app: env.appExe, pid: child.pid });
}

function cmdDevices(env) {
  printJson({ audio: listDevices(env) });
}

function cmdDoctor(env, opts) {
  const checks = checkRequired(env, { diarize: true });
  let audio = null;
  try {
    const devices = listDevices(env);
    audio = {
      microphone: devices.find(d => d.input && d.default)?.name ?? null,
      output: devices.find(d => d.output && d.default)?.name ?? null,
    };
  } catch (e) {
    audio = { error: e.message };
  }
  let speech = null;
  try {
    require('sherpa-onnx-node');
    speech = { ok: true };
  } catch (e) {
    speech = { error: e.message };
  }
  const ok = checks.every(c => c.ok) && !audio.error && !speech.error;
  printJson({
    ok,
    version: VERSION,
    engine: { native: env.nativeDir, gpuBuild: env.gpuBuild },
    dataDir: env.dataDir,
    outputDir: outputDir(opts),
    audio,
    speechModules: speech,
    checks,
  });
  if (!ok) process.exitCode = 1;
}

module.exports = { withTrayApp, cmdApp, cmdDevices, cmdDoctor, VERSION };
