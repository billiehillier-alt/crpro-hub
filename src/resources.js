// Resources library, adapted from psyrenne's resources.php (a WordPress resource directory) and built into the app.
// The owner adds and edits; everyone signed in browses and searches. Categories come from Jess's dream board.
// Dropped from psyrenne: affiliate buttons (Amazon, TikTok Shop) and "I use this".
const express = require('express');
const { db } = require('./db');
const { ownerOnly } = require('./auth');

db.exec(`CREATE TABLE IF NOT EXISTS resources (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL, summary TEXT, url TEXT,
  source TEXT, location TEXT, cost TEXT, dates TEXT, tags TEXT, status TEXT NOT NULL DEFAULT 'published', checked_on TEXT, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`);
const CATEGORIES = ['Certifications', 'Conferences', 'Links to other resources', 'Organizations', 'Regulations and guidelines', 'Universities', 'Webinars'];
const COSTS = { free: 'Free', paid: 'Paid', varies: 'Varies' };
const clean = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);
const oops = m => Object.assign(new Error(m), { status: 400 });
const wrap = fn => (req, res) => { try { res.json(fn(req) || { ok: true }); } catch (err) { res.status(err.status || 400).json({ error: err.message }); } };
function fields(b) {
  if (!CATEGORIES.includes(b.category)) throw oops('Pick a category.');
  const title = clean(b.title, 200); if (!title) throw oops('Give it a title.');
  const url = clean(b.url, 500); if (url && !/^https?:\/\/\S+$/i.test(url)) throw oops('The link should start with https://');
  return { category: b.category, title, summary: clean(b.summary, 2000) || null, url: url || null, source: clean(b.source, 200) || null, location: clean(b.location, 200) || null,
    cost: COSTS[b.cost] ? b.cost : null, dates: clean(b.dates, 120) || null, tags: clean(b.tags, 300) || null, status: b.status === 'draft' ? 'draft' : 'published',
    checked_on: /^\d{4}-\d{2}-\d{2}$/.test(String(b.checked_on || '')) ? b.checked_on : null, sort: Math.round(Number(b.sort) || 0) };
}
const router = express.Router();
router.get('/', wrap(req => ({ categories: CATEGORIES, costs: COSTS,
  resources: db.prepare(`SELECT * FROM resources WHERE status = 'published' OR ? ORDER BY category, sort, title COLLATE NOCASE`).all(req.user.is_owner ? 1 : 0) })));
router.post('/admin', ownerOnly, wrap(req => { const f = fields(req.body || {}), cols = Object.keys(f);
  return { id: Number(db.prepare(`INSERT INTO resources (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(f)).lastInsertRowid) }; }));
router.put('/admin/:id', ownerOnly, wrap(req => { const f = fields(req.body || {});
  if (!db.prepare(`UPDATE resources SET ${Object.keys(f).map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(f), Number(req.params.id)).changes) throw Object.assign(new Error('That resource isn’t here.'), { status: 404 }); }));
router.delete('/admin/:id', ownerOnly, wrap(req => { db.prepare('DELETE FROM resources WHERE id = ?').run(Number(req.params.id)); }));
try { if (!db.prepare("SELECT 1 FROM settings WHERE key = 'seed_resources_v1'").get()) {
  db.prepare("INSERT INTO resources (category, title, summary, status) VALUES ('Links to other resources', 'Sample resource (delete me)', 'A placeholder so the page can be tried. Delete it before launch.', 'published')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('seed_resources_v1', 'done')").run(); } } catch (err) { console.error('Resources sample:', err.message); }
module.exports = { router, CATEGORIES };
