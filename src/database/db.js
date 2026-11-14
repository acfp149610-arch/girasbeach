const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'giras-beach.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function initialize() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','admin')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS courts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS opening_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      slot_minutes INTEGER NOT NULL DEFAULT 60 CHECK(slot_minutes BETWEEN 30 AND 240),
      price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS blocked_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      court_id INTEGER NOT NULL REFERENCES courts(id),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      reason TEXT DEFAULT '',
      CHECK(ends_at > starts_at)
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      court_id INTEGER NOT NULL REFERENCES courts(id),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
      status TEXT NOT NULL DEFAULT 'pending_payment' CHECK(status IN ('pending_payment','confirmed','cancelled','expired')),
      payment_provider_id TEXT,
      payment_method TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(ends_at > starts_at)
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_court_time ON bookings(court_id, starts_at, ends_at);
    CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id, created_at);
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
      provider TEXT NOT NULL DEFAULT 'mercado_pago',
      provider_payment_id TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      amount_cents INTEGER NOT NULL,
      raw_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const court = db.prepare('SELECT id FROM courts LIMIT 1').get();
  if (!court) db.prepare('INSERT INTO courts (name, description) VALUES (?, ?)').run('Quadra 1', 'Quadra de beach tennis');
}

module.exports = { db, initialize, dbPath };
