'use strict';
// scriptorium: non-interactive CLI. Every command runs to completion from its options alone,
// prints one JSON result on stdout (or the requested transcript format), logs on stderr,
// and exits 0 on success, 1 on failure, 2 on bad usage, 3 when an output file name is taken.
//
// The commands live in src/commands/: transcribe, record (record/stop/pause/resume/status),
// notes (notes/speakers), clean, setup (app/devices/doctor); common holds what they share.

const { resolveEnv } = require('./env');
const { UsageError } = require('./store');
const { parseArgs } = require('./args');
const { printJson } = require('./commands/common');
const { cmdTranscribe } = require('./commands/transcribe');
const { cmdRecord, cmdStop, setPaused, recordingStatus } = require('./commands/record');
const { cmdNotes, cmdSpeakers } = require('./commands/notes');
const { cmdClean } = require('./commands/clean');
const { withTrayApp, cmdApp, cmdDevices, cmdDoctor, VERSION } = require('./commands/setup');

const GLOBAL_VALUES = ['data-dir', 'models-dir', 'whisper-model', 'native', 'log-file'];
const GLOBAL_BOOLEANS = ['quiet', 'help'];
const TRANSCRIBE_VALUES = ['lang', 'prompt', 'backend', 'gpu', 'threads', 'beam', 'speakers', 'vad-threshold', 'title', 'format', 'out', 'output-dir'];
const TRANSCRIBE_BOOLEANS = ['diarize', 'save', 'stream', 'text', 'overwrite'];

const HELP = `Scriptorium ${VERSION} - offline lecture/meeting transcription (no server, no account)

Usage: scriptorium <command> [options]

Transcription
  transcribe <file> [<file> ...]   transcribe audio/video files
  record                           record microphone + system audio and transcribe live
  stop [--id <noteId>]             stop a running recording and wait for its result
  pause [--id <noteId>]            pause a recording (the paused time is left out)
  resume [--id <noteId>]           resume a paused recording
  status                           show running recordings

Notes
  notes list [--search <text>] [--limit <n>]
  notes show <noteId> [--format json|srt|vtt|txt|md|timed]
  notes export <noteId> --format <fmt> --out <file>
  notes rename <noteId> <title>
  notes delete <noteId> [--keep-files]
  speakers rename <noteId> <SPEAKER_00> <name>   (also rewrites the note's .txt)

Cleaning up
  clean                            show what can be deleted, delete nothing
  clean recordings                 delete the .wav files of recordings made up to 0.4 (<data>\\recordings)
  clean run                        delete logs and other leftovers of finished work (<data>\\run)
  clean all                        both; add --dry-run to any of these to only show
    Work in progress is left alone, and so are notes, transcripts and Documents\\Scriptorium.

App
  app                              open the Scriptorium tray app (start recordings, see what is running)

Setup
  devices                          audio devices
  doctor                           check that the engine and models are in place
  setup-claude [--remove [--if-own]] [--dry-run] [--config <file>]
                                   register Scriptorium with Claude Desktop (then restart Claude)
  mcp                              run as an MCP server on stdin/stdout (Claude Desktop starts this)

Files
  Each recording is saved as <title>.wav plus its transcript <title>.txt ("(mm:ss)" then the
  text, written as it goes) in Documents\\Scriptorium; a transcribed file gets <title>.txt there
  (title = file name). A taken name stops before anything starts (exit code 3).

Transcription options (transcribe, record)
  --lang <code|auto>      language, e.g. ko, en; auto = detect (default ko)
  --diarize               separate speakers when the audio ends (default: off)
  --speakers <n>          number of speakers, when known (default: estimate); turns --diarize on
  --prompt <text>         vocabulary/context hint for Whisper
  --backend <auto|cpu|gpu>  gpu needs the GPU build (default auto)
  --gpu <index>           pin a GPU
  --threads <n>           CPU threads (default: the CPU shared with the work already running, 2 to 8)
  --beam <n>              beam size; 1 = greedy, faster (default 5)
  --vad-threshold <0-1>   speech detection sensitivity; lower keeps quieter speech (default 0.15)
  --title <text>          title, and the file name (default: file name / start time)
  --output-dir <dir>      folder for the .wav/.txt (default Documents\\Scriptorium, or SCRIPTORIUM_OUTPUT)
  --overwrite             replace an existing <title>.wav/.txt
  --no-text               do not write the <title>.txt
  --no-save               do not store a note
  --format <fmt>          print the transcript as json|srt|vtt|txt|md|timed instead of the result JSON
  --out <file>            also write the transcript to this file (format from --format or extension)
  --stream                print JSON lines while running: started, segment..., done

Record options
  --duration <time>       stop after e.g. 90s, 45m, 1h30m of recorded time (default: until stopped)
  --mic <id|default|none> microphone (default: system default; none = system audio only)
  --no-system             do not capture system audio (microphone only)
  --audio-out <file.wav>  save the recording here instead (the .txt goes next to it)
  --no-audio              do not keep the recording
  --detach                start in the background, print the note id and return
  Stops on: --duration, "scriptorium stop", Ctrl+C. Pauses with "scriptorium pause" until "resume".

Global options
  --data-dir <dir>        notes database and run state (default %USERPROFILE%\\.scriptorium)
  --models-dir <dir>      model folder (default: models next to scriptorium)
  --whisper-model <file>  a different ggml Whisper model (e.g. a smaller, faster one)
  --quiet                no progress on stderr
`;

