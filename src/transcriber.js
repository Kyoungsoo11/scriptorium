'use strict';
// One transcription run: a note with a transcript component, a recognizer, and the audio fed
// into it. Shared by file transcription and live recording.
//
// Flow: audio → Silero VAD → speech regions packed into ≤28 s chunks → whisper.cpp → segments
// mapped back to the original timeline → (at the end) speaker separation over the whole audio.
// Partial transcripts are saved while it runs, so an interrupted run keeps what it had.

const { Whisper } = require('./native');
const {
  SR,
  SpeechDetector,
  ChunkPacker,
  mapSegments,
  uncoveredChunk,
  isDuplicate,
  isSparse,
  keepRetrySegment,
  diarize,
  assignSpeakers,
  concat,
} = require('./speech');
const { toAltEntries } = require('./format');

const SAVE_EVERY_MS = 2000;
/** Live: a chunk goes out at a pause once it holds this much speech... */
const LIVE_PAUSE_FLUSH_S = 8;
/** ...or when it holds this much... */
const LIVE_FULL_S = 25;
/** ...or when its oldest speech has waited this long. */
const LIVE_MAX_WAIT_MS = 15000;
/** File mode: chunks waiting in the recognizer before decoding pauses. */
const MAX_IN_FLIGHT = 2;

class TranscriptionRun {
  /**
   * @param {object} p
   * @param {object} p.env
   * @param {import('./store').Store|null} p.store   null with --no-save
   * @param {object} p.note     { title, type: 'file'|'recording', folderId, sourcePath }
   * @param {object} p.options  { language, diarize, speakers, prompt, threads, beam, useGpu, gpu }
   * @param {(msg: string) => void} p.log
   * @param {(event: object) => void} [p.onEvent]
   */
  constructor({ env, store, note, options, log, onEvent }) {
    Object.assign(this, { env, store, noteSpec: note, options, log, onEvent: onEvent || (() => {}) });
    this.live = note.type === 'recording';
    this.segments = [];
    this.sent = [];
    this.audio = [];
    this.fedSamples = 0;
    this.inFlight = new Set();
    this.lastSave = 0;
  }

  async start() {
    this.whisper = new Whisper(this.env, {
      language: this.options.language || 'auto',
      threads: this.options.threads,
      beam: this.options.beam,
      prompt: this.options.prompt,
      useGpu: this.options.useGpu !== false,
      gpu: this.options.gpu,
    });
    this.log('loading speech recognizer');
    const ready = await this.whisper.start();
    this.backend = /VULKAN = 1|Vulkan/i.test(ready.system || '') && this.options.useGpu !== false ? 'vulkan' : 'cpu';
    this.detector = new SpeechDetector(this.env, { threshold: this.options.vadThreshold });
    this.packer = new ChunkPacker();
    if (this.store) {
      this.note = this.store.createNote({
        title: this.noteSpec.title,
        type: this.noteSpec.type,
        folderId: this.noteSpec.folderId ?? null,
        sourcePath: this.noteSpec.sourcePath ?? null,
        status: this.live ? 'recording' : 'processing',
      });
      this.transcript = this.store.addComponent({
        noteId: this.note.id,
        type: 'transcript',
        title: 'Transcript',
        contentText: '[]',
        metadata: { speakerNames: {}, language: this.options.language || 'auto', backend: this.backend },
      });
    }
    if (this.live) this.liveTimer = setInterval(() => this.liveFlush(), 500);
    this.onEvent({ event: 'started', noteId: this.note?.id ?? null, backend: this.backend });
  }

  /** Feeds 16 kHz mono audio. In file mode, resolves when the recognizer has room for more. */
  async feed(samples) {
    this.fedSamples += samples.length;
    if (this.options.diarize !== false) this.audio.push(samples);
    for (const region of this.detector.push(samples)) {
      for (const chunk of this.packer.add(region)) this.submit(chunk);
    }
    while (!this.live && this.inFlight.size >= MAX_IN_FLIGHT) await Promise.race(this.inFlight);
  }

  liveFlush() {
    const speech = this.packer.speechSeconds;
    if (!speech) return;
    const waited = Date.now() - this.packer.firstAddedAt;
    if (speech >= LIVE_FULL_S || (!this.detector.speaking && speech >= LIVE_PAUSE_FLUSH_S) || waited >= LIVE_MAX_WAIT_MS) {
      this.submit(this.packer.take());
    }
  }

