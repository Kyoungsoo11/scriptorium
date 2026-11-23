'use strict';
// Where a recording's files go and what they are called. A recording titled "알고리즘 1주차" is
// saved as Documents\Scriptorium\알고리즘 1주차.wav with its transcript next to it as
// 알고리즘 1주차.txt. A name that is taken is not overwritten unless asked (--overwrite).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { UsageError } = require('./store');

/** Exit code of `record` when the name is taken, so the tray app can offer to overwrite. */
const NAME_TAKEN_EXIT = 3;

class NameTakenError extends UsageError {
  constructor(base, taken, { recording = false } = {}) {
    super(
      `"${path.basename(base)}" already exists in ${path.dirname(base)} (${taken.join(', ')}); ` +
        (recording ? 'a running recording uses it: choose another --title' : 'choose another --title or pass --overwrite'),
    );
    this.exitCode = NAME_TAKEN_EXIT;
    this.taken = taken;
  }
}

/**
 * The user's Documents folder, following a move (e.g. to OneDrive) made in Explorer. The registry
 * holds it as "%USERPROFILE%\OneDrive\문서" style text, expanded here.
 */
function documentsDir() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = /Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out);
    if (m) {
      const dir = m[1].trim().replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all);
      if (path.isAbsolute(dir)) return dir;
    }
  } catch {
    // not Windows, or no such value
  }
  return path.join(os.homedir(), 'Documents');
}

/** Folder for recordings and their transcripts: --output-dir, SCRIPTORIUM_OUTPUT, or Documents\Scriptorium. */
function outputDir(opts = {}) {
  const given = opts['output-dir'] || process.env.SCRIPTORIUM_OUTPUT;
  return path.resolve(given || path.join(documentsDir(), 'Scriptorium'));
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const MAX_NAME = 120;

/**
 * A title as a Windows file name: characters Windows refuses become "_", control characters go,
 * trailing dots and spaces go, and reserved device names (CON, NUL, ...) get a "_" in front.
 */
function safeFileName(title) {
  let name = String(title ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  name = [...name].slice(0, MAX_NAME).join('').replace(/[. ]+$/, '');
  if (!name) name = 'Recording';
  if (RESERVED.test(name.split('.')[0])) name = `_${name}`;
  return name;
}

/** The default title of a recording: its start time, e.g. "2026-11-23 14-30" (no ':' in file names). */
function defaultTitle(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}-${p(date.getMinutes())}`;
}

/**
 * Paths of one recording. --audio-out picks the wav (the transcript goes next to it, same name);
 * otherwise both go in the output folder under the title.
 * @returns {{ base: string, wav: string|null, txt: string }}
 */
function recordingPaths({ dir, title, audioOut = null, audio = true }) {
  const base = audioOut ? path.resolve(audioOut).replace(/\.wav$/i, '') : path.join(dir, safeFileName(title));
  return { base, wav: audio ? (audioOut ? path.resolve(audioOut) : `${base}.wav`) : null, txt: `${base}.txt` };
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * What already holds a recording's names: existing files, or another running recording that will
 * write them. `running` are the state files of running recordings ({ audioPath, textPath }).
 */
function takenNames(paths, running = []) {
  const taken = [];
  for (const file of [paths.wav, paths.txt].filter(Boolean)) {
    const busy = running.some(r => [r.audioPath, r.textPath].some(p => p && samePath(p, file)));
    if (busy) taken.push(`${path.basename(file)} (being recorded now)`);
    else if (fs.existsSync(file)) taken.push(path.basename(file));
  }
  return taken;
}

/** True when a running recording owns one of these names: even --overwrite must not take it. */
function takenByRunning(paths, running = []) {
  return [paths.wav, paths.txt]
    .filter(Boolean)
    .some(file => running.some(r => [r.audioPath, r.textPath].some(p => p && samePath(p, file))));
}

/** Throws NameTakenError unless the names are free (or overwrite is set and no recording uses them). */
function checkNames(paths, running, { overwrite = false } = {}) {
  const taken = takenNames(paths, running);
  if (!taken.length) return;
  const recording = takenByRunning(paths, running);
  if (overwrite && !recording) return;
  throw new NameTakenError(paths.base, taken, { recording });
}

/** True when the file is one Scriptorium wrote into one of its folders (safe to delete with a note). */
function isOwnFile(file, dirs) {
  const abs = path.resolve(file).toLowerCase();
  return dirs.some(d => abs.startsWith(path.resolve(d).toLowerCase() + path.sep));
}

module.exports = {
  NAME_TAKEN_EXIT,
  NameTakenError,
  documentsDir,
  outputDir,
  safeFileName,
  defaultTitle,
  recordingPaths,
  takenNames,
  checkNames,
  isOwnFile,
};
