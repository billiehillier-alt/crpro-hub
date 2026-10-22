// Social posts, ported from psyrenne's social.js. When an article is live on the WordPress site, the owner (or the
// automatic drafter) gets a caption per platform written by Claude for clinical research professionals. Drafts wait for
// approval. Approved posts go out at their time: straight to the platform when it's connected (social-platforms.js),
// otherwise the owner gets an email reminder with the caption to post by hand. Every post has a tracked short link
// (/l/<code>) so clicks are counted (link-preview robots aren't). Share images are uploaded here (or sent by
// tools/social-packs.js through the signed endpoint) and served at /si/<article>/<size>.jpg for the platforms to fetch.
// Left out from psyrenne: Buffer, the extra pins and repeats of old articles, Keep promoting, and phone push alerts.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, DATA_DIR, getSetting, setSetting } = require('./db');
const { ownerOnly } = require('./auth');
const ai = require('./ai');
const mailer = require('./mailer');
const platforms = require('./social-platforms');

db.exec(`CREATE TABLE IF NOT EXISTS social_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, text TEXT NOT NULL, hashtags TEXT, link TEXT,
  post_id INTEGER, title TEXT, at TEXT, status TEXT NOT NULL DEFAULT 'planned', image TEXT, image_picked INTEGER NOT NULL DEFAULT 0, code TEXT UNIQUE, remote_id TEXT,
  stats TEXT, stats_at TEXT, note TEXT, tries INTEGER NOT NULL DEFAULT 0, retry_at TEXT, posting_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), done_at TEXT);
CREATE TABLE IF NOT EXISTS social_clicks (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')), ref TEXT);
CREATE TABLE IF NOT EXISTS social_images (post_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT, at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (post_id, code));
CREATE TABLE IF NOT EXISTS social_auto (post_id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), result TEXT);
CREATE INDEX IF NOT EXISTS social_posts_at ON social_posts (status, at);`);
// Statuses: draft (needs the owner's OK) → planned → posting → posted, or due (time to post by hand), or skipped.

const APP = () => (process.env.APP_URL || 'http://localhost:4310').replace(/\/$/, '');
const TZ = () => getSetting('timezone') || 'America/New_York';
// A to Z. max: the platform's caption limit.
const PLATFORMS = {
  facebook: { name: 'Facebook Page', max: 2000, open: 'https://www.facebook.com/', tip: 'Post on the Clinical Research Pro Page, with the link.' },
  instagram: { name: 'Instagram', max: 2200, open: 'https://www.instagram.com/', tip: 'Links don’t work in captions: say “link in bio”.' },
  linkedin: { name: 'LinkedIn', max: 3000, open: 'https://www.linkedin.com/feed/', tip: 'Post from the company page. LinkedIn posting isn’t automatic yet, so you get a reminder.' },
  pinterest: { name: 'Pinterest', max: 500, open: 'https://www.pinterest.com/pin-builder/', tip: 'First line is the pin title; the link is the destination.' },
  threads: { name: 'Threads', max: 500, open: 'https://www.threads.net/', tip: 'Short and friendly; the link can go in the post.' },
  x: { name: 'X', max: 280, open: 'https://x.com/compose/post', tip: '280 characters, link included.' },
  youtube: { name: 'YouTube (community post)', max: 1000, open: 'https://studio.youtube.com/', tip: 'A community post with the link.' },
};
const IMG_FOR = { facebook: 'FB', instagram: 'IGP', linkedin: 'FB', pinterest: 'P1', threads: 'FB', x: 'X', youtube: 'YT' };
const clean = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);
const when = v => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toISOString() : null; };

