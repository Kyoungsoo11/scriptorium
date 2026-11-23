'use strict';
// `record`, `stop`, `pause`, `resume`, `status`: live recordings. A recording runs in one process
// that keeps <data>\run\recording-<id>.json up to date; the other commands, the tray app and MCP
// act on it through files next to it (.stop, .pause). See src/activity.js.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { UsageError } = require('../store');
const { parseDuration } = require('../args');
const { WavWriter, rms } = require('../audio');
const { Capture } = require('../native');
const { TranscriptionRun } = require('../transcriber');
const { fromAltEntries } = require('../format');
const { writeJsonAtomic, writeFinished } = require('../activity');
const { outputDir, recordingPaths, checkNames, takenNames, defaultTitle } = require('../output');
const {
  makeLog,
  printJson,
  openStore,
  withStore,
  alive,
  stateFiles,
  runningRecordings,
  busyFiles,
  transcriptionOptions,
  requireModels,
  deliver,
  streamer,
} = require('./common');

const CLI = path.join(__dirname, '..', '..', 'bin', 'scriptorium.js');

/** Seconds actually recorded so far (pauses left out), from a recording's state file. */
function recordedSeconds(s, now = Date.now()) {
  const paused = (s.pausedMs || 0) + (s.paused && s.pausedAt ? now - Date.parse(s.pausedAt) : 0);
  return Math.max(0, Math.round((now - Date.parse(s.startedAt) - paused) / 1000));
}

/**
 * Title and file paths of a new recording. A given --title must be free (or --overwrite); the
 * default title (the start time) takes the next free "title (2)", "title (3)", ...
 */
function recordingTarget(env, opts, startedAt) {
  const dir = outputDir(opts);
  const running = busyFiles(env);
  const make = title => {
    const paths = recordingPaths({ dir, title, audioOut: opts['audio-out'], audio: opts.audio !== false });
    if (opts.text === false) paths.txt = null;
    return { title, paths };
  };
  if (opts.title || opts['audio-out']) {
    const target = make(opts.title || path.parse(opts['audio-out']).name);
    checkNames(target.paths, running, { overwrite: opts.overwrite });
    return target;
  }
  const base = defaultTitle(startedAt);
  for (let n = 1; ; n++) {
    const target = make(n === 1 ? base : `${base} (${n})`);
    if (!takenNames(target.paths, running).length) return target;
  }
}

/** The running recordings `stop`/`pause`/`resume` act on: id, all, or the only one. */
function pickRecordings(running, { id, all } = {}, verb) {
  if (id) {
    const found = running.filter(s => s.noteId === id || String(s.pid) === id);
    if (!found.length) throw new UsageError(`No running recording ${id}`);
    return found;
  }
  if (!running.length) throw new UsageError('No recording is running');
  if (!all && running.length > 1)
    throw new UsageError(`${running.length} recordings are running; pass --id <noteId> or --all to ${verb}`);
  return running;
}

/** Pauses or resumes recordings (the recorder polls recording-<id>.pause every 250 ms) and waits for them. */
async function setPaused(env, { id, all } = {}, pause) {
  const targets = pickRecordings(runningRecordings(env), { id, all }, pause ? 'pause' : 'resume');
  for (const t of targets) {
    const file = t.file.replace(/\.json$/, '.pause');
    if (pause) fs.writeFileSync(file, '');
    else fs.rmSync(file, { force: true });
  }
  const deadline = Date.now() + 3000;
  let states = targets;
  while (Date.now() < deadline) {
    states = targets.map(t => stateFiles(env).find(s => s.file === t.file) ?? t);
    if (states.every(s => Boolean(s.paused) === pause || !alive(s.pid))) break;
    await new Promise(r => setTimeout(r, 150));
  }
  const out = states.map(s => ({ noteId: s.noteId, title: s.title, paused: Boolean(s.paused), recordedSeconds: recordedSeconds(s) }));
  return out.length === 1 ? out[0] : out;
}

/**
 * Stops recordings and waits for their transcripts. Resolves with { done, pending }: pending
 * lists the ones still finishing when timeoutMs ran out (0 = do not wait).
 */
