// Directory, adapted from psyrenne's directory.js. In psyrenne the listings lived in WordPress and were pushed to the app;
// here they live in the app (the hub owns the data, WordPress only markets). Listing types come from Jess's dream board:
// Organizations, Vendors (can take RFPs later), Consultants (patient advisors too; can share their work and presentations),
// Sites (basic feasibility answers, site details, pictures, a video), Sponsors and biotech, and Technology (eClinical tools,
// from psyrenne's "tools" listings).
// Kept from psyrenne: search and filters, reviews (scores show once there are 3, and 3 reports from different people hide one
// until the owner looks), suggest-an-edit, the owner's approval queue, and open counts.
// Dropped: TikTok, brand, and affiliate fields; credits and rooms; the AI webinar-from-email extraction; nudges; private contacts.
const express = require('express');
const { db, tx } = require('./db');
const { ownerOnly } = require('./auth');

db.exec(`
CREATE TABLE IF NOT EXISTS dir_listings (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT, description TEXT, website TEXT, contact_email TEXT, phone TEXT, city TEXT, state TEXT, country TEXT, logo_url TEXT, video_url TEXT,
  photos TEXT, links TEXT, data TEXT, submitted_by INTEGER, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);
CREATE TABLE IF NOT EXISTS dir_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id INTEGER NOT NULL REFERENCES dir_listings(id) ON DELETE CASCADE,
  field TEXT NOT NULL, value TEXT NOT NULL, was TEXT, note TEXT, user_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT);
CREATE TABLE IF NOT EXISTS dir_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id INTEGER NOT NULL REFERENCES dir_listings(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
  stars INTEGER NOT NULL, relation TEXT, note TEXT, status TEXT NOT NULL DEFAULT 'live', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, UNIQUE (listing_id, user_id));
CREATE TABLE IF NOT EXISTS dir_review_reports (review_id INTEGER NOT NULL REFERENCES dir_reviews(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (review_id, user_id));
CREATE TABLE IF NOT EXISTS dir_opens (listing_id INTEGER NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (listing_id, day));
`);
const REVIEW_MIN = 3, REPORTS_TO_HIDE = 3;
// Types, A to Z, with their own fields: [key, label, kind ('text' | 'long' | 'yesno' | 'list'), help].
const TYPES = {
  consultant: { name: 'Consultants', one: 'Consultant', fields: [['expertise', 'Expertise', 'text', 'For example: site startup, monitoring, regulatory submissions'], ['patient_advisor', 'Patient advisor', 'yesno', 'Shares lived experience as a patient or caregiver'],
    ['credentials', 'Credentials', 'text', 'For example: CCRP, CCRA, PMP'], ['availability', 'Availability', 'text', 'For example: part-time, project-based']] },
  organization: { name: 'Organizations', one: 'Organization', fields: [['org_kind', 'Kind of organization', 'text', 'For example: professional association, nonprofit, patient advocacy group'], ['membership_url', 'Membership page', 'text', 'https://'],
    ['serves', 'Who they serve', 'text', '']] },
  site: { name: 'Sites', one: 'Research site', fields: [['therapeutic_areas', 'Therapeutic areas', 'text', 'For example: oncology, cardiology'], ['phases', 'Phases', 'text', 'For example: I, II, III, IV'],
    ['investigators', 'Number of investigators', 'text', ''], ['coordinators', 'Number of coordinators', 'text', ''], ['irb', 'IRB', 'text', 'Central, local, or both'],
    ['populations', 'Patient populations', 'text', 'For example: pediatric, geriatric, rare disease'], ['equipment', 'Equipment and facilities', 'long', 'For example: -80 freezer, infusion chairs, lab'],
    ['feasibility', 'Feasibility answers', 'long', 'Basic answers sponsors ask for: enrollment rate, startup time, EHR access, recruitment methods']] },
  sponsor: { name: 'Sponsors and biotech', one: 'Sponsor or biotech', fields: [['areas', 'Therapeutic areas', 'text', ''], ['stage', 'Stage', 'text', 'For example: preclinical, clinical, commercial'], ['partnering_url', 'Partnering or site page', 'text', 'https://']] },
  technology: { name: 'Technology', one: 'Technology', fields: [['category', 'Kind of tool', 'text', 'For example: CTMS, EDC, eTMF, eConsent, eCOA, IRT, RBQM'], ['pricing', 'Pricing', 'text', 'Free, free plan + paid, paid, custom'],
    ['platforms', 'Works on', 'text', 'For example: web, iPhone, Android'], ['bestfor', 'Best for', 'text', 'One line: who it helps most'], ['watch', 'Watch-outs', 'long', 'Anything to know before signing up']] },
  vendor: { name: 'Vendors', one: 'Vendor', fields: [['services', 'Services', 'text', 'For example: patient recruitment, central lab, translation'], ['rfp', 'Takes RFPs', 'yesno', 'Open to requests for proposals'],
    ['rfp_email', 'Where RFPs go', 'text', 'An email or a page']] },
};
// Fields members can suggest a fix for (common ones plus the type's own).
const COMMON = [['summary', 'Short description'], ['website', 'Website'], ['contact_email', 'Contact email'], ['phone', 'Phone'], ['city', 'City'], ['state', 'State or region'], ['country', 'Country'], ['other', 'Something else']];
const RELATION = { client: 'I was a client', partner: 'We worked together', staff: 'I worked there', other: 'Other' };
const clean = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);
const httpsOrEmpty = (v, what) => { const s = clean(v, 500); if (s && !/^https?:\/\/\S+$/i.test(s)) throw Object.assign(new Error(`${what} should be a full link starting with https://`), { status: 400 }); return s || null; };
const json = (v, d) => { try { return JSON.parse(v || '') ?? d; } catch { return d; } };
const isOwner = req => !!(req.user && req.user.is_owner);
const wrap = fn => (req, res) => { try { res.json(fn(req) || { ok: true }); } catch (err) { res.status(err.status || 400).json({ error: err.message }); } };
const oops = (m, s = 400) => Object.assign(new Error(m), { status: s });
// One link per line: "Title | https://link".
const linksFrom = v => String(v || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 20).map(l => { const [t, u] = l.includes('|') ? l.split('|').map(x => x.trim()) : ['', l]; return /^https?:\/\/\S+$/i.test(u) ? { title: (t || u).slice(0, 160), url: u.slice(0, 500) } : null; }).filter(Boolean);
const linksText = list => (list || []).map(x => x.title && x.title !== x.url ? `${x.title} | ${x.url}` : x.url).join('\n');