// ---------- tracked links ----------
const newCode = () => { for (;;) { const c = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 6); if (c.length === 6 && !db.prepare('SELECT 1 FROM social_posts WHERE code = ?').get(c)) return c; } };
function trackLink(id) {
  const p = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(id); if (!p || !p.link) return;
  const code = p.code || newCode(), short = `${APP()}/l/${code}`;
  db.prepare('UPDATE social_posts SET code = ?, text = ? WHERE id = ?').run(code, p.text.split(p.link).join(short), p.id);
}
const BOT = /bot|crawler|spider|facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|discordbot|whatsapp|embedly|preview|headless|pinterest/i;
function go(req, res) {
  const p = db.prepare('SELECT id, link, platform FROM social_posts WHERE code = ?').get(String(req.params.code || ''));
  if (!p || !p.link) return res.redirect(302, getSetting('site_url') || '/');
  if (!BOT.test(String(req.get('user-agent') || ''))) try { db.prepare('INSERT INTO social_clicks (post_id, ref) VALUES (?, ?)').run(p.id, String(req.get('referer') || '').slice(0, 200) || null); } catch {}
  let to; try { const u = new URL(p.link); u.searchParams.set('utm_source', p.platform); u.searchParams.set('utm_medium', 'social'); u.searchParams.set('utm_campaign', 'crpro-social'); to = u.toString(); } catch { to = p.link; }
  res.set('Cache-Control', 'no-store'); res.redirect(302, to);
}
const clicksOf = id => db.prepare('SELECT COUNT(*) n FROM social_clicks WHERE post_id = ?').get(id).n;

// ---------- share images: files next to the data, listed in social_images ----------
const IMG_DIR = () => { const d = path.join(DATA_DIR, 'social-images'); fs.mkdirSync(d, { recursive: true }); return d; };
const imgPath = (pid, code) => path.join(IMG_DIR(), `${Number(pid)}-${code}.jpg`);
const imageFor = (postId, platform) => { const code = IMG_FOR[platform]; if (!postId || !code) return null; return db.prepare('SELECT 1 FROM social_images WHERE post_id = ? AND code = ?').get(Number(postId), code) ? `${APP()}/si/${Number(postId)}/${code}.jpg` : null; };
const imageOf = p => (p.image_picked && p.image) || imageFor(p.post_id, p.platform) || p.image || null;
const isJpeg = b => b[0] === 0xFF && b[1] === 0xD8;
function receiveImages(req, res) {   // signed (sitesync.js checks the signature first)
  const b = req.body || {}, pid = Number(b.post_id); if (!pid) return res.status(400).json({ error: 'No article.' });
  let n = 0;
  for (const f of [].concat(b.files || [])) { const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(f.data || '')); if (!m || !/^[A-Z][A-Z0-9]{0,4}$/.test(String(f.code))) continue;
    const buf = Buffer.from(m[1], 'base64'); if (buf.length > 5e6 || !isJpeg(buf)) continue; fs.writeFileSync(imgPath(pid, String(f.code)), buf);
    db.prepare('INSERT OR REPLACE INTO social_images (post_id, code, name) VALUES (?, ?, ?)').run(pid, String(f.code), String(f.name || '').slice(0, 120)); n++; }
  res.json({ ok: true, saved: n });
}
function serveImage(req, res) {
  const code = String(req.params.code || '').replace(/\.jpg$/, ''), r = /^[A-Z][A-Z0-9]{0,4}$/.test(code) && db.prepare('SELECT name FROM social_images WHERE post_id = ? AND code = ?').get(Number(req.params.post), code);
  if (!r || !fs.existsSync(imgPath(req.params.post, code))) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'public, max-age=86400');
  if (req.query.download) res.set('Content-Disposition', `attachment; filename="${String(r.name || 'picture').replace(/[^\w.-]/g, '') || 'picture'}.jpg"`);
  res.sendFile(imgPath(req.params.post, code));
}