async function stopRecordings(env, { id, all } = {}, timeoutMs = 600_000) {
  const targets = pickRecordings(runningRecordings(env), { id, all }, 'stop');
  for (const t of targets) fs.writeFileSync(t.file.replace(/\.json$/, '.stop'), '');
  if (!timeoutMs) return { stopping: targets.map(t => t.noteId ?? t.pid) };
  const deadline = Date.now() + timeoutMs;
  const busy = t => fs.existsSync(t.file) && alive(t.pid);
  while (Date.now() < deadline && targets.some(busy)) await new Promise(r => setTimeout(r, 300));
  const pending = targets.filter(busy);
  const done = withStore(env, store =>
    targets
      .filter(t => !pending.includes(t))
      .map(t => {
        if (!t.noteId) return { pid: t.pid, saved: false, textPath: t.textPath ?? null };
        const note = store.getNote(t.noteId);
        const transcript = store.getTranscript(t.noteId);
        const segments = transcript ? fromAltEntries(JSON.parse(transcript.content_text || '[]')) : [];
        return {
          noteId: note.id,
          title: note.title,
          status: note.status,
          segmentCount: segments.length,
          audioPath: t.audioPath,
          textPath: t.textPath ?? null,
        };
      }),
  );
  return { done, pending: pending.map(p => p.noteId ?? p.pid) };
}

/** What `status` prints: running recordings with their recorded time. */
function recordingStatus(env) {
  const recordings = runningRecordings(env).map(({ file, ...s }) => ({
    ...s,
    elapsedSeconds: Math.round((Date.now() - Date.parse(s.startedAt)) / 1000),
    recordedSeconds: recordedSeconds(s),
  }));
  return { recording: recordings.length > 0, recordings };
}

async function cmdStop(env, opts) {
  const timeout = opts.wait === false ? 0 : (opts.timeout ? parseDuration(opts.timeout) : 600) * 1000;
  const r = await stopRecordings(env, opts, timeout);
  if (r.stopping) return printJson(r);
  if (r.pending.length) throw new Error(`Still finalizing after ${timeout / 1000} s: ${r.pending.join(', ')}`);
  printJson(r.done.length === 1 ? r.done[0] : r.done);
}

async function cmdRecordDetached(env, opts, argv) {
  // Check the options here, so a mistake is reported directly instead of as "did not start".
  const options = transcriptionOptions(opts);
  if (opts.duration) {
    try {
      parseDuration(opts.duration);
    } catch (e) {
      throw new UsageError(e.message);
    }
  }
  if (opts.mic === 'none' && opts.system === false) throw new UsageError('Nothing to record: --mic none with --no-system');
  // A taken name is reported here (exit 3), not as "the recorder did not start".
  recordingTarget(env, opts, new Date());
  requireModels(env, options);
  fs.mkdirSync(env.runDir, { recursive: true });
  const logFile = opts['log-file'] ? path.resolve(opts['log-file']) : path.join(env.runDir, `record-${Date.now()}.log`);
  const args = ['record', ...argv.filter(a => a !== '--detach' && a !== '--stream')];
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [CLI, ...args], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
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
  // The recorder's own error line, when it wrote one, says more than "did not start".
  let reason = '';
  try {
    const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(l => l.startsWith('scriptorium: '));
    if (lines.length) reason = `: ${lines[lines.length - 1].slice('scriptorium: '.length)}`;
  } catch {
    // no log
  }
  throw new Error(`The background recorder did not start${reason} (log: ${logFile})`);
}

const MUTED_WARNING =
  'The microphone is muted in Windows, so it records silence. Unmute it (mic mute key, or Settings > System > Sound > Input).';
// A muted speaker is not reported at all: WASAPI loopback still receives the audio (checked on Realtek),
// and a systemMuted flag only made agents warn about a problem that does not exist.
const SILENT_WARNING =
  'The microphone has sent pure digital silence for 10 s: it is muted (mute key or switch) or blocked. Nothing it hears is being recorded.';

/** Human-readable problems for a recording's mute / silence state. */
function audioWarnings(a) {
  const w = [];
  if (a.microphoneMuted) w.push(MUTED_WARNING);
  else if (a.microphoneSilent) w.push(SILENT_WARNING);
  return w;
}

