'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, parseDuration } = require('../src/args');
const { toAltEntries, fromAltEntries, render, clock } = require('../src/format');
const { WavWriter } = require('../src/audio');
const { Store } = require('../src/store');

test('parseArgs handles values, flags, negations and positionals', () => {
  const { opts, positionals } = parseArgs(['a.mp3', '--lang', 'ko', '--no-diarize', '--title=제목 x', 'b.wav', '--stream'], {
    values: ['lang', 'title'],
    booleans: ['diarize', 'stream'],
  });
  assert.deepEqual(opts, { lang: 'ko', diarize: false, title: '제목 x', stream: true });
  assert.deepEqual(positionals, ['a.mp3', 'b.wav']);
  assert.throws(() => parseArgs(['--nope'], {}), /Unknown option/);
  assert.throws(() => parseArgs(['--lang'], { values: ['lang'] }), /needs a value/);
});

test('parseDuration', () => {
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('15m'), 900);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('1:02:03'), 3723);
  assert.throws(() => parseDuration('soon'));
});

test('segments round-trip through Alt transcript entries', () => {
  const flat = [
    { start: 0, end: 1500, speaker: 'SPEAKER_00', text: '안녕' },
    { start: 3500, end: 3750, speaker: 'SPEAKER_01', text: 'hi' },
    { start: 4000, end: 4500, text: 'no speaker' },
  ];
  const entries = toAltEntries(flat);
  assert.equal(entries[0].speaker, 'SPEAKER_00');
  assert.equal(entries[2].speaker, undefined);
  assert.deepEqual(fromAltEntries(entries), flat.map(s => ({ ...s, speaker: s.speaker })));
});

test('old Alt entries end at the next entry', () => {
  const flat = fromAltEntries([
    { originalText: 'a', relativeStart: 0 },
    { originalText: 'b', relativeStart: 2000 },
  ]);
  assert.equal(flat[0].end, 2000);
});

test('renderers', () => {
  const segs = [{ start: 3723004, end: 3725000, speaker: 'SPEAKER_00', text: '문장' }];
  assert.equal(clock(3723004, ','), '01:02:03,004');
  assert.match(render(segs, 'srt', { speakerNames: { SPEAKER_00: '김' } }), /^1\n01:02:03,004 --> 01:02:05,000\n\[김\] 문장\n/);
  assert.match(render(segs, 'vtt'), /^WEBVTT\n\n01:02:03\.004 --> 01:02:05\.000\n<v SPEAKER_00>문장/);
  assert.equal(render(segs, 'txt'), '문장\n');
  assert.match(render(segs, 'md', { title: 'T' }), /^# T\n\n\*\*SPEAKER_00\*\* \(1:02:03\)\n문장/);
});

test('WavWriter writes a valid header', () => {
  const file = path.join(os.tmpdir(), `scriptorium-test-${process.pid}.wav`);
  const w = new WavWriter(file);
  w.write(new Float32Array(16000).fill(0.5));
  assert.equal(w.close().seconds, 1);
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.readUInt32LE(40), 32000);
  assert.equal(buf.readInt16LE(44), Math.round(0.5 * 0x7fff));
  fs.rmSync(file);
});

test('Store keeps notes, transcripts and search', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-store-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const note = store.createNote({ title: 'OS', type: 'file' });
  assert.equal('folder_id' in note, false, 'folders are gone from what notes look like');
  const t = store.addComponent({ noteId: note.id, type: 'transcript', title: 'Transcript', contentText: '[]', metadata: { speakerNames: {} } });
  store.updateComponent(t.id, { contentText: JSON.stringify(toAltEntries([{ start: 0, end: 1, text: '스케줄링' }])) });
  assert.equal(store.listNotes({ search: '스케줄링' }).length, 1);
  assert.equal(store.listNotes().length, 1);
  store.updateNote(note.id, { title: '운영체제' });
  assert.equal(store.getNote(note.id).title, '운영체제');
  store.deleteNote(note.id);
  assert.throws(() => store.getNote(note.id), /No note/);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('app command reports a missing tray app instead of failing silently', () => {
  const { spawnSync } = require('node:child_process');
  const missing = path.join(os.tmpdir(), `scriptorium-no-app-${process.pid}.exe`);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'scriptorium.js'), 'app'], {
    env: { ...process.env, SCRIPTORIUM_APP: missing },
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tray app is missing/);
  assert.match(r.stderr, /scripts\\build-app\.cmd/);
});

test('resolveEnv points at the tray app', () => {
  const { resolveEnv } = require('../src/env');
  assert.equal(path.basename(resolveEnv().appExe), 'Scriptorium.exe');
});