function reviewStats() { const m = new Map(); for (const r of db.prepare("SELECT listing_id, COUNT(*) n, AVG(stars) a FROM dir_reviews WHERE status = 'live' GROUP BY listing_id").all()) m.set(r.listing_id, r); return m; }
function out(l, owner, stats) {
  const s = stats.get(l.id), show = s && (s.n >= REVIEW_MIN || owner);
  return { id: l.id, type: l.type, typeName: (TYPES[l.type] || {}).one || l.type, name: l.name, status: l.status, summary: l.summary || '', description: l.description || '', website: l.website || '', contact_email: l.contact_email || '',
    phone: l.phone || '', city: l.city || '', state: l.state || '', country: l.country || '', logo_url: l.logo_url || '', video_url: l.video_url || '', photos: json(l.photos, []), links: json(l.links, []), data: json(l.data, {}),
    reviews: show ? s.n : 0, stars: show ? Math.round(s.a * 10) / 10 : null, updated: l.updated_at || l.created_at };
}
function reviewView(id, uid, owner) {
  const rows = db.prepare('SELECT * FROM dir_reviews WHERE listing_id = ? ORDER BY COALESCE(updated_at, created_at) DESC').all(id), live = rows.filter(r => r.status === 'live'), show = live.length >= REVIEW_MIN || owner;
  const reported = new Set(db.prepare('SELECT review_id FROM dir_review_reports WHERE user_id = ?').all(uid).map(r => r.review_id));
  const note = r => ({ id: r.id, stars: r.stars, relation: RELATION[r.relation] || '', note: r.note || '', when: String(r.updated_at || r.created_at).slice(0, 10), reported: reported.has(r.id) });
  const mine = rows.find(r => r.user_id === uid);
  return { count: live.length, min: REVIEW_MIN, show, stars: show && live.length ? Math.round(live.reduce((a, r) => a + r.stars, 0) / live.length * 10) / 10 : null,
    reviews: show ? live.filter(r => r.user_id !== uid).map(note) : [], mine: mine ? { stars: mine.stars, relation: mine.relation || '', note: mine.note || '', status: mine.status } : null,
    hidden: owner ? rows.filter(r => r.status === 'hidden').map(r => ({ ...note(r), reports: db.prepare('SELECT reason FROM dir_review_reports WHERE review_id = ?').all(r.id).map(x => x.reason) })) : [] };
}
const listing = (id, req) => { const l = db.prepare('SELECT * FROM dir_listings WHERE id = ?').get(Number(id)); if (!l || (l.status !== 'published' && !isOwner(req))) throw oops('That listing isn’t here.', 404); return l; };

