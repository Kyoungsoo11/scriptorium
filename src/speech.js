'use strict';
// Speech detection, chunk packing and speaker separation (sherpa-onnx, ONNX Runtime).
//
// Whisper encodes a fixed 30 s window, so each request costs about the same whatever its length
// (measured: ~6 s on 16 CPU threads for 3 s or 28 s of audio). Like Alt's pipeline, silence is
// dropped and speech regions are packed into chunks of up to ~28 s; each piece remembers where it
// came from so segment times map back to the original recording.

const SR = 16000;
const GAP = Math.round(SR * 1.0); // silence between packed pieces; 0.3 s let Whisper fuse sentences and drop one in another language
const MAX_CHUNK = SR * 28;

let sherpa = null;
function sherpaModule() {
  if (!sherpa) sherpa = require('sherpa-onnx-node');
  return sherpa;
}

/** Audio kept around each detected region; Silero cuts close and clips word edges. */
const PAD = Math.round(SR * 0.3);
/**
 * Speech probability threshold. Silero's usual 0.5 kept 94 of 180 s of a real lecture and lost
 * soft speech; 0.15 with padding recovered it and still found nothing in 30 s of room noise.
 */
const DEFAULT_VAD_THRESHOLD = 0.15;

/**
 * Streaming Silero VAD. push() returns finished speech regions { start (samples), samples },
 * padded by PAD on both sides (without overlapping the previous region).
 */
class SpeechDetector {
  constructor(env, { threshold } = {}) {
    threshold = threshold || Number(process.env.SCRIPTORIUM_VAD_THRESHOLD) || DEFAULT_VAD_THRESHOLD;
    const { Vad } = sherpaModule();
    this.windowSize = 512;
    this.vad = new Vad(
      {
        sileroVad: {
          model: env.vadModel,
          threshold,
          minSilenceDuration: 0.5,
          minSpeechDuration: 0.25,
          maxSpeechDuration: 20,
          windowSize: this.windowSize,
        },
        sampleRate: SR,
        numThreads: 1,
        debug: false,
      },
      60,
    );
    this.pending = new Float32Array(0);
    this.hist = []; // recent audio, for padding
    this.histStart = 0; // absolute sample index of hist[0][0]
    this.total = 0; // samples pushed so far
    this.lastEnd = 0; // end of the last region returned
  }

  remember(samples) {
    this.hist.push(samples);
    this.total += samples.length;
    while (this.hist.length > 1 && this.histStart + this.hist[0].length < this.total - 90 * SR) {
      this.histStart += this.hist.shift().length;
    }
  }

  /** Samples [s, e) from the history. */
  slice(s, e) {
    const out = new Float32Array(Math.max(0, e - s));
    let pos = this.histStart;
    for (const h of this.hist) {
      const a = Math.max(s, pos);
      const b = Math.min(e, pos + h.length);
      if (b > a) out.set(h.subarray(a - pos, b - pos), a - s);
      pos += h.length;
      if (pos >= e) break;
    }
    return out;
  }

  push(samples) {
    this.remember(samples);
    let buf = this.pending.length ? concat([this.pending, samples]) : samples;
    let off = 0;
    for (; off + this.windowSize <= buf.length; off += this.windowSize) {
      this.vad.acceptWaveform(buf.subarray(off, off + this.windowSize));
    }
    this.pending = buf.slice(off);
    return this.drain();
  }

  flush() {
    if (this.pending.length) {
      const last = new Float32Array(this.windowSize);
      last.set(this.pending);
      this.vad.acceptWaveform(last);
      this.pending = new Float32Array(0);
    }
    this.vad.flush();
    return this.drain();
  }

  get speaking() {
    return this.vad.isDetected();
  }

  drain() {
    const out = [];
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front(false);
      const s = Math.max(seg.start - PAD, this.lastEnd, this.histStart);
      const e = Math.min(seg.start + seg.samples.length + PAD, this.total);
      if (e > s) {
        out.push({ start: s, samples: this.slice(s, e) });
        this.lastEnd = e;
      }
      this.vad.pop();
    }
    return out;
  }
}