const COMMANDS = {
  transcribe: { values: TRANSCRIBE_VALUES, booleans: TRANSCRIBE_BOOLEANS },
  record: {
    values: [...TRANSCRIBE_VALUES, 'duration', 'mic', 'audio-out'],
    booleans: [...TRANSCRIBE_BOOLEANS, 'system', 'audio', 'detach'],
  },
  stop: { values: ['id', 'timeout'], booleans: ['wait', 'all'] },
  pause: { values: ['id'], booleans: ['all'] },
  resume: { values: ['id'], booleans: ['all'] },
  status: {},
  notes: { values: ['search', 'limit', 'format', 'out', 'output-dir'], booleans: ['keep-files', 'keep-audio'] },
  speakers: {},
  clean: { booleans: ['dry-run'] },
  app: {},
  devices: {},
  doctor: { values: ['output-dir'] },
  'setup-claude': { values: ['config'], booleans: ['remove', 'if-own', 'dry-run'] },
  mcp: {},
};

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'version' || command === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  try {
    const spec = COMMANDS[command];
    if (!spec) throw new UsageError(`Unknown command "${command}"`);
    const { opts, positionals } = parseArgs(rest, {
      values: [...GLOBAL_VALUES, ...(spec.values || [])],
      booleans: [...GLOBAL_BOOLEANS, ...(spec.booleans || [])],
    });
    if (opts.help) {
      process.stdout.write(HELP);
      return;
    }
    const env = resolveEnv(opts);
    switch (command) {
      case 'transcribe':
        await withTrayApp(env, () => cmdTranscribe(env, opts, positionals));
        break;
      case 'record':
        // --detach only starts the recorder, which then keeps the app itself
        if (opts.detach) await cmdRecord(env, opts, rest);
        else await withTrayApp(env, () => cmdRecord(env, opts, rest));
        break;
      case 'stop':
        await cmdStop(env, opts);
        break;
      case 'pause':
      case 'resume':
        printJson(await setPaused(env, opts, command === 'pause'));
        break;
      case 'status':
        printJson(recordingStatus(env));
        break;
      case 'notes':
        cmdNotes(env, opts, positionals);
        break;
      case 'speakers':
        cmdSpeakers(env, opts, positionals);
        break;
      case 'clean':
        cmdClean(env, opts, positionals);
        break;
      case 'app':
        await cmdApp(env);
        break;
      case 'devices':
        cmdDevices(env);
        break;
      case 'doctor':
        cmdDoctor(env, opts);
        break;
      case 'setup-claude':
        printJson(
          require('./claude').setupClaude(env, {
            configPath: opts.config,
            remove: opts.remove,
            ifOwn: opts['if-own'],
            dryRun: opts['dry-run'],
          }),
        );
        break;
      case 'mcp':
        await require('./mcp').serve(opts);
        break;
    }
  } catch (err) {
    const usage = err instanceof UsageError;
    process.stderr.write(`scriptorium: ${err.message}\n${usage ? 'Run "scriptorium help" for usage.\n' : ''}`);
    process.exitCode = err.exitCode ?? (usage ? 2 : 1);
  }
}

module.exports = { main };
