import initSqlJs from 'sql.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', 'cardlistcompare.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

let db;

export async function initDb() {
  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      email TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: add email column to existing databases
  // Note: SQLite ALTER TABLE ADD COLUMN does not support UNIQUE constraint,
  // so we add the column plain and enforce uniqueness via a separate index.
  try {
    db.run('ALTER TABLE users ADD COLUMN email TEXT');
  } catch {
    // Column already exists — ignore
  }
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');

  // Migration: add is_admin column to existing databases
  try {
    db.run('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }

  // Auto-promote user id=1 to admin (idempotent)
  db.run('UPDATE users SET is_admin = 1 WHERE id = 1');

  db.run(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tracked_owners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      archidekt_username TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, archidekt_username)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tracked_decks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tracked_owner_id INTEGER NOT NULL REFERENCES tracked_owners(id) ON DELETE CASCADE,
      archidekt_deck_id INTEGER NOT NULL,
      deck_name TEXT NOT NULL,
      deck_url TEXT,
      last_refreshed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, archidekt_deck_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS deck_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracked_deck_id INTEGER NOT NULL REFERENCES tracked_decks(id) ON DELETE CASCADE,
      deck_text TEXT NOT NULL,
      nickname TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS shared_comparisons (
      id TEXT PRIMARY KEY,
      before_text TEXT NOT NULL,
      after_text TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Seed default settings
  db.run(`INSERT OR IGNORE INTO server_settings (key, value) VALUES ('registration_enabled', 'true')`);

  // Migration: add commanders column to tracked_decks
  try {
    db.run('ALTER TABLE tracked_decks ADD COLUMN commanders TEXT');
  } catch {
    // Column already exists — ignore
  }

  // Backfill commanders from latest snapshots for existing decks
  const decksNeedingCommanders = all(
    'SELECT d.id FROM tracked_decks d WHERE d.commanders IS NULL'
  );
  if (decksNeedingCommanders.length > 0) {
    const { parse: parseDeck } = await import('../src/lib/parser.js');
    for (const deck of decksNeedingCommanders) {
      const snap = get(
        'SELECT deck_text FROM deck_snapshots WHERE tracked_deck_id = ? ORDER BY created_at DESC LIMIT 1',
        [deck.id]
      );
      if (snap?.deck_text) {
        try {
          const parsed = parseDeck(snap.deck_text);
          const cmds = parsed.commanders || [];
          run('UPDATE tracked_decks SET commanders = ? WHERE id = ?',
            [JSON.stringify(cmds), deck.id]);
        } catch {
          run('UPDATE tracked_decks SET commanders = ? WHERE id = ?',
            [JSON.stringify([]), deck.id]);
        }
      } else {
        run('UPDATE tracked_decks SET commanders = ? WHERE id = ?',
          [JSON.stringify([]), deck.id]);
      }
    }
  }

  // Indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_tracked_owners_user ON tracked_owners(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tracked_decks_user ON tracked_decks(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tracked_decks_owner ON tracked_decks(tracked_owner_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_deck_snapshots_deck ON deck_snapshots(tracked_deck_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_deck_snapshots_created ON deck_snapshots(tracked_deck_id, created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_reset_tokens_token ON password_reset_tokens(token)');

  persist();
  return db;
}

export function persist() {
  if (!db) return;
  const data = db.export();
  writeFileSync(DB_PATH, Buffer.from(data));
}

// Helper to run a query and return all rows as objects
export function all(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Helper to get a single row
export function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

// Helper to run an INSERT/UPDATE/DELETE and return info
export function run(sql, params = []) {
  db.run(sql, params);
  const lastId = db.exec('SELECT last_insert_rowid() as id')[0]?.values[0]?.[0];
  const changes = db.getRowsModified();
  persist();
  return { lastInsertRowid: lastId, changes };
}

export function getDb() {
  return db;
}
