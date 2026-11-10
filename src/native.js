'use strict';
// Wrappers around scriptorium-core.exe (native/scriptorium-core.cpp): file decoding (Media Foundation), audio
// capture (WASAPI), and a persistent whisper.cpp recognizer. Talks over pipes only.

const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

/** Splits a byte stream into Float32Arrays, carrying partial samples over. */
class FloatStream {
  constructor() {
    this.rest = Buffer.alloc(0);
  }
  push(chunk) {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const usable = buf.length - (buf.length % 4);
    this.rest = Buffer.from(buf.subarray(usable));
    if (usable === 0) return null;
    const own = Buffer.from(buf.subarray(0, usable)); // aligned copy
    return new Float32Array(own.buffer, own.byteOffset, usable / 4);
  }
}

function jsonLines(stream, onLine) {
  let text = '';
  stream.setEncoding('utf8');
  stream.on('data', d => {
    text += d;
    let i;
    while ((i = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, i).trim();
      text = text.slice(i + 1);
      if (!line) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        onLine({ text: line });
      }
    }
  });
}

function listDevices(env) {
  const r = spawnSync(env.coreExe, ['devices'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`scriptorium-core devices failed: ${r.stderr || r.error?.message}`);
  return JSON.parse(r.stdout);
}

/**
 * Decodes a media file to 16 kHz mono float. onInfo gets { duration, sourceRate, channels };
 * onChunk is awaited before more is read (backpressure).
 */
function decodeFile(env, file, { onInfo, onChunk }) {
  return new Promise((resolve, reject) => {
    const p = spawn(env.coreExe, ['decode', file], { windowsHide: true });
    const fs = new FloatStream();
    let errors = [];
    let chain = Promise.resolve();
    let failed = null;
    let samples = 0;
    jsonLines(p.stderr, msg => {
      if (msg.duration !== undefined) onInfo?.(msg);
      else if (msg.error) errors.push(msg.error);
    });
    p.stdout.on('data', chunk => {
      const arr = fs.push(chunk);
      if (!arr) return;
      samples += arr.length;
      p.stdout.pause();
      chain = chain
        .then(() => onChunk(arr, samples))
        .catch(e => {
          failed = e;
          p.kill();
        })
        .finally(() => p.stdout.resume());
    });
    p.on('error', reject);
    p.on('close', code => {
      chain.then(() => {
        if (failed) return reject(failed);
        if (code !== 0) return reject(new Error(errors.join('; ') || `could not decode ${file} (exit ${code})`));
        resolve({ samples });
      });
    });
  });
}

/**
 * Live microphone + system audio, mixed by scriptorium-core. Emits 'data' (Float32Array), 'started',
 * 'warning', 'error', 'end'.
 */
class Capture extends EventEmitter {
  constructor(env, { mic = 'default', system = true }) {
    super();
    this.args = ['capture', '--mic', mic];
    if (!system) this.args.push('--no-system');
    this.env = env;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.env.coreExe, this.args, { windowsHide: true });
      const fs = new FloatStream();
      let started = false;
      let lastError = null;
      jsonLines(this.proc.stderr, msg => {
        if (msg.event === 'started') {
          started = true;
          this.emit('started', msg);
          resolve(msg);
        } else if (msg.warning) this.emit('warning', msg.warning);
        else if (msg.error) {
          lastError = msg.error;
          if (started) this.emit('error', new Error(msg.error));
        }
      });
      this.proc.stdout.on('data', chunk => {
        const arr = fs.push(chunk);
        if (arr) this.emit('data', arr);
      });
      this.proc.on('error', reject);
      this.proc.on('close', code => {
        this.closed = true;
        if (!started) reject(new Error(lastError || `audio capture failed (exit ${code})`));
        this.emit('end', code);
      });
    });
  }

  /** Asks scriptorium-core to stop and waits until all audio has been delivered. */
  stop() {
    if (!this.proc || this.closed) return Promise.resolve();
    return new Promise(resolve => {
      this.once('end', resolve);
      try {
        this.proc.stdin.end('stop\n');
      } catch {
        this.proc.kill();
      }
      setTimeout(() => this.proc.kill(), 5000).unref();
    });
  }
}

/** One persistent whisper.cpp process; requests are answered in order. */
class Whisper {
  constructor(env, { language = 'auto', threads, beam, prompt, gpu, useGpu = true, verbose = false }) {
    const args = ['whisper', '--model', env.whisperModel, '--lang', language];
    if (threads) args.push('--threads', String(threads));
    if (beam) args.push('--beam', String(beam));
    if (prompt) args.push('--prompt', prompt);
    if (!useGpu) args.push('--no-gpu');
    if (gpu !== undefined) args.push('--gpu', String(gpu));
    if (verbose) args.push('--verbose');
    this.env = env;
    this.args = args;
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.env.coreExe, this.args, { windowsHide: true });
      let ready = false;
      let lastError = null;
      jsonLines(this.proc.stderr, msg => {
        if (msg.event === 'ready') {
          ready = true;
          this.system = msg.system;
          resolve(msg);
        } else if (msg.error) lastError = msg.error;
      });
      jsonLines(this.proc.stdout, msg => {
        const job = this.pending.get(msg.id);
        if (!job) return;
        this.pending.delete(msg.id);
        if (msg.error) job.reject(new Error(msg.error));
        else job.resolve(msg);
      });
      this.proc.on('error', reject);
      this.proc.on('close', code => {
        const err = new Error(lastError || `speech recognizer exited (${code})`);
        if (!ready) reject(err);
        for (const job of this.pending.values()) job.reject(err);
        this.pending.clear();
      });
    });
  }

  /**
   * Transcribes samples; segment times come back in ms, shifted by offsetMs. `language`
   * overrides the process language for this request only.
   */
  transcribe(samples, { offsetMs = 0, language } = {}) {
    const id = this.nextId++;
    if (language && !/^[a-z]{2,3}$|^auto$/.test(language)) throw new Error(`bad language ${language}`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`T ${id} ${Math.round(offsetMs)} ${samples.length}${language ? ` ${language}` : ''}\n`);
      this.proc.stdin.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    });
  }

  close() {
    if (this.proc && this.proc.exitCode === null) this.proc.stdin.end();
  }
}

module.exports = { listDevices, decodeFile, Capture, Whisper, FloatStream };
