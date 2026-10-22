// SEO mapping, ported from psyrenne's seo.js (one site only: psyrenne's multi-site sites.js and its X-Psy-Site header are gone).
// The owner uploads Semrush and Google Search Console exports (CSV or Excel), or imports from Semrush when SEMRUSH_API_KEY is
// set. Terms are grouped into an SEO plan, each matched to the closest article on the WordPress site (sent here through the
// signed endpoint in sitesync.js). Claude can sort the terms into a pillar → cluster → detail topic map (ANTHROPIC_API_KEY).
// Picks become article ideas (ideas.js).
const express = require('express');
const { db, getSetting, setSetting } = require('./db');
const { ownerOnly } = require('./auth');
const ideas = require('./ideas');
const ai = require('./ai');

db.exec(`CREATE TABLE IF NOT EXISTS seo_terms (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL, origin TEXT NOT NULL, position REAL, clicks INTEGER,
  impressions INTEGER, volume INTEGER, url TEXT, file TEXT, status TEXT NOT NULL DEFAULT 'new', note TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT, kd REAL, traffic REAL, prev_position REAL, prev_clicks INTEGER, prev_at TEXT, UNIQUE (term, origin));
CREATE TABLE IF NOT EXISTS seo_articles (id INTEGER PRIMARY KEY, title TEXT, status TEXT, url TEXT, edit TEXT, keyphrase TEXT, text TEXT, slug TEXT, date_gmt TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS seo_plan (key TEXT PRIMARY KEY, parent TEXT, target INTEGER NOT NULL DEFAULT 0, request_id INTEGER, ai INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0, not_match TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS seo_topics (key TEXT PRIMARY KEY, parent TEXT, level INTEGER NOT NULL DEFAULT 3, manual INTEGER NOT NULL DEFAULT 0, updated_at TEXT);`);

const siteDomain = () => { try { return new URL(getSetting('site_url')).hostname.replace(/^www\./, ''); } catch { return 'clinicalresearchpro.com'; } };
const ABOUT = 'clinicalresearchpro.com (Clinical Research Pro), training and career help for clinical research professionals: Good Clinical Practice (ICH E6(R3)), CRC and CRA careers, research sites, sponsors and CROs, regulatory and IRB work, feasibility, and clinical research project management and PMP prep';
const EX = { pillar: 'good clinical practice', cluster: 'ich gcp e6 r3 training', detail: 'how often does gcp training need to be renewed' };

// The website sends every article with its status (see NOTES-FOR-CLAUDE.md for the exact request).
function receiveArticles(list) {
  const put = db.prepare("INSERT INTO seo_articles (id, title, status, url, edit, keyphrase, text, slug, date_gmt, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))");
  db.exec('BEGIN'); IDX.ver = null;
  try { db.exec('DELETE FROM seo_articles'); for (const a of list) if (a && Number(a.id)) put.run(Number(a.id), String(a.title || '').slice(0, 300), String(a.status || '').slice(0, 20), String(a.url || '').slice(0, 500), String(a.edit || '').slice(0, 500),
      String(a.keyphrase || '').slice(0, 200), String(a.text || '').slice(0, 60000), String(a.slug || '').slice(0, 200) || null, String(a.date_gmt || '').slice(0, 30) || null); db.exec('COMMIT'); }
  catch (err) { db.exec('ROLLBACK'); throw err; }
}