  submit(chunk) {
    if (!chunk) return;
    const job = this.whisper
      .transcribe(chunk.audio, chunk.retry ? { language: 'auto' } : {})
      .then(reply => {
        let segs = mapSegments(reply, chunk.pieces);
        if (chunk.retry) {
          const mainLang = this.options.language || this.language;
          segs = segs.filter(s => !isDuplicate(s, this.segments) && keepRetrySegment(s, reply.lang, mainLang));
          // A stretched segment that hid the recovered speech starts after it instead.
          this.segments = this.segments.map(e => {
            const inside = segs.filter(r => r.start >= e.start && r.end <= e.end);
            if (!inside.length || !isSparse(e)) return e;
            return { ...e, start: Math.min(e.end, Math.max(...inside.map(r => r.end))) };
          });
        }
        this.segments = [...this.segments, ...segs].sort((a, b) => a.start - b.start);
        if (!chunk.retry) {
          this.language = reply.lang || this.language;
          const missed = uncoveredChunk(chunk, reply);
          if (missed) {
            this.retries = (this.retries || 0) + missed.pieces.length;
            this.submit(missed);
          }
        }
        this.emitChanges();
        if (this.store && Date.now() - this.lastSave > SAVE_EVERY_MS) this.save();
      })
      .catch(err => {
        this.error = this.error || err;
      })
      .finally(() => this.inFlight.delete(job));
    this.inFlight.add(job);
  }

  get fedSeconds() {
    return this.fedSamples / SR;
  }

  /** Last transcribed position (s), for progress. */
  get transcribedSeconds() {
    return this.segments.length ? this.segments[this.segments.length - 1].end / 1000 : 0;
  }

  /** Streams new segments as 'segment', changed ones as 'update', vanished ones as 'remove'. */
  emitChanges() {
    const view = this.segments.map(({ noSpeech, ...s }) => s);
    view.forEach((s, index) => {
      const json = JSON.stringify(s);
      if (this.sent[index] === json) return;
      this.onEvent({ event: index < this.sent.length ? 'update' : 'segment', index, ...s });
      this.sent[index] = json;
    });
    for (let index = view.length; index < this.sent.length; index++) this.onEvent({ event: 'remove', index });
    this.sent.length = view.length;
  }

  publicSegments() {
    return this.segments.map(({ noSpeech, ...s }) => s);
  }

  save(final = false) {
    this.lastSave = Date.now();
    if (!this.store || !this.transcript) return;
    this.store.updateComponent(this.transcript.id, { contentText: JSON.stringify(toAltEntries(this.publicSegments())) });
    if (final) this.store.updateNote(this.note.id, { status: 'completed' });
  }

  attachFile(type, filePath, metadata) {
    if (!this.store || !this.note) return null;
    return this.store.addComponent({ noteId: this.note.id, type, title: 'Recording', filePath, metadata });
  }

  async finish() {
    clearInterval(this.liveTimer);
    for (const region of this.detector.flush()) {
      for (const chunk of this.packer.add(region)) this.submit(chunk);
    }
    this.submit(this.packer.take());
    while (this.inFlight.size) await Promise.race(this.inFlight);
    if (this.error) throw this.error;

    let speakers = [];
    if (this.options.diarize !== false && this.segments.length) {
      this.log('separating speakers');
      const t0 = Date.now();
      const turns = diarize(this.env, concat(this.audio), {
        speakers: this.options.speakers,
        threads: this.options.threads || 8,
      });
      this.audio = [];
      this.segments = assignSpeakers(this.segments, turns);
      speakers = [...new Set(this.segments.map(s => s.speaker))];
      this.log(`speakers: ${speakers.length} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      this.emitChanges();
    }
    this.save(true);
    if (this.store && this.transcript) {
      this.store.updateComponent(this.transcript.id, {
        metadata: { ...this.transcript.metadata, language: this.language || this.options.language || 'auto' },
      });
    }
    this.close();
    return {
      noteId: this.note?.id ?? null,
      title: this.noteSpec.title,
      backend: this.backend,
      language: this.language ?? null,
      audioSeconds: Math.round(this.fedSeconds * 100) / 100,
      retriedPieces: this.retries || 0,
      speakers,
      segments: this.publicSegments(),
    };
  }

  /** Keeps the partial transcript and marks the note failed. */
  async fail(err) {
    clearInterval(this.liveTimer);
    try {
      this.save();
      if (this.store && this.note) this.store.updateNote(this.note.id, { status: 'failed' });
    } catch {
      /* best effort */
    }
    this.close();
    return err;
  }

  close() {
    this.whisper?.close();
  }
}

module.exports = { TranscriptionRun };