async function cmdRecord(env, opts, argv) {
  if (opts.detach) return cmdRecordDetached(env, opts, argv);
  const log = makeLog(opts);
  const options = transcriptionOptions(opts, env);
  requireModels(env, options);
  const duration = opts.duration ? parseDuration(opts.duration) : null;
  if (opts.mic === 'none' && opts.system === false) throw new UsageError('Nothing to record: --mic none with --no-system');
  const startedAt = new Date();
  // Checked before anything starts, so a taken name costs nothing; the empty .txt then holds the
  // name while the recognizer loads (another recording with this title sees it).
  const { title, paths } = recordingTarget(env, opts, startedAt);
  for (const p of [paths.wav, paths.txt].filter(Boolean)) fs.mkdirSync(path.dirname(p), { recursive: true });
  if (paths.txt) fs.writeFileSync(paths.txt, '');
  const store = opts.save === false ? null : openStore(env);
  const stream = streamer(opts);

  const capture = new Capture(env, { mic: opts.mic || 'default', system: opts.system !== false });
  const run = new TranscriptionRun({
    env,
    store,
    note: { title, type: 'recording' },
    options,
    log,
    onEvent: stream || undefined,
    textPath: paths.txt,
  });
  try {
    await run.start();
  } catch (err) {
    store?.close();
    throw await run.fail(err);
  }

  fs.mkdirSync(env.runDir, { recursive: true });
  const id = run.note?.id ?? `nosave-${process.pid}`;
  const statePath = path.join(env.runDir, `recording-${id}.json`);
  const stopFile = path.join(env.runDir, `recording-${id}.stop`);
  const pauseFile = path.join(env.runDir, `recording-${id}.pause`);
  fs.rmSync(pauseFile, { force: true });
  const wav = paths.wav ? new WavWriter(paths.wav) : null;
  if (paths.txt) run.attachFile('text', paths.txt, { format: 'timed' });

  let stopReason = null;
  let resolveStop;
  const stopped = new Promise(r => (resolveStop = r));
  const stop = reason => {
    if (!stopReason) {
      stopReason = reason;
      resolveStop();
    }
  };

  // Pausing cuts the paused span out: nothing reaches the wav or the recognizer, so the file and
  // the transcript times count recorded time only.
  let paused = false;
  let pausedAt = null;
  let pausedMs = 0;
  let lastText = '';

  let level = { sum: 0, n: 0 };
  capture.on('data', samples => {
    if (paused) return;
    wav?.write(samples);
    run.feed(samples);
    level.sum += rms(samples);
    level.n++;
  });
  capture.on('warning', m => log(`warning: ${m}`));

  // Mute / digital-silence state, kept in the state file so `status` (and the MCP tools) can show it.
  // The tray app reads this file too; phase turns "finishing" once the recording was told to stop.
  const audioState = { microphoneMuted: null, microphoneSilent: false };
  let stateReady = false;
  let phase = 'recording';
  // Never throws: it runs inside capture event handlers, and a failed status update must not stop
  // the recording (writeJsonAtomic already retries while a reader holds the file).
  const writeState = () => {
    if (!stateReady) return;
    const warnings = audioWarnings(audioState);
    try {
      writeJsonAtomic(statePath, {
        kind: 'recording',
        phase,
        pid: process.pid,
        noteId: run.note?.id ?? null,
        title,
        startedAt: startedAt.toISOString(),
        // recorded time = now - startedAt - pausedMs - (now - pausedAt while paused)
        paused,
        pausedAt: pausedAt ? new Date(pausedAt).toISOString() : null,
        pausedMs,
        audioPath: wav?.file ?? null,
        textPath: paths.txt,
        lastText,
        duration,
        audio: audioState,
        ...(warnings.length ? { warnings } : {}),
      });
    } catch (e) {
      log(`warning: could not update ${statePath}: ${e.message}`);
    }
  };
  const finished = (ok, extra) =>
    writeFinished(env, { kind: 'recording', id, title, ok, noteId: run.note?.id ?? null, ...extra });
  const followPause = want => {
    if (want === paused || phase !== 'recording') return;
    paused = want;
    if (want) pausedAt = Date.now();
    else {
      pausedMs += Date.now() - pausedAt;
      pausedAt = null;
    }
    log(want ? 'paused' : 'resumed');
    writeState();
  };
  capture.on('started', msg => {
    audioState.microphoneMuted = msg.microphoneMuted ?? null;
    for (const w of audioWarnings(audioState)) log(`warning: ${w}`);
  });
  capture.on('audio-state', msg => {
    if (msg.event === 'mute') {
      audioState.microphoneMuted = msg.muted;
      log(`${msg.source} ${msg.muted ? 'muted' : 'unmuted'}`);
    } else if (msg.event === 'silent') {
      audioState.microphoneSilent = msg.silent;
      log(msg.silent ? `warning: ${SILENT_WARNING}` : 'microphone signal is back');
    }
    writeState();
  });
  capture.on('error', e => {
    log(`capture error: ${e.message}`);
    stop('error');
  });

  const onSignal = () => stop('signal');
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGBREAK', onSignal);
  const timers = [];
  timers.push(
    setInterval(() => {
      if (fs.existsSync(stopFile)) stop('stop');
      followPause(fs.existsSync(pauseFile));
      // --duration counts recorded time, so a pause does not eat into it
      if (duration && run.fedSeconds >= duration) stop('duration');
    }, 250),
  );
  timers.push(
    setInterval(() => {
      const last = run.segments[run.segments.length - 1];
      const text = last ? last.text.trim().slice(0, 300) : '';
      if (text !== lastText) {
        lastText = text;
        writeState();
      }
    }, 1000),
  );
  timers.push(
    setInterval(() => {
      const avg = level.n ? level.sum / level.n : 0;
      level = { sum: 0, n: 0 };
      log(`recording ${Math.round(run.fedSeconds)} s${paused ? ' (paused)' : ''}, ${run.segments.length} segments, level ${avg.toFixed(3)}`);
    }, 10_000),
  );

  try {
    try {
      await capture.start();
    } catch (err) {
      timers.forEach(t => clearTimeout(t));
      wav?.close();
      if (wav) fs.rmSync(wav.file, { force: true });  // nothing was recorded
      store?.close();
      finished(false, { error: err.message });
      throw await run.fail(err);
    }
    stateReady = true;
    writeState();
    log(`recording "${title}" (${options.threads ?? 'default'} threads)${duration ? ` for ${duration} s` : ''}; stop with "scriptorium stop" or Ctrl+C`);
    await stopped;
    log(`stopping (${stopReason})`);
    phase = 'finishing';
    writeState();
  } finally {
    timers.forEach(t => clearTimeout(t));
    await capture.stop();
    stateReady = false;
  }

  try {
    const audio = wav?.close() ?? null;
    if (audio) run.attachFile('recording', audio.path, { seconds: audio.seconds, sampleRate: 16000, format: 'wav' });
    log('finishing the transcript');
    const result = await run.finish();
    result.audioPath = audio?.path ?? null;
    result.textPath = paths.txt;
    result.startedAt = startedAt.toISOString();
    result.pausedSeconds = Math.round((pausedMs + (pausedAt ? Date.now() - pausedAt : 0)) / 1000);
    result.stopReason = stopReason;
    deliver(result, opts, { stream, title });
    // A capture error still saves what was recorded, but the notice should say it went wrong.
    finished(stopReason !== 'error', {
      audioPath: result.audioPath,
      textPath: result.textPath,
      ...(stopReason === 'error' ? { error: 'audio capture failed; what was recorded until then is saved' } : {}),
    });
    if (stopReason === 'error') process.exitCode = 1;
  } catch (err) {
    finished(false, { error: err.message });
    throw await run.fail(err);
  } finally {
    fs.rmSync(statePath, { force: true });
    fs.rmSync(stopFile, { force: true });
    fs.rmSync(pauseFile, { force: true });
    store?.close();
  }
}

module.exports = {
  cmdRecord,
  cmdStop,
  recordingStatus,
  setPaused,
  stopRecordings,
  recordedSeconds,
};