// ---------- captions ----------
const brandTag = () => getSetting('brand_hashtag') || '#ClinicalResearchPro';
const withBrandTag = tags => { const t = String(tags || '').trim().replace(/\s+/g, ' '), b = brandTag(); return new RegExp(`(^|\\s)${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i').test(t) ? t : (b + ' ' + t).trim(); };
const captionOf = p => [String(p.text || '').trim(), withBrandTag(p.hashtags)].filter(Boolean).join('\n\n');
const RULES = () => [
  `You write social posts for ${getSetting('site_name')} (tagline: “Collaborate. Educate. Empower.”), a training and career hub for clinical research professionals, to share one of its articles.`,
  'The readers: CRCs, CRAs, PIs, site staff, sponsor and CRO teams, regulatory and IRB staff, project managers, and people moving into clinical research.',
  'Voice: warm, clear, and professional, about a 9th grade reading level. Short sentences, everyday words. US spelling. Use the serial comma.',
  'Only say what the article says. No made-up numbers, results, or promises. Never give medical, legal, or regulatory advice beyond the article. Spell out a term the first time if a beginner might not know it (for example “GCP (Good Clinical Practice)”).',
  'Every caption has three parts, in this order:',
  '1. The hook: one short question about the reader’s problem, then one line on what the article gives them.',
  '2. The value: 2 or 3 bullets, each on its own line starting with “✅ ”, each a benefit (what’s in it for them). Start each with a verb like Learn, See, Get, or Find. Only benefits the article really covers.',
  '3. The call to action: tell them exactly what to do next, like “Read the full guide at the link below.”',
  'Fit each platform: Facebook and LinkedIn end with the link on its own line. Instagram says “Tap the link in bio to read the full guide.” and never includes a link. X is one hook line, one benefit line, and the link, under 240 characters with no bullets. Threads is the hook, 2 bullets, and the call to action. Pinterest starts with a pin title line (the keyphrase), then the hook and bullets. YouTube is a short community post with the link.',
  `Hashtags go in their own field, never in the caption: 3 to 5 for Instagram, 2 or 3 for Facebook, LinkedIn, Pinterest, and Threads, 1 or 2 for X, 3 for YouTube. Always start with ${brandTag()} (it counts toward the number), then #ClinicalResearch on most. CamelCase the rest.`,
].join('\n');
const articleOf = id => db.prepare('SELECT * FROM seo_articles WHERE id = ?').get(Number(id));
async function draft(postId, list, extra) {
  const a = articleOf(postId); if (!a) throw Object.assign(new Error('Pick an article from the list. Articles come from the WordPress site.'), { status: 400 });
  if (!['publish', 'future'].includes(a.status)) throw Object.assign(new Error('That article isn’t published or scheduled yet.'), { status: 400 });
  list = list.filter(p => PLATFORMS[p]); if (!list.length) throw Object.assign(new Error('Pick at least one platform.'), { status: 400 });
  if (!ai.client()) throw Object.assign(new Error(ai.MISSING), { status: 400 });
  const one = { type: 'object', additionalProperties: false, required: ['caption', 'hashtags'], properties: { caption: { type: 'string' }, hashtags: { type: 'string' } } };
  const text = String(a.text || '').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
  const out = await ai.askJson({ system: RULES(), maxTokens: 3000, schema: { type: 'object', additionalProperties: false, required: list, properties: Object.fromEntries(list.map(p => [p, one])) },
    content: `Article title: ${a.title}\nLink: ${a.url}\n\n${text ? 'Article text:\n' + text : '(Only the title is available.)'}\n\nWrite one post for each of: ${list.map(p => PLATFORMS[p].name).join(', ')}.${extra ? '\n\n' + extra : ''}` });
  return { title: a.title, link: a.url, posts: list.map(p => { const v = out[p] || {}, tags = String(v.hashtags || '').trim().replace(/\s+/g, ' ');
    return { platform: p, text: String(v.caption || '').trim().slice(0, Math.max(50, PLATFORMS[p].max - tags.length - 2)), hashtags: withBrandTag(tags) }; }) };
}

// ---------- posting slots, in the business time zone (Settings) ----------
const zonedISO = (day, h, min = 0) => { const [y, m, d] = day.split('-').map(Number), guess = Date.UTC(y, m - 1, d, h, min);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  return new Date(guess - (Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - guess)).toISOString(); };
const zonedDay = t => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ() });
const zonedHour = t => Number(new Date(t).toLocaleString('en-US', { timeZone: TZ(), hour: 'numeric', hourCycle: 'h23' })) % 24;
// Good hours for each platform (a pool), and how many posts a day. Each day takes a different set of hours, with different minutes.
const POOL = { facebook: [9, 12, 13, 15, 19], instagram: [11, 14, 18, 19, 20], linkedin: [8, 10, 12, 17], pinterest: [8, 10, 13, 15, 20], threads: [11, 13, 19], x: [8, 9, 12, 15, 17], youtube: [12, 15, 17] };
const PER_DAY = { facebook: 1, instagram: 1, linkedin: 1, pinterest: 2, threads: 1, x: 2, youtube: 1 };
const START_DAY = { linkedin: 0, facebook: 0, x: 1, instagram: 2, threads: 2, pinterest: 3, youtube: 5 };
const dayNum = day => Math.round(Date.parse(day + 'T12:00:00Z') / 864e5);
const addDay = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function slotsFor(platform, day) {
  const pool = POOL[platform] || [12], n = Math.min(PER_DAY[platform] || 1, pool.length), k = dayNum(day), start = (k * 3 + platform.length) % pool.length;
  return Array.from({ length: n }, (_, i) => pool[(start + i * Math.max(1, Math.floor(pool.length / n))) % pool.length]).filter((h, i, a) => a.indexOf(h) === i).sort((a, b) => a - b).map(h => ({ h, min: [0, 15, 30, 45][(k + h) % 4] }));
}
// The next open slot at or after `from` (ms); one article's posts on different platforms stay a day apart.
const GAP = 24 * 3600e3;
function nextSlot(platform, from, skipId = 0, postId = null, avoid = []) {
  const near = [...(postId ? db.prepare("SELECT at FROM social_posts WHERE post_id = ? AND platform <> ? AND id <> ? AND at IS NOT NULL AND status <> 'skipped'").all(postId, platform, skipId).map(r => Date.parse(r.at)) : []), ...avoid];
  const busy = db.prepare("SELECT at FROM social_posts WHERE platform = ? AND id <> ? AND at IS NOT NULL AND status <> 'skipped' AND at >= ? AND at < ?");
  let day = zonedDay(from);
  for (let i = 0; i < 180; i++, day = addDay(day, 1)) {
    const taken = busy.all(platform, skipId, zonedISO(addDay(day, -1), 23), zonedISO(addDay(day, 1), 1)).filter(r => zonedDay(r.at) === day).map(r => zonedHour(r.at));
    const slots = slotsFor(platform, day); if (taken.length >= slots.length) continue;
    for (const { h, min } of slots) { const at = zonedISO(day, h, min); if (Date.parse(at) >= from && !taken.includes(h) && !near.some(t => Math.abs(Date.parse(at) - t) < GAP)) return at; }
  }
  const s = slotsFor(platform, day)[0]; return zonedISO(day, s.h, s.min);
}
const articleSlot = (platform, live, postId) => nextSlot(platform, Math.max(Date.parse(zonedISO(addDay(zonedDay(live), START_DAY[platform] ?? 1), 0)), Date.now() + 30 * 60e3), 0, postId);
const autoOn = () => getSetting('social_auto') === '1';
const autoPlatforms = () => String(getSetting('social_platforms') || '').split(',').filter(p => PLATFORMS[p]);

