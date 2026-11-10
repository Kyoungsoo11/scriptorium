'use strict';
// Where things live. Everything scriptorium needs ships inside its own folder: the native helper
// (scriptorium-core.exe + whisper.cpp DLLs), the ONNX runtime (sherpa-onnx), and the models.
//
// Packaged layout (dist):          Development layout (this repo):
//   <root>/app/src/...               <root>/src/...
//   <root>/native/scriptorium-core.exe        <root>/build/whisper-<cpu|vulkan>/bin/scriptorium-core.exe
//   <root>/models/*                  <root>/models/*
//   <root>/runtime/node.exe          system node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP_DIR = path.resolve(__dirname, '..');
const PACKAGED = path.basename(APP_DIR) === 'app' && fs.existsSync(path.join(APP_DIR, '..', 'native'));
const ROOT = PACKAGED ? path.resolve(APP_DIR, '..') : APP_DIR;

const MODEL_FILES = {
  whisper: 'ggml-large-v3-turbo-q5_0.bin',
  vad: 'silero_vad.onnx',
  segmentation: 'pyannote-segmentation-3.0.onnx',
  embedding: '3dspeaker_eres2net_base_16k.onnx',
};

/** The first native build found: Vulkan (GPU) preferred over CPU unless asked otherwise. */
function nativeDir(opts) {
  if (opts.native) return path.resolve(opts.native);
  if (process.env.SCRIPTORIUM_NATIVE) return path.resolve(process.env.SCRIPTORIUM_NATIVE);
  if (PACKAGED) return path.join(ROOT, 'native');
  const order = opts.backend === 'cpu' ? ['cpu', 'vulkan'] : ['vulkan', 'cpu'];
  const builds = order.map(m => path.join(ROOT, 'build', `whisper-${m}`, 'bin'));
  return builds.find(d => fs.existsSync(path.join(d, 'scriptorium-core.exe'))) || builds[0];
}

function resolveEnv(opts = {}) {
  const modelsDir = path.resolve(opts['models-dir'] || process.env.SCRIPTORIUM_MODELS || path.join(ROOT, 'models'));
  // Not under AppData: the Microsoft Store build of Claude Desktop runs MCP servers in its
  // package container, where AppData writes are redirected to a private copy. A folder in the
  // user profile is the same for the terminal, Claude chat and Claude Code.
  const dataDir = path.resolve(opts['data-dir'] || process.env.SCRIPTORIUM_HOME || path.join(os.homedir(), '.scriptorium'));
  const native = nativeDir(opts);
  return {
    dataDir,
    dbPath: path.join(dataDir, 'scriptorium.db'),
    recordingsDir: path.join(dataDir, 'recordings'),
    runDir: path.join(dataDir, 'run'),
    nativeDir: native,
    coreExe: path.join(native, 'scriptorium-core.exe'),
    gpuBuild: fs.existsSync(path.join(native, 'ggml-vulkan.dll')),
    modelsDir,
    whisperModel: opts['whisper-model'] ? path.resolve(opts['whisper-model']) : path.join(modelsDir, MODEL_FILES.whisper),
    vadModel: path.join(modelsDir, MODEL_FILES.vad),
    segmentationModel: path.join(modelsDir, MODEL_FILES.segmentation),
    embeddingModel: path.join(modelsDir, MODEL_FILES.embedding),
  };
}

function checkRequired(env, { diarize = true } = {}) {
  const required = [
    ['native helper', env.coreExe],
    ['whisper model', env.whisperModel],
    ['VAD model', env.vadModel],
  ];
  if (diarize) {
    required.push(['speaker segmentation model', env.segmentationModel], ['speaker embedding model', env.embeddingModel]);
  }
  return required.map(([name, file]) => ({ name, path: file, ok: fs.existsSync(file) }));
}

module.exports = { resolveEnv, checkRequired, MODEL_FILES };