const router = express.Router();
router.get('/', wrap(req => {
  const owner = isOwner(req), stats = reviewStats();
  return { types: Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, { name: t.name, one: t.one, fields: t.fields }])), relations: RELATION, common: COMMON, reviewMin: REVIEW_MIN,
    listings: db.prepare("SELECT * FROM dir_listings WHERE status = 'published' ORDER BY name COLLATE NOCASE").all().map(l => out(l, owner, stats)) };
}));
router.get('/item/:id', wrap(req => { const l = listing(req.params.id, req); return { listing: out(l, isOwner(req), reviewStats()), reviews: reviewView(l.id, req.user.id, isOwner(req)) }; }));
// Open counts (the owner's own visits don't count).
router.post('/item/:id/opened', wrap(req => { if (!isOwner(req)) db.prepare("INSERT INTO dir_opens (listing_id, day, n) VALUES (?, date('now'), 1) ON CONFLICT (listing_id, day) DO UPDATE SET n = n + 1").run(Number(req.params.id)); }));
// Reviews: your own experience only. One per person per listing; you can change or remove it.
router.post('/item/:id/reviews', wrap(req => { const l = listing(req.params.id, req), b = req.body || {}, stars = Number(b.stars);
  if (b.own !== true) throw oops('Please confirm this is your own experience.');
  if (![1, 2, 3, 4, 5].includes(stars)) throw oops('Pick 1 to 5 stars.');
  db.prepare(`INSERT INTO dir_reviews (listing_id, user_id, stars, relation, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT (listing_id, user_id) DO UPDATE SET stars = excluded.stars, relation = excluded.relation, note = excluded.note, updated_at = datetime('now')`)
    .run(l.id, req.user.id, stars, RELATION[b.relation] ? b.relation : null, clean(b.note, 600) || null);
  return reviewView(l.id, req.user.id, isOwner(req)); }));
router.delete('/item/:id/reviews', wrap(req => { db.prepare('DELETE FROM dir_reviews WHERE listing_id = ? AND user_id = ?').run(Number(req.params.id), req.user.id); return reviewView(Number(req.params.id), req.user.id, isOwner(req)); }));
router.post('/reviews/:rid/report', wrap(req => { const rid = Number(req.params.rid), r = db.prepare('SELECT * FROM dir_reviews WHERE id = ?').get(rid); if (!r) throw oops('Review not found.', 404);
  if (r.user_id === req.user.id) throw oops('That’s your own review.');
  db.prepare('INSERT OR IGNORE INTO dir_review_reports (review_id, user_id, reason) VALUES (?, ?, ?)').run(rid, req.user.id, clean(req.body.reason, 80) || null);
  if (db.prepare('SELECT COUNT(*) n FROM dir_review_reports WHERE review_id = ?').get(rid).n >= REPORTS_TO_HIDE) db.prepare("UPDATE dir_reviews SET status = 'hidden' WHERE id = ?").run(rid); }));