/** Packs speech regions into chunks with a map back to original sample positions. */
class ChunkPacker {
  constructor() {
    this.reset();
  }

  reset() {
    this.parts = []; // Float32Arrays, gaps included
    this.pieces = []; // { chunkStart, origStart, length }
    this.length = 0;
    this.firstAddedAt = 0;
  }

  get speechSeconds() {
    return this.pieces.reduce((s, p) => s + p.length, 0) / SR;
  }

  /** Adds a region; returns a full chunk first if the region would not fit. */
  add(region) {
    const out = [];
    let { start, samples } = region;
    while (samples.length > 0) {
      const room = MAX_CHUNK - this.length - (this.pieces.length ? GAP : 0);
      if (room < SR && this.pieces.length) {
        out.push(this.take());
        continue;
      }
      const n = Math.min(samples.length, Math.max(room, SR));
      if (this.pieces.length) {
        this.parts.push(new Float32Array(GAP));
        this.length += GAP;
      } else {
        this.firstAddedAt = Date.now();
      }
      this.pieces.push({ chunkStart: this.length, origStart: start, length: n });
      this.parts.push(samples.subarray(0, n));
      this.length += n;
      start += n;
      samples = samples.subarray(n);
    }
    return out;
  }

  /** The current chunk (or null when empty), and starts a new one. */
  take() {
    if (!this.pieces.length) return null;
    const chunk = { audio: concat(this.parts), pieces: this.pieces };
    this.reset();
    return chunk;
  }
}

/** Maps a time in a packed chunk (ms) back to the original timeline (ms). */
function toOriginalMs(pieces, chunkMs, edge) {
  const pos = (chunkMs / 1000) * SR;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const end = p.chunkStart + p.length;
    if (pos < p.chunkStart) {
      // In the gap before this piece: a start snaps forward, an end snaps back.
      const q = edge === 'end' && i > 0 ? pieces[i - 1] : p;
      const at = edge === 'end' && i > 0 ? q.origStart + q.length : p.origStart;
      return Math.round((at / SR) * 1000);
    }
    if (pos <= end) return Math.round(((p.origStart + (pos - p.chunkStart)) / SR) * 1000);
  }
  const last = pieces[pieces.length - 1];
  return Math.round(((last.origStart + last.length) / SR) * 1000);
}

const MIN_SEGMENT_MS = 150;

/**
 * Phrases Whisper is known to invent over noise and silence (YouTube outro lines and the like).
 * A segment made of nothing else is dropped. Seen in a 70-minute Korean lecture: "Thank you." x4,
 * "We'll be right back.", "I don't know.", "Gracias.".
 */
const HALLUCINATION =
  /^(thank you( (very much|so much|for watching))?|thanks( for watching)?|we'?ll be right back|i don'?t know|bye( bye)?|you|gracias|merci|danke|시청해 ?주셔서 감사합니다|구독과 좋아요.*|MBC 뉴스.*|자막.*제공.*)[\s.!?,~…]*$/i;

function isHallucination(text) {
  return HALLUCINATION.test(text.trim()) || textLength(text) === 0;
}

/** Whisper reply for a packed chunk → segments on the original timeline. */
function mapSegments(reply, pieces) {
  return (reply.segments || [])
    .map(s => ({
      start: toOriginalMs(pieces, s.start, 'start'),
      end: toOriginalMs(pieces, s.end, 'end'),
      text: (s.text || '').trim(),
      noSpeech: s.noSpeech,
    }))
    .map(s => ({ ...s, end: Math.max(s.end, s.start) }))
    // Likely hallucinations: little text Whisper itself thinks is not speech, segments too short
    // to hold a word (seen: a 34 ms "Thank you." at the end of a chunk), and the stock phrases.
    .filter(
      s => s.text && !(s.noSpeech > 0.8 && s.text.length < 30) && s.end - s.start >= MIN_SEGMENT_MS && !isHallucination(s.text),
    );
}

/**
 * Keeps a retry result (decoded with language detection) only if it is in the run's language or
 * has 3+ words: short off-language bits from a retry were noise ("我", "Gracias."), while
 * "Good morning everyone." (3 words) was real.
 */
