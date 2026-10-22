// Article ideas and draft requests (from psyrenne's trends.js "Article ideas" list). The SEO plan, the search-term picker,
// and the Article map all send ideas here. WordPress (or a writing helper) reads the waiting requests through the signed
// endpoint in sitesync.js and marks them Drafting or Published.
// psyrenne's "question trends" (counting what members ask in chats and forums) is left out: CR Pro has no chat data yet.
const express = require('express');
const { db } = require('./db');
const { ownerOnly } = require('./auth');

db.exec(`CREATE TABLE IF NOT EXISTS article_ideas (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, note TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'idea', source TEXT NOT NULL DEFAULT 'manual', kind TEXT, keyphrase TEXT, terms TEXT, ai INTEGER NOT NULL DEFAULT 0,
  article_id INTEGER, url TEXT, edit TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`);
const STATUSES = { idea: 'Waiting', drafting: 'Drafting', published: 'Published', dropped: 'Not now' };
const out = i => i && ({ ...i, terms: (() => { try { return JSON.parse(i.terms || '[]'); } catch { return []; } })(), ai: !!i.ai, statusName: STATUSES[i.status] || i.status });
const list = () => db.prepare('SELECT * FROM article_ideas ORDER BY id DESC LIMIT 1000').all().map(out);
const get = id => out(db.prepare('SELECT * FROM article_ideas WHERE id = ?').get(Number(id)));
function add(i) {
  return Number(db.prepare('INSERT INTO article_ideas (topic, note, notes, status, source, kind, keyphrase, terms, ai, article_id, url, edit) VALUES (?, ?, ?, \'idea\', ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(String(i.topic || '').slice(0, 200), String(i.note || '').slice(0, 1000) || null, String(i.notes || '').slice(0, 4000) || null, i.source || 'manual', i.kind || null,
      String(i.keyphrase || '').slice(0, 200) || null, JSON.stringify((i.terms || []).slice(0, 60)), i.ai ? 1 : 0, Number(i.articleId) || null, i.url || null, i.edit || null).lastInsertRowid);
}
function update(id, b) {
  const i = db.prepare('SELECT * FROM article_ideas WHERE id = ?').get(Number(id)); if (!i) return false;
  if (STATUSES[b.status]) db.prepare("UPDATE article_ideas SET status = ?, updated_at = datetime('now') WHERE id = ?").run(b.status, i.id);
  if ('note' in b) db.prepare("UPDATE article_ideas SET note = ?, updated_at = datetime('now') WHERE id = ?").run(String(b.note || '').slice(0, 1000) || null, i.id);
  if ('topic' in b && String(b.topic || '').trim()) db.prepare('UPDATE article_ideas SET topic = ? WHERE id = ?').run(String(b.topic).trim().slice(0, 200), i.id);
  if (Number(b.articleId)) db.prepare('UPDATE article_ideas SET article_id = ? WHERE id = ?').run(Number(b.articleId), i.id);
  if (b.edit) db.prepare('UPDATE article_ideas SET edit = ? WHERE id = ?').run(String(b.edit).slice(0, 500), i.id);
  if (b.url) db.prepare('UPDATE article_ideas SET url = ? WHERE id = ?').run(String(b.url).slice(0, 500), i.id);
  return true;
}
// A request whose article is now published on the site is marked Published.
function markPublished() {
  db.prepare(`UPDATE article_ideas SET status = 'published', updated_at = datetime('now') WHERE status IN ('idea','drafting') AND article_id IS NOT NULL
    AND article_id IN (SELECT id FROM seo_articles WHERE status = 'publish')`).run();
}

const router = express.Router();
router.use(ownerOnly);
router.get('/', (req, res) => { try { markPublished(); } catch {} res.json({ ideas: list(), statuses: STATUSES }); });
router.post('/', (req, res) => { const topic = String((req.body || {}).topic || '').trim(); if (!topic) return res.status(400).json({ error: 'What’s the idea? Type a topic.' });
  res.json({ ok: true, id: add({ topic, note: req.body.note, keyphrase: req.body.keyphrase, terms: req.body.keyphrase ? [req.body.keyphrase] : [], source: 'manual' }) }); });
router.put('/:id', (req, res) => update(req.params.id, req.body || {}) ? res.json({ ok: true }) : res.status(404).json({ error: 'That idea isn’t here.' }));
router.delete('/:id', (req, res) => { db.prepare('DELETE FROM article_ideas WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); });

module.exports = { router, add, update, list, get, STATUSES, markPublished };
