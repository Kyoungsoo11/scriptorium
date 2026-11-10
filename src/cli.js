'use strict';
// scriptorium: non-interactive CLI. Every command runs to completion from its options alone,
// prints one JSON result on stdout (or the requested transcript format), logs on stderr,
// and exits 0 on success, 1 on failure, 2 on bad usage.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { resolveEnv, checkRequired } = require('./env');
const { Store, UsageError } = require('./store');
const { parseArgs, parseDuration } = require('./args');
const { WavWriter, rms } = require('./audio');
const { decodeFile, Capture, listDevices } = require('./native');
const { TranscriptionRun } = require('./transcriber');
const { render, fromAltEntries, FORMATS } = require('./format');

const VERSION = require('../package.json').version;

const GLOBAL_VALUES = ['data-dir', 'models-dir', 'whisper-model', 'native', 'log-file'];
const GLOBAL_BOOLEANS = ['quiet', 'help'];
const TRANSCRIBE_VALUES = ['lang', 'prompt', 'backend', 'gpu', 'threads', 'beam', 'speakers', 'vad-threshold', 'title', 'folder', 'format', 'out'];
const TRANSCRIBE_BOOLEANS = ['diarize', 'save', 'stream'];

const HELP = `Scriptorium ${VERSION} - offline lecture/meeting transcription (no server, no account)

Usage: scriptorium <command> [options]

Transcription
  transcribe <file> [<file> ...]   transcribe audio/video files
  record                           record microphone + system audio and transcribe live
  stop [--id <noteId>]             stop a running recording and wait for its result
  status                           show running recordings

Notes
  notes list [--folder <name|id|null>] [--search <text>] [--limit <n>]
  notes show <noteId> [--format json|srt|vtt|txt|md]
  notes export <noteId> --format <fmt> --out <file>
  notes rename <noteId> <title>
  notes move <noteId> <folder|null>
  notes delete <noteId> [--keep-audio]
  folders list | folders create <name> [--parent <id>] | folders delete <id>
  speakers rename <noteId> <SPEAKER_00> <name>

Setup
  devices                          audio devices
  doctor                           check that the engine and models are in place
  setup-claude [--remove] [--dry-run] [--config <file>]
                                   register Scriptorium with Claude Desktop (then restart Claude)
  mcp                              run as an MCP server on stdin/stdout (Claude Desktop starts this)

Transcription options (transcribe, record)
  --lang <code|auto>      language, e.g. ko, en (default: auto-detect)
  --no-diarize            skip speaker separation
  --speakers <n>          number of speakers, when known (default: estimate)
  --prompt <text>         vocabulary/context hint for Whisper
  --backend <auto|cpu|gpu>  gpu needs the GPU build (default auto)
  --gpu <index>           pin a GPU
  --threads <n>           CPU threads (default: up to 16)
  --beam <n>              beam size; 1 = greedy, faster (default 5)
  --vad-threshold <0-1>   speech detection sensitivity; lower keeps quieter speech (default 0.15)
  --title <text>          note title (default: file name / date)
  --folder <name|id>      put the note in a folder (created if missing)
  --no-save               do not store a note, only print the result
  --format <fmt>          print the transcript as json|srt|vtt|txt|md instead of the result JSON
  --out <file>            write the transcript to a file (format from --format or extension)
  --stream                print JSON lines while running: started, segment..., done

Record options
  --duration <time>       stop after e.g. 90s, 45m, 1h30m (default: until stopped)
  --mic <id|default|none> microphone (default: system default; none = system audio only)
  --no-system             do not capture system audio (microphone only)
  --stop-file <path>      stop when this file appears
  --audio-out <file.wav>  where to keep the recording (default: in the data folder)
  --no-audio              do not keep the recording
  --detach                start in the background, print the note id and return
  Stops on: --duration, --stop-file, "scriptorium stop", Ctrl+C.

Global options
  --data-dir <dir>        notes database and recordings (default %USERPROFILE%\\.scriptorium)
  --models-dir <dir>      model folder (default: models next to scriptorium)
  --whisper-model <file>  a different ggml Whisper model (e.g. a smaller, faster one)
  --quiet                no progress on stderr
`;

// ---- helpers -----------------------------------------------------------------

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

