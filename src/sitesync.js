// The WordPress site talks to the app here, signed with a shared secret (SITE_KEY, at least 24 characters, the same value
// saved in the WordPress side's settings). No sign-in: the signature is the proof.
// Each request carries two headers:
//   X-CRPro-Timestamp: the time in Unix seconds (requests older than 5 minutes are refused, so a copied request can't be replayed)
//   X-CRPro-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<exact request body>" with SITE_KEY>  (GET: the body is empty)
// See NOTES-FOR-CLAUDE.md for the exact requests WordPress sends.
const express = require('express');
const crypto = require('crypto');
const seo = require('./seo');
const ideas = require('./ideas');

const key = () => String(process.env.SITE_KEY || '');
function signed(req) {
  const k = key(); if (k.length < 24) return { ok: false, status: 503, error: 'SITE_KEY isn’t set up on the app (24 characters or more).' };
  const ts = Number(req.get('x-crpro-timestamp')), sig = String(req.get('x-crpro-signature') || '').replace(/^sha256=/, '');
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return { ok: false, status: 403, error: 'Not signed (missing or old timestamp).' };
  const want = crypto.createHmac('sha256', k).update(`${ts}.${req.rawBody || ''}`).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, status: 403, error: 'Not signed.' };
}
const router = express.Router();
router.use((req, res, next) => { const s = signed(req); if (!s.ok) return res.status(s.status).json({ error: s.error }); next(); });
// 1. Every article (published, scheduled, and drafts), whenever WordPress saves one or once an hour.
router.post('/articles', (req, res) => {
  const list = (req.body || {}).articles; if (!Array.isArray(list)) return res.status(400).json({ error: 'Send { articles: [...] }.' });
  try { seo.receiveArticles(list); try { ideas.markPublished(); } catch {} res.json({ ok: true, articles: list.length }); } catch (err) { res.status(500).json({ error: err.message }); }
});
// 2. Draft requests waiting to be written.
router.get('/requests', (req, res) => res.json({ requests: ideas.list().filter(i => ['idea', 'drafting'].includes(i.status) && i.source !== 'manual') }));
// 3. WordPress (or a writer) reports back: { status: 'drafting' | 'published', articleId, edit, url }.
router.put('/requests/:id', (req, res) => ideas.update(req.params.id, req.body || {}) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found.' }));
// 4. Share images made by tools/social-packs.js (also signed): { post_id, files: [{ code, name, data: "data:image/jpeg;base64,..." }] }.
router.post('/social-images', (req, res) => require('./social').receiveImages(req, res));

// Signs a request body (used by tools/social-packs.js and handy for testing).
const sign = (body, k = key()) => { const ts = Math.floor(Date.now() / 1000); return { 'X-CRPro-Timestamp': String(ts), 'X-CRPro-Signature': 'sha256=' + crypto.createHmac('sha256', k).update(`${ts}.${body}`).digest('hex') }; };
module.exports = { router, sign };