// Automatic drafts: each newly published article gets a draft per chosen platform, with suggested times. Nothing posts until approved.
if (!getSetting('social_since')) setSetting('social_since', new Date().toISOString());
let drafting = false;
async function autoDraft() {
  if (drafting || !autoOn() || !ai.client()) return; drafting = true;
  try {
    const fresh = db.prepare("SELECT a.* FROM seo_articles a LEFT JOIN social_auto s ON s.post_id = a.id WHERE s.post_id IS NULL AND a.status IN ('publish','future') AND COALESCE(a.date_gmt, a.updated_at) >= ? ORDER BY a.date_gmt LIMIT 3").all(getSetting('social_since'));
    for (const a of fresh) {
      try { const d = await draft(a.id, autoPlatforms()), live = Math.max(Date.parse(a.date_gmt) || 0, Date.now());
        for (const p of d.posts) trackLink(Number(db.prepare("INSERT INTO social_posts (platform, text, hashtags, link, post_id, title, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')").run(p.platform, p.text, p.hashtags, a.url, a.id, a.title, articleSlot(p.platform, live, a.id)).lastInsertRowid));
        db.prepare('INSERT OR REPLACE INTO social_auto (post_id, result) VALUES (?, ?)').run(a.id, 'drafted ' + d.posts.length);
        await emailOwners('Social posts ready for your OK', `Drafts are waiting for "${a.title}".\n\n${APP()}/#social`);
      } catch (err) { db.prepare('INSERT OR REPLACE INTO social_auto (post_id, result) VALUES (?, ?)').run(a.id, 'failed: ' + String(err.message).slice(0, 200)); }
    }
  } finally { drafting = false; }
}
setInterval(() => autoDraft().catch(() => {}), 15 * 60e3).unref();
async function emailOwners(subject, text) {
  for (const o of db.prepare('SELECT email FROM users WHERE is_owner = 1 AND email_on = 1').all()) try { await mailer.send({ to: o.email, subject, text }); } catch (err) { console.error('Social email:', err.message); }
}
// Once a minute: approved posts whose time came go out (connected platforms), or become a reminder to post by hand.
const TRIES = 3;
async function sendDue() {
  const now = new Date().toISOString(), stuck = new Date(Date.now() - 10 * 60e3).toISOString();
  const due = db.prepare("SELECT * FROM social_posts WHERE (status = 'planned' AND at IS NOT NULL AND at <= ? AND (retry_at IS NULL OR retry_at <= ?)) OR (status = 'posting' AND posting_at < ?)").all(now, now, stuck);
  for (const p of due) {
    if (!db.prepare("UPDATE social_posts SET status = 'posting', posting_at = ? WHERE id = ? AND status IN ('planned','posting')").run(now, p.id).changes) continue;
    const name = (PLATFORMS[p.platform] || {}).name || p.platform;
    if (platforms.connected(p.platform)) {
      try { const rid = await platforms.publish({ ...p, text: captionOf(p), image: imageOf(p), link: p.code ? `${APP()}/l/${p.code}` : p.link });
        db.prepare("UPDATE social_posts SET status = 'posted', remote_id = ?, note = NULL, retry_at = NULL, posting_at = NULL, done_at = datetime('now') WHERE id = ?").run(String(rid || ''), p.id); continue; }
      catch (err) { const tries = (p.tries || 0) + 1, msg = String(err.message).slice(0, 200);
        if (tries < TRIES) { db.prepare("UPDATE social_posts SET status = 'planned', tries = ?, retry_at = ?, posting_at = NULL, note = ? WHERE id = ?").run(tries, new Date(Date.now() + 10 * 60e3).toISOString(), `${name} said: ${msg} (trying again in 10 minutes)`, p.id); continue; }
        db.prepare('UPDATE social_posts SET tries = ?, note = ? WHERE id = ?').run(tries, `${name} said: ${msg} (tried ${TRIES} times; post it yourself)`, p.id); }
    }
    db.prepare("UPDATE social_posts SET status = 'due', posting_at = NULL WHERE id = ?").run(p.id);
    await emailOwners(`Time to post on ${name}`, `${captionOf(p)}\n\n${p.image ? 'Picture: ' + imageOf(p) + '\n\n' : ''}Open the post: ${APP()}/#social/${p.id}\nPost it here: ${(PLATFORMS[p.platform] || {}).open || ''}\n\nTap "Posted" in the app when it's up.`);
  }
}
setInterval(() => sendDue().catch(err => console.error('Social posts check:', err.message)), 60e3).unref();
async function refreshStats() {
  for (const p of db.prepare("SELECT * FROM social_posts WHERE status = 'posted' AND remote_id IS NOT NULL AND remote_id <> '' AND done_at >= datetime('now','-30 days') AND (stats_at IS NULL OR stats_at < datetime('now','-6 hours')) LIMIT 20").all())
    try { const s = await platforms.stats(p); if (s) db.prepare("UPDATE social_posts SET stats = ?, stats_at = datetime('now') WHERE id = ?").run(JSON.stringify(s), p.id); } catch {}
}
setInterval(() => refreshStats().catch(() => {}), 3600e3).unref();