function transcriptionOptions(opts) {
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
  if (opts.format && !FORMATS.includes(opts.format))
    throw new UsageError(`--format takes ${FORMATS.join(', ')}`);
  return {
    language: opts.lang && opts.lang !== 'auto' ? opts.lang : undefined,
    diarize: opts.diarize !== false,
    prompt: opts.prompt,
    speakers: positive('speakers', opts.speakers),
    useGpu: opts.backend !== 'cpu',
    gpu: opts.gpu,
    threads: positive('threads', opts.threads),
    beam: positive('beam', opts.beam),
    vadThreshold: fraction('vad-threshold', opts['vad-threshold']),
  };
}

function requireModels(env, options) {
  const missing = checkRequired(env, options).filter(r => !r.ok);
  if (missing.length) {
    throw new Error(
      `Missing ${missing.map(m => `${m.name} (${m.path})`).join(', ')}. ` +
        'Run "scriptorium doctor" to see what is missing.',
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

// ---- transcribe ----------------------------------------------------------------

async function cmdTranscribe(env, opts, files) {
  if (files.length === 0) throw new UsageError('transcribe needs at least one file');
  if (opts.out && files.length > 1) throw new UsageError('--out takes one input file; run once per file');
  const log = makeLog(opts);
  const options = transcriptionOptions(opts);
  requireModels(env, options);
  const store = opts.save === false ? null : openStore(env);
  const folder = store ? store.resolveFolder(opts.folder, { create: true }) : null;
  const stream = streamer(opts);
  const results = [];
  try {
    for (const file of files) {
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) throw new UsageError(`No such file: ${file}`);
      const title = opts.title || path.parse(abs).name;
      let total = null;
      const run = new TranscriptionRun({
        env,
        store,
        note: { title, type: 'file', folderId: folder?.id, sourcePath: abs },
        options,
        log,
        onEvent: stream || undefined,
      });
      const started = Date.now();
      await run.start();
      const progress = setInterval(() => {
        const sec = run.transcribedSeconds;
        log(`  transcribed ${Math.round(sec)} s${total ? ` / ${Math.round(total)} s (${Math.round((sec / total) * 100)}%)` : ''}`);
      }, 15000);
      try {
        await decodeFile(env, abs, {
          onInfo: info => {
            total = info.duration > 0 ? info.duration : null;
            log(`transcribing ${path.basename(abs)}${total ? ` (${Math.round(total)} s)` : ''} on ${run.backend}`);
          },
          onChunk: chunk => run.feed(chunk),
        });
        const result = await run.finish();
        clearInterval(progress);
        result.sourcePath = abs;
        result.elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
        log(`done: ${result.segments.length} segments, ${result.speakers.length} speakers, ${result.elapsedSeconds} s`);
        deliver(result, opts, { stream, title });
        results.push(result);
      } catch (err) {
        clearInterval(progress);
        throw await run.fail(err);
      }
    }
  } finally {
    store?.close();
  }
  return results;
}

// ---- record ------------------------------------------------------------------

function stateFiles(env) {
  if (!fs.existsSync(env.runDir)) return [];
  return fs
    .readdirSync(env.runDir)
    .filter(f => f.startsWith('recording-') && f.endsWith('.json'))
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

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Running recordings; removes state left by a recorder that died. */
function runningRecordings(env) {
  return stateFiles(env).filter(s => {
    if (alive(s.pid)) return true;
    fs.rmSync(s.file, { force: true });
    return false;
  });
}

async function cmdRecordDetached(env, opts, argv) {
  fs.mkdirSync(env.runDir, { recursive: true });
  const logFile = opts['log-file'] ? path.resolve(opts['log-file']) : path.join(env.runDir, `record-${Date.now()}.log`);
  const args = ['record', ...argv.filter(a => a !== '--detach' && a !== '--stream')];
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'scriptorium.js'), ...args], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(fd);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    const state = stateFiles(env).find(s => s.pid === child.pid);
    if (state) {
      const { file, ...info } = state;
      printJson({ detached: true, ...info, log: logFile, stop: 'scriptorium stop' + (info.noteId ? ` --id ${info.noteId}` : '') });
      return;
    }
    if (!alive(child.pid)) break;
  }
  throw new Error(`The background recorder did not start; see ${logFile}`);
}

