'use strict';
// `scriptorium mcp`: an MCP server over stdio (newline-delimited JSON-RPC 2.0) so that Claude
// Desktop's chat, or any MCP client, can drive Scriptorium. Reads (notes, transcripts, running
// recordings) and recording control call the command functions in this process; work that runs
// on (recording, file transcription) starts the CLI detached, so it outlives this server.
//
// File transcription can take longer than a client waits for one tool call (a 70-minute
// lecture takes ~28 minutes on CPU), so it runs as a background job: one tool starts it and
// returns a job id, another reports progress and the result.
//
// Nothing but protocol messages may be written to stdout in this mode.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const { resolveEnv } = require('./env');
const { listDevices } = require('./native');
const notes = require('./commands/notes');
const { setPaused, stopRecordings, recordingStatus } = require('./commands/record');

const VERSION = require('../package.json').version;
const CLI = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const DEFAULT_TEXT_LIMIT = 40000;
const STOP_WAIT_S = 50;

const INSTRUCTIONS = `Scriptorium transcribes lectures and meetings on this computer, offline.
- Transcribe a file: scriptorium_transcribe_file returns a jobId at once; the work takes about 0.4x the
  audio length on CPU (a 1-hour lecture ≈ 25 min). Call scriptorium_get_job every minute or two until
  status is "done", then read the note with scriptorium_get_transcript.
- Record: scriptorium_start_recording (microphone + computer audio by default; mic "none" = computer audio
  only, e.g. an online lecture). scriptorium_control_recording pauses, resumes or stops it; stopping
  finishes the transcript, which can take a few minutes for long recordings. Paused time is left out.
- Files: a recording is saved as <title>.wav plus <title>.txt (the transcript, written as it goes) in
  Documents\\Scriptorium; a transcribed file gets <title>.txt there. Results give audioPath / textPath.
  If the name is taken, starting fails: ask the user for another title, or pass overwrite: true only when
  they agree to replace the old files.
- Transcripts are long: read them in pages with offset/maxChars, or export to a file.
- Speakers are SPEAKER_00, SPEAKER_01, ...; name them with scriptorium_rename_speaker. If the user knows how
  many people spoke, pass speakers (it is more accurate than the estimate).
- File paths are on this Windows computer; use absolute paths.`;

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });

const TRANSCRIBE_PROPS = {
  language: str('Language code such as "ko" or "en", or "auto" (default). Giving it is faster and more accurate.'),
  speakers: int('Number of speakers, if known. Omit to estimate.', { minimum: 1 }),
  diarize: { type: 'boolean', description: 'Separate speakers (default true). False is faster.' },
  title: str('Title, also the file name of the .wav/.txt (default: file name or recording start time).'),
  overwrite: { type: 'boolean', description: 'Replace existing files with this name (default false: fail if the name is taken).' },
  prompt: str('Words or names likely to appear, to help recognition (e.g. "LRU, 세마포어").'),
};

