'use strict';
// Running work, as files in <data>/run that the tray app (native/scriptorium-app.cpp) watches:
//
//   recording-<id>.json            a live recording (also read by `status` and `stop`).
//                                  phase "recording", then "finishing" once it was told to stop.
//   recording-<id>.stop            asks that recording to stop (written by `stop` and the tray app)
//   recording-<id>.pause           while it exists the recording is paused (`pause`/`resume`, tray app)
//   transcribe-<pid>.json          a file transcription in progress, with progress in seconds
//   finished-<kind>-<id>.json      one piece of work that ended (ok or not); the tray app shows a
//                                  notice and deletes it. Notices older than a week are pruned.
//
// Files are written whole (temporary file + rename) so a reader never sees half of one.

const fs = require('node:fs');
const path = require('node:path');

const NOTICE_TTL_MS = 7 * 24 * 3600 * 1000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes JSON through a temporary file and a rename. On Windows the rename fails (EPERM, EBUSY,
 * EACCES) while another process has the target open, which the tray app does every second to
 * read it, so it is retried for up to about a second before giving up.
 */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 20) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      sleepSync(50);
    }
  }
}

function pruneOldNotices(runDir) {
  const now = Date.now();
  for (const f of fs.readdirSync(runDir)) {
    if (!f.startsWith('finished-') || !f.endsWith('.json')) continue;
    const file = path.join(runDir, f);
    try {
      if (now - fs.statSync(file).mtimeMs > NOTICE_TTL_MS) fs.rmSync(file, { force: true });
    } catch {
      // another process took it
    }
  }
}

/** Records that a recording or transcription ended. Never throws: the work itself is done. */
function writeFinished(env, { kind, id, title, ok, noteId = null, error = null, audioPath = null, textPath = null }) {
  try {
    const safeId = String(id).replace(/[^\w.-]/g, '_');
    writeJsonAtomic(path.join(env.runDir, `finished-${kind}-${safeId}.json`), {
      kind,
      id: String(id),
      title,
      ok,
      noteId,
      ...(error ? { error: String(error).slice(0, 500) } : {}),
      ...(audioPath ? { audioPath } : {}),
      ...(textPath ? { textPath } : {}),
      endedAt: new Date().toISOString(),
    });
    // with no tray app running nothing consumes them
    pruneOldNotices(env.runDir);
  } catch {
    // a notice is nice to have; never let it fail the run
  }
}

/** The state file of one file transcription; one per process, updated as it goes. */
class TranscribeState {
  constructor(env, { count }) {
    this.file = path.join(env.runDir, `transcribe-${process.pid}.json`);
    this.state = { kind: 'transcribe', pid: process.pid, count, index: 0, startedAt: new Date().toISOString() };
  }

  update(fields) {
    Object.assign(this.state, fields);
    try {
      writeJsonAtomic(this.file, this.state);
    } catch {
      // progress display only
    }
  }

  close() {
    fs.rmSync(this.file, { force: true });
  }
}

module.exports = { writeJsonAtomic, writeFinished, TranscribeState };
