'use strict';
// Helpers shared by the commands: output, option checks, and the run folder's state files.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkRequired } = require('../env');
const { Store, UsageError } = require('../store');
const { render, FORMATS } = require('../format');

function makeLog(opts) {
  return msg => {
    if (!opts.quiet) process.stderr.write(`[scriptorium] ${msg}\n`);
  };
}

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, process.stdout.isTTY ? 2 : 0)}\n`);
}

function openStore(env) {
  return new Store(env.dbPath);
}

/** Runs fn with an open store and closes it afterwards. */
function withStore(env, fn) {
  const store = openStore(env);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** The JSON state files in <data>\run whose names start with prefix, with their path as `file`. */
function stateFiles(env, prefix = 'recording-') {
  if (!fs.existsSync(env.runDir)) return [];
  return fs
    .readdirSync(env.runDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => {
      const file = path.join(env.runDir, f);
      try {
        return { file, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Running recordings; removes state left by a recorder that died. */
function runningRecordings(env) {
  return stateFiles(env).filter(s => {
    if (alive(s.pid)) return true;
    fs.rmSync(s.file, { force: true });
    return false;
  });
}

/** Running file transcriptions (their state files; dead ones are left for the tray app to clear). */
function runningTranscriptions(env) {
  return stateFiles(env, 'transcribe-').filter(s => alive(s.pid));
}

/** Work that is writing files now: recordings (wav + txt) and file transcriptions (txt). */
function busyFiles(env) {
  return [...runningRecordings(env), ...runningTranscriptions(env)];
}

/**
 * Whisper threads for a new piece of work when --threads is not given: the CPU shared between the
 * recordings and transcriptions running now and this one. Each whisper process otherwise takes up
 * to 16, and three at once on 16 cores made live text lag and finishing take minutes.
 */
function autoThreads(env, cpus = os.availableParallelism?.() ?? os.cpus().length) {
  const active = runningRecordings(env).length + runningTranscriptions(env).length + 1;
  return Math.max(2, Math.min(16, Math.floor(cpus / active)));
}

function transcriptionOptions(opts, env) {
  if (opts.backend && !['auto', 'cpu', 'gpu'].includes(opts.backend))
    throw new UsageError('--backend takes auto, cpu or gpu');
  const fraction = (name, v) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!(n > 0 && n < 1)) throw new UsageError(`--${name} takes a number between 0 and 1`);
    return n;
  };
  const positive = (name, v) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} takes a whole number of 1 or more`);
    return n;
  };
  if (opts.format && !FORMATS.includes(opts.format)) throw new UsageError(`--format takes ${FORMATS.join(', ')}`);
  return {
    language: opts.lang && opts.lang !== 'auto' ? opts.lang : undefined,
    diarize: opts.diarize !== false,
    prompt: opts.prompt,
    speakers: positive('speakers', opts.speakers),
    useGpu: opts.backend !== 'cpu',
    gpu: opts.gpu,
    threads: positive('threads', opts.threads) ?? (env ? autoThreads(env) : undefined),
    beam: positive('beam', opts.beam),
    vadThreshold: fraction('vad-threshold', opts['vad-threshold']),
  };
}

function requireModels(env, options) {
  const missing = checkRequired(env, options).filter(r => !r.ok);
  if (missing.length) {
    throw new Error(
      `Missing ${missing.map(m => `${m.name} (${m.path})`).join(', ')}. ` + 'Run "scriptorium doctor" to see what is missing.',
    );
  }
}

function formatFor(opts, outFile) {
  if (opts.format) return opts.format;
  const ext = outFile ? path.extname(outFile).slice(1).toLowerCase() : '';
  return FORMATS.includes(ext) ? ext : 'json';
}

/** Prints or writes a finished run per --format/--out/--stream. */
function deliver(result, opts, { stream, title }) {
  const out = opts.out;
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, render(result.segments, formatFor(opts, out), { title }));
  }
  const summary = { ...result, ...(out ? { saved: path.resolve(out) } : {}) };
  if (stream) {
    const { segments, ...rest } = summary;
    stream({ event: 'done', ...rest, segmentCount: segments.length });
    return;
  }
  if (opts.format && !out) {
    process.stdout.write(render(result.segments, opts.format, { title }));
    return;
  }
  printJson(summary);
}

function streamer(opts) {
  return opts.stream ? event => process.stdout.write(`${JSON.stringify(event)}\n`) : null;
}

module.exports = {
  makeLog,
  printJson,
  openStore,
  withStore,
  alive,
  stateFiles,
  runningRecordings,
  runningTranscriptions,
  busyFiles,
  autoThreads,
  transcriptionOptions,
  requireModels,
  formatFor,
  deliver,
  streamer,
};
