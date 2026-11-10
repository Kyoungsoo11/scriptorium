'use strict';
// WAV output and small sample helpers. Audio is 16 kHz mono float32 throughout.

const fs = require('node:fs');

const SAMPLE_RATE = 16000;

// ---- WAV output --------------------------------------------------------------

/** Streams 16-bit PCM mono WAV; the header is patched with the final size on close. */
class WavWriter {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'w');
    this.bytes = 0;
    fs.writeSync(this.fd, header(0));
  }

  write(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
    }
    fs.writeSync(this.fd, buf);
    this.bytes += buf.length;
  }

  close() {
    fs.writeSync(this.fd, header(this.bytes), 0, 44, 0);
    fs.closeSync(this.fd);
    return { path: this.file, seconds: this.bytes / 2 / SAMPLE_RATE };
  }
}

function header(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// ---- helpers ------------------------------------------------------------------

function rms(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / Math.max(1, samples.length));
}

module.exports = { SAMPLE_RATE, WavWriter, rms };
