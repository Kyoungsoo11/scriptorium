#!/usr/bin/env node
'use strict';
// Builds the distributable folder and zip:
//   dist/scriptorium-<version>-win-x64/
//     scriptorium.cmd          entry point (uses the bundled Node runtime)
//     runtime/node.exe      the Node.js that runs this script (signed by the OpenJS Foundation)
//     app/                  JS sources + sherpa-onnx (ONNX Runtime) modules
//     native/               scriptorium-core.exe + whisper.cpp/ggml DLLs
//     models/               Whisper, Silero VAD, pyannote segmentation, 3D-Speaker embedding
//     LICENSES/             third-party notices and license texts
// Usage: node scripts/package.js [--build cpu|vulkan] [--no-zip]

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const build = opt('--build', 'cpu');
const zip = !args.includes('--no-zip');

const name = `scriptorium-${pkg.version}-win-x64${build === 'vulkan' ? '-gpu' : ''}`;
const OUT = path.join(ROOT, 'dist', name);
const nativeSrc = path.join(ROOT, 'build', `whisper-${build}`, 'bin');

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function copyDir(src, dst, filter = () => true) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (!filter(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d, filter);
    else copy(s, d);
  }
}
function need(file) {
  if (!fs.existsSync(file)) {
    console.error(`missing: ${file}`);
    process.exit(1);
  }
  return file;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// app
copyDir(path.join(ROOT, 'src'), path.join(OUT, 'app', 'src'));
copyDir(path.join(ROOT, 'bin'), path.join(OUT, 'app', 'bin'));
const appPkg = { ...pkg, scripts: undefined, devDependencies: undefined };
fs.writeFileSync(path.join(OUT, 'app', 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`);
for (const mod of ['sherpa-onnx-node', 'sherpa-onnx-win-x64']) {
  copyDir(need(path.join(ROOT, 'node_modules', mod)), path.join(OUT, 'app', 'node_modules', mod));
}

// runtime
copy(process.execPath, path.join(OUT, 'runtime', 'node.exe'));

// native: the helper and the libraries it loads, not whisper.cpp's sample programs
need(path.join(nativeSrc, 'scriptorium-core.exe'));
for (const f of fs.readdirSync(nativeSrc)) {
  if (f === 'scriptorium-core.exe' || /^(whisper|ggml.*)\.dll$/i.test(f)) copy(path.join(nativeSrc, f), path.join(OUT, 'native', f));
}

// Visual C++ runtime, app-local (Microsoft permits redistributing the files in VC\Redist), so
// the package runs on PCs without the VC++ 2015-2022 redistributable. whisper/ggml and
// onnxruntime both need it; ONNX Runtime also needs the newer vcruntime140_threads.dll.
// Each copy sits next to the DLLs that load it (Windows searches the loading module's folder
// for a native addon, and the exe's folder for scriptorium-core).
const redistRoot = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Redist\\MSVC';
const redistVersion = fs
  .readdirSync(need(redistRoot))
  .filter(v => /^\d+\.\d+\.\d+$/.test(v) && fs.existsSync(path.join(redistRoot, v, 'x64', 'Microsoft.VC143.CRT')))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .pop();
const crtDirs = ['Microsoft.VC143.CRT', 'Microsoft.VC143.OpenMP'].map(d => path.join(redistRoot, redistVersion, 'x64', d));
for (const dest of [path.join(OUT, 'native'), path.join(OUT, 'app', 'node_modules', 'sherpa-onnx-win-x64')]) {
  for (const dir of crtDirs) for (const f of fs.readdirSync(need(dir))) copy(path.join(dir, f), path.join(dest, f));
}
console.log(`VC++ runtime ${redistVersion} bundled`);

// models
const { MODEL_FILES } = require(path.join(ROOT, 'src', 'env.js'));
for (const f of Object.values(MODEL_FILES)) copy(need(path.join(ROOT, 'models', f)), path.join(OUT, 'models', f));

// entry point and docs
fs.writeFileSync(path.join(OUT, 'scriptorium.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0app\\bin\\scriptorium.js" %*\r\n');
copy(path.join(ROOT, 'README.md'), path.join(OUT, 'README.md'));

// licenses
const L = path.join(OUT, 'LICENSES');
copy(need(path.join(ROOT, 'vendor', 'whisper.cpp', 'LICENSE')), path.join(L, 'whisper.cpp-ggml-MIT.txt'));
copyDir(path.join(ROOT, 'licenses'), L);
copy(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), path.join(L, 'THIRD_PARTY_NOTICES.md'));

const size = dir =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`folder: ${OUT} (${(size(OUT) / 1e6).toFixed(0)} MB)`);

if (zip) {
  const zipPath = `${OUT}.zip`;
  fs.rmSync(zipPath, { force: true });
  // Windows' own tar.exe (bsdtar, Windows 10+) writes zip archives; called by full path because
  // Git Bash puts GNU tar first, which cannot write zip and reads "C:" as a remote host.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const r = spawnSync(tar, ['-a', '-c', '-f', zipPath, '-C', path.dirname(OUT), name], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`zip: ${zipPath} (${(fs.statSync(zipPath).size / 1e6).toFixed(0)} MB)`);
}