async function cmdRecord(env, opts, argv) {
  if (opts.detach) return cmdRecordDetached(env, opts, argv);
  const log = makeLog(opts);
  const options = transcriptionOptions(opts);
  requireModels(env, options);
  const duration = opts.duration ? parseDuration(opts.duration) : null;
  const stopFile = opts['stop-file'] ? path.resolve(opts['stop-file']) : null;
  if (stopFile && fs.existsSync(stopFile)) throw new UsageError(`--stop-file ${stopFile} already exists; remove it first`);
  const store = opts.save === false ? null : openStore(env);
  const folder = store ? store.resolveFolder(opts.folder, { create: true }) : null;
  const stream = streamer(opts);
  const startedAt = new Date();
  const title = opts.title || `Recording ${startedAt.toLocaleString('sv-SE').slice(0, 16)}`;

  if (opts.mic === 'none' && opts.system === false) throw new UsageError('Nothing to record: --mic none with --no-system');
  const capture = new Capture(env, { mic: opts.mic || 'default', system: opts.system !== false });
  const run = new TranscriptionRun({
    env,
    store,
    note: { title, type: 'recording', folderId: folder?.id },
    options,
    log,
    onEvent: stream || undefined,
  });
  await run.start();

  fs.mkdirSync(env.runDir, { recursive: true });
  const id = run.note?.id ?? `nosave-${process.pid}`;
  const statePath = path.join(env.runDir, `recording-${id}.json`);
  const internalStop = path.join(env.runDir, `recording-${id}.stop`);
  let wav = null;
  if (opts.audio !== false) {
    const wavPath = opts['audio-out'] ? path.resolve(opts['audio-out']) : path.join(env.recordingsDir, `${id}.wav`);
    fs.mkdirSync(path.dirname(wavPath), { recursive: true });
    wav = new WavWriter(wavPath);
  }

  let stopReason = null;
  let resolveStop;
  const stopped = new Promise(r => (resolveStop = r));
  const stop = reason => {
    if (!stopReason) {
      stopReason = reason;
      resolveStop();
    }
  };

  let level = { sum: 0, n: 0 };
  capture.on('data', samples => {
    wav?.write(samples);
    run.feed(samples);
    level.sum += rms(samples);
    level.n++;
  });
  capture.on('warning', m => log(`warning: ${m}`));
  capture.on('error', e => {
    log(`capture error: ${e.message}`);
    stop('error');
  });

  const onSignal = () => stop('signal');
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGBREAK', onSignal);
  const timers = [];
  if (duration) timers.push(setTimeout(() => stop('duration'), duration * 1000));
  timers.push(
    setInterval(() => {
      if (fs.existsSync(internalStop) || (stopFile && fs.existsSync(stopFile))) stop('stop-file');
    }, 250),
  );
  timers.push(
    setInterval(() => {
      const avg = level.n ? level.sum / level.n : 0;
      level = { sum: 0, n: 0 };
      log(`recording ${Math.round(run.fedSeconds)} s, ${run.segments.length} segments, level ${avg.toFixed(3)}`);
    }, 10_000),
  );

  try {
    try {
      await capture.start();
    } catch (err) {
      timers.forEach(t => clearTimeout(t));
      wav?.close();
      store?.close();
      throw await run.fail(err);
    }
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        pid: process.pid,
        noteId: run.note?.id ?? null,
        title,
        startedAt: startedAt.toISOString(),
        audioPath: wav?.file ?? null,
        stopFile,
        duration,
      }),
    );
    log(`recording "${title}"${duration ? ` for ${duration} s` : ''}; stop with "scriptorium stop" or Ctrl+C`);
    await stopped;
    log(`stopping (${stopReason})`);
  } finally {
    timers.forEach(t => clearTimeout(t));
    await capture.stop();
  }

  try {
    const audio = wav?.close() ?? null;
    if (audio) run.attachFile('recording', audio.path, { seconds: audio.seconds, sampleRate: 16000, format: 'wav' });
    log('finishing the transcript');
    const result = await run.finish();
    result.audioPath = audio?.path ?? null;
    result.startedAt = startedAt.toISOString();
    result.stopReason = stopReason;
    deliver(result, opts, { stream, title });
    if (stopReason === 'error') process.exitCode = 1;
  } catch (err) {
    throw await run.fail(err);
  } finally {
    fs.rmSync(statePath, { force: true });
    fs.rmSync(internalStop, { force: true });
    if (stopFile) fs.rmSync(stopFile, { force: true });
    store?.close();
  }
}

