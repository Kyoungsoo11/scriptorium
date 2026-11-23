'use strict';
// `notes ...` and `speakers rename`. The functions return data; the cmd* wrappers print it.
// The MCP server calls the functions directly instead of starting the CLI for each read.

const fs = require('node:fs');
const path = require('node:path');

const { UsageError } = require('../store');
const { render, fromAltEntries } = require('../format');
const { outputDir, isOwnFile } = require('../output');
const { printJson, withStore, formatFor } = require('./common');

/** A note with its transcript segments, speaker names and files. */
function noteView(store, id) {
  const note = store.getNote(id);
  const components = store.getComponents(id);
  const transcript = components.find(c => c.component_type === 'transcript');
  const segments = transcript ? fromAltEntries(JSON.parse(transcript.content_text || '[]')) : [];
  return {
    note,
    speakerNames: transcript?.metadata?.speakerNames ?? {},
    files: components.filter(c => c.file_path).map(c => ({ type: c.component_type, path: c.file_path, ...c.metadata })),
    segments,
  };
}

function listNotes(env, { search, limit = 50 } = {}) {
  return withStore(env, store => store.listNotes({ search, limit: Number(limit) || 50 }));
}

function getNote(env, id) {
  return withStore(env, store => noteView(store, id));
}

/** The transcript as text in a format (md, timed, txt, srt, vtt, json) with the note it came from. */
function transcriptText(env, id, format = 'md') {
  return withStore(env, store => {
    const view = noteView(store, id);
    return { view, text: render(view.segments, format, { speakerNames: view.speakerNames, title: view.note.title }) };
  });
}

function exportNote(env, id, out, format) {
  const fmt = format || formatFor({}, out);
  const { view, text } = transcriptText(env, id, fmt);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, text);
  return { saved: path.resolve(out), format: fmt, segments: view.segments.length };
}

function renameNote(env, id, title) {
  return withStore(env, store => store.updateNote(id, { title }));
}

/**
 * Writes the note's saved transcript files (the .txt next to a recording or from a transcribed
 * file) again from the stored transcript, e.g. after a speaker was named. Returns the files
 * written; a missing file is left missing (the user deleted or moved it).
 */
function rewriteTextFiles(store, noteId) {
  const view = noteView(store, noteId);
  const written = [];
  for (const c of store.getComponents(noteId)) {
    if (c.component_type !== 'text' || !c.file_path || !fs.existsSync(c.file_path)) continue;
    fs.writeFileSync(c.file_path, render(view.segments, c.metadata?.format || 'timed', { speakerNames: view.speakerNames }));
    written.push(c.file_path);
  }
  return written;
}

function renameSpeaker(env, noteId, speaker, name) {
  return withStore(env, store => {
    const t = store.getTranscript(noteId);
    if (!t) throw new UsageError(`Note ${noteId} has no transcript`);
    const speakerNames = { ...(t.metadata?.speakerNames || {}), [speaker]: name };
    store.updateComponent(t.id, { metadata: { ...(t.metadata || {}), speakerNames } });
    return { noteId, speakerNames, rewritten: rewriteTextFiles(store, noteId) };
  });
}

/** Deletes a note, and (unless keepFiles) the recording and transcript files Scriptorium made for it. */
function deleteNote(env, id, { keepFiles = false, opts = {} } = {}) {
  return withStore(env, store => {
    const files = store.deleteNote(id);
    const own = [env.recordingsDir, outputDir(opts)];
    const removed = keepFiles ? [] : files.filter(f => isOwnFile(f, own) && fs.existsSync(f));
    removed.forEach(f => fs.rmSync(f, { force: true }));
    return { deleted: id, removedFiles: removed };
  });
}

function cmdNotes(env, opts, [sub, ...rest]) {
  switch (sub) {
    case 'list':
      return printJson(listNotes(env, { search: opts.search, limit: opts.limit }));
    case 'show': {
      if (!rest[0]) throw new UsageError('notes show needs a note id');
      if (opts.out) return printJson(exportNote(env, rest[0], opts.out, opts.format));
      if (opts.format) return process.stdout.write(transcriptText(env, rest[0], opts.format).text);
      return printJson(getNote(env, rest[0]));
    }
    case 'export':
      if (!rest[0]) throw new UsageError('notes export needs a note id');
      if (!opts.out) throw new UsageError('notes export needs --out <file>');
      return printJson(exportNote(env, rest[0], opts.out, opts.format));
    case 'rename':
      if (!rest[0] || rest[1] === undefined) throw new UsageError('notes rename <noteId> <title>');
      return printJson(renameNote(env, rest[0], rest[1]));
    case 'delete':
      if (!rest[0]) throw new UsageError('notes delete <noteId>');
      return printJson(deleteNote(env, rest[0], { keepFiles: opts['keep-audio'] || opts['keep-files'], opts }));
    default:
      throw new UsageError('notes list|show|export|rename|delete');
  }
}

function cmdSpeakers(env, opts, [sub, noteId, speaker, name]) {
  if (sub !== 'rename' || !noteId || !speaker || name === undefined)
    throw new UsageError('speakers rename <noteId> <SPEAKER_00> <name>');
  printJson(renameSpeaker(env, noteId, speaker, name));
}

module.exports = {
  noteView,
  listNotes,
  getNote,
  transcriptText,
  exportNote,
  renameNote,
  renameSpeaker,
  deleteNote,
  rewriteTextFiles,
  cmdNotes,
  cmdSpeakers,
};
