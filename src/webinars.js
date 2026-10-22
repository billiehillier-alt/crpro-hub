// Webinars, adapted from psyrenne's events.js. Students RSVP, add the webinar to Google Calendar, Outlook, or any calendar
// app (.ics), get reminder emails (if they keep email on), and rate it afterward. Times are stored in UTC and each viewer's
// screen shows them in their own time zone.
// The owner can upload Zoom's attendance report: anyone who stayed for at least 90% of it counts as attended.
// Recordings are an uploaded video or a link. elite_only: Elite members only. free_until: open to everyone until that date,
// then Elite only ("free for the first month, then Elite").
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db, getSetting } = require('./db');
const { ownerOnly, isElite, appUrl } = require('./auth');
const zoom = require('./zoom');
const media = require('./media');
const mailer = require('./mailer');

db.exec(`
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60, link TEXT, zoom_id TEXT, host TEXT, topic TEXT, recording TEXT, recording_url TEXT,
  elite_only INTEGER NOT NULL DEFAULT 0, free_until TEXT, admin_notes TEXT, ce_credits REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS event_rsvps (event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
  rsvp_at TEXT NOT NULL DEFAULT (datetime('now')), attended INTEGER NOT NULL DEFAULT 0, minutes INTEGER, PRIMARY KEY (event_id, user_id));
CREATE TABLE IF NOT EXISTS event_ratings (event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, stars INTEGER NOT NULL,
  helped TEXT, at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (event_id, user_id));
CREATE TABLE IF NOT EXISTS event_reminders (event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (event_id, user_id, kind));
`);
const FULL_SHARE = 0.9;   // "the entire webinar": at least 90% of it
const TOPICS = ['Careers', 'Clinical operations', 'Good Clinical Practice', 'Patient recruitment', 'Professional development', 'Project management', 'Regulatory', 'Sites', 'Technology', 'Other'];
const clean = (v, n) => String(v ?? '').trim().slice(0, n);
const isOwner = req => !!(req.user && req.user.is_owner);
const endOf = e => new Date(new Date(e.starts_at).getTime() + e.duration_min * 60000).toISOString();
const wrap = fn => async (req, res) => { try { res.json((await fn(req)) || { ok: true }); } catch (err) { res.status(err.status || 400).json({ error: err.message }); } };
const oops = (m, status = 400) => Object.assign(new Error(m), { status });

// Who may see the join link and the recording.
function eliteGate(e, user) {
  if (!user || user.is_owner) return { open: true };
  if (e.free_until && new Date().toISOString().slice(0, 10) <= e.free_until) return { open: true, freeUntil: e.free_until };
  if (e.elite_only || e.free_until) return isElite(user) ? { open: true } : { open: false, why: e.free_until ? `Free for everyone until ${e.free_until}. Now part of Elite membership.` : 'For Elite members.' };
  return { open: true };
}

// Add-to-calendar links (UTC, so every calendar shows the viewer's own time).
const stamp = iso => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function calendarLinks(e, site, link) {
  const details = [e.description || '', link ? `Join: ${link}` : '', `${site}/#webinars`].filter(Boolean).join('\n\n');
  const q = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return {
    google: 'https://calendar.google.com/calendar/render?' + q({ action: 'TEMPLATE', text: e.title, dates: `${stamp(e.starts_at)}/${stamp(endOf(e))}`, details, location: link || '' }),
    outlook: 'https://outlook.live.com/calendar/0/deeplink/compose?' + q({ path: '/calendar/action/compose', rru: 'addevent', subject: e.title, startdt: e.starts_at, enddt: endOf(e), body: details, location: link || '' }),
    office: 'https://outlook.office.com/calendar/0/deeplink/compose?' + q({ path: '/calendar/action/compose', rru: 'addevent', subject: e.title, startdt: e.starts_at, enddt: endOf(e), body: details, location: link || '' }),
  };
}
const icsText = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// ICS lines longer than 75 octets must fold (RFC 5545).
const fold = line => { const out = []; let s = line; while (Buffer.byteLength(s) > 75) { let n = 74; while (Buffer.byteLength(s.slice(0, n)) > 74) n--; out.push(s.slice(0, n)); s = ' ' + s.slice(n); } out.push(s); return out.join('\r\n'); };

