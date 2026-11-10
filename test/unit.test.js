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

test('Store keeps notes, folders, transcripts and search', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-store-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const folder = store.resolveFolder('강의', { create: true });
  assert.equal(store.resolveFolder('강의').id, folder.id);
  const note = store.createNote({ title: 'OS', type: 'file', folderId: folder.id });
  const t = store.addComponent({ noteId: note.id, type: 'transcript', title: 'Transcript', contentText: '[]', metadata: { speakerNames: {} } });
  store.updateComponent(t.id, { contentText: JSON.stringify(toAltEntries([{ start: 0, end: 1, text: '스케줄링' }])) });
  assert.equal(store.listNotes({ search: '스케줄링' }).length, 1);
  assert.equal(store.listNotes({ folderId: folder.id }).length, 1);
  assert.equal(store.listNotes({ folderId: null }).length, 0);
  store.updateNote(note.id, { title: '운영체제' });
  assert.equal(store.getNote(note.id).title, '운영체제');
  store.deleteNote(note.id);
  assert.throws(() => store.getNote(note.id), /No note/);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
