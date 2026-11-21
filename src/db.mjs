import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(currentDir, '..');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'confesiones.db');

export const CATEGORIES = [
  'Confesión',
  'Anécdota',
  'Agradecimiento',
  'Saludo',
  'Pregunta',
];

export const STATUSES = ['pending', 'approved', 'read', 'rejected'];
export const LIVE_MODES = ['qr', 'featured', 'wall'];

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS confessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'Anónimo',
    category TEXT NOT NULL DEFAULT 'Confesión',
    status TEXT NOT NULL DEFAULT 'pending',
    is_featured INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_confessions_status_id ON confessions (status, id DESC);
  CREATE INDEX IF NOT EXISTS idx_confessions_featured ON confessions (is_featured);
`);

export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPin(pin, storedHash) {
  if (typeof pin !== 'string' || typeof storedHash !== 'string') {
    return false;
  }
  const parts = storedHash.split(':');
  if (parts.length !== 2) {
    return false;
  }
  const [salt, originalHex] = parts;
  if (!salt || !originalHex) {
    return false;
  }
  const derivedBuf = crypto.scryptSync(pin, salt, 64);
  const originalBuf = Buffer.from(originalHex, 'hex');
  if (derivedBuf.length !== originalBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(derivedBuf, originalBuf);
}

function seedSettings() {
  const defaults = [
    ['event_title', 'Confesiones Anónimas'],
    ['event_subtitle', ''],
    ['submissions_open', 'true'],
    ['live_mode', 'qr'],
    ['public_url', ''],
    ['session_secret', crypto.randomBytes(32).toString('hex')],
    ['presenter_token', crypto.randomBytes(12).toString('hex')],
    ['admin_pin_hash', hashPin(process.env.ADMIN_PIN || '2026')],
  ];
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of defaults) {
    stmt.run(key, value);
  }
}

seedSettings();

function runInTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function normalizeConfession(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    message: row.message,
    author: row.author,
    category: row.category,
    status: row.status,
    is_featured: Boolean(row.is_featured),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return map;
}

export function getPublicSettings() {
  const all = getSettings();
  return {
    event_title: all.event_title || 'Confesiones Anónimas',
    event_subtitle: all.event_subtitle || '',
    submissions_open: all.submissions_open === 'true',
    live_mode: LIVE_MODES.includes(all.live_mode) ? all.live_mode : 'qr',
    public_url: all.public_url || '',
  };
}

export function getAdminSafeSettings() {
  const all = getSettings();
  return {
    event_title: all.event_title || 'Confesiones Anónimas',
    event_subtitle: all.event_subtitle || '',
    submissions_open: all.submissions_open === 'true',
    live_mode: LIVE_MODES.includes(all.live_mode) ? all.live_mode : 'qr',
    public_url: all.public_url || '',
    presenter_token: all.presenter_token || '',
  };
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function updateSettings(partial) {
  runInTransaction(() => {
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        setSetting(key, value);
      }
    }
  });
  return getAdminSafeSettings();
}

export function listConfessions({ status, search, category } = {}) {
  const clauses = [];
  const params = [];

  if (status && STATUSES.includes(status)) {
    clauses.push('status = ?');
    params.push(status);
  }

  if (category && CATEGORIES.includes(category)) {
    clauses.push('category = ?');
    params.push(category);
  }

  if (search && typeof search === 'string' && search.trim()) {
    const escaped = search.trim().replace(/[\\%_]/g, '\\$&');
    const pattern = `%${escaped}%`;
    clauses.push("(message LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM confessions ${whereSql} ORDER BY id DESC`;
  return db.prepare(sql).all(...params).map(normalizeConfession);
}

export function listPublicApproved(limit = 8) {
  const safeLimit = Math.max(1, Math.min(24, Number(limit) || 8));
  return db
    .prepare("SELECT * FROM confessions WHERE status IN ('approved', 'read') ORDER BY id DESC LIMIT ?")
    .all(safeLimit)
    .map(normalizeConfession);
}

export function listPresenterConfessions() {
  return db
    .prepare("SELECT * FROM confessions WHERE status IN ('approved', 'read') ORDER BY id ASC")
    .all()
    .map(normalizeConfession);
}

export function getFeaturedConfession() {
  const row = db
    .prepare("SELECT * FROM confessions WHERE is_featured = 1 AND status IN ('approved', 'read') LIMIT 1")
    .get();
  return normalizeConfession(row);
}

export function getConfessionById(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return null;
  }
  const row = db.prepare('SELECT * FROM confessions WHERE id = ?').get(numericId);
  return normalizeConfession(row);
}

export function getCounts() {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS count FROM confessions GROUP BY status')
    .all();
  const counts = {
    pending: 0,
    approved: 0,
    read: 0,
    rejected: 0,
    total: 0,
  };
  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status] = Number(row.count);
    }
    counts.total += Number(row.count);
  }
  return counts;
}

export function createConfession({ message, author, category }) {
  const now = new Date().toISOString();
  const cleanAuthor = author && author.trim() ? author.trim() : 'Anónimo';
  const cleanCategory = CATEGORIES.includes(category) ? category : 'Confesión';
  const info = db
    .prepare(
      'INSERT INTO confessions (message, author, category, status, is_featured, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    )
    .run(message.trim(), cleanAuthor, cleanCategory, 'pending', now, now);
  return getConfessionById(Number(info.lastInsertRowid));
}

export function updateConfession(id, updates) {
  const existing = getConfessionById(id);
  if (!existing) {
    return null;
  }

  const nextMessage =
    typeof updates.message === 'string' && updates.message.trim()
      ? updates.message.trim()
      : existing.message;
  const nextAuthor =
    typeof updates.author === 'string'
      ? updates.author.trim() || 'Anónimo'
      : existing.author;
  const nextCategory =
    updates.category && CATEGORIES.includes(updates.category)
      ? updates.category
      : existing.category;
  const nextStatus =
    updates.status && STATUSES.includes(updates.status)
      ? updates.status
      : existing.status;

  const nextFeatured =
    nextStatus === 'rejected' || nextStatus === 'pending'
      ? 0
      : existing.is_featured
        ? 1
        : 0;

  const now = new Date().toISOString();
  db.prepare(
    'UPDATE confessions SET message = ?, author = ?, category = ?, status = ?, is_featured = ?, updated_at = ? WHERE id = ?',
  ).run(nextMessage, nextAuthor, nextCategory, nextStatus, nextFeatured, now, existing.id);

  return getConfessionById(existing.id);
}

export function setFeaturedConfession(idOrNull) {
  return runInTransaction(() => {
    const now = new Date().toISOString();
    db.prepare('UPDATE confessions SET is_featured = 0 WHERE is_featured = 1').run();
    if (idOrNull === null || idOrNull === undefined) {
      return null;
    }
    const existing = getConfessionById(idOrNull);
    if (!existing) {
      return null;
    }
    const nextStatus =
      existing.status === 'pending' || existing.status === 'rejected'
        ? 'approved'
        : existing.status;
    db.prepare(
      'UPDATE confessions SET is_featured = 1, status = ?, updated_at = ? WHERE id = ?',
    ).run(nextStatus, now, existing.id);
    setSetting('live_mode', 'featured');
    return getConfessionById(existing.id);
  });
}

export function deleteConfession(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return false;
  }
  const info = db.prepare('DELETE FROM confessions WHERE id = ?').run(numericId);
  return info.changes > 0;
}

export function clearAllConfessions() {
  return runInTransaction(() => {
    const info = db.prepare('DELETE FROM confessions').run();
    return Number(info.changes);
  });
}

export function closeDb() {
  db.close();
}