async function eventOut(e, req) {
  const me = req.user.id, gate = eliteGate(e, req.user), site = appUrl(req);
  const r = db.prepare('SELECT * FROM event_rsvps WHERE event_id = ? AND user_id = ?').get(e.id, me);
  const recMedia = media.mediaId(e.recording);
  const out = { id: e.id, title: e.title, description: e.description || '', starts_at: e.starts_at, ends_at: endOf(e), duration_min: e.duration_min, host: e.host || getSetting('site_name'),
    topic: e.topic || '', elite_only: !!e.elite_only, free_until: e.free_until || '', ce_credits: e.ce_credits, open: gate.open, lock: gate.open ? null : gate.why,
    going: !!r, attended: !!(r && r.attended), rsvps: db.prepare('SELECT COUNT(*) n FROM event_rsvps WHERE event_id = ?').get(e.id).n,
    myStars: (db.prepare('SELECT stars FROM event_ratings WHERE event_id = ? AND user_id = ?').get(e.id, me) || {}).stars || 0,
    link: gate.open && (r || isOwner(req)) ? e.link || '' : '', hasRecording: !!(recMedia || e.recording_url),
    recording: gate.open && recMedia ? await media.playUrl(recMedia) : null, recording_url: gate.open ? e.recording_url || '' : '' };
  out.links = calendarLinks(e, site, out.link);
  if (isOwner(req)) { const rt = db.prepare('SELECT COUNT(*) n, AVG(stars) avg FROM event_ratings WHERE event_id = ?').get(e.id);
    Object.assign(out, { admin_notes: e.admin_notes || '', zoom: !!e.zoom_id, recordingToken: e.recording || '', ratings: rt.n, avgStars: rt.n ? Math.round(rt.avg * 10) / 10 : 0,
      attendedCount: db.prepare('SELECT COUNT(*) n FROM event_rsvps WHERE event_id = ? AND attended = 1').get(e.id).n,
      helped: db.prepare("SELECT helped FROM event_ratings WHERE event_id = ? AND helped IS NOT NULL AND helped <> '' ORDER BY at DESC LIMIT 10").all(e.id).map(x => x.helped) }); }
  return out;
}