// ---------- reading the exports ----------
const { parseCsv } = require('./csv');
const num = v => { const n = Number(String(v ?? '').replace(/[,%\s]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const TERM = /^(term|terms|keyword|keywords|top queries|query|queries|search query|search term|organic google search query)$/;
function readExport(name, text, b64) {
  const fromHeader = list => { const clean = list.filter(r => r.some(x => String(x).trim())); const i = clean.slice(0, 15).findIndex(r => r.some(h => TERM.test(String(h).trim().toLowerCase()))); return i < 0 ? clean : clean.slice(i); };
  let rows;
  if (b64) { const X = require('xlsx'), wb = X.read(Buffer.from(String(b64), 'base64'), { type: 'buffer' });
    const tabs = wb.SheetNames.map(n => ({ n, rows: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }) }));
    const has = t => t.rows.slice(0, 15).some(r => r.some(h => TERM.test(String(h).trim().toLowerCase())));
    const pick = tabs.find(t => /^(queries|keywords?)$/i.test(t.n.trim()) && has(t)) || tabs.find(has) || tabs[0];
    rows = fromHeader(pick ? pick.rows : []); }
  else rows = fromHeader(parseCsv(String(text || '').split(/\r?\n/).filter(l => !/^#/.test(l)).join('\n')));
  if (!rows.length) throw new Error('That file is empty.');
  const head = rows[0].map(h => String(h).trim().toLowerCase()), col = re => head.findIndex(h => re.test(h));
  const iTerm = col(TERM), iOrigin = col(/^(origin|source)$/);
  if (iTerm < 0) throw new Error('I couldn’t find the search terms column. It should be called Term, Keyword, or Top queries.');
  const iKd = col(/keyword difficulty|^kd%?$/), iTraffic = col(/^traffic$/), iPos = col(/^(position|average position|current position|pos\.?|organic google search average position)$/), iClicks = col(/^(organic google search )?clicks$/), iImpr = col(/^(organic google search )?impressions$/), iVol = col(/search volume|^volume$/), iUrl = col(/^(url|landing page|page|landing page \+ query string)$/);
  const guess = iImpr >= 0 && iClicks >= 0 ? 'Search Console' : iVol >= 0 || head.some(h => /keyword difficulty|^kd/.test(h)) ? 'Semrush' : /semrush/i.test(name) ? 'Semrush' : /console|gsc|quer/i.test(name) ? 'Search Console' : 'Upload';
  const out = [];
  for (const r of rows.slice(1)) { const term = String(r[iTerm] || '').trim().replace(/\s+/g, ' ').slice(0, 200); if (!term) continue;
    let origin = iOrigin >= 0 ? String(r[iOrigin] || '').trim().slice(0, 40) : guess; if (!origin) origin = guess;
    if (/^gsc$|google|console/i.test(origin)) origin = 'Search Console'; else if (/sem/i.test(origin)) origin = 'Semrush';
    out.push({ term, origin, position: iPos >= 0 ? num(r[iPos]) : null, clicks: iClicks >= 0 ? num(r[iClicks]) : null, impressions: iImpr >= 0 ? num(r[iImpr]) : null, volume: iVol >= 0 ? num(r[iVol]) : null,
      url: iUrl >= 0 ? String(r[iUrl] || '').trim().slice(0, 500) || null : null, kd: iKd >= 0 ? num(r[iKd]) : null, traffic: iTraffic >= 0 ? num(r[iTraffic]) : null }); }
  return out;
}

// ---------- matching terms to articles (words, not AI) ----------
const STOP = new Set('a an and are as at be best by can do does for from get how i in is it my of on or the this to vs what when where which who why with you your'.split(' '));
const stem = w => w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
const words = s => String(s || '').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)).map(stem);
const keyOf = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
function match(terms) {
  const want = [...new Set(terms.flatMap(t => words(t)))]; if (!want.length) return [];
  const phrases = terms.map(t => String(t).toLowerCase().trim()).filter(Boolean);
  return db.prepare('SELECT * FROM seo_articles').all().map(a => {
    const tw = new Set(words(a.title)), kw = new Set(words(a.keyphrase)), xw = new Set(words(a.text)), low = (a.title + ' ' + a.keyphrase + ' ' + a.text).toLowerCase();
    const hits = want.filter(w => tw.has(w) || kw.has(w) || xw.has(w)), inTitle = want.filter(w => tw.has(w)), inKey = want.filter(w => kw.has(w)), phrase = phrases.filter(p => low.includes(p));
    const score = Math.round((hits.length / want.length) * 60 + (inTitle.length / want.length) * 20 + (inKey.length / want.length) * 10 + (phrase.length ? 10 : 0));
    return { id: a.id, title: a.title, status: a.status, url: a.url, edit: a.edit, keyphrase: a.keyphrase, score: Math.min(100, score), missing: want.filter(w => !hits.includes(w)), phrase: phrase[0] || null };
  }).filter(x => x.score >= 25).sort((a, b) => b.score - a.score).slice(0, 8);
}
// An index of the articles' words, so each term only looks at articles sharing a word with it.
let IDX = { ver: null, list: [] };
const artVer = () => { const r = db.prepare('SELECT COUNT(*) n, MAX(updated_at) at, SUM(id) s FROM seo_articles').get() || {}; return r.n + '|' + r.at + '|' + r.s; };
function articleIndex() {
  const ver = artVer(); if (IDX.ver === ver) return IDX;
  const list = db.prepare('SELECT id, title, status, url, edit, keyphrase, text FROM seo_articles ORDER BY rowid').all()
    .map(a => ({ ...a, tw: new Set(words(a.title)), kw: new Set(words(a.keyphrase)), xw: new Set(words(a.text)), low: (a.title + ' ' + a.keyphrase + ' ' + a.text).toLowerCase(), kpl: keyOf(a.keyphrase), tl: String(a.title || '').toLowerCase() }));
  const any = new Map(), push = (w, i) => { const l = any.get(w); if (l) l.push(i); else any.set(w, [i]); };
  list.forEach((a, i) => { for (const w of new Set([...a.tw, ...a.kw, ...a.xw])) push(w, i); });
  IDX = { ver, list, any, memo: new Map() }; return IDX;
}
function bestFor(term, skip) {
  const want = [...new Set(words(term))]; if (!want.length) return null;
  const I = articleIndex(), mk = term + '\u0001' + (skip && skip.size ? [...skip].sort().join(',') : ''); if (I.memo.has(mk)) return I.memo.get(mk);
  const p = keyOf(term), W = want.length, cand = new Set(); for (const w of want) for (const i of I.any.get(w) || []) cand.add(i);
  let best = null;
  for (const i of cand) { const a = I.list[i]; if (skip && skip.has(a.id)) continue;
    const hit = want.filter(w => a.tw.has(w) || a.kw.has(w) || a.xw.has(w)).length, t = want.filter(w => a.tw.has(w)).length, k = want.filter(w => a.kw.has(w)).length;
    const score = Math.min(100, Math.round(hit / W * 60 + t / W * 20 + k / W * 10 + (hit === W && a.low.includes(p) ? 10 : 0))); if (score < 35) continue;
    // Ties go to the article built for this exact search: its keyphrase is the term, then the term is in its title, then published.
    const rank = score * 1000 + (a.kpl === p ? 300 : a.kpl && (a.kpl.includes(p) || p.includes(a.kpl)) ? 150 : 0) + (a.tl.includes(p) ? 100 : 0) + (a.status === 'publish' ? 10 : 0);
    if (!best || rank > best.rank) best = { rank, score, a }; }
  const out = best ? { id: best.a.id, title: best.a.title, url: best.a.url, edit: best.a.edit, score: best.score, status: best.a.status } : null;
  I.memo.set(mk, out); return out;
}

// ---------- off-topic terms (clinical research words instead of psyrenne's creator words) ----------
const ADULT = /\b(porn|porno|xxx|sex|sexy|nude|nudes|naked|nsfw|onlyfans|escort|hentai|fetish|erotic|casino|betting|gambling|viagra|loan|loans|crypto|bitcoin)\b/i;
const CORE = ('adverse agile alcoa amendment association audit biotech blinded budget capa capm career careers case cdisc certificate certification certified clinical clinicaltrial clinicaltrials cmc compliance consent ' +
  'consultant contract coordinator course courses cra crc cro ctms data decentralized device deviation diversity drug ecoa ecrf edc eligibility endpoint enrollment esource ethic ethics etmf fda feasibility gcp ' +
  'grant guideline guidelines hipaa ich ind informed inspection investigator irb iso job jobs medical monitor monitoring nih oncology patient patients pdu pdus pharma pharmaceutical phase pi pmi pmp ' +
  'principal project protocol qa quality randomization rbqm recruitment regulatory research resume retention risk safety salary sae scrum site sites smo sop sponsor stakeholder startup study subject ' +
  'timeline training trial trials validation vendor visit webinar').split(' ');
const GENERIC = new Set('free new tips tip guide ideas idea easy make money online near me 2025 2026 2027 top list way ways start step steps using use example examples app apps vs review reviews cost price prices job'.split(' '));
let VOCAB = { at: 0, set: null };
function vocab() { if (VOCAB.set && Date.now() - VOCAB.at < 10 * 60e3) return VOCAB.set;
  const s = new Set(CORE.map(stem)); for (const a of db.prepare('SELECT title, keyphrase FROM seo_articles').all()) for (const w of words(a.title + ' ' + a.keyphrase)) if (w.length > 2 && !GENERIC.has(w)) s.add(w);
  VOCAB = { at: Date.now(), set: s }; return s; }
// Our words with other meanings: "pi" (math, Raspberry Pi), "protocol" (networks), "crc" (checksums), "site" (website builders).
// A term with one of these is off-topic unless it also has a clear clinical research word.
const OTHER_FIELD = /\b(raspberry|digits|calculator|tcp|udp|ip|http|https|network|networking|ethernet|router|bluetooth|checksum|cyclic|wordpress|wix|squarespace|shopify|domain|hosting|python|javascript|java|sql|excel|minecraft|roblox|pizza|movie|lyrics)\b/i;
const CLIN = /\b(clinical|trial|trials|research|study|studies|patient|patients|gcp|ich|irb|fda|sponsor|cro|cra|crc|pharma|medical|investigator|protocol deviation|informed consent|pmp)\b/i;
const offTopic = term => { if (ADULT.test(term)) return true; if (OTHER_FIELD.test(term) && !CLIN.test(term)) return true; const v = vocab(), w = words(term).filter(x => !GENERIC.has(x)); return !w.some(x => v.has(x)); };
// Your own rankings are never set aside as off-topic (except adult terms): if the site shows up for a search, it belongs here.
const OWN_ORIGIN = o => !/^Competitor: |^Keyword research$/.test(o);
const offTopicFor = r => OWN_ORIGIN(r.origin) ? ADULT.test(r.term) : offTopic(r.term);
function sweepOffTopic() { let n = 0; for (const r of db.prepare("SELECT id, term, origin FROM seo_terms WHERE status = 'new' AND (note IS NULL OR note <> 'kept')").all()) if (offTopicFor(r)) { db.prepare("UPDATE seo_terms SET status = 'skip', note = 'off-topic (automatic)' WHERE id = ?").run(r.id); n++; } return n; }

// ---------- routes (owner only) ----------
const STATUS = { new: 'New', idea: 'New article idea', grow: 'Grow an article', skip: 'Skipped' };
const router = express.Router();
router.use(ownerOnly);
router.get('/', (req, res) => {
  const a = db.prepare("SELECT COUNT(*) n, SUM(status = 'publish') pub, MAX(updated_at) at FROM seo_articles").get();
  res.json({ statuses: STATUS, terms: db.prepare("SELECT * FROM seo_terms ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, COALESCE(impressions, volume, 0) DESC, term LIMIT 3000").all(),
    articles: { total: a.n || 0, published: a.pub || 0, at: a.at || null }, domain: siteDomain(), ai: !!ai.client(), semrush: !!semKey() });
});
function saveTerms(rows, body) {
  const comp = String(body.competitor || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').slice(0, 80);
  const mine = body.whose === 'mine' || !body.whose || comp === siteDomain();
  if (body.whose === 'competitor' && !mine && !comp) throw new Error('Type the competitor’s site, like example.org.');
  const src = { semrush: 'Semrush', gsc: 'Search Console' }[body.source] || null;
  if (body.whose === 'research') rows = rows.map(r => ({ ...r, origin: 'Keyword research', position: null, url: null }));
  else rows = rows.map(r => ({ ...r, origin: mine ? (src || (/^Competitor: /.test(r.origin) ? 'Semrush' : r.origin)) : 'Competitor: ' + comp }));
  const up = db.prepare(`INSERT INTO seo_terms (term, origin, position, clicks, impressions, volume, url, file, kd, traffic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(term, origin) DO UPDATE SET prev_position = CASE WHEN excluded.position IS NOT NULL AND seo_terms.position IS NOT NULL THEN seo_terms.position ELSE seo_terms.prev_position END,
    prev_clicks = CASE WHEN excluded.clicks IS NOT NULL THEN seo_terms.clicks ELSE seo_terms.prev_clicks END, prev_at = COALESCE(seo_terms.updated_at, seo_terms.added_at), position = excluded.position,
    clicks = excluded.clicks, impressions = excluded.impressions, volume = excluded.volume, url = COALESCE(excluded.url, url), file = excluded.file, kd = COALESCE(excluded.kd, kd),
    traffic = COALESCE(excluded.traffic, traffic), updated_at = datetime('now')`);
  const before = db.prepare('SELECT COUNT(*) n FROM seo_terms').get().n;
  db.exec('BEGIN'); try { for (const r of rows) up.run(r.term, r.origin, r.position, r.clicks, r.impressions, r.volume, r.url, String(body.name || '').slice(0, 120), r.kd, r.traffic); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  const gone = new Set(db.prepare('SELECT key FROM seo_plan WHERE dismissed = 1').all().map(r => r.key)); let redismissed = 0;
  for (const r of db.prepare("SELECT id, term FROM seo_terms WHERE status <> 'skip'").all()) if (gone.has(keyOf(r.term))) { db.prepare("UPDATE seo_terms SET status = 'skip', note = 'dismissed' WHERE id = ?").run(r.id); redismissed++; }
  const added = db.prepare('SELECT COUNT(*) n FROM seo_terms').get().n - before;
  return { ok: true, rows: rows.length, added, updated: rows.length - added, offtopic: sweepOffTopic(), redismissed, origin: [...new Set(rows.map(r => r.origin))].join(', ') };
}
router.post('/upload', (req, res) => {
  try { const rows = readExport(String(req.body.name || ''), req.body.text, req.body.b64); if (!rows.length) throw new Error('No search terms found in that file.'); res.json(saveTerms(rows, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Semrush's own API with Jess's key (SEMRUSH_API_KEY). API units per row, from Semrush's API price list.
const SEMRUSH = { competitor: { type: 'domain_organic', per: 10 }, mine: { type: 'domain_organic', per: 10 }, research: { type: 'phrase_fullsearch', per: 20 } };
const semKey = () => String(process.env.SEMRUSH_API_KEY || '').trim();
const cleanSite = s => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').slice(0, 80);
async function semUnits() { if (!semKey()) return null; try { const r = await fetch('https://www.semrush.com/users/countapiunits.html?key=' + encodeURIComponent(semKey())); const t = (await r.text()).trim(); return /^\d+$/.test(t) ? Number(t) : null; } catch { return null; } }
router.get('/semrush', async (req, res) => res.json({ connected: !!semKey(), why: semKey() ? null : 'Semrush isn’t set up. Add SEMRUSH_API_KEY to the server’s environment, or upload CSV exports instead.', units: await semUnits(), per: Object.fromEntries(Object.entries(SEMRUSH).map(([k, v]) => [k, v.per])) }));
router.post('/semrush', async (req, res) => {
  try {
    if (!semKey()) throw new Error('Semrush isn’t set up. Add SEMRUSH_API_KEY to the server’s environment, or upload CSV exports instead.');
    const b = req.body || {}, mode = SEMRUSH[b.mode] ? b.mode : 'competitor', limit = Math.max(10, Math.min(25000, Math.round(Number(b.limit) || 100)));
    const database = /^[a-z-]{2,12}$/.test(String(b.database || '')) ? b.database : 'us';
    const target = mode === 'mine' ? siteDomain() : mode === 'research' ? String(b.target || '').trim().slice(0, 80) : cleanSite(b.target);
    if (!target) throw new Error(mode === 'research' ? 'Type a keyword to research, like “gcp training”.' : 'Type the competitor’s site, like example.org.');
    const q = new URLSearchParams({ type: SEMRUSH[mode].type, key: semKey(), database, display_limit: String(limit), display_sort: mode === 'research' ? 'nq_desc' : 'tr_desc',
      export_columns: mode === 'research' ? 'Ph,Nq,Kd,Cp' : 'Ph,Po,Nq,Ur,Tr,Kd', ...(mode === 'research' ? { phrase: target } : { domain: target }) });
    const r = await fetch('https://api.semrush.com/?' + q.toString()), text = await r.text();
    if (/^ERROR\s*50\b|NOTHING FOUND/i.test(text)) return res.json({ ok: true, rows: 0, added: 0, updated: 0, note: 'Semrush has no terms for that.' });
    if (!r.ok || /^ERROR/i.test(text.trim())) throw new Error('Semrush said: ' + text.trim().slice(0, 160));
    const lines = text.trim().split(/\r?\n/), head = lines.shift().split(';').map(h => h.trim().toLowerCase()), col = n => head.findIndex(h => h === n);
    const n2 = v => { const x = Number(String(v || '').replace(/[^\d.]/g, '')); return Number.isFinite(x) && String(v || '').trim() !== '' ? x : null; };
    const iK = col('keyword'), iP = col('position'), iV = col('search volume'), iU = col('url'), iT = col('traffic'), iD = col('keyword difficulty');
    const rows = lines.map(l => l.split(';')).filter(c => c[iK]).map(c => ({ term: String(c[iK]).trim().slice(0, 200), origin: 'Semrush', position: iP >= 0 ? n2(c[iP]) : null, clicks: null, impressions: null,
      volume: iV >= 0 ? n2(c[iV]) : null, url: iU >= 0 ? (String(c[iU] || '').trim() || null) : null, kd: iD >= 0 ? n2(c[iD]) : null, traffic: iT >= 0 ? n2(c[iT]) : null }));
    const name = `Semrush ${mode === 'research' ? 'keywords' : 'rankings'}: ${target} (${new Date().toISOString().slice(0, 10)})`;
    res.json({ ...saveTerms(rows, { name, source: 'semrush', whose: mode === 'research' ? 'research' : mode === 'mine' ? 'mine' : 'competitor', competitor: mode === 'competitor' ? target : '' }), used: rows.length * SEMRUSH[mode].per, units: await semUnits() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/search', (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean).slice(0, 50), terms = ids.length ? db.prepare(`SELECT term FROM seo_terms WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.term) : [];
  if (!terms.length) return res.status(400).json({ error: 'Tick at least one term.' });
  res.json({ terms, results: match(terms), articles: db.prepare('SELECT COUNT(*) n FROM seo_articles').get().n });
});
// New article, grow an existing one, skip, or put back to New. New and grow add to Article ideas.
router.post('/decide', (req, res) => {
  const b = req.body || {}, ids = (b.ids || []).map(Number).filter(Boolean).slice(0, 50); if (!ids.length) return res.status(400).json({ error: 'Tick at least one term.' });
  const rows = db.prepare(`SELECT * FROM seo_terms WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const what = ['idea', 'grow', 'skip', 'new'].includes(b.action) ? b.action : null; if (!what) return res.status(400).json({ error: 'Pick what to do.' });
  const line = rows.map(r => `${r.term} (${r.origin}${r.position != null ? ', position ' + r.position : ''}${r.impressions != null ? ', ' + r.impressions + ' impressions' : ''}${r.volume != null ? ', ' + r.volume + ' searches a month' : ''})`).join('; ');
  if (what === 'idea' || what === 'grow') {
    const art = what === 'grow' ? db.prepare('SELECT id, title, url, edit FROM seo_articles WHERE id = ?').get(Number(b.articleId)) : null;
    if (what === 'grow' && !art) return res.status(400).json({ error: 'Pick the article to add to.' });
    ideas.add({ topic: what === 'grow' ? `Grow: ${art.title}` : String(b.title || rows[0].term).trim(), note: `From search: ${line}`, source: 'search', terms: rows.map(r => r.term), ...(art ? { articleId: art.id, url: art.url, edit: art.edit } : {}) });
  }
  db.prepare(`UPDATE seo_terms SET status = ?, note = ?, updated_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`).run(what, what === 'grow' ? `Article ${b.articleId}` : null, ...ids);
  if (what === 'skip' || what === 'new') for (const r of rows) db.prepare("INSERT INTO seo_plan (key, dismissed, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET dismissed = excluded.dismissed, updated_at = excluded.updated_at").run(keyOf(r.term), what === 'skip' ? 1 : 0);
  res.json({ ok: true });
});
router.get('/articles-list', (req, res) => res.json({ articles: db.prepare('SELECT id, title, status, url, edit, keyphrase FROM seo_articles ORDER BY title COLLATE NOCASE').all() }));
// Request an update to an existing article: it goes to Article ideas with the notes.
router.post('/revise', (req, res) => { const b = req.body || {}, art = db.prepare('SELECT id, title, url, edit, keyphrase FROM seo_articles WHERE id = ?').get(Number(b.articleId));
  if (!art) return res.status(400).json({ error: 'Pick the article to update.' });
  const notes = String(b.notes || '').trim().slice(0, 3000); if (notes.length < 5) return res.status(400).json({ error: 'Say what should change (a sentence or two is fine).' });
  const terms = String(b.terms || '').split(/[,\n]/).map(t => t.trim()).filter(Boolean).slice(0, 20), key = String(b.keyphrase || '').trim().slice(0, 120) || art.keyphrase || '';
  ideas.add({ topic: 'Update: ' + art.title, note: 'Update request for an existing article. Change only what the notes ask; keep the address.' + (terms.length ? ' Also cover: ' + terms.join(', ') + '.' : ''),
    source: 'revise', kind: 'revise', articleId: art.id, url: art.url, edit: art.edit, keyphrase: key, terms: key ? [key, ...terms] : terms, ai: !!b.ai, notes: 'UPDATE THIS ARTICLE, do not write a new one. ' + notes });
  res.json({ ok: true }); });

// ---------- the SEO plan ----------
const notMatch = p => { try { return new Set(JSON.parse((p && p.not_match) || '[]').map(Number)); } catch { return new Set(); } };
router.post('/plan/not-match', (req, res) => { const k = keyOf((req.body || {}).key), id = Number((req.body || {}).article_id); if (!k) return res.status(400).json({ error: 'Pick a term.' });
  const cur = notMatch(db.prepare('SELECT not_match FROM seo_plan WHERE key = ?').get(k)); if (req.body.clear) cur.clear(); else if (id) cur.add(id);
  db.prepare("INSERT INTO seo_plan (key, not_match, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET not_match = excluded.not_match, updated_at = excluded.updated_at").run(k, JSON.stringify([...cur]));
  res.json({ ok: true }); });
const slim = t => { const o = {}; for (const [k, v] of Object.entries(t)) { if (v == null || v === false || (k === 'notMatch' && !v) || k === 'status' || k === 'manual') continue; o[k] = v; }
  o.target = !!t.target; if (t.competitors) o.competitors = t.competitors.map(c => c.position != null ? { name: c.name, position: c.position } : { name: c.name }); if (t.children) o.children = t.children.map(slim); return o; };
router.get('/plan', (req, res) => {
  try { ideas.markPublished(); } catch {}
  const ideaList = ideas.list(), ideaById = new Map(ideaList.map(i => [i.id, i]));
  const mineOnly = req.query.scope === 'mine', withWant = req.query.include === '1', isMine = o => OWN_ORIGIN(o);
  const rowsAll = db.prepare("SELECT * FROM seo_terms WHERE status <> 'skip'").all(), mineKeys = new Set(rowsAll.filter(r => isMine(r.origin)).map(r => keyOf(r.term)));
  const by = new Map();
  for (const r of rowsAll.filter(r => !mineOnly || isMine(r.origin) || (withWant && !mineKeys.has(keyOf(r.term))))) { const k = keyOf(r.term);
    const g = by.get(k) || { key: k, term: r.term, volume: null, kd: null, ours: null, impressions: null, competitors: [], ids: [], clicks: null, url: null, sources: [], status: r.status, want: !mineKeys.has(k) };
    g.ids.push(r.id); if (!g.sources.includes(r.origin)) g.sources.push(r.origin); if (r.clicks != null) g.clicks = (g.clicks || 0) + r.clicks; if (r.prev_clicks != null) g.clicksPrev = (g.clicksPrev || 0) + r.prev_clicks;
    if (isMine(r.origin) && r.url && !g.url) g.url = r.url; if (r.status !== 'new') g.status = r.status;
    if (r.volume != null) g.volume = Math.max(g.volume || 0, r.volume); if (r.kd != null) g.kd = Math.max(g.kd || 0, r.kd); if (r.impressions != null) g.impressions = (g.impressions || 0) + r.impressions;
    if (/^Competitor: /.test(r.origin)) g.competitors.push({ name: r.origin.slice(12), position: r.position, url: r.url }); else if (r.position != null && (g.ours == null || r.position < g.ours)) { g.ours = r.position; g.oursPrev = r.prev_position ?? null; }
    by.set(k, g); }
  const plan = new Map(db.prepare('SELECT * FROM seo_plan').all().map(p => [p.key, p]));
  const keys = [...by.keys()], wsets = new Map(keys.map(k => [k, new Set(words(k))]));
  // Automatic parent: the longest other term (2+ words) whose words are all inside this one. The owner can move any term.
  const byWord = new Map(); for (const o of keys) { const ow = wsets.get(o); if (ow.size < 2) continue; for (const x of ow) { if (!byWord.has(x)) byWord.set(x, []); byWord.get(x).push(o); } }
  const apMemo = new Map(), autoParent = k => { if (apMemo.has(k)) return apMemo.get(k); const w = wsets.get(k); let best = null; const seen = new Set();
    for (const x of w) for (const o of byWord.get(x) || []) { if (o === k || seen.has(o)) continue; seen.add(o); const ow = wsets.get(o); if (ow.size > w.size) continue;
      if (ow.size === w.size) { const vo = by.get(o).volume || 0, vk = by.get(k).volume || 0; if (vo < vk || (vo === vk && (o.length > k.length || (o.length === k.length && o > k)))) continue; }
      if ([...ow].every(y => w.has(y)) && (!best || ow.size > wsets.get(best).size || (ow.size === wsets.get(best).size && o.length < best.length))) best = o; }
    apMemo.set(k, best); return best; };
  // by=topic: the AI topic map decides the parent; a term it hasn't placed yet climbs its word parents until one is placed.
  const topics = req.query.by === 'topic' ? new Map(db.prepare('SELECT * FROM seo_topics').all().filter(t => by.has(t.key)).map(t => [t.key, t])) : null;
  const topicParent = k => { const t = topics.get(k); if (t) return t.parent && topics.has(t.parent) && t.parent !== k ? t.parent : null; let p = autoParent(k), n = 0; while (p && !topics.has(p) && n++ < 60) p = autoParent(p); return p || null; };
  const parentOf = new Map(keys.map(k => { if (topics) return [k, topicParent(k)]; const p = plan.get(k); return [k, p && p.parent != null ? (p.parent && by.has(p.parent) && p.parent !== k ? p.parent : null) : autoParent(k)]; }));
  const top = k => { let p = parentOf.get(k), n = 0; while (p && parentOf.get(p) && n++ < 60) p = parentOf.get(p); return p || k; };
  const out = k => { const g = by.get(k), p = plan.get(k) || {}, idea = p.request_id ? ideaById.get(p.request_id) : null, nm = notMatch(p);
    return { ...g, target: !!p.target, article: bestFor(g.term, nm), notMatch: nm.size, requested: idea ? { status: idea.statusName, title: idea.topic, notes: idea.notes || '', edit: idea.edit || null } : null, manual: p.parent != null,
      ...(topics ? { level: topics.has(k) ? topics.get(k).level : null } : {}) }; };
  // A requested term takes the terms under it into the "Drafts requested" box.
  const isReq = k => { const p = plan.get(k); return !!(p && p.request_id && ideaById.has(p.request_id) && !['dropped', 'published'].includes(ideaById.get(p.request_id).status)); };
  const reqOwner = k => { let owner = null, c = k, n = 0; while (c && n++ < 60) { if (isReq(c)) owner = c; c = parentOf.get(c); } return owner; };
  const ownerOf = new Map(keys.map(k => [k, reqOwner(k)])), boxed = new Map();
  for (const k of keys) { const o = ownerOf.get(k); if (!o) continue; if (!boxed.has(o)) boxed.set(o, { ...out(o), children: [] }); if (k !== o) boxed.get(o).children.push(out(k)); }
  const requested = [...boxed.values()].sort((a, b) => a.term.localeCompare(b.term));
  const planKeys = keys.filter(k => !ownerOf.get(k)), groups = new Map();
  for (const k of planKeys) { const t = top(k); if (!groups.has(t)) groups.set(t, { ...out(t), children: [] }); if (t !== k) groups.get(t).children.push(out(k)); }
  const list = [...groups.values()].map(g => ({ ...g, total: (g.volume || 0) + g.children.reduce((a, c) => a + (c.volume || 0), 0), children: g.children.sort((a, b) => (b.volume || 0) - (a.volume || 0)) }))
    .sort((a, b) => (b.target - a.target) || (b.total - a.total) || a.term.localeCompare(b.term));
  const competitors = [...new Set(db.prepare("SELECT origin FROM seo_terms WHERE origin LIKE 'Competitor: %'").all().map(r => r.origin.slice(12)))].sort();
  res.set('Cache-Control', 'no-store');
  if (req.query.tree === '1') return res.json({ requested: requested.map(slim), mapped: topics ? topics.size : null, tree: planKeys.map(k => slim({ ...out(k), parent: parentOf.get(k) || null })), competitors });
  res.json({ requested: requested.map(slim), groups: list.map(slim), competitors, articles: articleIndex().list.length });
});
// ⭐ a main term, or move a term under another one ('' = make it a main term; null = back to automatic).
router.put('/plan', (req, res) => { const b = req.body || {}, k = keyOf(b.key); if (!k) return res.status(400).json({ error: 'Which term?' });
  const cur = db.prepare('SELECT * FROM seo_plan WHERE key = ?').get(k) || {};
  const parent = 'parent' in b ? (b.parent === null ? null : keyOf(b.parent)) : cur.parent ?? null, target = 'target' in b ? (b.target ? 1 : 0) : cur.target || 0;
  db.prepare("INSERT INTO seo_plan (key, parent, target, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET parent = excluded.parent, target = excluded.target, updated_at = excluded.updated_at").run(k, parent, target);
  res.json({ ok: true }); });

// The topic map: Claude sorts the terms by topic and search intent, like H1, H2, and H3. Level 1 = pillar, 2 = cluster,
// 3 = detail. The owner's own moves are kept (manual = 1) when it rebuilds.
const TOPIC_SYSTEM = `You organize search phrases into an SEO topic map for ${ABOUT}.
The map works like H1, H2, and H3 headings:
- Level 1, pillar: a broad, high-volume phrase a whole cornerstone guide answers. Example: "${EX.pillar}".
- Level 2, cluster: a subtopic of a pillar that a section or its own supporting article covers. Example: "${EX.cluster}".
- Level 3, detail: a specific question or long-tail phrase under a cluster. Example: "${EX.detail}".
The readers are clinical research professionals and people moving into the field: CRCs, CRAs, PIs, site managers, sponsor and CRO staff, regulatory and IRB staff, and project managers (PMP).
Typical topics: GCP and ICH guidelines, informed consent, IRBs, protocols and deviations, feasibility, site startup, monitoring, budgets, recruitment, careers and certifications, project management.
Group by topic and what the searcher wants, not by shared words. Use the phrases exactly as given; never invent or reword one.`;
let topicJob = { running: false, step: '', done: 0, total: 0, error: null, at: null };
async function buildTopics() {
  const gone = new Set(db.prepare('SELECT key FROM seo_plan WHERE dismissed = 1').all().map(r => r.key)), all = new Map();
  for (const r of db.prepare("SELECT term, volume FROM seo_terms WHERE status <> 'skip'").all()) { const k = keyOf(r.term); if (!k || gone.has(k)) continue;
    const g = all.get(k) || { key: k, term: r.term, volume: 0 }; g.volume = Math.max(g.volume, r.volume || 0); all.set(k, g); }
  const list = [...all.values()].sort((a, b) => b.volume - a.volume || a.key.localeCompare(b.key)).slice(0, 3000);
  if (!list.length) throw new Error('Upload some search terms first.');
  const manual = new Map(db.prepare('SELECT * FROM seo_topics WHERE manual = 1').all().map(t => [t.key, t])), line = t => `${t.term} | ${t.volume || 0}`;
  topicJob.step = 'Picking the pillars'; topicJob.total = Math.ceil(Math.max(0, list.length - 400) / 200) + 2;
  const outline = await ai.askJson({ system: TOPIC_SYSTEM, maxTokens: 12000, schema: { type: 'object', additionalProperties: false, required: ['pillars'], properties: { pillars: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['term', 'clusters'], properties: { term: { type: 'string' }, clusters: { type: 'array', items: { type: 'string' } } } } } } },
    content: `Here are the site's top search phrases (phrase | searches a month). Pick 5 to 15 pillars, each one a phrase from this list, and under each pillar 2 to 15 clusters, also phrases from this list. Pillars should be broad and high-volume. A phrase appears at most once.\n\n${list.slice(0, 400).map(line).join('\n')}` });
  const placed = new Map(), add = (k, parent, level) => { if (!all.has(k) || placed.has(k) || manual.has(k)) return; placed.set(k, { parent, level }); };
  for (const p of outline.pillars || []) { const pk = keyOf(p.term); add(pk, null, 1); if (!placed.has(pk) && !manual.has(pk)) continue; for (const cl of p.clusters || []) add(keyOf(cl), pk, 2); }
  topicJob.done = 1;
  const heads = () => { const o = []; for (const [k, v] of [...placed, ...manual]) if (v.level <= 2) o.push(`${v.level === 1 ? 'PILLAR' : '  cluster'}: ${all.get(k) ? all.get(k).term : k}`); return o.join('\n'); };
  const rest = list.filter(t => !placed.has(t.key) && !manual.has(t.key));
  topicJob.step = 'Placing the rest'; topicJob.total = Math.ceil(rest.length / 200) + 1;
  for (let i = 0; i < rest.length; i += 200) { const batch = rest.slice(i, i + 200);
    const got = await ai.askJson({ system: TOPIC_SYSTEM, maxTokens: 12000, schema: { type: 'object', additionalProperties: false, required: ['placed'], properties: { placed: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['term', 'under'], properties: { term: { type: 'string' }, under: { type: 'string' } } } } } },
      content: `The topic map so far:\n${heads()}\n\nPut each phrase below under the pillar or cluster it fits best (use that heading's phrase exactly as "under"). Use "" when nothing fits.\n\n${batch.map(line).join('\n')}` });
    for (const g of got.placed || []) { const k = keyOf(g.term), u = keyOf(g.under), h = placed.get(u) || manual.get(u); if (!h || !all.has(k) || k === u) continue; add(k, u, Math.min(3, h.level + 1)); }
    topicJob.done++; }
  db.exec('BEGIN'); try { db.prepare('DELETE FROM seo_topics WHERE manual = 0').run();
    const ins = db.prepare("INSERT OR IGNORE INTO seo_topics (key, parent, level, manual, updated_at) VALUES (?, ?, ?, 0, datetime('now'))");
    for (const [k, v] of placed) ins.run(k, v.parent, v.level); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
  return placed.size;
}
router.get('/plan/topics', (req, res) => res.json({ ...topicJob, ai: !!ai.client(), mapped: db.prepare('SELECT COUNT(*) n FROM seo_topics').get().n }));
router.post('/plan/topics', (req, res) => { if (topicJob.running) return res.json(topicJob);
  if (!ai.client()) return res.status(400).json({ error: ai.MISSING });
  topicJob = { running: true, step: 'Starting', done: 0, total: 1, error: null, at: null };
  buildTopics().then(n => { topicJob.placed = n; }).catch(err => { topicJob.error = err.message; console.error('SEO topic map:', err.message); }).finally(() => { topicJob.running = false; topicJob.at = new Date().toISOString(); });
  res.json(topicJob); });
router.put('/plan/topics', (req, res) => { const b = req.body || {}, k = keyOf(b.key), u = keyOf(b.under); if (!k) return res.status(400).json({ error: 'Which term?' });
  let level = 1; if (u) { const h = db.prepare('SELECT level FROM seo_topics WHERE key = ?').get(u); if (!h) return res.status(400).json({ error: 'Pick a pillar or cluster.' });
    for (let p = u, n = 0; p && n < 60; n++) { if (p === k) return res.status(400).json({ error: 'That’s inside this term already.' }); const r = db.prepare('SELECT parent FROM seo_topics WHERE key = ?').get(p); p = r && r.parent; }
    level = Math.min(3, h.level + 1); }
  db.prepare("INSERT INTO seo_topics (key, parent, level, manual, updated_at) VALUES (?, ?, ?, 1, datetime('now')) ON CONFLICT(key) DO UPDATE SET parent = excluded.parent, level = excluded.level, manual = 1, updated_at = excluded.updated_at").run(k, u || null, level);
  const relevel = (p, lv) => { for (const ch of db.prepare('SELECT key FROM seo_topics WHERE parent = ?').all(p)) { db.prepare('UPDATE seo_topics SET level = ? WHERE key = ?').run(Math.min(3, lv + 1), ch.key); relevel(ch.key, lv + 1); } };
  relevel(k, level); res.json({ ok: true }); });
// Request a draft: goes to Article ideas with the main term as the keyphrase and the child terms.
router.post('/plan/request', (req, res) => { const b = req.body || {}, k = keyOf(b.key); if (!k) return res.status(400).json({ error: 'Which term?' });
  const kids = (Array.isArray(b.children) ? b.children : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 40), ai_ = !!b.ai, notes = String(b.notes || '').trim().slice(0, 3000);
  const id = ideas.add({ topic: String(b.title || k).trim(), note: `Draft request from the SEO plan. Keyphrase: ${k}.${kids.length ? ' Also cover: ' + kids.join(', ') + '.' : ''}${ai_ ? ' Include the AI disclosure note at the top.' : ''}`, source: 'plan', keyphrase: k, terms: [k, ...kids], ai: ai_, notes });
  const mark = db.prepare("INSERT INTO seo_plan (key, request_id, ai, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET request_id = excluded.request_id, ai = excluded.ai, updated_at = excluded.updated_at");
  mark.run(k, id, ai_ ? 1 : 0); for (const c of kids) mark.run(keyOf(c), id, ai_ ? 1 : 0);
  res.json({ ok: true, id }); });
router.post('/retag', (req, res) => { const b = req.body || {}, file = String(b.file || ''); if (!file) return res.status(400).json({ error: 'Which file?' });
  const comp = cleanSite(b.competitor), rows = db.prepare('SELECT id, term, clicks, impressions FROM seo_terms WHERE file = ?').all(file); let n = 0;
  for (const r of rows) { const to = b.whose === 'research' ? 'Keyword research' : b.whose === 'competitor' && comp ? 'Competitor: ' + comp : ({ semrush: 'Semrush', gsc: 'Search Console' }[b.source] || (r.clicks != null || r.impressions != null ? 'Search Console' : 'Semrush'));
    if (db.prepare('SELECT 1 FROM seo_terms WHERE term = ? AND origin = ? AND id <> ?').get(r.term, to, r.id)) db.prepare('DELETE FROM seo_terms WHERE id = ?').run(r.id); else db.prepare('UPDATE seo_terms SET origin = ? WHERE id = ?').run(to, r.id); n++; }
  res.json({ ok: true, moved: n }); });
router.post('/plan/dismiss', (req, res) => { const k = keyOf((req.body || {}).key); if (!k) return res.status(400).json({ error: 'Which term?' });
  const back = req.body.back === true; let n = 0;
  db.prepare("INSERT INTO seo_plan (key, dismissed, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET dismissed = excluded.dismissed, updated_at = excluded.updated_at").run(k, back ? 0 : 1);
  for (const r of db.prepare('SELECT id, term FROM seo_terms').all()) if (keyOf(r.term) === k) { db.prepare("UPDATE seo_terms SET status = ?, note = ?, updated_at = datetime('now') WHERE id = ?").run(back ? 'new' : 'skip', back ? 'kept' : 'dismissed', r.id); n++; }
  res.json({ ok: true, n }); });
router.post('/plan/dismiss-many', (req, res) => {
  const keys = new Set((Array.isArray((req.body || {}).keys) ? req.body.keys : []).slice(0, 5000).map(keyOf).filter(Boolean)); if (!keys.size) return res.status(400).json({ error: 'Tick some terms first.' });
  let n = 0; db.exec('BEGIN');
  try { for (const k of keys) db.prepare("INSERT INTO seo_plan (key, dismissed, updated_at) VALUES (?, 1, datetime('now')) ON CONFLICT(key) DO UPDATE SET dismissed = 1, updated_at = excluded.updated_at").run(k);
    for (const r of db.prepare('SELECT id, term FROM seo_terms').all()) if (keys.has(keyOf(r.term))) { db.prepare("UPDATE seo_terms SET status = 'skip', note = 'dismissed', updated_at = datetime('now') WHERE id = ?").run(r.id); n++; } db.exec('COMMIT'); }
  catch (err) { db.exec('ROLLBACK'); return res.status(500).json({ error: err.message }); }
  res.json({ ok: true, terms: keys.size, n });
});
router.get('/dismissed', (req, res) => res.json({ terms: db.prepare("SELECT term, GROUP_CONCAT(origin, ', ') origins, MAX(note = 'off-topic (automatic)') auto FROM seo_terms WHERE status = 'skip' GROUP BY lower(term) ORDER BY auto, term LIMIT 3000").all() }));
router.post('/sweep', (req, res) => res.json({ ok: true, n: sweepOffTopic() }));
router.post('/clear-mine', (req, res) => { if ((req.body || {}).confirm !== 'yes') return res.status(400).json({ error: 'Confirm first.' });
  res.json({ ok: true, n: db.prepare("DELETE FROM seo_terms WHERE origin NOT LIKE 'Competitor: %' AND origin <> 'Keyword research'").run().changes }); });
router.get('/files', (req, res) => res.json({ files: db.prepare("SELECT file, origin, COUNT(*) n, MAX(COALESCE(updated_at, added_at)) at FROM seo_terms WHERE file IS NOT NULL AND file <> '' GROUP BY file, origin ORDER BY at DESC LIMIT 100").all() }));
router.delete('/terms', (req, res) => { const ids = ((req.body || {}).ids || []).map(Number).filter(Boolean).slice(0, 500); if (ids.length) db.prepare(`DELETE FROM seo_terms WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids); res.json({ ok: true }); });
// Coverage color bands: the lowest score for each band, its color, and its label, plus the gray for "no article".
const BANDS_DEFAULT = { bands: [{ min: 90, color: '#1f8a4c', label: 'Covered' }, { min: 80, color: '#c99a00', label: 'Mostly' }, { min: 70, color: '#e07b1a', label: 'Partly' }, { min: 0, color: '#c93a3a', label: 'Weak' }], none: { color: '#8a8698', label: 'Not covered' } };
function bandsGet() { try { const v = JSON.parse(getSetting('seo_bands') || 'null'); return v && Array.isArray(v.bands) && v.bands.length ? v : BANDS_DEFAULT; } catch { return BANDS_DEFAULT; } }
router.get('/bands', (req, res) => res.json(bandsGet()));
router.put('/bands', (req, res) => {
  const b = req.body || {}, hex = c => /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c).toLowerCase() : null, lab = l => String(l || '').trim().slice(0, 24);
  if (b.reset) { setSetting('seo_bands', ''); return res.json(BANDS_DEFAULT); }
  const bands = (Array.isArray(b.bands) ? b.bands : []).map(x => ({ min: Math.max(0, Math.min(100, Math.round(Number(x.min) || 0))), color: hex(x.color), label: lab(x.label) })).filter(x => x.color && x.label).slice(0, 8).sort((p, q) => q.min - p.min);
  if (!bands.length) return res.status(400).json({ error: 'Keep at least one band.' });
  bands[bands.length - 1].min = 0;
  const none = { color: hex(b.none && b.none.color) || BANDS_DEFAULT.none.color, label: lab(b.none && b.none.label) || BANDS_DEFAULT.none.label };
  setSetting('seo_bands', JSON.stringify({ bands, none })); res.json({ bands, none });
});
setTimeout(() => { try { sweepOffTopic(); } catch (err) { console.error('SEO sweep:', err.message); } }, 20e3).unref();

module.exports = { router, receiveArticles, readExport, match, bestFor };