async function cmdStop(env, opts) {
  const running = runningRecordings(env);
  let targets = running;
  if (opts.id) targets = running.filter(s => s.noteId === opts.id || String(s.pid) === opts.id);
  else if (!opts.all && running.length > 1)
    throw new UsageError(`${running.length} recordings are running; pass --id <noteId> or --all`);
  if (targets.length === 0) throw new UsageError(opts.id ? `No running recording ${opts.id}` : 'No recording is running');
  for (const t of targets) fs.writeFileSync(t.file.replace(/\.json$/, '.stop'), '');
  if (opts.wait === false) return printJson({ stopping: targets.map(t => t.noteId ?? t.pid) });

  const timeout = (opts.timeout ? parseDuration(opts.timeout) : 600) * 1000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && targets.some(t => fs.existsSync(t.file) && alive(t.pid))) {
    await new Promise(r => setTimeout(r, 300));
  }
  const pending = targets.filter(t => fs.existsSync(t.file) && alive(t.pid));
  if (pending.length) throw new Error(`Still finalizing after ${timeout / 1000} s: ${pending.map(p => p.noteId).join(', ')}`);

  const store = openStore(env);
  try {
    const notes = targets.map(t => {
      if (!t.noteId) return { pid: t.pid, saved: false };
      const note = store.getNote(t.noteId);
      const transcript = store.getTranscript(t.noteId);
      const segments = transcript ? fromAltEntries(JSON.parse(transcript.content_text || '[]')) : [];
      return { noteId: note.id, title: note.title, status: note.status, segmentCount: segments.length, audioPath: t.audioPath };
    });
    printJson(notes.length === 1 ? notes[0] : notes);
  } finally {
    store.close();
  }
}

function cmdStatus(env) {
  const running = runningRecordings(env).map(({ file, ...s }) => ({
    ...s,
    elapsedSeconds: Math.round((Date.now() - Date.parse(s.startedAt)) / 1000),
  }));
  printJson({ recording: running.length > 0, recordings: running });
}

// ---- notes / folders / speakers ------------------------------------------------

function noteView(store, id) {
  const note = store.getNote(id);
  const components = store.getComponents(id);
  const transcript = components.find(c => c.component_type === 'transcript');
  const segments = transcript ? fromAltEntries(JSON.parse(transcript.content_text || '[]')) : [];
  return {
    note,
    speakerNames: transcript?.metadata?.speakerNames ?? {},
    files: components.filter(c => c.file_path).map(c => ({ type: c.component_type, path: c.file_path, ...c.metadata })),
    segments,
  };
}

function cmdNotes(env, opts, [sub, ...rest]) {
  const store = openStore(env);
  try {
    switch (sub) {
      case 'list': {
        const folderId = opts.folder === undefined ? undefined : store.resolveFolder(opts.folder)?.id ?? null;
        return printJson(store.listNotes({ folderId, search: opts.search, limit: opts.limit ? Number(opts.limit) : 50 }));
      }
      case 'show':
      case 'export': {
        if (!rest[0]) throw new UsageError(`notes ${sub} needs a note id`);
        const view = noteView(store, rest[0]);
        if (sub === 'export' && !opts.out) throw new UsageError('notes export needs --out <file>');
        const fmt = formatFor(opts, opts.out);
        const text = render(view.segments, fmt, { speakerNames: view.speakerNames, title: view.note.title });
        if (opts.out) {
          fs.writeFileSync(opts.out, text);
          return printJson({ saved: path.resolve(opts.out), format: fmt, segments: view.segments.length });
        }
        if (opts.format) return process.stdout.write(text);
        return printJson(view);
      }
      case 'rename':
        if (!rest[0] || rest[1] === undefined) throw new UsageError('notes rename <noteId> <title>');
        return printJson(store.updateNote(rest[0], { title: rest[1] }));
      case 'move': {
        if (!rest[0] || rest[1] === undefined) throw new UsageError('notes move <noteId> <folder|null>');
        const folder = store.resolveFolder(rest[1]);
        return printJson(store.updateNote(rest[0], { folder_id: folder?.id ?? null }));
      }
      case 'delete': {
        if (!rest[0]) throw new UsageError('notes delete <noteId>');
        const files = store.deleteNote(rest[0]);
        // Only remove recordings scriptorium itself made inside its data folder.
        const removed = opts['keep-audio']
          ? []
          : files.filter(f => path.resolve(f).startsWith(env.recordingsDir + path.sep) && fs.existsSync(f));
        removed.forEach(f => fs.rmSync(f, { force: true }));
        return printJson({ deleted: rest[0], removedFiles: removed });
      }
      default:
        throw new UsageError('notes list|show|export|rename|move|delete');
    }
  } finally {
    store.close();
  }
}