const router = express.Router();
router.get('/', wrap(async req => {
  const rows = db.prepare('SELECT * FROM events ORDER BY starts_at').all(), events = [];
  for (const e of rows) events.push(await eventOut(e, req));
  return { owner: isOwner(req), topics: TOPICS, fullShare: FULL_SHARE, zoom: zoom.ready(), events };
}));
router.post('/:id/rsvp', wrap(req => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(req.params.id)); if (!e) throw oops('That webinar isn’t here.', 404);
  if (req.body.going === false) { db.prepare('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ? AND attended = 0').run(e.id, req.user.id); return; }
  if (!eliteGate(e, req.user).open) throw oops('This webinar is for Elite members.', 403);
  if (new Date(endOf(e)) < new Date()) throw oops('This webinar already happened.');
  db.prepare('INSERT OR IGNORE INTO event_rsvps (event_id, user_id) VALUES (?, ?)').run(e.id, req.user.id);
}));
router.post('/:id/rate', wrap(req => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(req.params.id)); if (!e) throw oops('That webinar isn’t here.', 404);
  if (new Date(e.starts_at) > new Date()) throw oops('You can rate it once it has started.');
  if (!db.prepare('SELECT 1 FROM event_rsvps WHERE event_id = ? AND user_id = ?').get(e.id, req.user.id)) throw oops('Only people who signed up can rate it.');
  const stars = Math.max(1, Math.min(5, Math.round(Number(req.body.stars) || 0)));
  db.prepare('INSERT INTO event_ratings (event_id, user_id, stars, helped) VALUES (?, ?, ?, ?) ON CONFLICT(event_id, user_id) DO UPDATE SET stars = excluded.stars, helped = excluded.helped, at = excluded.at').run(e.id, req.user.id, stars, clean(req.body.helped, 300) || null);
}));
// A calendar file for Apple Calendar and anything else. The join link is in it only for people who signed up.
router.get('/:id/ics', (req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(req.params.id)); if (!e) return res.status(404).end();
  const site = appUrl(req), going = isOwner(req) || !!db.prepare('SELECT 1 FROM event_rsvps WHERE event_id = ? AND user_id = ?').get(e.id, req.user.id);
  const link = going && eliteGate(e, req.user).open ? e.link : '', host = new URL(site).hostname;
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Clinical Research Pro//webinars//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', `UID:crpro-webinar-${e.id}@${host}`, `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(e.starts_at)}`, `DTEND:${stamp(endOf(e))}`, `SUMMARY:${icsText(e.title)}`, `DESCRIPTION:${icsText([e.description, link && 'Join: ' + link, site + '/#webinars'].filter(Boolean).join('\n\n'))}`,
    `LOCATION:${icsText(link || 'Online')}`, 'END:VEVENT', 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="crpro-webinar-${e.id}.ics"`);
  res.send(body);
});

// ---------- the owner ----------
const fields = b => {
  const starts = new Date(b.starts_at); if (isNaN(starts)) throw oops('Pick the date and time.');
  const title = clean(b.title, 160); if (!title) throw oops('Give the webinar a title.');
  const link = clean(b.link, 500); if (link && !/^https:\/\//i.test(link)) throw oops('The meeting link should start with https://');
  const recUrl = clean(b.recording_url, 500); if (recUrl && !/^https:\/\//i.test(recUrl)) throw oops('The recording link should start with https://');
  const rec = clean(b.recording, 100); if (rec && !media.mediaId(rec)) throw oops('The recording upload didn’t come through. Upload it again.');
  const topic = TOPICS.includes(b.topic) ? b.topic : null, free = /^\d{4}-\d{2}-\d{2}$/.test(String(b.free_until || '')) ? b.free_until : null;
  const ce = b.ce_credits === '' || b.ce_credits == null ? null : Number(b.ce_credits);
  return { title, description: clean(b.description, 5000) || null, starts_at: starts.toISOString(), duration_min: Math.max(5, Math.min(600, Math.round(Number(b.duration_min) || 60))),
    link: link || null, host: clean(b.host, 120) || null, topic, recording: rec || null, recording_url: recUrl || null, elite_only: b.elite_only ? 1 : 0, free_until: free,
    admin_notes: clean(b.admin_notes, 4000) || null, ce_credits: Number.isFinite(ce) ? ce : null };
};
async function zoomSync(id) {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id); if (!e || !zoom.ready()) return null;
  try {
    if (e.zoom_id) { if (e.link && !/zoom\.us\//i.test(e.link)) { await zoom.remove(e.zoom_id); db.prepare('UPDATE events SET zoom_id = NULL WHERE id = ?').run(id); return 'Your own link is used now. The Zoom meeting the app made was canceled.'; }
      await zoom.update(e.zoom_id, e); return 'Zoom meeting updated.'; }
    if (e.link) return null;
    const m = await zoom.create(e); db.prepare('UPDATE events SET link = ?, zoom_id = ? WHERE id = ?').run(m.link, m.id, id); return 'Zoom meeting made. The link is on the webinar.';
  } catch (err) { console.error('Zoom:', err.message); return 'Zoom didn’t work this time: ' + err.message; }
}
router.get('/zoom/status', ownerOnly, wrap(() => zoom.status()));
router.post('/', ownerOnly, wrap(async req => { const f = fields(req.body || {}), cols = Object.keys(f);
  const id = Number(db.prepare(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(f)).lastInsertRowid);
  return { ok: true, id, zoom: await zoomSync(id) }; }));
router.put('/:id', ownerOnly, wrap(async req => { const id = Number(req.params.id); if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(id)) throw oops('That webinar isn’t here.', 404);
  const f = fields(req.body || {}); db.prepare(`UPDATE events SET ${Object.keys(f).map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...Object.values(f), id);
  return { ok: true, zoom: await zoomSync(id) }; }));
router.delete('/:id', ownerOnly, wrap(async req => { const e = db.prepare('SELECT zoom_id FROM events WHERE id = ?').get(Number(req.params.id)); db.prepare('DELETE FROM events WHERE id = ?').run(Number(req.params.id));
  if (e && e.zoom_id) try { await zoom.remove(e.zoom_id); } catch (err) { console.error('Zoom cancel:', err.message); } }));