function keepRetrySegment(seg, replyLang, mainLang) {
  if (!mainLang || mainLang === 'auto' || replyLang === mainLang) return true;
  return seg.text.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length >= 3;
}

/** A segment's time span from its tokens when the recognizer gave them, else its own. */
function tightSpan(s) {
  return s.tokStart >= 0 && s.tokEnd > s.tokStart ? { ...s, start: s.tokStart, end: s.tokEnd } : s;
}

/** Uncovered stretches shorter than this are pauses, not missed speech. */
const MIN_MISSED = Math.round(SR * 1.5);
/** Slack around each returned segment before a stretch counts as uncovered. */
const SLACK = Math.round(SR * 0.4);
/** Segments at least this long (s) with fewer characters per second than this are suspect. */
const SPARSE_MIN_S = 4;
const SPARSE_CHARS_PER_S = 1.5;

function textLength(t) {
  return (t || '').replace(/[\s.,?!~…'"]/g, '').length;
}

/** True for a long segment with little text: likely stretched over speech it dropped. */
function isSparse(s) {
  const seconds = (s.end - s.start) / 1000;
  return seconds >= SPARSE_MIN_S && textLength(s.text) / seconds < SPARSE_CHARS_PER_S;
}

/**
 * Speech the recognizer returned no text for. Whisper silently drops speech in a language other
 * than the one it decodes with (tested: English sentences vanish with language "ko", also inside
 * a speech piece that is otherwise Korean). Stretches of detected speech of at least 1.5 s with
 * no returned segment (by token times) are packed into a new chunk for a retry with language
 * detection. Returns null when everything is covered.
 */
function uncoveredChunk(chunk, reply) {
  const texts = (reply.segments || []).filter(s => (s.text || '').trim());
  const covered = texts
    .map(tightSpan)
    .map(s => [(s.start / 1000) * SR - SLACK, (s.end / 1000) * SR + SLACK])
    .sort((x, y) => x[0] - y[0]);
  const missing = [];
  for (const p of chunk.pieces) {
    let cursor = p.chunkStart;
    const end = p.chunkStart + p.length;
    for (const [a, b] of covered) {
      if (b <= cursor) continue;
      if (a >= end) break;
      if (a - cursor >= MIN_MISSED) missing.push({ p, from: cursor, to: Math.floor(a) });
      cursor = Math.max(cursor, Math.ceil(b));
    }
    if (end - cursor >= MIN_MISSED) missing.push({ p, from: cursor, to: end });
  }
  // A segment stretched over speech it did not transcribe has very little text for its length
  // (seen: 8 Korean characters over 8 s that also held a dropped English sentence).
  for (const s of texts) {
    if (!isSparse(s)) continue;
    const a = (s.start / 1000) * SR;
    const b = (s.end / 1000) * SR;
    for (const p of chunk.pieces) {
      const from = Math.max(a, p.chunkStart);
      const to = Math.min(b, p.chunkStart + p.length);
      if (to - from < MIN_MISSED) continue;
      if (missing.some(m => m.p === p && m.from < to && m.to > from)) continue;
      missing.push({ p, from: Math.floor(from), to: Math.ceil(to) });
    }
  }
  missing.sort((x, y) => x.from - y.from);
  if (!missing.length) return null;
  const parts = [];
  const pieces = [];
  let length = 0;
  for (const { p, from, to } of missing) {
    if (pieces.length) {
      parts.push(new Float32Array(GAP));
      length += GAP;
    }
    pieces.push({ chunkStart: length, origStart: p.origStart + (from - p.chunkStart), length: to - from });
    parts.push(chunk.audio.subarray(from, to));
    length += to - from;
  }
  return { audio: concat(parts), pieces, retry: true };
}

/** Retry segments that repeat text already transcribed around the same time. */
function isDuplicate(seg, existing) {
  const norm = t => t.replace(/[\s.,?!~…]/g, '');
  const t = norm(seg.text);
  if (!t) return true;
  return existing.some(
    e => e.end > seg.start - 1000 && e.start < seg.end + 1000 && (norm(e.text).includes(t) || t.includes(norm(e.text))),
  );
}

/**
 * Clustering distance threshold (higher = fewer speakers). sherpa-onnx's 0.5 split a one-lecturer
 * class into 57 speakers and a one-narrator video into 2. 0.7 kept the video whole and still
 * separated a two-voice dialogue in two of three test clips (0.75 and up merged it more often).
 */
const SPEAKER_THRESHOLD = 0.7;
/** Speakers with less than this share of speech (and under MINOR_MAX_S) are folded into others. */
const MINOR_SHARE = 0.02;
const MINOR_MAX_S = 20;

/** Speaker turns for the whole recording: [{ start, end (ms), speaker }]. */
function diarize(env, audio, { speakers, threshold = SPEAKER_THRESHOLD, threads = 8 } = {}) {
  const { OfflineSpeakerDiarization } = sherpaModule();
  const sd = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: env.segmentationModel }, numThreads: threads, debug: false },
    embedding: { model: env.embeddingModel, numThreads: threads, debug: false },
    clustering: { numClusters: speakers ? Number(speakers) : -1, threshold },
    minDurationOn: 0.2,
    minDurationOff: 0.5,
  });
  const turns = sd.process(audio).map(t => ({
    start: Math.round(t.start * 1000),
    end: Math.round(t.end * 1000),
    speaker: `SPEAKER_${String(t.speaker).padStart(2, '0')}`,
  }));
  return speakers ? turns : foldMinorSpeakers(turns);
}

