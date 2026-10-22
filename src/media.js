// Video uploads (lessons and webinar recordings), ported from psyrenne's media.js.
// With R2 (or any S3-compatible storage) set up: the browser asks for a one-time upload link, sends the file straight to the
// private bucket, then tells us it's done. The server never handles the video itself. Playing one gets a link that works
// for a few hours. Env: MEDIA_S3_ENDPOINT, MEDIA_S3_KEY_ID, MEDIA_S3_SECRET, MEDIA_S3_BUCKET (default crpro-media),
// MEDIA_S3_REGION (default auto).
// Without those: files are saved in the media-local folder next to the app (MEDIA_LOCAL_DIR to move it) and played from here.
// That's fine for testing; for real students, use the bucket (a server's own disk can be wiped on redeploy).
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db } = require('./db');
const { ownerOnly } = require('./auth');

db.exec(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, key TEXT NOT NULL, name TEXT, type TEXT, size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), done_at TEXT)`);

const TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v' };
const MAX = 4 * 1024 ** 3;   // 4 GB per video (webinar recordings run long)

const LOCAL_DIR = () => path.resolve(process.env.MEDIA_LOCAL_DIR || path.join(__dirname, '..', 'media-local'));
const localFile = key => { const p = path.join(LOCAL_DIR(), ...String(key).split('/').filter(s => s && s !== '..')); if (!p.startsWith(LOCAL_DIR())) throw new Error('Bad file name.'); return p; };
const cfg = () => { const e = process.env, endpoint = (e.MEDIA_S3_ENDPOINT || '').trim(), id = (e.MEDIA_S3_KEY_ID || '').trim(), secret = (e.MEDIA_S3_SECRET || '').trim();
  if (!endpoint || !id || !secret) return null;
  let origin; try { origin = new URL(endpoint).origin; } catch { origin = endpoint.replace(/\/$/, ''); }
  return { endpoint: origin, region: (e.MEDIA_S3_REGION || 'auto').trim(), bucket: (e.MEDIA_S3_BUCKET || 'crpro-media').trim(), id, secret }; };
const isLocal = () => !cfg();
let client = null, clientFor = '';
function s3() {
  const c = cfg(); if (!c) throw Object.assign(new Error('Cloud video storage isn’t set up.'), { status: 503 });
  if (!client || clientFor !== c.endpoint + c.id) { const { S3Client } = require('@aws-sdk/client-s3');
    client = new S3Client({ endpoint: c.endpoint, region: c.region, forcePathStyle: true, credentials: { accessKeyId: c.id, secretAccessKey: c.secret } }); clientFor = c.endpoint + c.id; }
  return { client, bucket: c.bucket };
}
const presign = (cmd, seconds) => require('@aws-sdk/s3-request-presigner').getSignedUrl(s3().client, cmd, { expiresIn: seconds });

const router = express.Router();
// 1. Ask for an upload link (owner only: lessons and recordings).
router.post('/upload', ownerOnly, async (req, res) => {
  try {
    const b = req.body || {}, type = String(b.type || '').toLowerCase(), size = Number(b.size) || 0, name = String(b.name || 'video').replace(/[^\w .()-]/g, '').slice(0, 120) || 'video';
    if (!TYPES[type]) return res.status(400).json({ error: 'That isn’t a video file we can play. Use MP4, MOV, or WebM.' });
    if (!size || size > MAX) return res.status(400).json({ error: 'Videos can be up to 4 GB.' });
    const id = crypto.randomBytes(16).toString('hex'), key = `videos/${id}.${TYPES[type]}`;
    db.prepare('INSERT INTO media (id, user_id, key, name, type, size) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.user.id, key, name, type, size);
    if (isLocal()) return res.json({ id, url: `/api/media/local/${id}`, headers: { 'Content-Type': type }, local: true });
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    res.json({ id, url: await presign(new PutObjectCommand({ Bucket: s3().bucket, Key: key, ContentType: type }), 3600), headers: { 'Content-Type': type } });
  } catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Couldn’t start the upload. Try again in a minute.' }); console.error('media upload:', err.message); }
});
// Local only: the browser sends the file here and plays it from here.
router.put('/local/:id', ownerOnly, (req, res) => {
  const m = isLocal() && db.prepare("SELECT * FROM media WHERE id = ? AND status = 'pending'").get(String(req.params.id));
  if (!m) return res.status(404).json({ error: 'Upload not found.' });
  const file = localFile(m.key); fs.mkdirSync(path.dirname(file), { recursive: true });
  let n = 0; const out = fs.createWriteStream(file);
  req.on('data', c => { n += c.length; if (n > MAX) { req.destroy(); out.destroy(); fs.rm(file, { force: true }, () => {}); } });
  req.pipe(out); out.on('finish', () => res.json({ ok: true })); out.on('error', () => res.status(500).json({ error: 'Couldn’t save the file.' }));
});
router.get('/local/:id', (req, res) => {
  const m = isLocal() && db.prepare("SELECT * FROM media WHERE id = ? AND status = 'ready'").get(String(req.params.id));
  if (!m) return res.status(404).end();
  res.type(m.type || 'video/mp4'); res.sendFile(localFile(m.key));
});
// 2. The browser says it finished; we check the file is really there.
router.post('/:id/done', ownerOnly, async (req, res) => {
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(String(req.params.id));
  if (!m) return res.status(404).json({ error: 'Upload not found.' });
  if (isLocal()) { let size = 0; try { size = fs.statSync(localFile(m.key)).size; } catch {}
    if (!size) return res.status(400).json({ error: 'The video didn’t finish uploading. Try again.' });
    db.prepare("UPDATE media SET status = 'ready', size = ?, done_at = datetime('now') WHERE id = ?").run(size, m.id); return res.json({ ok: true, token: 'media:' + m.id }); }
  try { const { HeadObjectCommand } = require('@aws-sdk/client-s3'); const h = await s3().client.send(new HeadObjectCommand({ Bucket: s3().bucket, Key: m.key }));
    db.prepare("UPDATE media SET status = 'ready', size = ?, done_at = datetime('now') WHERE id = ?").run(Number(h.ContentLength) || m.size, m.id);
    res.json({ ok: true, token: 'media:' + m.id });
  } catch { res.status(400).json({ error: 'The video didn’t finish uploading. Try again.' }); }
});
// 3. Play: a link that works for a few hours. Callers check the student may see the lesson or recording first (playUrl below).
async function playUrl(id) {
  const m = db.prepare("SELECT * FROM media WHERE id = ? AND status = 'ready'").get(String(id));
  if (!m) return null;
  if (isLocal()) return `/api/media/local/${m.id}`;
  const { GetObjectCommand } = require('@aws-sdk/client-s3'); return presign(new GetObjectCommand({ Bucket: s3().bucket, Key: m.key }), 4 * 3600);
}
router.get('/status', ownerOnly, (req, res) => res.json({ cloud: !isLocal(), bucket: cfg() ? cfg().bucket : null }));
// "media:<32 hex>" from the upload, or a plain https link (Bunny Stream, Vimeo, or any video page or file).
const mediaId = v => { const m = /^media:([a-f0-9]{32})$/.exec(String(v || '').trim()); return m ? m[1] : null; };
module.exports = { router, playUrl, mediaId, isLocal };