router.get('/:id/people', ownerOnly, wrap(req => ({ people: db.prepare(`SELECT u.id, u.name, u.last_name, u.email, r.attended, r.minutes, r.rsvp_at FROM event_rsvps r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? ORDER BY u.email`).all(Number(req.params.id)) })));
router.post('/:id/attended', ownerOnly, wrap(req => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(req.params.id)); if (!e) throw oops('That webinar isn’t here.', 404);
  for (const uid of (Array.isArray(req.body.userIds) ? req.body.userIds : []).map(Number).filter(Boolean))
    db.prepare('INSERT INTO event_rsvps (event_id, user_id, attended) VALUES (?, ?, 1) ON CONFLICT(event_id, user_id) DO UPDATE SET attended = 1').run(e.id, uid);
}));
// Zoom's participant report (CSV or Excel): people whose email matches an account and who stayed at least 90% count.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/:id/report', ownerOnly, upload.single('file'), (req, res) => {
  try {
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(req.params.id)); if (!e) throw new Error('That webinar isn’t here.');
    if (!req.file) throw new Error('Choose the attendance report file.');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    const h = grid.findIndex(r => r.some(c => /e-?mail/i.test(String(c))));
    if (h < 0) throw new Error('Couldn’t find an Email column. Use Zoom’s participant report (with emails).');
    const head = grid[h].map(c => String(c).trim()), ei = head.findIndex(c => /e-?mail/i.test(c)), di = head.findIndex(c => /duration/i.test(c));
    if (di < 0) throw new Error('Couldn’t find a Duration column in the report.');
    const minutes = new Map();
    for (const r of grid.slice(h + 1)) { const em = String(r[ei] || '').trim().toLowerCase(), m = Number(String(r[di]).replace(/[^\d.]/g, '')) || 0; if (em) minutes.set(em, (minutes.get(em) || 0) + m); }
    const need = Math.ceil(e.duration_min * FULL_SHARE); let full = 0, partial = 0, unknown = 0;
    for (const [em, m] of minutes) { const u = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(em); if (!u) { unknown++; continue; }
      const att = m >= need ? 1 : 0; if (att) full++; else partial++;
      db.prepare('INSERT INTO event_rsvps (event_id, user_id, attended, minutes) VALUES (?, ?, ?, ?) ON CONFLICT(event_id, user_id) DO UPDATE SET attended = MAX(attended, excluded.attended), minutes = excluded.minutes').run(e.id, u.id, att, Math.round(m)); }
    res.json({ ok: true, full, partial, unknown, need });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------- reminder emails: a day before and an hour before, to people who signed up and keep email on ----------
const whenFor = (iso, tz) => { try { return new Date(iso).toLocaleString('en-US', { timeZone: tz || getSetting('timezone'), weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch { return new Date(iso).toUTCString(); } };
async function sendReminders() {
  const now = Date.now();
  for (const [kind, ms] of [['24h', 24 * 3600e3], ['1h', 3600e3]]) {
    const rows = db.prepare(`SELECT e.*, u.id AS uid, u.email, u.name, u.timezone, u.email_on FROM events e JOIN event_rsvps r ON r.event_id = e.id JOIN users u ON u.id = r.user_id
      WHERE e.starts_at > ? AND e.starts_at <= ? AND NOT EXISTS (SELECT 1 FROM event_reminders x WHERE x.event_id = e.id AND x.user_id = u.id AND x.kind = ?)`).all(new Date(now).toISOString(), new Date(now + ms).toISOString(), kind);
    for (const r of rows) {
      db.prepare('INSERT OR IGNORE INTO event_reminders (event_id, user_id, kind) VALUES (?, ?, ?)').run(r.id, r.uid, kind);
      if (!r.email_on || (kind === '24h' && Date.parse(r.starts_at) - now < 3 * 3600e3)) continue;   // signed up at the last minute: the 1-hour one is enough
      const app = (process.env.APP_URL || '').replace(/\/$/, '');
      try { await mailer.send({ to: r.email, subject: `${kind === '1h' ? 'Starting in an hour' : 'Tomorrow'}: ${r.title}`,
        text: `Hi${r.name ? ' ' + r.name : ''},\n\nA reminder: "${r.title}" starts ${whenFor(r.starts_at, r.timezone)}.\n\n${r.link ? 'Join here: ' + r.link + '\n\n' : ''}Details: ${app}/#webinars\n\n${getSetting('site_name')}\n(You can turn these emails off in My account.)` }); }
      catch (err) { console.error('Webinar reminder:', err.message); }
    }
  }
}
setInterval(() => sendReminders().catch(err => console.error('Webinar reminders:', err.message)), 10 * 60e3).unref();
setTimeout(() => sendReminders().catch(() => {}), 60e3).unref();

module.exports = { router, sendReminders };