/**
 * Reassigns turns of speakers with very little speech (fragments of noise, coughs, a cluster
 * split off one voice) to the nearest turn in time of a main speaker.
 */
function foldMinorSpeakers(turns) {
  const total = new Map();
  for (const t of turns) total.set(t.speaker, (total.get(t.speaker) || 0) + (t.end - t.start) / 1000);
  const all = [...total.values()].reduce((s, v) => s + v, 0);
  const minor = new Set([...total].filter(([, s]) => s < MINOR_MAX_S && s / all < MINOR_SHARE).map(([k]) => k));
  if (!minor.size || minor.size === total.size) return turns;
  const major = turns.filter(t => !minor.has(t.speaker));
  return turns.map(t => {
    if (!minor.has(t.speaker)) return t;
    const mid = (t.start + t.end) / 2;
    let best = major[0];
    let bestD = Infinity;
    for (const m of major) {
      const d = mid < m.start ? m.start - mid : mid > m.end ? mid - m.end : 0;
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return { ...t, speaker: best.speaker };
  });
}

/**
 * Gives each transcript segment the speaker it overlaps most; without overlap, the nearest turn.
 * Speaker ids are renumbered in order of first appearance.
 */
function assignSpeakers(segments, turns) {
  if (!turns.length) return segments;
  const labeled = segments.map(s => {
    const score = new Map();
    for (const t of turns) {
      const ov = Math.min(s.end, t.end) - Math.max(s.start, t.start);
      if (ov > 0) score.set(t.speaker, (score.get(t.speaker) || 0) + ov);
    }
    let speaker = [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!speaker) {
      const mid = (s.start + s.end) / 2;
      speaker = turns.reduce((best, t) => {
        const d = Math.min(Math.abs(mid - t.start), Math.abs(mid - t.end));
        return !best || d < best.d ? { d, speaker: t.speaker } : best;
      }, null).speaker;
    }
    return { ...s, speaker };
  });
  const order = new Map();
  for (const s of labeled) if (!order.has(s.speaker)) order.set(s.speaker, `SPEAKER_${String(order.size).padStart(2, '0')}`);
  return labeled.map(s => ({ ...s, speaker: order.get(s.speaker) }));
}

function concat(arrays) {
  const n = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(n);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

module.exports = {
  SR,
  SpeechDetector,
  ChunkPacker,
  toOriginalMs,
  mapSegments,
  uncoveredChunk,
  isDuplicate,
  isSparse,
  isHallucination,
  keepRetrySegment,
  diarize,
  foldMinorSpeakers,
  assignSpeakers,
  concat,
  MAX_CHUNK,
};
