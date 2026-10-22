// Article map, ported from psyrenne's articlemap.js: every WordPress article (published and draft, from the signed sync) can
// be placed in a tree of three levels: 1 a header, 2 a subheader or an article right under a header, 3 the articles under
// those. Gaps get "missing" cards, and a missing card can be sent to Article ideas as a draft request. Coverage colors say
// whether a topic has enough supporting articles. Owner only.
// Left out from psyrenne: its one-time moves of psyrenne.com's own articles, and the "send family links to the website" panel
// (that needs a matching WordPress plugin; see NOTES-FOR-CLAUDE.md).
const express = require('express');
const { db, tx } = require('./db');
const { ownerOnly } = require('./auth');
const ideas = require('./ideas');

db.exec(`CREATE TABLE IF NOT EXISTS am_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER UNIQUE, title TEXT, parent INTEGER,
  sort INTEGER NOT NULL DEFAULT 0, idea_id INTEGER, kind TEXT, custom_order INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
const MAX_LEVEL = 3;
const LEVEL_ERR = 'Only three levels: header, subheader, article.';
const SUB_ERR = 'A subheader goes under a header, or one step inside a subheader.';
const subParentOk = (p, byId) => !!p && (p.kind === 'header' || (p.kind === 'subheader' && !!byId(p.parent) && byId(p.parent).kind === 'header'));
const oops = (m, status = 400) => Object.assign(new Error(m), { status });
// Coverage: topic-cluster guides suggest 8 to 15 supporting articles for a main topic, about 5 for a smaller group.
const COVERAGE = {
  main: { what: 'a main topic', bands: [[5, 'red'], [8, 'yellow'], [21, 'green'], [Infinity, 'blue']], ideal: '8 to 20' },
  sub: { what: 'a smaller topic group', bands: [[3, 'red'], [5, 'yellow'], [13, 'green'], [Infinity, 'blue']], ideal: '5 to 12' },
};
const BAND_SAY = { red: 'It needs a lot more under it.', yellow: 'A few more will round it out.', green: 'Nice coverage.', blue: 'That’s a lot for one topic. Consider splitting it with a subheader.' };
const bandOf = (set, n) => COVERAGE[set].bands.find(([max]) => n < max)[1];
const tipOf = (set, n) => `Most SEO guides suggest ${COVERAGE[set].ideal} supporting articles for ${COVERAGE[set].what}. You have ${n}. ${BAND_SAY[bandOf(set, n)]}`;
const LEGEND = Object.fromEntries(Object.entries(COVERAGE).map(([k, c]) => { const [r, y, g] = c.bands.map(b => b[0]); return [k, { what: c.what, ideal: c.ideal, red: `under ${r}`, yellow: `${r} to ${y - 1}`, green: `${y} to ${g - 1}`, blue: `over ${g - 1}` }]; }));

// "Match to headers": articles not on the map yet go under the header (or subheader) whose name is in their title.
const SAME = { 'gcp': ['good clinical practice'], 'good clinical practice': ['gcp'], 'irb': ['institutional review board', 'ethics committee'], 'cra': ['clinical research associate', 'monitor'],
  'crc': ['clinical research coordinator', 'coordinator'], 'pi': ['principal investigator', 'investigator'], 'pmp': ['project management professional'], 'cro': ['contract research organization'],
  'project management': ['pmp', 'project manager'], 'ai': ['artificial intelligence'], 'regulatory': ['fda', 'ich', 'regulation', 'regulations'] };
const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = p => new RegExp('\\b' + p.split(/\s+/).map(w => esc(w.replace(/s$/, '')) + 's?').join('[\\s-]+') + '\\b', 'i');
function headerTest(title) {
  const t = String(title || '').toLowerCase().replace(/[’‘]/g, "'").replace(/\(\s*(?:formerly|aka|now|or)?\s*/g, '/').replace(/\)/g, ' ').replace(/[^a-z0-9'&,/+\s-]/g, ' ').trim();
  const parts = t.split(/\s*(?:&|,|\/|\+|\band\b)\s*/).map(x => x.trim()).filter(x => x.length >= 2);
  const res = parts.flatMap(p => [p, ...(SAME[p] || [])]).map(phraseRe);
  return res.length ? { rank: /clinical research/.test(t) ? 2 : 1, len: t.length, test: x => res.some(r => r.test(x)) } : null;
}
const nodes = () => db.prepare('SELECT * FROM am_nodes ORDER BY sort, id').all();
const artTitles = () => new Map(db.prepare('SELECT id, title, status FROM seo_articles').all().map(a => [a.id, a]));
function levels(all = nodes()) {
  const kids = new Map(); for (const n of all) { const p = n.parent || 0; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n); }
  for (const l of kids.values()) l.sort((a, b) => a.sort - b.sort || a.id - b.id);
  const lv = new Map(), sec = new Map(), order = new Map(), seen = new Set();
  const walk = (n, l) => { if (seen.has(n.id)) return; seen.add(n.id); lv.set(n.id, l); order.set(n.id, order.size); for (const k of kids.get(n.id) || []) walk(k, l + (k.kind === 'subheader' && n.kind === 'subheader' ? 0 : 1)); };
  let head = 0;
  for (const r of kids.get(0) || []) { if (r.kind === 'header') { head = r.id; walk(r, 1); } else { if (head) sec.set(r.id, head); walk(r, head ? 2 : 1); } }
  for (const n of all) if (!seen.has(n.id)) walk(n, 1);
  return { lv, sec, order, kids };
}
function place(id, parent, beforeId, afterId) {
  const sibs = db.prepare('SELECT id FROM am_nodes WHERE COALESCE(parent, 0) = ? AND id <> ? ORDER BY sort, id').all(parent || 0, id).map(r => r.id);
  let at = beforeId ? sibs.indexOf(beforeId) : afterId ? sibs.indexOf(afterId) + 1 : sibs.length; if (at < 0) at = sibs.length; sibs.splice(at, 0, id);
  db.prepare('UPDATE am_nodes SET parent = ? WHERE id = ?').run(parent || null, id);
  const set = db.prepare('UPDATE am_nodes SET sort = ? WHERE id = ?'); sibs.forEach((x, i) => set.run(i + 1, x));
}
// Subheaders keep their cards A to Z unless the owner moves one by hand (then their own order sticks; "A to Z" resets it).
function sortSubs() {
  const titles = artTitles(), name = n => String((n.post_id && titles.get(n.post_id) ? titles.get(n.post_id).title : n.title) || '').toLowerCase();
  for (const sh of db.prepare("SELECT id FROM am_nodes WHERE kind = 'subheader' AND COALESCE(custom_order, 0) = 0").all())
    db.prepare('SELECT * FROM am_nodes WHERE parent = ?').all(sh.id).sort((a, b) => (b.kind === 'subheader') - (a.kind === 'subheader') || name(a).localeCompare(name(b)) || a.id - b.id)
      .forEach((k, i) => { if (k.sort !== i + 1) db.prepare('UPDATE am_nodes SET sort = ? WHERE id = ?').run(i + 1, k.id); });
}
const markCustom = parentId => { if (parentId) db.prepare("UPDATE am_nodes SET custom_order = 1 WHERE id = ? AND kind = 'subheader'").run(parentId); };
// Runs a change, then checks nothing went past three levels and every subheader sits right under a header. Otherwise undone.
function checked(fn) {
  const before = levels().lv;
  return tx(() => { const out = fn(); sortSubs(); const all = nodes(), { lv } = levels(all), by = new Map(all.map(n => [n.id, n]));
    for (const n of all) { const l = lv.get(n.id), was = before.get(n.id);
      if (l > MAX_LEVEL && (was === undefined || was <= MAX_LEVEL || l > was)) throw oops(LEVEL_ERR);
      if (n.kind === 'subheader' && !subParentOk(by.get(n.parent), id => by.get(id))) throw oops(SUB_ERR); }
    return out; });
}
function coverage(all, L, arts) {
  const by = new Map(all.map(n => [n.id, n])), memo = new Map();
  const self = n => n.kind === 'header' || n.kind === 'subheader' ? [0, 0, 0] : n.post_id ? (arts.has(n.post_id) ? [1, arts.get(n.post_id).status === 'publish' ? 1 : 0, 0] : [0, 0, 0]) : [0, 0, 1];
  const add = (t, a) => { for (let i = 0; i < 3; i++) t[i] += a[i]; return t; };
  const under = id => { if (memo.has(id)) return memo.get(id); memo.set(id, [0, 0, 0]); const t = [0, 0, 0]; for (const k of L.kids.get(id) || []) { add(t, self(k)); add(t, under(k.id)); } memo.set(id, t); return t; };
  const out = new Map();
  for (const n of all) {
    const l = L.lv.get(n.id), hasKids = (L.kids.get(n.id) || []).length > 0;
    const set = n.kind === 'header' ? 'main' : n.kind === 'subheader' ? 'sub' : n.post_id && l === 1 && !L.sec.has(n.id) ? 'main' : n.post_id && l === 2 && hasKids ? 'sub' : null; if (!set) continue;
    const t = [...under(n.id)];
    if (n.kind === 'header') for (const [m, h] of L.sec) if (h === n.id && by.get(m)) { add(t, self(by.get(m))); add(t, under(m)); }
    out.set(n.id, { set, n: t[0], live: t[1], missing: t[2], band: bandOf(set, t[0]), tip: tipOf(set, t[0]) });
  }
  return out;
}
function matchToHeaders() {
  const order = (x, y) => x.rank - y.rank || (y.len || 0) - (x.len || 0);
  const tests = db.prepare("SELECT id, title, parent, kind FROM am_nodes WHERE kind IN ('header', 'subheader') ORDER BY sort, id").all().map(h => ({ ...h, ...(headerTest(h.title) || {}) })).filter(h => h.test);
  const heads = tests.filter(h => h.kind === 'header').sort(order), subs = tests.filter(h => h.kind === 'subheader').sort(order);
  const placed = new Set(db.prepare('SELECT post_id FROM am_nodes WHERE post_id IS NOT NULL').all().map(r => r.post_id)), pick = new Map([...heads, ...subs].map(h => [h.id, []]));
  for (const a of db.prepare('SELECT id, title FROM seo_articles').all()) { if (placed.has(a.id)) continue; const t = String(a.title || '').replace(/[’‘]/g, "'");
    const h = heads.find(x => x.test(t)), s = h ? subs.find(x => x.parent === h.id && x.test(t)) : subs.find(x => x.test(t)), dest = s || h; if (dest) pick.get(dest.id).push(a); }
  const out = [];
  for (const h of [...heads, ...subs]) { const list = pick.get(h.id).sort((a, b) => String(a.title).localeCompare(String(b.title))); if (!list.length) continue;
    let s = (db.prepare('SELECT MAX(sort) s FROM am_nodes WHERE parent = ?').get(h.id) || {}).s || 0; for (const a of list) db.prepare('INSERT INTO am_nodes (post_id, parent, sort) VALUES (?, ?, ?)').run(a.id, h.id, ++s);
    out.push({ header: h.title, count: list.length }); }
  return out;
}
const isUnder = (id, maybe, all) => { const by = new Map(all.map(n => [n.id, n])); let n = by.get(maybe); while (n) { if (n.id === id) return true; n = by.get(n.parent); } return false; };
function headerToTop(id) { const all = nodes(), n = all.find(x => x.id === id); if (!n || !n.parent) return; const by = new Map(all.map(x => [x.id, x])); let top = by.get(n.parent); while (top && top.parent) top = by.get(top.parent); place(id, 0, 0, top ? top.id : 0); }
function fixPlan() {
  const all = nodes().map(n => ({ ...n })), by = new Map(all.map(n => [n.id, n])), moves = [];
  for (let pass = 0; pass < 20; pass++) { const { lv, order } = levels(all), deep = all.filter(n => lv.get(n.id) > MAX_LEVEL); if (!deep.length) break;
    const min = Math.min(...deep.map(n => lv.get(n.id)));
    for (const n of deep.filter(x => lv.get(x.id) === min).sort((a, b) => order.get(a.id) - order.get(b.id))) { const p = by.get(n.parent); moves.push({ id: n.id, from: p.id, to: p.parent || 0, after: p.id }); n.parent = p.parent || null; } }
  return moves;
}

const wrap = fn => (req, res) => { try { res.json(fn(req) || { ok: true }); } catch (err) { res.status(err.status || 400).json({ error: err.message }); } };
const router = express.Router();
router.use(ownerOnly);
router.get('/', wrap(() => {
  const articles = db.prepare('SELECT id, title, status, url, edit, keyphrase FROM seo_articles ORDER BY title').all();
  const all = nodes(), L = levels(all), arts = new Map(articles.map(a => [a.id, a])), cov = coverage(all, L, arts);
  const list = all.map(n => { const i = n.idea_id ? ideas.get(n.idea_id) : null; return { ...n, idea: i ? { status: i.status, statusName: i.statusName, url: i.edit || i.url || '' } : null, level: L.lv.get(n.id) || 1, sec: L.sec.get(n.id) || 0, cov: cov.get(n.id) || null }; });
  return { articles, nodes: list, maxLevel: MAX_LEVEL, legend: LEGEND, deep: list.filter(n => n.level > MAX_LEVEL).length };
}));
router.post('/match', wrap(() => { const placed = checked(matchToHeaders); return { placed, total: placed.reduce((t, x) => t + x.count, 0) }; }));
router.post('/subsort/:id', wrap(req => checked(() => { db.prepare("UPDATE am_nodes SET custom_order = NULL WHERE id = ? AND kind = 'subheader'").run(Number(req.params.id)); return { ok: true }; })));
// Move (or first place) an article or a card: before / after a card (same level), or inside it.
router.post('/move', wrap(req => checked(() => {
  const b = req.body || {}; let id = Number(b.node) || 0;
  if (!id && Number(b.post_id)) { const have = db.prepare('SELECT id FROM am_nodes WHERE post_id = ?').get(Number(b.post_id)); id = have ? have.id : Number(db.prepare('INSERT INTO am_nodes (post_id, sort) VALUES (?, 0)').run(Number(b.post_id)).lastInsertRowid); }
  if (!id) throw oops('Nothing to move.');
  const all = nodes(), me = all.find(n => n.id === id), target = b.target ? all.find(n => n.id === Number(b.target)) : null;
  if (me && me.kind === 'header' && target && (b.where === 'in' || target.parent)) { headerToTop(id); return { ok: true, note: 'A header stays on the top level.' }; }
  if (b.target && !target) throw oops('That spot is gone. Refresh the page.');
  if (target && (target.id === id || isUnder(id, target.id, all))) throw oops('An article can’t go inside one of its own sub-articles.');
  const parent = !target ? 0 : b.where === 'in' ? target.id : (target.parent || 0);
  if (me && me.kind === 'subheader' && !subParentOk(all.find(n => n.id === parent), x => all.find(n => n.id === x))) throw oops(SUB_ERR);
  if (b.where === 'before' || b.where === 'after') markCustom(parent);
  place(id, parent, b.where === 'before' && target ? target.id : 0, b.where === 'after' && target ? target.id : 0);
  return { ok: true };
})));
router.post('/unplace', wrap(req => checked(() => { const id = Number((req.body || {}).node), n = db.prepare('SELECT * FROM am_nodes WHERE id = ?').get(id); if (!n) return { ok: true };
  if (n.kind === 'header' && db.prepare("SELECT 1 FROM am_nodes WHERE parent = ? AND kind = 'subheader'").get(id)) throw oops('Move or delete its subheaders first.');
  db.prepare('UPDATE am_nodes SET parent = ? WHERE parent = ?').run(n.parent || null, id); db.prepare('DELETE FROM am_nodes WHERE id = ?').run(id); return { ok: true }; })));
// A missing article, a header (top level), or a subheader (right under a header).
router.post('/missing', wrap(req => checked(() => { const b = req.body || {}, title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const kind = b.kind === 'header' || b.kind === 'subheader' ? b.kind : null;
  if (!title) throw oops(kind === 'header' ? 'Type the header.' : kind === 'subheader' ? 'Type the subheader.' : 'Type the missing article’s title.');
  const parent = kind === 'header' ? 0 : Number(b.parent) || 0;
  if (kind === 'subheader' && !subParentOk(db.prepare('SELECT * FROM am_nodes WHERE id = ?').get(parent), x => db.prepare('SELECT * FROM am_nodes WHERE id = ?').get(x))) throw oops(SUB_ERR);
  if (parent && !db.prepare('SELECT 1 FROM am_nodes WHERE id = ?').get(parent)) throw oops('That spot is gone. Refresh the page.');
  const id = Number(db.prepare('INSERT INTO am_nodes (title, sort, kind) VALUES (?, 0, ?)').run(title, kind).lastInsertRowid); place(id, parent, 0, 0); return { id }; })));
router.put('/missing/:id', wrap(req => { const t = String((req.body || {}).title || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!t) throw oops('The title can’t be empty.');
  db.prepare('UPDATE am_nodes SET title = ? WHERE id = ? AND post_id IS NULL').run(t, Number(req.params.id));
  const n = db.prepare('SELECT idea_id FROM am_nodes WHERE id = ?').get(Number(req.params.id)); if (n && n.idea_id) { const i = ideas.get(n.idea_id); if (i && i.status === 'idea') ideas.update(i.id, { topic: t }); } }));
router.put('/missing/:id/kind', wrap(req => checked(() => { const n = db.prepare('SELECT * FROM am_nodes WHERE id = ?').get(Number(req.params.id)); if (!n || n.post_id) throw oops('Only a card you added can change.');
  if (n.idea_id) throw oops('A draft was already requested for this one.');
  const to = ['header', 'subheader'].includes((req.body || {}).kind) ? req.body.kind : null;
  if (to === 'subheader' && !subParentOk(db.prepare('SELECT * FROM am_nodes WHERE id = ?').get(n.parent || 0), x => db.prepare('SELECT * FROM am_nodes WHERE id = ?').get(x))) throw oops('Only a card right under a header or a subheader can be a subheader.');
  db.prepare('UPDATE am_nodes SET kind = ? WHERE id = ?').run(to, n.id); if (to === 'header') headerToTop(n.id); return { ok: true }; })));
// Send a missing card to Article ideas; what sits above and below it on the map goes along as context.
router.post('/missing/:id/draft', wrap(req => {
  const all = nodes(), n = all.find(x => x.id === Number(req.params.id)); if (!n || n.post_id) throw oops('Only a missing card can be requested.');
  if (n.kind) throw oops('A header or subheader is a section break, not an article.');
  if (n.idea_id && ideas.get(n.idea_id)) throw oops('Already requested.');
  const titles = artTitles(), titleOf = x => x.post_id ? ((titles.get(x.post_id) || {}).title || '') : x.title;
  const parent = n.parent ? all.find(x => x.id === n.parent) : null, kids = all.filter(x => x.parent === n.id).map(titleOf).filter(Boolean);
  const b = req.body || {}, newTitle = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (newTitle && newTitle !== n.title) { db.prepare('UPDATE am_nodes SET title = ? WHERE id = ?').run(newTitle, n.id); n.title = newTitle; }
  const key = String(b.keyphrase || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120) || n.title.replace(/[?.:]+$/, '').toLowerCase();
  const id = ideas.add({ topic: n.title, note: `From the Article map.${parent ? ' It sits under “' + titleOf(parent) + '”; link up to it.' : ' It’s a main topic (a pillar).'}${kids.length ? ' Link down to: ' + kids.join('; ') + '.' : ''}`,
    notes: String(b.notes || '').slice(0, 3000), source: 'articlemap', keyphrase: key, terms: [key], ai: !!b.ai });
  db.prepare('UPDATE am_nodes SET idea_id = ? WHERE id = ?').run(id, n.id);
}));
router.post('/indent', wrap(req => checked(() => { const b = req.body || {}, all = nodes(), n = all.find(x => x.id === Number(b.node)); if (!n) throw oops('That card is gone. Refresh the page.');
  if (b.dir === 'out') { if (!n.parent) return { ok: true }; const p = all.find(x => x.id === n.parent); place(n.id, p ? p.parent || 0 : 0, 0, p ? p.id : 0); return { ok: true }; }
  markCustom(n.parent);
  const sibs = all.filter(x => (x.parent || 0) === (n.parent || 0)).sort((a, c) => a.sort - c.sort || a.id - c.id), i = sibs.findIndex(x => x.id === n.id);
  if (i < 1) throw oops('Move it just below the card it belongs under first.');
  place(n.id, sibs[i - 1].id, 0, 0); return { ok: true }; })));
router.post('/nudge', wrap(req => checked(() => { const b = req.body || {}, all = nodes(), n = all.find(x => x.id === Number(b.node)); if (!n) throw oops('That card is gone. Refresh the page.');
  const sibs = all.filter(x => (x.parent || 0) === (n.parent || 0)).sort((a, c) => a.sort - c.sort || a.id - c.id), i = sibs.findIndex(x => x.id === n.id);
  markCustom(n.parent);
  if (b.dir === 'up' && i > 0) place(n.id, n.parent || 0, sibs[i - 1].id, 0); else if (b.dir === 'down' && i < sibs.length - 1) place(n.id, n.parent || 0, 0, sibs[i + 1].id);
  return { ok: true }; })));
router.get('/fix-levels', wrap(() => { const all = nodes(), by = new Map(all.map(n => [n.id, n])), arts = artTitles(), t = n => n ? (n.post_id ? ((arts.get(n.post_id) || {}).title || '(article no longer on the site)') : n.title || '') : '';
  return { moves: fixPlan().map(m => ({ id: m.id, title: t(by.get(m.id)), from: t(by.get(m.from)), to: m.to ? t(by.get(m.to)) : '' })) }; }));
router.post('/fix-levels', wrap(() => { const moves = fixPlan(); tx(() => { const anchor = new Map(); for (const m of moves) { place(m.id, m.to, 0, anchor.get(m.after) || m.after); anchor.set(m.after, m.id); } }); return { moved: moves.length }; }));

module.exports = { router };
