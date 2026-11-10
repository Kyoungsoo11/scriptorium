'use strict';
// Local note store. Mirrors the parts of Alt's schema that transcription touches
// (lecture_notes, folders, note_components) without any sync columns: nothing leaves this machine.
//
// A transcript component's content_text uses Alt's format: a JSON array of entries, each
// { speaker, segments: [{ start, end, text, speaker }] } with times in ms from the recording start.
// Speaker display names live in the component's metadata.speakerNames.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lecture_notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  lecture_date TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  source_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS note_components (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES lecture_notes(id) ON DELETE CASCADE,
  component_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_text TEXT,
  metadata TEXT,
  file_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_folder ON lecture_notes(folder_id);
CREATE INDEX IF NOT EXISTS idx_components_note ON note_components(note_id);
`;

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

class Store {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // ---- folders -------------------------------------------------------------

  listFolders() {
    return this.db.prepare('SELECT * FROM folders ORDER BY name').all().map(plain);
  }

  createFolder(name, parentId = null) {
    if (parentId) this.requireFolder(parentId);
    const row = { id: newId(), name, parent_id: parentId, created_at: now() };
    this.db
      .prepare('INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)')
      .run(row.id, row.name, row.parent_id, row.created_at);
    return row;
  }

  /** Folder by id or exact name; with create, a missing name becomes a new top-level folder. */
  resolveFolder(ref, { create = false } = {}) {
    if (ref === undefined || ref === null || ref === '' || ref === 'null') return null;
    const byId = this.db.prepare('SELECT * FROM folders WHERE id = ?').get(ref);
    if (byId) return plain(byId);
    const byName = this.db.prepare('SELECT * FROM folders WHERE name = ?').all(ref);
    if (byName.length > 1) throw new UsageError(`More than one folder is named "${ref}"; use its id`);
    if (byName.length === 1) return plain(byName[0]);
    if (create) return this.createFolder(ref);
    throw new UsageError(`No folder "${ref}"`);
  }

  requireFolder(id) {
    const row = this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!row) throw new UsageError(`No folder ${id}`);
    return plain(row);
  }

  deleteFolder(id) {
    this.requireFolder(id);
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  }

  // ---- notes ---------------------------------------------------------------

  createNote({ title, folderId = null, type, status = 'processing', sourcePath = null, lectureDate }) {
    const t = now();
    const row = {
      id: newId(),
      title,
      folder_id: folderId,
      lecture_date: lectureDate || t,
      type,
      status,
      source_path: sourcePath,
      created_at: t,
      updated_at: t,
    };
    this.db
      .prepare(
        `INSERT INTO lecture_notes (id, title, folder_id, lecture_date, type, status, source_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...Object.values(row));
    return row;
  }

  getNote(id) {
    const row = this.db.prepare('SELECT * FROM lecture_notes WHERE id = ?').get(id);
    if (!row) throw new UsageError(`No note ${id}`);
    return plain(row);
  }

  listNotes({ folderId, search, limit = 50 } = {}) {
    const where = [];
    const args = [];
    if (folderId !== undefined) {
      where.push(folderId === null ? 'n.folder_id IS NULL' : 'n.folder_id = ?');
      if (folderId !== null) args.push(folderId);
    }
    if (search) {
      // Title or transcript text, like Alt's lectureNotes:search.
      where.push(
        `(n.title LIKE ? OR EXISTS (SELECT 1 FROM note_components c
           WHERE c.note_id = n.id AND c.component_type = 'transcript' AND c.content_text LIKE ?))`,
      );
      args.push(`%${search}%`, `%${search}%`);
    }
    const sql = `SELECT n.* FROM lecture_notes n ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY n.lecture_date DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit).map(plain);
  }

  updateNote(id, changes) {
    this.getNote(id);
    const allowed = ['title', 'folder_id', 'status', 'lecture_date'];
    const keys = Object.keys(changes).filter(k => allowed.includes(k));
    if (keys.length === 0) return this.getNote(id);
    const sets = keys.map(k => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE lecture_notes SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...keys.map(k => changes[k]), now(), id);
    return this.getNote(id);
  }

  /** Deletes the note and its components; returns files the caller may remove. */
  deleteNote(id) {
    this.getNote(id);
    const files = this.getComponents(id)
      .map(c => c.file_path)
      .filter(Boolean);
    this.db.prepare('DELETE FROM lecture_notes WHERE id = ?').run(id);
    return files;
  }

  // ---- components ----------------------------------------------------------

  addComponent({ noteId, type, title, contentText = null, metadata = null, filePath = null }) {
    const t = now();
    const row = {
      id: newId(),
      note_id: noteId,
      component_type: type,
      title,
      content_text: contentText,
      metadata: metadata ? JSON.stringify(metadata) : null,
      file_path: filePath,
      created_at: t,
      updated_at: t,
    };
    this.db
      .prepare(
        `INSERT INTO note_components (id, note_id, component_type, title, content_text, metadata, file_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...Object.values(row));
    return this.decode(row);
  }

  updateComponent(id, { contentText, metadata }) {
    const sets = [];
    const args = [];
    if (contentText !== undefined) {
      sets.push('content_text = ?');
      args.push(contentText);
    }
    if (metadata !== undefined) {
      sets.push('metadata = ?');
      args.push(JSON.stringify(metadata));
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE note_components SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...args, now(), id);
  }

  getComponents(noteId) {
    return this.db
      .prepare('SELECT * FROM note_components WHERE note_id = ? ORDER BY created_at')
      .all(noteId)
      .map(r => this.decode(plain(r)));
  }

  getTranscript(noteId) {
    const row = this.db
      .prepare(
        "SELECT * FROM note_components WHERE note_id = ? AND component_type = 'transcript' ORDER BY created_at LIMIT 1",
      )
      .get(noteId);
    return row ? this.decode(plain(row)) : null;
  }

  decode(row) {
    return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
  }
}

/** node:sqlite returns null-prototype rows; JSON output wants plain objects. */
function plain(row) {
  return row ? { ...row } : row;
}

class UsageError extends Error {}

module.exports = { Store, UsageError };