// Suggest an edit (goes to the owner's approval queue).
router.post('/item/:id/suggest', wrap(req => { const l = listing(req.params.id, req), b = req.body || {}, field = String(b.field || '');
  const own = (TYPES[l.type] || { fields: [] }).fields.map(f => f[0]); if (!COMMON.some(c => c[0] === field) && !own.includes(field)) throw oops('Pick what to fix.');
  const value = clean(b.value, 2000); if (!value) throw oops('Type the fix.');
  if (db.prepare("SELECT COUNT(*) n FROM dir_suggestions WHERE user_id = ? AND created_at > datetime('now','-1 day')").get(req.user.id).n >= 20) throw oops('That’s a lot of suggestions for one day. Thank you! Try again tomorrow.');
  const was = COMMON.some(c => c[0] === field) ? (field === 'other' ? null : l[field]) : json(l.data, {})[field];
  db.prepare('INSERT INTO dir_suggestions (listing_id, field, value, was, note, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(l.id, field, value, was == null ? null : String(was), clean(b.note, 500) || null, req.user.id); }));
// Suggest a new listing: it waits, unpublished, until the owner checks it.
router.post('/submit', wrap(req => { const b = req.body || {}; if (!TYPES[b.type]) throw oops('Pick a type.');
  const name = clean(b.name, 200); if (!name) throw oops('Type the name.');
  if (db.prepare("SELECT COUNT(*) n FROM dir_listings WHERE submitted_by = ? AND created_at > datetime('now','-1 day')").get(req.user.id).n >= 5) throw oops('That’s five suggestions today. Thank you! Try again tomorrow.');
  db.prepare("INSERT INTO dir_listings (type, name, status, summary, website, city, state, country, submitted_by) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)")
    .run(b.type, name, clean(b.summary, 600) || null, httpsOrEmpty(b.website, 'The website'), clean(b.city, 80) || null, clean(b.state, 80) || null, clean(b.country, 80) || null, req.user.id); }));

// ---------- the owner ----------
const admin = express.Router();
admin.use(ownerOnly);
admin.get('/', wrap(() => { const stats = reviewStats(), opens = new Map(db.prepare("SELECT listing_id, SUM(n) n FROM dir_opens WHERE day >= date('now','-30 days') GROUP BY listing_id").all().map(r => [r.listing_id, r.n]));
  return { listings: db.prepare('SELECT * FROM dir_listings ORDER BY name COLLATE NOCASE').all().map(l => ({ ...out(l, true, stats), opens30: opens.get(l.id) || 0, note: l.note || '' })) }; }));
admin.get('/queue', wrap(() => ({
  pending: db.prepare("SELECT l.*, u.email FROM dir_listings l LEFT JOIN users u ON u.id = l.submitted_by WHERE l.status = 'pending' ORDER BY l.id").all(),
  suggestions: db.prepare("SELECT s.*, l.name, l.type, u.email FROM dir_suggestions s JOIN dir_listings l ON l.id = s.listing_id LEFT JOIN users u ON u.id = s.user_id WHERE s.status = 'new' ORDER BY s.id").all(),
  hiddenReviews: db.prepare("SELECT r.*, l.name, (SELECT GROUP_CONCAT(reason, '; ') FROM dir_review_reports x WHERE x.review_id = r.id) reasons FROM dir_reviews r JOIN dir_listings l ON l.id = r.listing_id WHERE r.status = 'hidden' ORDER BY r.id").all(),
  opens30: (db.prepare("SELECT SUM(n) n FROM dir_opens WHERE day >= date('now','-30 days')").get() || {}).n || 0,
  top: db.prepare("SELECT o.listing_id id, SUM(o.n) n, l.name FROM dir_opens o JOIN dir_listings l ON l.id = o.listing_id WHERE o.day >= date('now','-30 days') GROUP BY o.listing_id ORDER BY n DESC LIMIT 10").all() })));
const fields = (b, type) => {
  if (!TYPES[type]) throw oops('Pick a type.');
  const name = clean(b.name, 200); if (!name) throw oops('Type the name.');
  const data = {}; for (const [k, , kind] of TYPES[type].fields) { if (kind === 'yesno') data[k] = !!b['d_' + k]; else { const v = clean(b['d_' + k], kind === 'long' ? 4000 : 400); if (v) data[k] = v; } }
  const email = clean(b.contact_email, 200); if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw oops('That contact email doesn’t look right.');
  return { type, name, status: ['draft', 'published'].includes(b.status) ? b.status : 'draft', summary: clean(b.summary, 600) || null, description: clean(b.description, 8000) || null,
    website: httpsOrEmpty(b.website, 'The website'), contact_email: email || null, phone: clean(b.phone, 60) || null, city: clean(b.city, 80) || null, state: clean(b.state, 80) || null, country: clean(b.country, 80) || null,
    logo_url: httpsOrEmpty(b.logo_url, 'The logo'), video_url: httpsOrEmpty(b.video_url, 'The video'), photos: JSON.stringify(String(b.photos || '').split(/\s+/).filter(u => /^https?:\/\/\S+$/i.test(u)).slice(0, 12)),
    links: JSON.stringify(linksFrom(b.links)), data: JSON.stringify(data), note: clean(b.note, 2000) || null };
};
admin.get('/item/:id', wrap(req => { const l = db.prepare('SELECT * FROM dir_listings WHERE id = ?').get(Number(req.params.id)); if (!l) throw oops('That listing isn’t here.', 404);
  return { listing: { ...l, photosText: json(l.photos, []).join('\n'), linksText: linksText(json(l.links, [])), data: json(l.data, {}) }, reviews: reviewView(l.id, 0, true) }; }));
admin.post('/', wrap(req => { const f = fields(req.body || {}, (req.body || {}).type), cols = Object.keys(f);
  return { id: Number(db.prepare(`INSERT INTO dir_listings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(f)).lastInsertRowid) }; }));
admin.put('/item/:id', wrap(req => { const l = db.prepare('SELECT * FROM dir_listings WHERE id = ?').get(Number(req.params.id)); if (!l) throw oops('That listing isn’t here.', 404);
  const f = fields(req.body || {}, (req.body || {}).type || l.type); db.prepare(`UPDATE dir_listings SET ${Object.keys(f).map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(f), l.id); }));
admin.delete('/item/:id', wrap(req => { db.prepare('DELETE FROM dir_listings WHERE id = ?').run(Number(req.params.id)); }));
admin.post('/item/:id/publish', wrap(req => { db.prepare("UPDATE dir_listings SET status = 'published', updated_at = datetime('now') WHERE id = ?").run(Number(req.params.id)); }));
// Approve a suggested edit (the value goes into the listing) or decline it.
admin.post('/suggestions/:sid', wrap(req => tx(() => { const s = db.prepare('SELECT * FROM dir_suggestions WHERE id = ?').get(Number(req.params.sid)); if (!s || s.status !== 'new') throw oops('That suggestion was already handled.');
  if (req.body.approve === true && s.field !== 'other') { const l = db.prepare('SELECT * FROM dir_listings WHERE id = ?').get(s.listing_id);
    if (COMMON.some(c => c[0] === s.field)) { if (s.field === 'website') httpsOrEmpty(s.value, 'The website'); db.prepare(`UPDATE dir_listings SET ${s.field} = ?, updated_at = datetime('now') WHERE id = ?`).run(s.value, l.id); }
    else { const d = json(l.data, {}); const f = (TYPES[l.type].fields.find(x => x[0] === s.field) || [])[2]; d[s.field] = f === 'yesno' ? /^(y|yes|true|1)$/i.test(s.value) : s.value; db.prepare("UPDATE dir_listings SET data = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(d), l.id); } }
  db.prepare("UPDATE dir_suggestions SET status = ?, decided_at = datetime('now') WHERE id = ?").run(req.body.approve === true ? 'approved' : 'declined', s.id); })));
// A hidden review: put it back (clears its reports) or remove it.
admin.post('/reviews/:rid', wrap(req => { const rid = Number(req.params.rid);
  if (req.body.action === 'remove') db.prepare('DELETE FROM dir_reviews WHERE id = ?').run(rid); else { db.prepare('DELETE FROM dir_review_reports WHERE review_id = ?').run(rid); db.prepare("UPDATE dir_reviews SET status = 'live' WHERE id = ?").run(rid); } }));

// One clearly marked sample, so the page can be tried.
try { if (!db.prepare("SELECT 1 FROM settings WHERE key = 'seed_directory_v1'").get()) {
  db.prepare(`INSERT INTO dir_listings (type, name, status, summary, description, city, state, country, data, note) VALUES ('site', 'Sample listing (delete me)', 'published',
    'A made-up research site to show how listings look. Delete it before launch.', 'Everything here is made up.', 'Anytown', 'Ohio', 'United States', ?, 'Sample made by the app. Delete before launch.')`)
    .run(JSON.stringify({ therapeutic_areas: 'Cardiology, endocrinology', phases: 'II, III', irb: 'Central', feasibility: 'Sample answer: about 4 patients a month for a typical diabetes study.' }));
  db.prepare("INSERT INTO settings (key, value) VALUES ('seed_directory_v1', 'done')").run(); } } catch (err) { console.error('Directory sample:', err.message); }

const mount = app => app.use('/api/admin/directory', admin);
module.exports = { router, mount, TYPES };