// ---------- routes (owner only) ----------
const out = p => ({ ...p, image: imageOf(p), picked: !!p.image_picked, caption: captionOf(p), stats: (() => { try { return p.stats ? JSON.parse(p.stats) : null; } catch { return null; } })(),
  platformName: (PLATFORMS[p.platform] || {}).name || p.platform, short: p.code ? `${APP()}/l/${p.code}` : '', clicks: clicksOf(p.id), how: platforms.connected(p.platform) ? 'self' : 'remind' });
const router = express.Router();
router.use(ownerOnly);
router.get('/', (req, res) => {
  const posts = db.prepare("SELECT * FROM social_posts WHERE status IN ('draft','planned','posting','due') OR done_at > datetime('now','-14 days') ORDER BY CASE WHEN at IS NULL THEN 1 ELSE 0 END, at, id").all().map(out);
  const articles = db.prepare("SELECT id, title, status, date_gmt, url FROM seo_articles WHERE status IN ('publish','future') ORDER BY COALESCE(date_gmt, '') DESC LIMIT 300").all();
  res.json({ posts, articles, platforms: PLATFORMS, hasKey: !!ai.client(), aiWhy: ai.client() ? null : ai.MISSING, auto: { on: autoOn(), platforms: autoPlatforms() }, brandTag: brandTag(), timezone: TZ(), connections: platforms.status() });
});
router.get('/connections', (req, res) => res.json(platforms.status()));
router.get('/oauth/:p/start', (req, res) => { try { res.redirect(302, platforms.startUrl(req.params.p)); } catch (err) { res.redirect(302, '/#social/conn/' + encodeURIComponent(err.message)); } });
router.get('/oauth/:p', async (req, res) => { try { await platforms.finish(req.params.p, req.query); res.redirect(302, '/#social/conn/connected'); } catch (err) { res.redirect(302, '/#social/conn/' + encodeURIComponent(err.message)); } });
router.post('/connections/:p/pick', (req, res) => { try { platforms.pick(req.params.p, (req.body || {}).id); res.json(platforms.status()); } catch (err) { res.status(400).json({ error: err.message }); } });
router.delete('/connections/:p', (req, res) => { platforms.disconnect(req.params.p); res.json(platforms.status()); });
router.put('/settings', (req, res) => { const b = req.body || {}; if ('auto' in b) setSetting('social_auto', b.auto ? '1' : '0');
  if (Array.isArray(b.platforms)) setSetting('social_platforms', b.platforms.filter(p => PLATFORMS[p]).join(',') || 'linkedin'); res.json({ ok: true, on: autoOn(), platforms: autoPlatforms() }); });
