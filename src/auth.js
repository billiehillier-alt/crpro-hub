// Accounts and sign-in, ported from psyrenne's auth.js. Sign-in is always on: there is no "no user means owner" shortcut.
// Passwords are scrypt-hashed; only a hash of each session token is stored, so a copy of the database can't be used to
// sign in. Sessions last 30 days. Forgot-password links work once, for one hour.
// Roles: the owner/admin (is_owner = 1) and students. The very first account is made on the one-time setup page.
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { db, getSetting, addColumn } = require('./db');
const mailer = require('./mailer');

const COOKIE = 'crp_session';
const DAYS = 30;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, name TEXT, last_name TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0, is_elite INTEGER NOT NULL DEFAULT 0, email_on INTEGER NOT NULL DEFAULT 1, timezone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, device TEXT);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
`);
addColumn('users', 'elite_until', 'TEXT');

const hashPassword = pw => { const salt = crypto.randomBytes(16).toString('hex'); return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
const checkPassword = (pw, stored) => {
  const [, salt, hash] = String(stored).split('$'); if (!salt || !hash) return false;
  const a = crypto.scryptSync(pw, salt, 64), b = Buffer.from(hash, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const tokenFrom = req => (String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`)) || [])[1];
const secure = req => req.secure || String(req.headers['x-forwarded-proto'] || '') === 'https';

function currentUser(req) {
  if (req._user !== undefined) return req._user;
  const t = tokenFrom(req);
  req._user = t ? db.prepare(`SELECT u.id, u.email, u.name, u.last_name, u.is_owner, u.is_elite, u.elite_until, u.email_on, u.timezone FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).get(sha(t)) || null : null;
  return req._user;
}
// Elite: the flag, or a paid-through date still in the future (Stripe will set elite_until later).
const isElite = u => !!u && (!!u.is_owner || !!u.is_elite || (!!u.elite_until && u.elite_until > new Date().toISOString()));

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, device) VALUES (?, ?, datetime('now', '+${DAYS} days'), ?)`).run(sha(token), userId, String(req.headers['user-agent'] || '').slice(0, 200));
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly;${secure(req) ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${DAYS * 86400}`);
}
function endSession(req, res) {
  const t = tokenFrom(req); if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly;${secure(req) ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=0`);
}

// Wrong passwords: 5 tries per address, then a 15-minute pause.
const tries = new Map();
const lockedOut = ip => { const t = tries.get(ip); return t && t.until > Date.now(); };
const failed = ip => { const t = tries.get(ip) || { n: 0, until: 0 }; t.n++; if (t.n >= 5) { t.until = Date.now() + 15 * 60e3; t.n = 0; } tries.set(ip, t); };

// ---------- who gets in ----------
// Pages anyone may load without signing in. Feature modules add their own (the signed WordPress endpoints, /verify, /l/:code).
const OPEN = new Set(['/login', '/login.html', '/style.css', '/logo.png', '/favicon.ico', '/fonts.css', '/api/auth/status', '/api/auth/setup', '/api/auth/login',
  '/api/auth/signup', '/api/auth/forgot', '/api/auth/reset', '/api/health', '/verify', '/calendar.ics', '/preview', '/preview.html']);
const OPEN_PREFIX = ['/fonts/', '/verify/', '/api/verify/', '/l/', '/api/site/', '/si/'];
function guard(req, res, next) {
  if (OPEN.has(req.path) || OPEN_PREFIX.some(p => req.path.startsWith(p))) return next();
  const u = currentUser(req);
  if (u) { req.user = u; return next(); }
  // Visitors who aren't signed in see the public front page (the design preview); Sign in is on it.
  if (req.path === '/' && req.method === 'GET') return res.sendFile(path.join(__dirname, '..', 'public', 'preview.html'));
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please sign in.', login: true });
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}
const ownerOnly = (req, res, next) => (req.user && req.user.is_owner ? next() : res.status(403).json({ error: 'Only the CR Pro team can do that.' }));

