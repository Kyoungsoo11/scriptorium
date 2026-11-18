'use strict';
// Running work, as files in <data>/run that the tray app (native/scriptorium-app.cpp) watches:
//
//   recording-<id>.json            a live recording (also read by `status` and `stop`).
//                                  phase "recording", then "finishing" once it was told to stop.
//   recording-<id>.stop            asks that recording to stop (written by `stop` and the tray app)
//   transcribe-<pid>.json          a file transcription in progress, with progress in seconds
//   finished-<kind>-<id>.json      one piece of work that ended (ok or not); the tray app shows a
//                                  notice and deletes it. Old ones are cleaned up by the app.
//
// Files are written whole (temporary file + rename) so a reader never sees half of one.

const fs = require('node:fs');
const path = require('node:path');

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/** Records that a recording or transcription ended. Never throws: the work itself is done. */
function writeFinished(env, { kind, id, title, ok, noteId = null, error = null, audioPath = null }) {
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
      endedAt: new Date().toISOString(),
    });
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
