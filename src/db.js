// The one database for the CR Pro hub (node:sqlite for now). Every feature keeps its own queries in its own module
// (auth, academy, webinars, seo, articlemap, ideas, social), so moving to Postgres later means rewriting those few files.
// Times are stored in UTC: ISO strings ("2026-10-22T18:00:00.000Z") for things people schedule, and SQLite's
// datetime('now') (UTC, "2026-10-22 18:00:00") for record stamps.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.CRPRO_DATA || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'crpro.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

// Settings the owner can change on the Settings screen. Defaults live here.
const DEFAULTS = {
  site_name: 'Clinical Research Pro',
  site_url: 'https://clinicalresearchpro.com',
  brand_hashtag: '#ClinicalResearchPro',
  timezone: 'America/New_York',
  open_signup: '1',
  social_auto: '0',
  social_platforms: 'facebook,linkedin,x',
};
const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : (DEFAULTS[k] ?? null); };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v == null ? null : String(v));

// Adds a column only when it's missing (simple, repeatable migrations).
const addColumn = (table, col, type) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); };

// Runs fn inside one transaction.
function tx(fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { try { db.exec('ROLLBACK'); } catch {} throw err; }
}

module.exports = { db, DATA_DIR, getSetting, setSetting, addColumn, tx, DEFAULTS };
