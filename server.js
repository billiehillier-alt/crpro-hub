// Clinical Research Pro hub app. Node 24 + Express + node:sqlite, plain-JS front end in public/.
// Start: npm start (PORT, default 4310). See NOTES-FOR-CLAUDE.md for everything else.
const path = require('path');
const fs = require('fs');
// A local .env file (never committed) is read if it's there. Real environment variables win.
try { for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); } } catch {}

const express = require('express');
const { getSetting, setSetting, DEFAULTS } = require('./src/db');
const auth = require('./src/auth');
const academy = require('./src/academy');
const webinars = require('./src/webinars');
const media = require('./src/media');
const pages = require('./src/pages');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});
// JSON bodies; the raw text is kept for the signed WordPress endpoints (their signature covers the exact bytes).
app.use(express.json({ limit: '25mb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use(auth.guard);

// Fonts are self-hosted (no Google Fonts: they're blocked in China). Montserrat from @fontsource.
const FONT_DIR = path.join(__dirname, 'node_modules', '@fontsource', 'montserrat', 'files');
app.get('/fonts.css', (req, res) => {
  res.type('text/css').set('Cache-Control', 'public, max-age=86400');
  res.send([600, 700, 800].map(w => `@font-face{font-family:Montserrat;font-style:normal;font-display:swap;font-weight:${w};src:url(/fonts/montserrat-latin-${w}-normal.woff2) format("woff2")}`).join('\n'));
});
app.get('/fonts/:file', (req, res) => { const f = String(req.params.file); if (!/^montserrat-[a-z-]+-\d{3}-normal\.woff2$/.test(f)) return res.status(404).end(); res.set('Cache-Control', 'public, max-age=2592000'); res.sendFile(path.join(FONT_DIR, f)); });

app.use('/api/auth', express.urlencoded({ extended: false }), auth.router);
app.use('/api/academy', academy.router);
app.use('/api/admin/academy', academy.admin);
app.use('/api/verify', academy.publicRouter);
app.use('/api/webinars', webinars.router);
app.use('/api/media', media.router);
for (const [mount, mod] of [['seo', './src/seo'], ['articlemap', './src/articlemap'], ['ideas', './src/ideas'], ['social', './src/social'], ['site', './src/sitesync'], ['directory', './src/directory'], ['resources', './src/resources'], ['calendar', './src/calendar']]) {
  if (fs.existsSync(path.join(__dirname, mod + '.js'))) { const m = require(mod); app.use('/api/' + mount, m.router); if (m.mount) m.mount(app); }
}

// Settings (owner only).
const SETTING_KEYS = Object.keys(DEFAULTS);
app.get('/api/settings', auth.ownerOnly, (req, res) => res.json({ settings: Object.fromEntries(SETTING_KEYS.map(k => [k, getSetting(k)])),
  env: { email: !!(process.env.SMTP_HOST && process.env.MAIL_FROM), video: !media.isLocal(), zoom: !!process.env.ZOOM_CLIENT_ID, ai: !!process.env.ANTHROPIC_API_KEY,
    semrush: !!process.env.SEMRUSH_API_KEY, siteKey: (process.env.SITE_KEY || '').length >= 24, appUrl: process.env.APP_URL || '' } }));
app.put('/api/settings', auth.ownerOnly, (req, res) => {
  const b = req.body || {};
  for (const k of SETTING_KEYS) if (k in b) {
    let v = String(b[k] ?? '').trim().slice(0, 300);
    if (k === 'timezone') { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); } catch { return res.status(400).json({ error: 'That time zone isn’t one the app knows. Try America/New_York.' }); } }
    if (k === 'brand_hashtag') { v = v.replace(/\s+/g, ''); if (v && !v.startsWith('#')) v = '#' + v; if (!/^#\w{2,60}$/.test(v)) return res.status(400).json({ error: 'The hashtag is one word, like #ClinicalResearchPro.' }); }
    if (k === 'open_signup' || k === 'social_auto') v = b[k] === true || b[k] === '1' ? '1' : '0';
    setSetting(k, v);
  }
  res.json({ ok: true });
});

// Server-made pages: the public certificate check and the printable certificate.
app.get('/verify', (req, res) => { const id = String(req.query.id || '').trim(); if (!id) return res.send(pages.verifyPage(undefined, ''));
  let v; try { v = academy.lookup(id, req.ip); } catch (err) { return res.status(429).send(pages.verifyPage(null, id, err.message)); } res.status(v ? 200 : 404).send(pages.verifyPage(v, id)); });
app.get('/verify/:id', (req, res) => { let v; try { v = academy.lookup(req.params.id, req.ip); } catch (err) { return res.status(429).send(pages.verifyPage(null, req.params.id, err.message)); } res.status(v ? 200 : 404).send(pages.verifyPage(v, req.params.id)); });
app.get('/certificate/:id', (req, res) => {
  const c = require('./src/db').db.prepare('SELECT * FROM certificates WHERE id = ?').get(String(req.params.id));
  if (!c || (c.user_id !== req.user.id && !req.user.is_owner)) return res.status(404).send('Not found.');
  res.send(pages.certificatePage(c, auth.appUrl(req)));
});
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
// Errors nobody caught: a short message, never a stack trace.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || err.statusCode || 500; if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 400 ? 'That request didn’t read right.' : status === 413 ? 'That’s too big to send.' : 'Something went wrong. Try again.' });
});

const PORT = Number(process.env.PORT) || 4310;
app.listen(PORT, () => console.log(`${getSetting('site_name')} hub app on http://localhost:${PORT}`));
