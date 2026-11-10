'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { SR, ChunkPacker, toOriginalMs, mapSegments, uncoveredChunk, isSparse, isDuplicate, assignSpeakers, MAX_CHUNK } = require('../src/speech');
const { FloatStream } = require('../src/native');

const region = (startS, lenS) => ({ start: Math.round(startS * SR), samples: new Float32Array(Math.round(lenS * SR)).fill(0.1) });

test('packer keeps chunks under the limit and maps times back', () => {
  const p = new ChunkPacker();
  assert.deepEqual(p.add(region(10, 5)), []);
  assert.deepEqual(p.add(region(40, 5)), []);
  const chunk = p.take();
  assert.equal(chunk.pieces.length, 2);
  // 0 ms in the chunk is 10 s in the recording; the second piece starts after a 1 s gap.
  assert.equal(toOriginalMs(chunk.pieces, 0, 'start'), 10000);
  assert.equal(toOriginalMs(chunk.pieces, 5000, 'end'), 15000);
  assert.equal(toOriginalMs(chunk.pieces, 6000, 'start'), 40000);
  // Inside the gap: a start snaps forward, an end snaps back.
  assert.equal(toOriginalMs(chunk.pieces, 5500, 'start'), 40000);
  assert.equal(toOriginalMs(chunk.pieces, 5500, 'end'), 15000);
  assert.equal(p.take(), null);
});

test('packer splits when full and never exceeds MAX_CHUNK', () => {
  const p = new ChunkPacker();
  const out = [];
  for (let i = 0; i < 6; i++) out.push(...p.add(region(i * 30, 20)));
  const last = p.take();
  if (last) out.push(last);
  assert.ok(out.length >= 4);
  for (const c of out) assert.ok(c.audio.length <= MAX_CHUNK, `chunk ${c.audio.length}`);
  const total = out.reduce((s, c) => s + c.pieces.reduce((a, x) => a + x.length, 0), 0);
  assert.equal(total, 6 * 20 * SR);
});

test('mapSegments maps, trims and drops likely hallucinations', () => {
  const pieces = [{ chunkStart: 0, origStart: 5 * SR, length: 3 * SR }];
  const segs = mapSegments(
    { segments: [{ start: 0, end: 2000, text: ' 안녕 ' }, { start: 2000, end: 3000, text: '감사합니다', noSpeech: 0.95 }] },
    pieces,
  );
  assert.deepEqual(segs, [{ start: 5000, end: 7000, text: '안녕', noSpeech: undefined }]);
});

test('uncoveredChunk finds speech the recognizer skipped', () => {
  const p = new ChunkPacker();
  p.add(region(0, 5));
  p.add(region(20, 5));
  const chunk = p.take();
  const full = '가'.repeat(40); // a normal amount of text for the span
  // Only the second piece (6–11 s in the chunk) got text.
  const missed = uncoveredChunk(chunk, { segments: [{ start: 6000, end: 11000, text: full }] });
  assert.equal(missed.pieces.length, 1);
  assert.equal(missed.pieces[0].origStart, 0);
  assert.equal(missed.retry, true);
  assert.equal(uncoveredChunk(chunk, { segments: [{ start: 0, end: 11000, text: full, tokStart: 0, tokEnd: 11000 }] }), null);
  // Token times override a stretched segment span.
  assert.ok(uncoveredChunk(chunk, { segments: [{ start: 0, end: 11000, text: full, tokStart: 6100, tokEnd: 11000 }] }));
});

test('a long segment with little text is retried', () => {
  const p = new ChunkPacker();
  p.add(region(0, 9));
  const chunk = p.take();
  // 8 characters over 8 s: the recognizer stretched it over speech it dropped.
  const missed = uncoveredChunk(chunk, { segments: [{ start: 500, end: 8500, text: '안녕하세요 교수님', tokStart: 500, tokEnd: 8500 }] });
  assert.equal(missed.pieces.length, 1);
  assert.equal(missed.pieces[0].origStart, 0.5 * SR);
  assert.equal(isSparse({ start: 0, end: 8000, text: '안녕하세요 교수님' }), true);
  assert.equal(isSparse({ start: 0, end: 8000, text: '가'.repeat(30) }), false);
  assert.equal(isSparse({ start: 0, end: 2000, text: '네' }), false); // short ones are fine
});

test('isDuplicate drops repeated retry text near the same time', () => {
  const existing = [{ start: 29000, end: 30000, text: '감사합니다.' }];
  assert.equal(isDuplicate({ start: 29500, end: 30200, text: '감사합니다' }, existing), true);
  assert.equal(isDuplicate({ start: 60000, end: 61000, text: '감사합니다' }, existing), false);
  assert.equal(isDuplicate({ start: 29500, end: 30200, text: 'Good morning' }, existing), false);
});

test('assignSpeakers uses overlap, then nearest turn, and renumbers by appearance', () => {
  const segs = [
    { start: 0, end: 1000, text: 'a' },
    { start: 1000, end: 2000, text: 'b' },
    { start: 5000, end: 5500, text: 'c' },
  ];
  const turns = [
    { start: 0, end: 1100, speaker: 'SPEAKER_03' },
    { start: 1100, end: 2000, speaker: 'SPEAKER_01' },
  ];
  assert.deepEqual(assignSpeakers(segs, turns).map(s => s.speaker), ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_01']);
});

test('FloatStream carries partial samples across chunks', () => {
  const f = new FloatStream();
  const bytes = Buffer.from(new Float32Array([1, 2, 3]).buffer);
  assert.equal(f.push(bytes.subarray(0, 2)), null);
  assert.deepEqual([...f.push(bytes.subarray(2, 9))], [1, 2]);
  assert.deepEqual([...f.push(bytes.subarray(9))], [3]);
});

test('stock hallucinations are dropped, real speech kept', () => {
  const { isHallucination, keepRetrySegment } = require('../src/speech');
  for (const t of ['Thank you.', "We'll be right back.", "I don't know.", 'Gracias.', '.', '시청해주셔서 감사합니다.']) {
    assert.equal(isHallucination(t), true, t);
  }
  for (const t of ['감사합니다.', 'Thank you for the question about K-means.', 'K-Means']) {
    assert.equal(isHallucination(t), false, t);
  }
  assert.equal(keepRetrySegment({ text: '我' }, 'zh', 'ko'), false);
  assert.equal(keepRetrySegment({ text: 'Good morning everyone.' }, 'en', 'ko'), true);
  assert.equal(keepRetrySegment({ text: '안녕' }, 'ko', 'ko'), true);
  assert.equal(keepRetrySegment({ text: 'Hi' }, 'en', 'auto'), true);
});

test('minor speakers fold into the nearest main speaker', () => {
  const { foldMinorSpeakers } = require('../src/speech');
  const turns = [
    { start: 0, end: 600000, speaker: 'SPEAKER_00' },
    { start: 600000, end: 603000, speaker: 'SPEAKER_07' }, // 3 s: a fragment
    { start: 603500, end: 900000, speaker: 'SPEAKER_01' },
  ];
  assert.deepEqual(foldMinorSpeakers(turns).map(t => t.speaker), ['SPEAKER_00', 'SPEAKER_00', 'SPEAKER_01']);
  const two = [{ start: 0, end: 5000, speaker: 'SPEAKER_00' }, { start: 5000, end: 9000, speaker: 'SPEAKER_01' }];
  assert.deepEqual(foldMinorSpeakers(two), two);
});