const needsSetup = () => !db.prepare('SELECT id FROM users LIMIT 1').get();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const PW_MIN = 12;
const appUrl = req => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

const router = express.Router();
router.get('/status', (req, res) => {
  const u = currentUser(req);
  res.json({ needsSetup: needsSetup(), setupCode: !!process.env.SETUP_CODE, openSignup: getSetting('open_signup') === '1', siteName: getSetting('site_name'),
    user: u ? { id: u.id, email: u.email, name: u.name, lastName: u.last_name, owner: !!u.is_owner, elite: isElite(u), emailOn: !!u.email_on, timezone: u.timezone || '' } : null });
});
// The one-time "create the owner account" page. Only works while there are no users at all.
// If SETUP_CODE is set (recommended once it's online), the code must be typed too, so nobody else can claim it first.
router.post('/setup', (req, res) => {
  if (!needsSetup()) return res.status(400).json({ error: 'The owner account is already set up. Sign in instead.' });
  if (process.env.SETUP_CODE && String(req.body.code || '').trim() !== process.env.SETUP_CODE) return res.status(403).json({ error: 'That setup code isn’t right.' });
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || ''), name = String(req.body.name || '').trim().slice(0, 60);
  if (!validEmail(email)) return res.status(400).json({ error: 'Type a valid email address.' });
  if (pw.length < PW_MIN) return res.status(400).json({ error: `Use a password of at least ${PW_MIN} characters.` });
  const id = Number(db.prepare('INSERT INTO users (email, pass_hash, name, is_owner) VALUES (?, ?, ?, 1)').run(email, hashPassword(pw), name || null).lastInsertRowid);
  startSession(req, res, id); res.json({ ok: true });
});
// Students make their own account (free courses are the front door). The owner can switch this off in Settings.
const signups = new Map();
router.post('/signup', (req, res) => {
  if (needsSetup()) return res.status(400).json({ error: 'The site isn’t set up yet.' });
  if (getSetting('open_signup') !== '1') return res.status(403).json({ error: 'New accounts are closed right now.' });
  const ip = req.ip, k = (signups.get(ip) || []).filter(t => Date.now() - t < 864e5);
  if (k.length >= 5) return res.status(429).json({ error: 'That’s a few accounts from here today. Please try again tomorrow.' });
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  const name = String(req.body.name || '').trim().slice(0, 60), last = String(req.body.lastName || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Add your first name. It goes on your certificates.' });
  if (!last) return res.status(400).json({ error: 'Add your last name. It goes on your certificates.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'Type a valid email address.' });
  if (pw.length < PW_MIN) return res.status(400).json({ error: `Use a password of at least ${PW_MIN} characters.` });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(400).json({ error: 'There’s already an account with that email. Sign in instead.' });
  k.push(Date.now()); signups.set(ip, k);
  const tz = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(String(req.body.timezone || '')) ? String(req.body.timezone) : null;
  const id = Number(db.prepare('INSERT INTO users (email, pass_hash, name, last_name, timezone) VALUES (?, ?, ?, ?, ?)').run(email, hashPassword(pw), name, last, tz).lastInsertRowid);
  startSession(req, res, id); res.json({ ok: true });
});
router.post('/login', (req, res) => {
  const ip = req.ip;
  if (lockedOut(ip)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !checkPassword(String(req.body.password || ''), u.pass_hash)) { failed(ip); return res.status(401).json({ error: 'That email or password isn’t right.' }); }
  tries.delete(ip); startSession(req, res, u.id); res.json({ ok: true });
});
router.post('/logout', (req, res) => { endSession(req, res); res.json({ ok: true }); });
// Always answers the same way, so nobody can use it to find out who has an account.
router.post('/forgot', async (req, res) => {
  const ip = req.ip; if (lockedOut(ip)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
  failed(ip);
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = validEmail(email) && db.prepare('SELECT id, email, name FROM users WHERE email = ?').get(email);
  if (u) {
    const code = crypto.randomBytes(24).toString('base64url');
    db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))").run(sha(code), u.id);
    const link = `${appUrl(req)}/login?reset=${code}`;
    try { await mailer.send({ to: u.email, subject: `Reset your ${getSetting('site_name')} password`,
      text: `Hi${u.name ? ' ' + u.name : ''},\n\nSomeone (hopefully you) asked to reset your password. This link works once, for the next hour:\n\n${link}\n\nIf it wasn't you, ignore this email. Your password stays the same.\n\n${getSetting('site_name')}` }); }
    catch (err) { console.error('Reset email:', err.message); }
  }
  res.json({ ok: true, message: 'If that email has an account, a reset link is on its way. Check your spam folder too.' });
});
router.post('/reset', (req, res) => {
  const r = db.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')").get(sha(String(req.body.code || '').trim()));
  if (!r) return res.status(400).json({ error: 'That reset link has expired or was already used. Ask for a new one.' });
  const pw = String(req.body.password || ''); if (pw.length < PW_MIN) return res.status(400).json({ error: `Use a password of at least ${PW_MIN} characters.` });
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(pw), r.user_id);
  db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(r.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id);
  startSession(req, res, r.user_id); res.json({ ok: true });
});
// Signed in from here on.
router.use((req, res, next) => { const u = currentUser(req); if (!u) return res.status(401).json({ error: 'Please sign in.', login: true }); req.user = u; next(); });
router.put('/password', (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!checkPassword(String(req.body.current || ''), row.pass_hash)) return res.status(400).json({ error: 'Your current password isn’t right.' });
  const pw = String(req.body.password || ''); if (pw.length < PW_MIN) return res.status(400).json({ error: `Use a password of at least ${PW_MIN} characters.` });
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(pw), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id); startSession(req, res, req.user.id); res.json({ ok: true });
});
// My profile: name (it goes on certificates), time zone, and the email on/off switch.
router.put('/me', (req, res) => {
  const b = req.body || {};
  if ('name' in b) { const n = String(b.name || '').trim().slice(0, 60); if (!n) return res.status(400).json({ error: 'Your first name can’t be empty.' }); db.prepare('UPDATE users SET name = ? WHERE id = ?').run(n, req.user.id); }
  if ('lastName' in b) db.prepare('UPDATE users SET last_name = ? WHERE id = ?').run(String(b.lastName || '').trim().slice(0, 60) || null, req.user.id);
  if ('emailOn' in b) db.prepare('UPDATE users SET email_on = ? WHERE id = ?').run(b.emailOn ? 1 : 0, req.user.id);
  if ('timezone' in b && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(String(b.timezone || ''))) db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(String(b.timezone), req.user.id);
  res.json({ ok: true });
});
// ---------- the owner: people ----------
router.get('/people', ownerOnly, (req, res) => {
  const q = '%' + String(req.query.q || '').trim().toLowerCase() + '%';
  res.json({ people: db.prepare(`SELECT id, email, name, last_name, is_owner, is_elite, elite_until, email_on, created_at FROM users
    WHERE lower(email) LIKE ? OR lower(COALESCE(name,'') || ' ' || COALESCE(last_name,'')) LIKE ? ORDER BY created_at DESC LIMIT 500`).all(q, q) });
});
router.put('/people/:id', ownerOnly, (req, res) => {
  const id = Number(req.params.id), b = req.body || {}, u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'That person isn’t here.' });
  if ('elite' in b) db.prepare('UPDATE users SET is_elite = ? WHERE id = ?').run(b.elite ? 1 : 0, id);
  if ('owner' in b) {
    if (id === req.user.id && !b.owner) return res.status(400).json({ error: 'You can’t remove your own admin access.' });
    db.prepare('UPDATE users SET is_owner = ? WHERE id = ?').run(b.owner ? 1 : 0, id); db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  res.json({ ok: true });
});

const nameOf = u => [u && u.name, u && u.last_name].filter(Boolean).join(' ') || (u && u.email) || 'Student';
module.exports = { router, guard, ownerOnly, currentUser, isElite, OPEN, OPEN_PREFIX, nameOf, appUrl, hashPassword };