function cmdFolders(env, opts, [sub, ...rest]) {
  const store = openStore(env);
  try {
    switch (sub) {
      case 'list':
        return printJson(store.listFolders());
      case 'create':
        if (!rest[0]) throw new UsageError('folders create <name>');
        return printJson(store.createFolder(rest[0], opts.parent || null));
      case 'delete':
        if (!rest[0]) throw new UsageError('folders delete <id>');
        store.deleteFolder(store.resolveFolder(rest[0]).id);
        return printJson({ deleted: rest[0] });
      default:
        throw new UsageError('folders list|create|delete');
    }
  } finally {
    store.close();
  }
}

function cmdSpeakers(env, opts, [sub, noteId, speaker, name]) {
  if (sub !== 'rename' || !noteId || !speaker || name === undefined)
    throw new UsageError('speakers rename <noteId> <SPEAKER_00> <name>');
  const store = openStore(env);
  try {
    const t = store.getTranscript(noteId);
    if (!t) throw new UsageError(`Note ${noteId} has no transcript`);
    const speakerNames = { ...(t.metadata?.speakerNames || {}), [speaker]: name };
    store.updateComponent(t.id, { metadata: { ...(t.metadata || {}), speakerNames } });
    printJson({ noteId, speakerNames });
  } finally {
    store.close();
  }
}

// ---- setup -------------------------------------------------------------------

function cmdDevices(env) {
  printJson({ audio: listDevices(env) });
}

function cmdDoctor(env) {
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
    audio,
    speechModules: speech,
    checks,
  });
  if (!ok) process.exitCode = 1;
}

// ---- main ----------------------------------------------------------------------

const COMMANDS = {
  transcribe: { values: TRANSCRIBE_VALUES, booleans: TRANSCRIBE_BOOLEANS },
  record: {
    values: [...TRANSCRIBE_VALUES, 'duration', 'mic', 'stop-file', 'audio-out'],
    booleans: [...TRANSCRIBE_BOOLEANS, 'system', 'audio', 'detach'],
  },
  stop: { values: ['id', 'timeout'], booleans: ['wait', 'all'] },
  status: {},
  notes: { values: ['folder', 'search', 'limit', 'format', 'out'], booleans: ['keep-audio'] },
  folders: { values: ['parent'] },
  speakers: {},
  devices: {},
  doctor: {},
  'setup-claude': { values: ['config'], booleans: ['remove', 'dry-run'] },
  mcp: {},
};

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'version' || command === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  try {
    const spec = COMMANDS[command];
    if (!spec) throw new UsageError(`Unknown command "${command}"`);
    const { opts, positionals } = parseArgs(rest, {
      values: [...GLOBAL_VALUES, ...(spec.values || [])],
      booleans: [...GLOBAL_BOOLEANS, ...(spec.booleans || [])],
    });
    if (opts.help) {
      process.stdout.write(HELP);
      return;
    }
    const env = resolveEnv(opts);
    switch (command) {
      case 'transcribe':
        await cmdTranscribe(env, opts, positionals);
        break;
      case 'record':
        await cmdRecord(env, opts, rest);
        break;
      case 'stop':
        await cmdStop(env, opts);
        break;
      case 'status':
        cmdStatus(env);
        break;
      case 'notes':
        cmdNotes(env, opts, positionals);
        break;
      case 'folders':
        cmdFolders(env, opts, positionals);
        break;
      case 'speakers':
        cmdSpeakers(env, opts, positionals);
        break;
      case 'devices':
        cmdDevices(env);
        break;
      case 'doctor':
        cmdDoctor(env);
        break;
      case 'setup-claude':
        printJson(require('./claude').setupClaude(env, { configPath: opts.config, remove: opts.remove, dryRun: opts['dry-run'] }));
        break;
      case 'mcp':
        await require('./mcp').serve(opts);
        break;
    }
  } catch (err) {
    const usage = err instanceof UsageError;
    process.stderr.write(`scriptorium: ${err.message}\n${usage ? 'Run "scriptorium help" for usage.\n' : ''}`);
    process.exitCode = usage ? 2 : 1;
  }
}

module.exports = { main };
