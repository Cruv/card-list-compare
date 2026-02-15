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

  // Migration: add last_login_at column to users
  try {
    db.run('ALTER TABLE users ADD COLUMN last_login_at TEXT');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add suspended column to users
  try {
    db.run('ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }

  // Admin audit log table
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER NOT NULL,
      admin_username TEXT NOT NULL,
      action TEXT NOT NULL,
      target_user_id INTEGER,
      target_username TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: add password_changed_at column to users (Phase 2 session management)
  try {
    db.run('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add email_verified column to users (Phase 2 email verification)
  try {
    db.run('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }

  // Email verification tokens table
  db.run(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: add brute-force protection columns (Phase 3)
  try {
    db.run('ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run('ALTER TABLE users ADD COLUMN locked_until TEXT');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add locked column to deck_snapshots (snapshot pruning)
  try {
    db.run('ALTER TABLE deck_snapshots ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }

  // Seed snapshot pruning settings
  db.run(`INSERT OR IGNORE INTO server_settings (key, value) VALUES ('max_snapshots_per_deck', '25')`);
  db.run(`INSERT OR IGNORE INTO server_settings (key, value) VALUES ('max_locked_per_deck', '5')`);

  // Seed price display setting
  db.run(`INSERT OR IGNORE INTO server_settings (key, value) VALUES ('price_display_enabled', 'true')`);

  // Migration: convert registration_enabled from boolean to tri-state
  const regSetting = get("SELECT value FROM server_settings WHERE key = 'registration_enabled'");
  if (regSetting) {
    if (regSetting.value === 'true') {
      run("UPDATE server_settings SET value = 'open' WHERE key = 'registration_enabled'");
    } else if (regSetting.value === 'false') {
      run("UPDATE server_settings SET value = 'closed' WHERE key = 'registration_enabled'");
    }
  }

  // Invite codes table
  db.run(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      max_uses INTEGER NOT NULL DEFAULT 1,
      use_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Invite redemptions audit trail
  db.run(`
    CREATE TABLE IF NOT EXISTS invite_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invite_code_id INTEGER NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redeemed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: add can_invite column to users
  try {
    db.run('ALTER TABLE users ADD COLUMN can_invite INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }

  // Shared deck views table (public read-only links to tracked decks)
  db.run(`
    CREATE TABLE IF NOT EXISTS shared_deck_views (
      id TEXT PRIMARY KEY,
      tracked_deck_id INTEGER NOT NULL REFERENCES tracked_decks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_deck_views_deck ON shared_deck_views(tracked_deck_id)');

  // Migration: add notify_on_change column to tracked_decks
  try {
    db.run('ALTER TABLE tracked_decks ADD COLUMN notify_on_change INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add last_notified_at column to tracked_decks
  try {
    db.run('ALTER TABLE tracked_decks ADD COLUMN last_notified_at TEXT');
  } catch {
    // Column already exists — ignore
  }

  // Seed notification settings
  db.run(`INSERT OR IGNORE INTO server_settings (key, value) VALUES ('notifications_enabled', 'true')`);
  db.run(`INSERT OR IGNORE INTO server_settings (key, value) VALUES ('notification_check_interval_hours', '6')`);

  // Migration: add discord_webhook_url column to tracked_decks
  try {
    db.run('ALTER TABLE tracked_decks ADD COLUMN discord_webhook_url TEXT');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add notes column to tracked_decks
  try {
    db.run('ALTER TABLE tracked_decks ADD COLUMN notes TEXT');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add pinned column to tracked_decks
  try {
    db.run('ALTER TABLE tracked_decks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }

  // Deck tags table (many-to-many via separate rows)
  db.run(`
    CREATE TABLE IF NOT EXISTS deck_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracked_deck_id INTEGER NOT NULL REFERENCES tracked_decks(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      UNIQUE(tracked_deck_id, tag)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_deck_tags_deck ON deck_tags(tracked_deck_id)');

  // Collection cards table
  db.run(`
    CREATE TABLE IF NOT EXISTS collection_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_name TEXT NOT NULL,
      set_code TEXT,
      collector_number TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      is_foil INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, card_name, set_code, collector_number, is_foil)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_collection_user ON collection_cards(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_collection_name ON collection_cards(user_id, card_name)');

  // Migration: add auto_refresh_hours column to tracked_decks
  try {
    db.run('ALTER TABLE tracked_decks ADD COLUMN auto_refresh_hours INTEGER');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add price_alert_threshold and last_known_price columns to tracked_decks
  try {
    db.run('ALTER TABLE tracked_decks ADD COLUMN price_alert_threshold REAL');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run('ALTER TABLE tracked_decks ADD COLUMN last_known_price REAL');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add paper_snapshot_id column to tracked_decks
  try {
    db.run('ALTER TABLE tracked_decks ADD COLUMN paper_snapshot_id INTEGER');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add budget price tracking and price alert mode to tracked_decks
  try {
    db.run('ALTER TABLE tracked_decks ADD COLUMN last_known_budget_price REAL');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run("ALTER TABLE tracked_decks ADD COLUMN price_alert_mode TEXT DEFAULT 'specific'");
  } catch {
    // Column already exists — ignore
  }

  // Migration: add price columns to deck_snapshots for price history tracking
  try {
    db.run('ALTER TABLE deck_snapshots ADD COLUMN snapshot_price REAL');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run('ALTER TABLE deck_snapshots ADD COLUMN snapshot_budget_price REAL');
  } catch {
    // Column already exists — ignore
  }

  // Playgroups tables removed — future TapTogether integration planned

  // Indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code)');
  db.run('CREATE INDEX IF NOT EXISTS idx_invite_codes_creator ON invite_codes(created_by_user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_invite_redemptions_code ON invite_redemptions(invite_code_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_log_created ON admin_audit_log(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_log_action ON admin_audit_log(action)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tracked_owners_user ON tracked_owners(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tracked_decks_user ON tracked_decks(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tracked_decks_owner ON tracked_decks(tracked_owner_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_deck_snapshots_deck ON deck_snapshots(tracked_deck_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_deck_snapshots_created ON deck_snapshots(tracked_deck_id, created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_reset_tokens_token ON password_reset_tokens(token)');
  db.run('CREATE INDEX IF NOT EXISTS idx_email_verify_token ON email_verification_tokens(token)');

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
