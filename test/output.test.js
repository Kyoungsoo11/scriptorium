'use strict';
// Recording files named after their title, the "(mm:ss)" transcript, pause/resume, and the
// transcript file being rewritten when a speaker is named.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { safeFileName, defaultTitle, recordingPaths, checkNames, takenNames, isOwnFile, NAME_TAKEN_EXIT } = require('../src/output');
const { render, toAltEntries } = require('../src/format');
const { Store } = require('../src/store');

const CLI = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const cli = (args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, SCRIPTORIUM_NO_GUI: '1', ...env } });

test('titles become safe Windows file names', () => {
  assert.equal(safeFileName('알고리즘 1주차'), '알고리즘 1주차');
  assert.equal(safeFileName('a:b/c?*"<>|'), 'a_b_c______');
  assert.equal(safeFileName('  끝에 점.  '), '끝에 점');
  assert.equal(safeFileName('CON'), '_CON');
  assert.equal(safeFileName('nul.txt'), '_nul.txt');
  assert.equal(safeFileName('\u0001\u0002'), 'Recording');
  assert.equal([...safeFileName('가'.repeat(300))].length, 120);
  assert.equal(defaultTitle(new Date(2026, 10, 23, 9, 5)), '2026-11-23 09-05');
});

test('recording paths: title in the output folder, or next to --audio-out', () => {
  const p = recordingPaths({ dir: 'C:\\out', title: 'a:b' });
  assert.equal(p.wav, path.join('C:\\out', 'a_b.wav'));
  assert.equal(p.txt, path.join('C:\\out', 'a_b.txt'));
  const q = recordingPaths({ dir: 'C:\\out', title: 'x', audioOut: 'D:\\rec\\lec.WAV' });
  assert.equal(q.wav, path.resolve('D:\\rec\\lec.WAV'));
  assert.equal(q.txt, path.resolve('D:\\rec\\lec.txt'));
  assert.equal(recordingPaths({ dir: 'C:\\out', title: 'x', audio: false }).wav, null);
});

test('timed transcript: "(mm:ss)" then the sentence; speakers only when two or more', () => {
  const one = [
    { start: 0, end: 5000, speaker: 'SPEAKER_00', text: '먼저 개념 정리를 해보고' },
    { start: 6400, end: 9000, speaker: 'SPEAKER_00', text: ' 그리고 성능 분석 ' },
  ];
  assert.equal(render(one, 'timed'), '(00:00)\n먼저 개념 정리를 해보고\n\n(00:06)\n그리고 성능 분석\n');
  const two = [...one, { start: 3723000, end: 3724000, speaker: 'SPEAKER_01', text: '질문' }];
  assert.equal(
    render(two, 'timed', { speakerNames: { SPEAKER_00: '교수' } }),
    '(00:00) 교수\n먼저 개념 정리를 해보고\n\n(00:06) 교수\n그리고 성능 분석\n\n(1:02:03) SPEAKER_01\n질문\n',
  );
  assert.equal(render([], 'timed'), '');
});