router.post('/draft', async (req, res) => { try { res.json(await draft((req.body || {}).post_id, [].concat((req.body || {}).platforms || []))); } catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'The drafts didn’t finish. Try again.' }); } });
// One article's planner: a box per platform with its caption, hashtags, picture, and time.
router.get('/article/:pid', (req, res) => {
  const pid = Number(req.params.pid), a = articleOf(pid); if (!a) return res.status(404).json({ error: 'That article isn’t here.' });
  const latest = {}; for (const p of db.prepare("SELECT * FROM social_posts WHERE post_id = ? ORDER BY CASE WHEN status IN ('draft','planned','posting','due') THEN 0 ELSE 1 END, at DESC").all(pid)) if (!latest[p.platform]) latest[p.platform] = out(p);
  const live = Math.max(Date.parse(a.date_gmt || '') || 0, Date.now());
  res.json({ article: { id: a.id, title: a.title, status: a.status, url: a.url }, auto: autoPlatforms(), hasKey: !!ai.client(),
    platforms: Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, { ...v, how: platforms.connected(k) ? 'self' : 'remind', image: imageFor(pid, k), suggestAt: (latest[k] && latest[k].at) || articleSlot(k, live, pid) }])), posts: latest });
});
router.post('/article/:pid', (req, res) => {
  try { const pid = Number(req.params.pid), a = articleOf(pid); if (!a) throw new Error('That article isn’t here.'); const saved = [];
    for (const w of [].concat((req.body || {}).windows || [])) { if (!PLATFORMS[w.platform]) continue;
      const cur = w.id ? db.prepare('SELECT * FROM social_posts WHERE id = ? AND post_id = ?').get(Number(w.id), pid) : null;
      if (cur && ['posted', 'skipped'].includes(cur.status) && !w.again) continue;
      if (!w.on) { if (cur && !['posted', 'skipped'].includes(cur.status)) db.prepare('DELETE FROM social_posts WHERE id = ?').run(cur.id); continue; }
      const text = clean(w.text, PLATFORMS[w.platform].max + 200); if (!text) throw new Error(`Write something for ${PLATFORMS[w.platform].name}, or untick it.`);
      const at = when(w.at); if (!at) throw new Error(`Pick a date and time for ${PLATFORMS[w.platform].name}.`);
      const img = /^https?:\/\//.test(String(w.image || '')) ? clean(w.image, 500) : null;
      if (cur && !['posted', 'skipped'].includes(cur.status)) { db.prepare("UPDATE social_posts SET text = ?, hashtags = ?, at = ?, status = 'planned', done_at = NULL, tries = 0, retry_at = NULL, note = NULL, image = ?, image_picked = ? WHERE id = ?").run(text, withBrandTag(w.hashtags), at, img, img ? 1 : 0, cur.id); saved.push(cur.id); }
      else { const id = Number(db.prepare("INSERT INTO social_posts (platform, text, hashtags, link, post_id, title, at, status, image, image_picked) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)").run(w.platform, text, withBrandTag(w.hashtags), a.url, pid, a.title, at, img, img ? 1 : 0).lastInsertRowid); trackLink(id); saved.push(id); } }
    res.json({ ok: true, saved: saved.length });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Approve every draft (or one article's).
router.post('/approve', (req, res) => { const pid = Number((req.body || {}).post_id) || null;
  const r = pid ? db.prepare("UPDATE social_posts SET status = 'planned' WHERE status = 'draft' AND post_id = ?").run(pid) : db.prepare("UPDATE social_posts SET status = 'planned' WHERE status = 'draft'").run();
  res.json({ ok: true, approved: r.changes }); });
// Catch up: every post whose time already passed moves to its platform's next open slot.
router.post('/catchup', (req, res) => { const moved = [];
  for (const p of db.prepare("SELECT * FROM social_posts WHERE status IN ('draft','planned','due') AND at IS NOT NULL AND at < ? ORDER BY at").all(new Date().toISOString())) {
    const at = nextSlot(p.platform, Date.now() + 30 * 60e3, p.id, p.post_id);
    db.prepare("UPDATE social_posts SET at = ?, status = CASE WHEN status = 'due' THEN 'planned' ELSE status END, tries = 0, retry_at = NULL, note = NULL WHERE id = ?").run(at, p.id); moved.push({ id: p.id, at }); }
  res.json({ moved }); });
router.get('/results', (req, res) => {
  const since = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const byPlatform = d => db.prepare('SELECT p.platform, COUNT(c.id) clicks, COUNT(DISTINCT p.id) posts FROM social_clicks c JOIN social_posts p ON p.id = c.post_id WHERE c.at >= ? GROUP BY p.platform ORDER BY clicks DESC').all(since(d)).map(r => ({ ...r, name: (PLATFORMS[r.platform] || {}).name || r.platform }));
  const posts = db.prepare("SELECT p.*, (SELECT COUNT(*) FROM social_clicks c WHERE c.post_id = p.id) n FROM social_posts p WHERE p.status = 'posted' AND COALESCE(p.done_at, p.at) >= ? ORDER BY COALESCE(p.done_at, p.at) DESC LIMIT 300").all(since(90)).map(p => {
    let s = {}; try { s = p.stats ? JSON.parse(p.stats) : {}; } catch {}
    return { id: p.id, platform: p.platform, name: (PLATFORMS[p.platform] || {}).name || p.platform, title: p.title || String(p.text || '').slice(0, 60), posted: p.done_at || p.at, clicks: p.n, likes: s.likes ?? null, comments: s.comments ?? null, shares: s.shares ?? null, reach: s.reach ?? null };
  });
  res.json({ posts, d30: byPlatform(30), d90: byPlatform(90), total30: db.prepare('SELECT COUNT(*) n FROM social_clicks WHERE at >= ?').get(since(30)).n });
});
// Every published article against each platform: posted, planned, waiting for an OK, or not yet.
router.get('/coverage', (req, res) => {
  const arts = db.prepare("SELECT id, title, url, date_gmt FROM seo_articles WHERE status = 'publish' ORDER BY COALESCE(date_gmt, '') DESC LIMIT 200").all();
  const rank = { posted: 4, planned: 3, due: 3, posting: 3, draft: 2, skipped: 1 }, cell = new Map();
  for (const r of db.prepare('SELECT post_id, platform, status, id, at FROM social_posts WHERE post_id IS NOT NULL').all()) { const k = r.post_id + '|' + r.platform, cur = cell.get(k); if (!cur || (rank[r.status] || 0) > (rank[cur.status] || 0)) cell.set(k, { status: r.status, id: r.id, at: r.at }); }
  const keys = Object.keys(PLATFORMS);
  res.json({ platforms: keys.map(p => ({ key: p, name: PLATFORMS[p].name })), articles: arts.map(a => ({ ...a, cells: Object.fromEntries(keys.map(p => [p, cell.get(a.id + '|' + p) || null])) })) });
});
// The picture library: pack pictures by article, and the owner's own uploads (article 0, codes UA, UB, …).
const SIZE_NAME = { FB: 'Facebook and LinkedIn (wide)', IGP: 'Instagram (4:5)', P1: 'Pinterest (2:3)', P2: 'Pinterest (2:3)', P3: 'Pinterest (2:3)', X: 'X (wide)', STORY: 'Story (tall)', YT: 'YouTube thumbnail', WP: 'Website featured image' };
router.get('/library', (req, res) => {
  const titles = new Map(db.prepare('SELECT id, title FROM seo_articles').all().map(a => [a.id, a.title]));
  res.json({ pictures: db.prepare('SELECT post_id, code, name, at FROM social_images ORDER BY at DESC LIMIT 400').all().map(r => ({ ...r, url: `${APP()}/si/${r.post_id}/${r.code}.jpg`, own: r.post_id === 0,
    label: r.post_id === 0 ? (r.name || 'My picture') : (titles.get(r.post_id) || 'Article ' + r.post_id), size: SIZE_NAME[r.code] || (r.post_id === 0 ? 'Your picture' : r.code) })) });
});
router.post('/library', (req, res) => {
  const b = req.body || {}, m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || '')); if (!m) return res.status(400).json({ error: 'Choose a JPG picture.' });
  const buf = Buffer.from(m[1], 'base64'); if (buf.length > 6e6 || !isJpeg(buf)) return res.status(400).json({ error: 'That picture is too big or isn’t a JPG.' });
  const used = new Set(db.prepare('SELECT code FROM social_images WHERE post_id = 0').all().map(r => r.code)); let code = null;
  for (let i = 0; i < 26 * 27 && !code; i++) { const c = 'U' + String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String.fromCharCode(65 + Math.floor(i / 26) - 1) : ''); if (!used.has(c)) code = c; }
  if (!code) return res.status(400).json({ error: 'The library is full. Remove a few of your pictures first.' });
  fs.writeFileSync(imgPath(0, code), buf); db.prepare('INSERT OR REPLACE INTO social_images (post_id, code, name) VALUES (0, ?, ?)').run(code, String(b.name || 'My picture').slice(0, 120));
  res.json({ ok: true, code, url: `${APP()}/si/0/${code}.jpg` });
});
router.delete('/library/:code', (req, res) => { const code = String(req.params.code); if (!/^U[A-Z]{1,2}$/.test(code)) return res.status(400).json({ error: 'Only your own pictures can be removed here.' });
  try { fs.unlinkSync(imgPath(0, code)); } catch {} db.prepare('DELETE FROM social_images WHERE post_id = 0 AND code = ?').run(code); res.json({ ok: true }); });
router.get('/:id', (req, res) => { const p = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(Number(req.params.id)); if (!p) return res.status(404).json({ error: 'That post isn’t here.' }); res.json({ post: out(p), platform: PLATFORMS[p.platform] || {} }); });
router.put('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(Number(req.params.id)); if (!p) return res.status(404).json({ error: 'That post isn’t here.' });
  const b = req.body || {};
  if ('text' in b) db.prepare('UPDATE social_posts SET text = ? WHERE id = ?').run(clean(b.text, 4200) || p.text, p.id);
  if ('hashtags' in b) db.prepare('UPDATE social_posts SET hashtags = ? WHERE id = ?').run(withBrandTag(clean(b.hashtags, 500)), p.id);
  if ('at' in b) db.prepare("UPDATE social_posts SET at = ?, status = CASE WHEN status = 'due' THEN 'planned' ELSE status END, tries = 0, retry_at = NULL WHERE id = ?").run(when(b.at), p.id);
  if ('image' in b) { const url = /^https?:\/\//.test(String(b.image || '')) ? clean(b.image, 500) : null; db.prepare('UPDATE social_posts SET image = ?, image_picked = ? WHERE id = ?').run(url, url ? 1 : 0, p.id); }
  if (['posted', 'skipped'].includes(b.status)) db.prepare("UPDATE social_posts SET status = ?, done_at = datetime('now') WHERE id = ?").run(b.status, p.id);
  if (b.status === 'planned') db.prepare("UPDATE social_posts SET status = 'planned', done_at = NULL WHERE id = ?").run(p.id);
  res.json({ ok: true });
});
router.delete('/:id', (req, res) => { db.prepare('DELETE FROM social_posts WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); });

// Public: tracked links and share pictures (no sign-in; the platforms fetch them).
const mount = app => { app.get('/l/:code', go); app.get('/si/:post/:code', serveImage); };
module.exports = { router, mount, receiveImages, PLATFORMS, nextSlot, withBrandTag };
