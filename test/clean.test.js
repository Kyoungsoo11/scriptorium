'use strict';
// `clean`: empties recordings\ and run\, never what running work uses, never notes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { clean } = require('../src/commands/clean');
const { resolveEnv } = require('../src/env');
const { Store } = require('../src/store');

const CLI = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const DEAD = 2 ** 31 - 2; // no such process
const cli = (...args) => spawnSync(process.execPath, [CLI, 'clean', ...args], { encoding: 'utf8', env: { ...process.env, SCRIPTORIUM_NO_GUI: '1' } });

/** A data folder with files in it: put('run/x.log', text). */
function dataFolder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = name => path.join(dir, ...name.split('/'));
  return {
    dir,
    env: resolveEnv({ 'data-dir': dir }),
    at,
    has: name => fs.existsSync(at(name)),
    put(name, content = 'x') {
      fs.mkdirSync(path.dirname(at(name)), { recursive: true });
      fs.writeFileSync(at(name), typeof content === 'string' ? content : JSON.stringify(content));
      return at(name);
    },
  };
}

/** Another process holding files open, as a recorder holds its .wav and log. */
async function holdOpen(t, ...files) {
  const p = spawn(process.execPath, [
    '-e',
    `const fs=require('fs');for(const f of ${JSON.stringify(files)})fs.openSync(f,'a');process.stdout.write('open');setInterval(()=>{},1000);`,
  ]);
  const exited = new Promise(r => p.once('exit', r));
  t.after(() => p.kill());
  await new Promise(r => p.stdout.once('data', r));
  return {
    pid: p.pid,
    async end() {
      p.kill();
      await exited;
    },
  };
}

test('clean: idle folders are emptied, notes and other files stay', t => {
  const d = dataFolder(t);
  new Store(d.env.dbPath).close();
  d.put('gui.json', '{}');
  d.put('recordings/a.wav', 'x'.repeat(100));
  d.put('recordings/memo.docx');
  d.put('recordings/sub/b.wav');
  d.put('run/record-1.log', 'x'.repeat(50));
  d.put('run/recording-dead.json', { pid: DEAD });
  d.put('run/recording-dead.stop', '');
  d.put('run/recording-gone.pause', '');
  d.put('run/transcribe-1.json', { pid: DEAD });
  d.put('run/finished-recording-a.json', {});
  d.put('run/app.json', { pid: DEAD });
  d.put('run/jobs/0123456789ab.json', { pid: DEAD, file: 'x' });
  d.put('run/jobs/0123456789ab.out');
  d.put('run/jobs/0123456789ab.log');
  d.put('run/mine.txt');

  const r = clean(d.env);
  assert.deepEqual(r.recordings.files, ['a.wav']);
  assert.equal(r.recordings.bytes, 100);
  assert.equal(r.run.count, 10);
  for (const part of [r.recordings, r.run]) {
    assert.deepEqual(part.inUse, []);
    assert.deepEqual(part.failed, []);
  }
  assert.deepEqual(fs.readdirSync(d.at('run')).sort(), ['jobs', 'mine.txt']);
  assert.deepEqual(fs.readdirSync(d.at('run/jobs')), []);
  for (const kept of ['scriptorium.db', 'gui.json', 'recordings/memo.docx', 'recordings/sub/b.wav']) assert.ok(d.has(kept), kept);
});

test('clean: missing folders are fine, and nothing is created', t => {
  const d = dataFolder(t);
  const r = clean(d.env);
  assert.equal(r.recordings.count + r.run.count, 0);
  assert.deepEqual(fs.readdirSync(d.dir), []);
});

test('clean: state, control and wav files of running work stay', t => {
  const d = dataFolder(t);
  // phase "finishing": the wav is closed by now, only the state file names it
  const wav = d.put('recordings/Live.wav');
  d.put('run/recording-live.json', { pid: process.pid, phase: 'finishing', audioPath: wav.toUpperCase() });
  d.put('run/recording-live.stop', '');
  d.put('run/recording-live.pause', '');
  d.put('run/transcribe-2.json', { pid: process.pid, file: d.put('recordings/now.wav'), files: [d.put('recordings/next.wav')] });
  d.put('run/jobs/aaaaaaaaaaaa.json', { pid: process.pid, file: d.put('recordings/job.wav') });
  d.put('run/jobs/aaaaaaaaaaaa.out', '');
  d.put('run/recording-half.json', '{"pid":');
  d.put('run/app.json', { pid: process.pid });
  d.put('run/finished-recording-x.json', {}); // the running app shows and deletes it
  d.put('run/app.json.tmp');
  d.put('recordings/old.wav');
  d.put('run/record-old.log');

  const r = clean(d.env);
  assert.deepEqual(r.recordings.files, ['old.wav']);
  assert.deepEqual(r.run.files, ['record-old.log']);
  assert.deepEqual(r.recordings.inUse.sort(), ['Live.wav', 'job.wav', 'next.wav', 'now.wav'].sort());
  assert.equal(r.run.inUse.length, 9); // not app.json: the running app itself is not work
  for (const name of r.run.inUse) assert.ok(d.has(`run/${name.replaceAll('\\', '/')}`), name);
  assert.ok(d.has('run/app.json'));
  for (const name of r.recordings.inUse) assert.ok(d.has(`recordings/${name}`), name);
});

test('clean: a file another process has open stays (a recorder that is still starting)', async t => {
  const d = dataFolder(t);
  const wav = d.put('recordings/starting.wav');
  const log = d.put('run/record-9.log');
  const out = d.put('run/jobs/bbbbbbbbbbbb.out', '');
  d.put('run/jobs/bbbbbbbbbbbb.log');
  const holder = await holdOpen(t, wav, log, out);

  let r = clean(d.env);
  assert.equal(r.recordings.count + r.run.count, 0);
  assert.deepEqual(r.recordings.inUse, ['starting.wav']);
  assert.equal(r.run.inUse.length, 3);
  assert.ok(d.has('recordings/starting.wav') && d.has('run/record-9.log') && d.has('run/jobs/bbbbbbbbbbbb.log'));

  await holder.end();
  r = clean(d.env);
  assert.equal(r.recordings.count, 1);
  assert.equal(r.run.count, 3);
});

test('clean command: no target only shows, a target deletes just that folder', t => {
  const d = dataFolder(t);
  d.put('recordings/a.wav');
  d.put('run/record-1.log');
  const run = (...args) => cli(...args, '--data-dir', d.dir);

  for (const args of [[], ['all', '--dry-run']]) {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.dryRun, true);
    assert.deepEqual([j.recordings.count, j.run.count], [1, 1]);
    assert.ok(d.has('recordings/a.wav') && d.has('run/record-1.log'));
  }
  const onlyRun = JSON.parse(run('run').stdout);
  assert.equal(onlyRun.dryRun, false);
  assert.equal(onlyRun.recordings, undefined);
  assert.ok(d.has('recordings/a.wav') && !d.has('run/record-1.log'));
  assert.equal(run('recordings').status, 0);
  assert.ok(!d.has('recordings/a.wav'));
  assert.equal(run('everything').status, 2);
  assert.equal(run('run', 'recordings').status, 2);
});

test('a transcription names every file it will read in its state', t => {
  const { TranscribeState } = require('../src/activity');
  const d = dataFolder(t);
  const s = new TranscribeState(d.env, { count: 2, files: ['a.wav', 'b.wav'] });
  s.update({ index: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')).files, ['a.wav', 'b.wav']);
  s.close();
});
