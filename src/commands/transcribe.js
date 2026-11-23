'use strict';
// `transcribe <file>...`: each file becomes a note and a "(mm:ss)" transcript
// Documents\Scriptorium\<title>.txt, written as it goes.

const fs = require('node:fs');
const path = require('node:path');

const { UsageError } = require('../store');
const { decodeFile } = require('../native');
const { TranscriptionRun } = require('../transcriber');
const { writeFinished, TranscribeState } = require('../activity');
const { outputDir, textPathFor, checkNames } = require('../output');
const { makeLog, openStore, transcriptionOptions, requireModels, deliver, streamer, busyFiles } = require('./common');

/** Each file's title and transcript path, all checked before the first one starts. */
function transcribeTargets(env, opts, files) {
  const dir = outputDir(opts);
  const running = busyFiles(env);
  const targets = files.map(file => {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new UsageError(`No such file: ${file}`);
    const title = opts.title || path.parse(abs).name;
    return { abs, title, txt: opts.text === false ? null : textPathFor(dir, title) };
  });
  const seen = new Set();
  for (const t of targets) {
    if (!t.txt) continue;
    const key = t.txt.toLowerCase();
    if (seen.has(key)) throw new UsageError(`Two files would both be saved as ${path.basename(t.txt)}; transcribe them separately with --title`);
    seen.add(key);
    checkNames({ base: t.txt.replace(/\.txt$/i, ''), wav: null, txt: t.txt }, running, { overwrite: opts.overwrite });
  }
  return targets;
}

async function cmdTranscribe(env, opts, files) {
  if (files.length === 0) throw new UsageError('transcribe needs at least one file');
  if (opts.out && files.length > 1) throw new UsageError('--out takes one input file; run once per file');
  if (opts.title && files.length > 1) throw new UsageError('--title takes one input file; run once per file');
  const log = makeLog(opts);
  const options = transcriptionOptions(opts, env);
  requireModels(env, options);
  const targets = transcribeTargets(env, opts, files);
  const store = opts.save === false ? null : openStore(env);
  const stream = streamer(opts);
  const results = [];
  // Shown by the tray app while this runs.
  const activity = new TranscribeState(env, { count: files.length, files: targets.map(t => t.abs) });
  // Ctrl+C or a kill from MCP: leave no state file behind and say the file did not finish.
  let current = null;
  const onSignal = () => {
    activity.close();
    if (current) writeFinished(env, { kind: 'transcribe', ...current, ok: false, error: 'interrupted' });
    process.exit(130);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK'];
  signals.forEach(s => process.on(s, onSignal));
  try {
    for (const [index, { abs, title, txt }] of targets.entries()) {
      current = { id: `${process.pid}-${index}`, title };
      let total = null;
      if (txt) {
        fs.mkdirSync(path.dirname(txt), { recursive: true });
        fs.writeFileSync(txt, '');  // claims the name while it runs
      }
      const run = new TranscriptionRun({
        env,
        store,
        note: { title, type: 'file', sourcePath: abs },
        options,
        log,
        onEvent: stream || undefined,
        textPath: txt,
      });
      const started = Date.now();
      const tick = () =>
        activity.update({ totalSeconds: total, doneSeconds: Math.round(Math.min(run.transcribedSeconds, total ?? Infinity)) });
      activity.update({ index, title, file: abs, textPath: txt, phase: 'transcribing', totalSeconds: null, doneSeconds: 0 });
      const progress = setInterval(() => {
        const sec = run.transcribedSeconds;
        log(`  transcribed ${Math.round(sec)} s${total ? ` / ${Math.round(total)} s (${Math.round((sec / total) * 100)}%)` : ''}`);
      }, 15000);
      const ticker = setInterval(tick, 2000);
      try {
        await run.start();
        await decodeFile(env, abs, {
          onInfo: info => {
            total = info.duration > 0 ? info.duration : null;
            log(`transcribing ${path.basename(abs)}${total ? ` (${Math.round(total)} s)` : ''} on ${run.backend}, ${options.threads ?? 'default'} threads`);
            tick();
          },
          onChunk: chunk => run.feed(chunk),
        });
        clearInterval(ticker);
        activity.update({ phase: 'finishing' });
        const result = await run.finish();
        clearInterval(progress);
        if (txt) run.attachFile('text', txt, { format: 'timed' });
        result.sourcePath = abs;
        result.textPath = txt;
        result.elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
        log(`done: ${result.segments.length} segments, ${result.speakers.length} speakers, ${result.elapsedSeconds} s`);
        deliver(result, opts, { stream, title });
        writeFinished(env, { kind: 'transcribe', ...current, ok: true, noteId: result.noteId, textPath: txt });
        current = null;
        results.push(result);
      } catch (err) {
        clearInterval(progress);
        clearInterval(ticker);
        writeFinished(env, { kind: 'transcribe', ...current, ok: false, noteId: run.note?.id ?? null, error: err.message });
        current = null;
        throw await run.fail(err);
      }
    }
  } finally {
    signals.forEach(s => process.off(s, onSignal));
    activity.close();
    store?.close();
  }
  return results;
}

module.exports = { cmdTranscribe, transcribeTargets };