test('activity files: transcribe state is written whole and removed, finished notices are safe names', () => {
  const { writeFinished, TranscribeState } = require('../src/activity');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-run-'));
  const env = { runDir: path.join(dir, 'run') };

  const state = new TranscribeState(env, { count: 2 });
  state.update({ index: 1, title: '3주차', phase: 'transcribing', totalSeconds: 100, doneSeconds: 40 });
  const written = JSON.parse(fs.readFileSync(state.file, 'utf8'));
  assert.equal(written.kind, 'transcribe');
  assert.equal(written.pid, process.pid);
  assert.equal(written.count, 2);
  assert.equal(written.doneSeconds, 40);
  assert.deepEqual(fs.readdirSync(env.runDir).filter(f => f.endsWith('.tmp')), []);
  state.close();
  assert.equal(fs.existsSync(state.file), false);

  writeFinished(env, { kind: 'recording', id: 'a/b:c', title: '회의', ok: false, error: 'x'.repeat(900) });
  const files = fs.readdirSync(env.runDir);
  assert.deepEqual(files, ['finished-recording-a_b_c.json']);
  const notice = JSON.parse(fs.readFileSync(path.join(env.runDir, files[0]), 'utf8'));
  assert.equal(notice.ok, false);
  assert.equal(notice.error.length, 500);
  assert.equal(notice.title, '회의');

  // never throws, even when the folder cannot be written
  writeFinished({ runDir: path.join(dir, 'run', files[0]) }, { kind: 'transcribe', id: 1, title: 't', ok: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonAtomic waits out a reader that holds the file open (Windows rename EPERM)', async () => {
  const { spawn } = require('node:child_process');
  const { writeJsonAtomic } = require('../src/activity');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-atomic-'));
  const file = path.join(dir, 'recording-x.json');
  fs.writeFileSync(file, '{"v":0}');
  // another process opens the file (as the tray app does every second) and keeps it for 300 ms
  const holder = spawn(process.execPath, [
    '-e',
    `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(file)},'r');process.stdout.write('open');setTimeout(()=>fs.closeSync(fd),300);`,
  ]);
  await new Promise(r => holder.stdout.once('data', r));
  writeJsonAtomic(file, { v: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 });
  assert.deepEqual(fs.readdirSync(dir), ['recording-x.json']);
  await new Promise(r => holder.once('exit', r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('record --detach rejects a bad option before starting anything', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-detach-'));
  const cli = path.join(__dirname, '..', 'bin', 'scriptorium.js');
  const run = (...args) => spawnSync(process.execPath, [cli, 'record', '--detach', '--data-dir', dir, ...args], { encoding: 'utf8' });
  let r = run('--duration', 'soon');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /soon/);
  r = run('--mic', 'none', '--no-system');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Nothing to record/);
  assert.equal(fs.existsSync(path.join(dir, 'run')), false, 'no recorder was started');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keepTrayApp starts the app only while it is not running, and stops checking when asked', async () => {
  const { keepTrayApp, trayAppRunning } = require('../src/tray');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-tray-'));
  const env = { runDir: path.join(dir, 'run'), dataDir: dir, appExe: process.execPath };
  fs.mkdirSync(env.runDir);
  const saved = process.env.SCRIPTORIUM_NO_GUI;
  delete process.env.SCRIPTORIUM_NO_GUI;
  try {
    assert.equal(trayAppRunning(env), false);
    fs.writeFileSync(path.join(env.runDir, 'app.json'), JSON.stringify({ pid: process.pid }));
    assert.equal(trayAppRunning(env), true);
    fs.writeFileSync(path.join(env.runDir, 'app.json'), JSON.stringify({ pid: 2 ** 31 - 2 }));
    assert.equal(trayAppRunning(env), false, 'a dead pid is not a running app');

    let launches = 0;
    let up = false;
    const stop = keepTrayApp(env, { launch: () => launches++, running: () => up, intervalMs: 20 });
    assert.equal(launches, 1, 'checks at once');
    up = true;
    await new Promise(r => setTimeout(r, 70));
    assert.equal(launches, 1, 'no launch while the app runs');
    up = false;
    await new Promise(r => setTimeout(r, 70));
    assert.ok(launches >= 2, 'relaunched after the app went away');
    stop();
    const after = launches;
    await new Promise(r => setTimeout(r, 70));
    assert.equal(launches, after, 'stopped');

    process.env.SCRIPTORIUM_NO_GUI = '1';
    let off = 0;
    keepTrayApp(env, { launch: () => off++, running: () => false, intervalMs: 20 })();
    assert.equal(off, 0, 'SCRIPTORIUM_NO_GUI=1 turns it off');
  } finally {
    if (saved === undefined) delete process.env.SCRIPTORIUM_NO_GUI;
    else process.env.SCRIPTORIUM_NO_GUI = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