test('a taken name stops a recording unless overwriting; a running recording can never be overwritten', () => {
  const dir = tmp('scriptorium-names-');
  const paths = recordingPaths({ dir, title: '회의' });
  assert.doesNotThrow(() => checkNames(paths, []));
  fs.writeFileSync(paths.txt, 'old');
  assert.throws(() => checkNames(paths, []), e => e.exitCode === NAME_TAKEN_EXIT && /회의/.test(e.message));
  assert.doesNotThrow(() => checkNames(paths, [], { overwrite: true }));
  const running = [{ audioPath: paths.wav.toUpperCase(), textPath: null }];
  assert.match(takenNames(paths, running).join(), /being recorded now/);
  assert.throws(() => checkNames(paths, running, { overwrite: true }), /being recorded now/);
  assert.equal(isOwnFile(paths.txt, [dir]), true);
  assert.equal(isOwnFile(path.join(os.tmpdir(), 'x.txt'), [dir]), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('record exits with code 3 before starting anything when the title is taken', () => {
  const data = tmp('scriptorium-data-');
  const out = tmp('scriptorium-out-');
  fs.writeFileSync(path.join(out, '1주차.wav'), '');
  for (const extra of [[], ['--detach']]) {
    const r = cli(['record', ...extra, '--title', '1주차', '--data-dir', data], { SCRIPTORIUM_OUTPUT: out });
    assert.equal(r.status, NAME_TAKEN_EXIT, r.stderr);
    assert.match(r.stderr, /"1주차" already exists/);
    assert.equal(fs.existsSync(path.join(data, 'run')), false, 'no recorder was started');
  }
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('transcribe checks every transcript name before starting, with the same exit code 3', () => {
  const data = tmp('scriptorium-data-');
  const out = tmp('scriptorium-out-');
  const a = path.join(data, '강의.m4a');
  const b = path.join(data, '회의.m4a');
  fs.writeFileSync(a, '');
  fs.writeFileSync(b, '');
  fs.writeFileSync(path.join(out, '회의.txt'), 'old');
  const r = cli(['transcribe', a, b, '--data-dir', data], { SCRIPTORIUM_OUTPUT: out });
  assert.equal(r.status, NAME_TAKEN_EXIT, r.stderr);
  assert.match(r.stderr, /"회의" already exists/);
  assert.equal(fs.existsSync(path.join(out, '강의.txt')), false, 'nothing started');
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('a run writes its transcript file on every save, and removes it when nothing was transcribed', async () => {
  const { TranscriptionRun } = require('../src/transcriber');
  const dir = tmp('scriptorium-run-');
  const txt = path.join(dir, 't.txt');
  const run = new TranscriptionRun({ env: {}, store: null, note: { title: 't', type: 'recording' }, options: {}, log: () => {}, textPath: txt });
  run.segments = [{ start: 61000, end: 62000, text: '중간 저장' }];
  run.save();
  assert.equal(fs.readFileSync(txt, 'utf8'), '(01:01)\n중간 저장\n');
  run.segments = [];
  await run.fail(new Error('x'));
  assert.equal(fs.existsSync(txt), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('segments over digital silence are dropped, speech is kept', () => {
  const { mapSegments, quietShare, SR } = require('../src/speech');
  const audio = new Float32Array(SR * 4);
  for (let i = 0; i < SR * 2; i++) audio[i] = 0.1 * Math.sin(i / 5);  // 0-2 s: sound, 2-4 s: silence
  assert.equal(quietShare(audio, 0, 2000), 0);
  assert.equal(quietShare(audio, 2000, 4000), 1);
  const pieces = [{ chunkStart: 0, origStart: 0, length: audio.length }];
  const reply = { segments: [{ start: 0, end: 2000, text: '실제 말' }, { start: 2100, end: 3900, text: '감사합니다.' }] };
  assert.deepEqual(mapSegments(reply, pieces, audio).map(s => s.text), ['실제 말']);
  assert.equal(mapSegments(reply, pieces).length, 2, 'without audio nothing changes');
});

test('whisper threads are shared with the work already running', () => {
  const { autoThreads } = require('../src/commands/common');
  const data = tmp('scriptorium-data-');
  const run = path.join(data, 'run');
  fs.mkdirSync(run);
  const env = { runDir: run };
  assert.equal(autoThreads(env, 16), 16);
  // two live recorders (this process stands in for both)
  for (const id of ['a', 'b']) fs.writeFileSync(path.join(run, `recording-${id}.json`), JSON.stringify({ pid: process.pid }));
  assert.equal(autoThreads(env, 16), 5);
  assert.equal(autoThreads(env, 4), 2, 'never below 2');
  fs.rmSync(data, { recursive: true, force: true });
});

test('naming a speaker rewrites the saved transcript file', () => {
  const data = tmp('scriptorium-data-');
  const store = new Store(path.join(data, 'scriptorium.db'));
  const note = store.createNote({ title: '회의', type: 'recording' });
  const segs = [
    { start: 0, end: 1000, speaker: 'SPEAKER_00', text: '안녕하세요' },
    { start: 2000, end: 3000, speaker: 'SPEAKER_01', text: '네' },
  ];
  store.addComponent({ noteId: note.id, type: 'transcript', title: 'Transcript', contentText: JSON.stringify(toAltEntries(segs)), metadata: { speakerNames: {} } });
  const txt = path.join(data, '회의.txt');
  fs.writeFileSync(txt, render(segs, 'timed'));
  store.addComponent({ noteId: note.id, type: 'text', title: 'Recording', filePath: txt, metadata: { format: 'timed' } });
  store.close();

  const r = cli(['speakers', 'rename', note.id, 'SPEAKER_00', '김교수', '--data-dir', data]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).rewritten, [txt]);
  assert.equal(fs.readFileSync(txt, 'utf8'), '(00:00) 김교수\n안녕하세요\n\n(00:02) SPEAKER_01\n네\n');
  fs.rmSync(data, { recursive: true, force: true });
});

test('pause and resume go through recording-<id>.pause and wait for the recorder', async () => {
  const data = tmp('scriptorium-data-');
  const run = path.join(data, 'run');
  fs.mkdirSync(run);
  const state = path.join(run, 'recording-n1.json');
  // A stand-in recorder: follows its .pause file the way cmdRecord does.
  const fake = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('fs');const [state,pause]=process.argv.slice(1);
       const base={kind:'recording',phase:'recording',pid:process.pid,noteId:'n1',title:'t',
         startedAt:new Date(Date.now()-60000).toISOString(),pausedMs:0};
       const write=p=>fs.writeFileSync(state,JSON.stringify({...base,paused:p,pausedAt:p?new Date().toISOString():null}));
       write(false);setInterval(()=>write(fs.existsSync(pause)),100);`,
      state,
      state.replace(/\.json$/, '.pause'),
    ],
    { stdio: 'ignore' },
  );
  try {
    while (!fs.existsSync(state)) await new Promise(r => setTimeout(r, 50));
    const paused = cli(['pause', '--data-dir', data]);
    assert.equal(paused.status, 0, paused.stderr);
    assert.equal(JSON.parse(paused.stdout).paused, true);
    assert.equal(fs.existsSync(path.join(run, 'recording-n1.pause')), true);
    const status = JSON.parse(cli(['status', '--data-dir', data]).stdout);
    assert.ok(Math.abs(status.recordings[0].recordedSeconds - 60) <= 2);
    const resumed = cli(['resume', '--id', 'n1', '--data-dir', data]);
    assert.equal(JSON.parse(resumed.stdout).paused, false);
    assert.equal(fs.existsSync(path.join(run, 'recording-n1.pause')), false);
    assert.equal(cli(['pause', '--id', 'nope', '--data-dir', data]).status, 2);
  } finally {
    fake.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