const TOOLS = [
  {
    name: 'scriptorium_transcribe_file',
    title: 'Transcribe an audio or video file',
    description:
      'Starts transcribing a local audio/video file (mp3, m4a, wav, mp4, ...) into a new note and returns a jobId immediately. Poll scriptorium_get_job for progress and the result.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Absolute path of the file on this computer.'), ...TRANSCRIBE_PROPS },
      required: ['path'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'scriptorium_get_job',
    title: 'Check a transcription job',
    description:
      'Status of a job from scriptorium_transcribe_file: "running" with progress, "done" with the note summary (noteId, language, speakers, segment count), or "failed" with the error. Omit jobId to list recent jobs.',
    inputSchema: { type: 'object', properties: { jobId: str('Job id returned by scriptorium_transcribe_file.') } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'scriptorium_start_recording',
    title: 'Start recording and transcribing',
    description:
      'Starts recording in the background and transcribing as it goes; returns the noteId. Captures the default microphone plus whatever the computer is playing, unless told otherwise. The result has audio.microphoneMuted; if it is true, or `warnings` is present, tell the user at once: a muted microphone records only silence.',
    inputSchema: {
      type: 'object',
      properties: {
        mic: str('"default" (default), "none" for computer audio only, or a device id from scriptorium_list_devices.'),
        systemAudio: { type: 'boolean', description: 'Also capture what the computer plays (default true).' },
        duration: str('Stop automatically after this much recorded time, e.g. "50m", "1h30m". Omit to record until stopped.'),
        ...TRANSCRIBE_PROPS,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'scriptorium_control_recording',
    title: 'Pause, resume or stop a recording',
    description: `action "pause" stops recording until "resume" (the paused time is left out of the file and the transcript times). "stop" ends it and waits up to ${STOP_WAIT_S} s for the transcript (the result has textPath); if it is still finishing, check again with scriptorium_list_recordings or scriptorium_get_transcript.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: str('"pause", "resume" or "stop".', { enum: ['pause', 'resume', 'stop'] }),
        noteId: str('Recording to act on; may be omitted when only one is running.'),
      },
      required: ['action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'scriptorium_list_recordings',
    title: 'Running recordings',
    description: 'Recordings currently running, with their noteId, elapsed time and audio state (audio.microphoneMuted, audio.microphoneSilent = 10 s or more of pure digital silence). Relay any `warnings` to the user: the microphone is not being recorded.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'scriptorium_list_notes',
    title: 'List or search notes',
    description: 'Notes newest first (id, title, date, status). Search matches titles and transcript text.',
    inputSchema: {
      type: 'object',
      properties: {
        search: str('Words to find in titles or transcripts.'),
        limit: int('Maximum notes (default 50).', { minimum: 1, maximum: 500 }),
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'scriptorium_get_transcript',
    title: 'Read a transcript',
    description:
      'Transcript of a note as text. Long transcripts come in pages: pass the returned nextOffset to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: str('Note id.'),
        format: str('"md" (default: paragraphs by speaker with times), "timed" (the .txt file\'s format), "txt", "srt", "vtt" or "json".', {
          enum: ['md', 'timed', 'txt', 'srt', 'vtt', 'json'],
        }),
        offset: int('Character offset to start from (default 0).', { minimum: 0 }),
        maxChars: int(`Characters per page (default ${DEFAULT_TEXT_LIMIT}).`, { minimum: 1000, maximum: 200000 }),
      },
      required: ['noteId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'scriptorium_export_transcript',
    title: 'Save a transcript to a file',
    description: 'Writes a note\'s transcript to a file (SRT/VTT subtitles, text, Markdown or JSON).',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: str('Note id.'),
        path: str('Absolute path of the file to write; the extension picks the format unless format is given.'),
        format: str('"srt", "vtt", "txt", "md", "timed" or "json".', { enum: ['md', 'timed', 'txt', 'srt', 'vtt', 'json'] }),
      },
      required: ['noteId', 'path'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'scriptorium_rename_speaker',
    title: 'Name a speaker',
    description: 'Gives a speaker label (e.g. SPEAKER_00) a display name in one note, and rewrites the note\'s saved .txt transcript with the new name.',
    inputSchema: {
      type: 'object',
      properties: { noteId: str('Note id.'), speaker: str('Label such as SPEAKER_00.'), name: str('Display name.') },
      required: ['noteId', 'speaker', 'name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'scriptorium_rename_note',
    title: 'Rename a note',
    description: 'Changes a note\'s title.',
    inputSchema: {
      type: 'object',
      properties: { noteId: str('Note id.'), title: str('New title.') },
      required: ['noteId', 'title'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'scriptorium_list_devices',
    title: 'Audio devices',
    description: 'Microphones and speakers on this computer, with ids for scriptorium_start_recording, the default of each, and for microphones whether Windows has it muted (muted: true), which records only silence. Speakers have no muted field: computer audio is recorded even when the speaker is muted.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

// ---- running the CLI -------------------------------------------------------------------

class ToolError extends Error {}

/** Runs `scriptorium <args>` and returns { code, stdout, stderr }. */
function runCli(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, ...args, '--quiet'], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.setEncoding('utf8').on('data', d => (stdout += d));
    p.stderr.setEncoding('utf8').on('data', d => (stderr += d));
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', reject);
    p.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function cliError(r) {
  const line = r.stderr
    .split('\n')
    .map(l => l.trim())
    .find(l => l.startsWith('scriptorium:'));
  return new ToolError(line ? line.replace(/^scriptorium:\s*/, '') : r.stderr.trim() || `exit ${r.code}`);
}

async function cliJson(args, opts) {
  const r = await runCli(args, opts);
  if (r.code !== 0) throw cliError(r);
  return JSON.parse(r.stdout);
}

function transcribeArgs(a) {
  const out = [];
  if (a.language) out.push('--lang', String(a.language));
  if (a.speakers) out.push('--speakers', String(a.speakers));
  if (a.diarize === false) out.push('--no-diarize');
  if (a.title) out.push('--title', String(a.title));
  if (a.overwrite === true) out.push('--overwrite');
  if (a.prompt) out.push('--prompt', String(a.prompt));
  return out;
}

/** Runs a command function here; its errors become tool errors the client shows as text. */
async function direct(fn) {
  try {
    return await fn();
  } catch (e) {
    throw new ToolError(e.message);
  }
}

function need(a, ...keys) {
  for (const k of keys) if (a[k] === undefined || a[k] === null || a[k] === '') throw new ToolError(`${k} is required`);
}

// ---- background jobs ---------------------------------------------------------------------

function jobsDir(env) {
  const dir = path.join(env.runDir, 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function startJob(env, a) {
  need(a, 'path');
  const file = path.resolve(String(a.path));
  if (!fs.existsSync(file)) throw new ToolError(`No such file: ${file}`);
  const id = crypto.randomBytes(6).toString('hex');
  const dir = jobsDir(env);
  const out = fs.openSync(path.join(dir, `${id}.out`), 'w');
  const log = fs.openSync(path.join(dir, `${id}.log`), 'w');
  // Detached: the job outlives this server (Claude Desktop may restart it).
  const child = spawn(process.execPath, [CLI, 'transcribe', file, ...transcribeArgs(a)], {
    detached: true,
    stdio: ['ignore', out, log],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(log);
  const job = { jobId: id, pid: child.pid, file, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(job));
  return { ...job, status: 'running', hint: 'Check with scriptorium_get_job; expect about 0.4x the audio length.' };
}

function readJob(env, id) {
  const dir = jobsDir(env);
  if (!/^[0-9a-f]{12}$/.test(String(id))) throw new ToolError(`Unknown job ${id}`);
  const metaFile = path.join(dir, `${id}.json`);
  if (!fs.existsSync(metaFile)) throw new ToolError(`Unknown job ${id}`);
  const job = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const read = ext => {
    try {
      return fs.readFileSync(path.join(dir, `${id}.${ext}`), 'utf8');
    } catch {
      return '';
    }
  };
  const out = read('out').trim();
  const log = read('log');
  if (out) {
    try {
      const { segments, ...result } = JSON.parse(out);
      return { ...job, status: 'done', result: { ...result, segmentCount: segments?.length ?? 0 } };
    } catch {
      /* still being written */
    }
  }
  const elapsedSeconds = Math.round((Date.now() - Date.parse(job.startedAt)) / 1000);
  if (alive(job.pid)) {
    const total = /transcribing .* \((\d+) s\)/.exec(log)?.[1];
    const done = [...log.matchAll(/transcribed (\d+) s/g)].pop()?.[1];
    const stage = /separating speakers/.test(log) ? 'separating speakers' : total ? 'transcribing' : 'starting';
    return {
      ...job,
      status: 'running',
      stage,
      elapsedSeconds,
      progress: total ? { transcribedSeconds: Number(done || 0), totalSeconds: Number(total), percent: Math.round((100 * Number(done || 0)) / Number(total)) } : null,
    };
  }
  const error = log
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('scriptorium:'))
    .pop();
  return { ...job, status: 'failed', elapsedSeconds, error: error ? error.replace(/^scriptorium:\s*/, '') : 'The job stopped without a result.' };
}

function listJobs(env) {
  const dir = jobsDir(env);
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .map(id => {
      try {
        const j = readJob(env, id);
        return { jobId: j.jobId, file: j.file, status: j.status, startedAt: j.startedAt, noteId: j.result?.noteId ?? null };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20);
}

// ---- tools -------------------------------------------------------------------------------------

async function callTool(env, name, a = {}) {
  switch (name) {
    case 'scriptorium_transcribe_file':
      return startJob(env, a);
    case 'scriptorium_get_job':
      return a.jobId ? readJob(env, a.jobId) : { jobs: listJobs(env) };
    case 'scriptorium_start_recording': {
      const args = ['record', '--detach', ...transcribeArgs(a)];
      if (a.mic) args.push('--mic', String(a.mic));
      if (a.systemAudio === false) args.push('--no-system');
      if (a.duration) args.push('--duration', String(a.duration));
      return cliJson(args, { timeoutMs: 120000 });
    }
    case 'scriptorium_control_recording': {
      need(a, 'action');
      const target = { id: a.noteId ? String(a.noteId) : undefined };
      if (a.action === 'pause' || a.action === 'resume') return direct(() => setPaused(env, target, a.action === 'pause'));
      if (a.action !== 'stop') throw new ToolError('action must be "pause", "resume" or "stop"');
      const r = await direct(() => stopRecordings(env, target, STOP_WAIT_S * 1000));
      if (r.pending.length) {
        return { status: 'finishing', message: 'Recording stopped; the transcript is still being finished. Check again in a minute.' };
      }
      return r.done.length === 1 ? r.done[0] : r.done;
    }
    case 'scriptorium_list_recordings':
      return recordingStatus(env);
    case 'scriptorium_list_notes':
      return direct(() => notes.listNotes(env, { search: a.search, limit: a.limit }));
    case 'scriptorium_get_transcript': {
      need(a, 'noteId');
      const { view, text: all } = await direct(() => notes.transcriptText(env, String(a.noteId), a.format || 'md'));
      const offset = Math.max(0, Number(a.offset) || 0);
      const limit = Math.max(1000, Number(a.maxChars) || DEFAULT_TEXT_LIMIT);
      const text = all.slice(offset, offset + limit);
      const next = offset + limit < all.length ? offset + limit : null;
      return {
        __text: text,
        meta: {
          noteId: view.note.id,
          title: view.note.title,
          status: view.note.status,
          segments: view.segments.length,
          speakerNames: view.speakerNames,
          files: view.files.map(f => ({ type: f.type, path: f.path })),
          totalChars: all.length,
          offset,
          nextOffset: next,
        },
      };
    }
    case 'scriptorium_export_transcript':
      need(a, 'noteId', 'path');
      return direct(() => notes.exportNote(env, String(a.noteId), path.resolve(String(a.path)), a.format));
    case 'scriptorium_rename_speaker':
      need(a, 'noteId', 'speaker', 'name');
      return direct(() => notes.renameSpeaker(env, String(a.noteId), String(a.speaker), String(a.name)));
    case 'scriptorium_rename_note':
      need(a, 'noteId', 'title');
      return direct(() => notes.renameNote(env, String(a.noteId), String(a.title)));
    case 'scriptorium_list_devices':
      return direct(() => ({ audio: listDevices(env) }));
    default:
      throw new ToolError(`Unknown tool ${name}`);
  }
}

function toContent(result) {
  if (result && typeof result === 'object' && '__text' in result) {
    return [
      { type: 'text', text: JSON.stringify(result.meta) },
      { type: 'text', text: result.__text },
    ];
  }
  return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
}

// ---- protocol ------------------------------------------------------------------------------------

async function handle(env, msg) {
  const { method, params } = msg;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'scriptorium', title: 'Scriptorium', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        return { content: toContent(await callTool(env, params?.name, params?.arguments || {})) };
      } catch (err) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

function serve(opts = {}) {
  const env = resolveEnv(opts);
  const send = m => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (msg.id === undefined || msg.id === null) return; // notifications need no reply
    // Answer each request when it finishes; a slow call must not hold up others.
    handle(env, msg).then(
      result => send({ id: msg.id, result }),
      err => send({ id: msg.id, error: { code: err.code || -32603, message: err.message } }),
    );
  });
  return new Promise(resolve => rl.on('close', resolve));
}

module.exports = { serve, TOOLS, callTool, readJob };
