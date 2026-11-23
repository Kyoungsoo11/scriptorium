'use strict';
// `clean [recordings|run|all]`: empties the data folder's recordings\ and run\ folders, leaving out
// whatever work in progress uses. Notes and transcripts (scriptorium.db) and the output folder
// (Documents\Scriptorium) are never touched. The tray app's 정리 menu runs this command too.
//
// What counts as in use:
// - a file any process has open: a recorder keeps its .wav and its log open for as long as it
//   writes them, which also covers one that is still starting and has no state file yet
// - files a running recording or transcription names in its state file or MCP job (a recording that
//   is finishing has closed its .wav; a transcription has more files waiting than it has open)
// - state files whose process is alive

const fs = require('node:fs');
const path = require('node:path');

const { UsageError } = require('../store');
const { trayAppRunning } = require('../tray');
const { printJson, alive } = require('./common');

const TARGETS = ['recordings', 'run'];
/** A temporary file of an atomic write lives for milliseconds; an older one was left by a crash. */
const TMP_MAX_AGE_MS = 60_000;
/** libuv's UV_FS_O_EXLOCK: on Windows, opens with no sharing, so it fails while anyone has the file open. */
const EXCLUSIVE = 0x10000000;

/** A path to compare by: case aside, and the long form of a short (8.3) one such as C:/Users/KYOUNG~1. */
function key(file) {
  let full = path.resolve(file);
  try {
    full = fs.realpathSync.native(full);
  } catch {
    // gone or not reachable: compare as written
  }
  return full.toLowerCase();
}

/** True when some process has the file open (or it cannot be checked). False when it is free. */
function isOpen(file) {
  if (process.platform !== 'win32') return false;
  try {
    fs.closeSync(fs.openSync(file, fs.constants.O_RDONLY | EXCLUSIVE));
    return false;
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

/** The names of the plain files in a folder (no folders, no links); none when it does not exist. */
function filesIn(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => e.name);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/** A JSON file's content; undefined when it is gone or unreadable (so it counts as in use). */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** False only when the state file says which process wrote it and that process is gone. */
function stateInUse(file) {
  if (!fs.existsSync(file)) return false;
  const state = readJson(file);
  return !state || !Number.isInteger(state.pid) || alive(state.pid);
}

/** Every file that running work reads or writes, as comparable keys. */
function filesInWork(env) {
  const jobs = path.join(env.runDir, 'jobs');
  const states = [
    ...filesIn(env.runDir)
      .filter(f => /^(recording|transcribe)-.*\.json$/i.test(f))
      .map(f => path.join(env.runDir, f)),
    ...filesIn(jobs)
      .filter(f => /\.json$/i.test(f))
      .map(f => path.join(jobs, f)),
  ];
  const used = new Set();
  for (const s of states.map(readJson)) {
    if (!s || !alive(s.pid)) continue;
    for (const f of [s.audioPath, s.textPath, s.file, ...(Array.isArray(s.files) ? s.files : [])]) {
      if (typeof f === 'string' && f) used.add(key(f));
    }
  }
  return used;
}

/** recordings\*.wav: where recordings went up to 0.4. */
function planRecordings(env) {
  const used = filesInWork(env);
  return filesIn(env.recordingsDir)
    .filter(f => /\.wav$/i.test(f))
    .map(f => {
      const file = path.join(env.recordingsDir, f);
      return { file, inUse: () => used.has(key(file)) || isOpen(file) };
    });
}

/** run\: logs, MCP job results, and what work that died left behind. */
function planRun(env) {
  const dir = env.runDir;
  const plan = [];
  const add = (file, inUse) => plan.push({ file, inUse });
  for (const f of filesIn(dir)) {
    const file = path.join(dir, f);
    let m;
    if (/\.log$/i.test(f)) add(file, () => isOpen(file));
    else if ((m = /^((?:recording|transcribe)-.*)\.(json|stop|pause)$/i.exec(f))) {
      // .stop and .pause belong to the recording whose state file they are next to
      const state = path.join(dir, `${m[1]}.json`);
      add(file, () => stateInUse(state));
    } else if (/^finished-.*\.json$/i.test(f)) {
      // a running tray app is about to show this notice, and deletes it itself
      add(file, () => trayAppRunning(env));
    } else if (/^app\.json$/i.test(f)) {
      // the running tray app's own file is not work in progress: not listed at all
      if (!stateInUse(file)) add(file, () => stateInUse(file));
    } else if (/\.tmp$/i.test(f)) {
      add(file, () => {
        const st = fs.statSync(file, { throwIfNoEntry: false });
        return Boolean(st) && Date.now() - st.mtimeMs < TMP_MAX_AGE_MS;
      });
    }
  }
  // An MCP transcription job is <id>.json + .out + .log, kept together while any of it is in use.
  const jobs = path.join(dir, 'jobs');
  for (const f of filesIn(jobs)) {
    const m = /^([0-9a-f]{12})\.(json|out|log)$/i.exec(f);
    if (!m) continue;
    const part = ext => path.join(jobs, `${m[1]}.${ext}`);
    add(path.join(jobs, f), () => stateInUse(part('json')) || isOpen(part('out')) || isOpen(part('log')));
  }
  return plan;
}

function sizeOf(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
}

/** Deletes (or with dryRun just lists) what a plan holds and is not in use right now. */
function carryOut(dir, plan, dryRun) {
  const out = { path: dir, count: 0, bytes: 0, files: [], inUse: [], failed: [] };
  const free = [];
  // Decided for all before the first deletion: a recording's .stop is judged by its .json.
  for (const { file, inUse } of plan) {
    if (inUse()) out.inUse.push(path.relative(dir, file));
    else free.push(file);
  }
  for (const file of free) {
    const name = path.relative(dir, file);
    const bytes = sizeOf(file);
    if (!dryRun) {
      try {
        fs.rmSync(file, { force: true });
      } catch (e) {
        out.failed.push({ file: name, error: e.message });
        continue;
      }
    }
    out.count++;
    out.bytes += bytes;
    out.files.push(name);
  }
  return out;
}

/**
 * Empties recordings\ and/or run\. Returns, per folder, the files deleted (or that would be), their
 * count and bytes, what was left because it is in use, and what could not be deleted.
 */
function clean(env, targets = TARGETS, { dryRun = false } = {}) {
  const out = { dryRun };
  // recordings first: what is in use there is told by the state files in run
  if (targets.includes('recordings')) out.recordings = carryOut(env.recordingsDir, planRecordings(env), dryRun);
  if (targets.includes('run')) out.run = carryOut(env.runDir, planRun(env), dryRun);
  return out;
}

/** Deleting takes a target; a bare `clean` only shows what there is to delete. */
function cmdClean(env, opts, positionals) {
  const [target] = positionals;
  if (positionals.length > 1 || (target !== undefined && ![...TARGETS, 'all'].includes(target))) {
    throw new UsageError('clean [recordings|run|all] [--dry-run]');
  }
  const targets = target === undefined || target === 'all' ? TARGETS : [target];
  const result = clean(env, targets, { dryRun: target === undefined || Boolean(opts['dry-run']) });
  printJson(result);
  if (targets.some(t => result[t].failed.length)) process.exitCode = 1;
}

module.exports = { clean, cmdClean, isOpen };
