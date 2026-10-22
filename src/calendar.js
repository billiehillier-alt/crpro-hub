// Calendar: one calendar for clinical research. It merges CR Pro's own webinars (webinars.js) with industry events the
// owner adds: conferences, outside webinars, workshops, trainings, association meetings, and deadlines (like regulatory
// comment deadlines). Members can suggest an event (it waits for the owner's OK), set a "Remind me" email, add any event to
// their own calendar, or subscribe to the whole calendar at /calendar.ics (optionally ?type=Conference).
// Times are stored in UTC (all-day events as plain dates); each viewer's screen shows their own time zone.
// The ICS code is the one ported for webinars; the month grid is drawn in public/calendar.js (psyrenne's calendar idea).
const express = require('express');
const { db, getSetting, tx } = require('./db');
const { ownerOnly, appUrl } = require('./auth');
const mailer = require('./mailer');
const { parseCsv } = require('./csv');

db.exec(`CREATE TABLE IF NOT EXISTS cal_events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, organizer TEXT, type TEXT NOT NULL,
  starts_at TEXT NOT NULL, ends_at TEXT, all_day INTEGER NOT NULL DEFAULT 0, timezone TEXT, format TEXT, city TEXT, country TEXT, link TEXT, cost TEXT,
  description TEXT, ce_credits REAL, status TEXT NOT NULL DEFAULT 'published', submitted_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);
CREATE TABLE IF NOT EXISTS cal_reminders (user_id INTEGER NOT NULL, event_key TEXT NOT NULL, remind_at TEXT NOT NULL, sent_at TEXT, PRIMARY KEY (user_id, event_key));
CREATE INDEX IF NOT EXISTS cal_events_start ON cal_events (status, starts_at);`);
const TYPES = ['Association meeting', 'Conference', 'CR Pro webinar', 'Deadline', 'Training', 'Webinar', 'Workshop'];
const OWN_TYPES = TYPES.filter(t => t !== 'CR Pro webinar');
const FORMATS = { hybrid: 'Hybrid', in_person: 'In person', online: 'Online' };
const STATUSES = { canceled: 'Canceled', draft: 'Draft', pending: 'Waiting for OK', published: 'Published' };
const clean = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);
const oops = (m, s = 400) => Object.assign(new Error(m), { status: s });
const wrap = fn => async (req, res) => { try { res.json((await fn(req)) || { ok: true }); } catch (err) { res.status(err.status || 400).json({ error: err.message }); } };
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
// A wall-clock time in a time zone ("2026-11-03T09:00" in America/Chicago) as a real UTC moment.
function zoned(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(String(local || '')); if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  return new Date(guess - (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - guess)).toISOString();
}
const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function fields(b, { suggest = false } = {}) {
  const title = clean(b.title, 200); if (!title) throw oops('Give the event a title.');
  const type = suggest ? (OWN_TYPES.includes(b.type) ? b.type : null) : (OWN_TYPES.includes(b.type) ? b.type : null); if (!type) throw oops('Pick the type of event.');
  const all = b.all_day === true || b.all_day === '1' || /^(yes|true|y)$/i.test(String(b.all_day || '')), tz = clean(b.timezone, 60) || getSetting('timezone');
  if (!validTz(tz)) throw oops('That time zone isn’t one the app knows. Try America/New_York or Europe/London.');
  let starts, ends;
  if (all) { const s = isDay(b.start_date) ? b.start_date : String(b.start_local || '').slice(0, 10); if (!isDay(s)) throw oops('Pick the start date.');
    const e = isDay(b.end_date) ? b.end_date : isDay(String(b.end_local || '').slice(0, 10)) ? String(b.end_local).slice(0, 10) : s; if (e < s) throw oops('The end date is before the start.'); starts = s; ends = e; }
  else { starts = zoned(b.start_local, tz); if (!starts) throw oops('Pick the start date and time.'); ends = b.end_local ? zoned(b.end_local, tz) : new Date(Date.parse(starts) + 3600e3).toISOString();
    if (!ends || ends < starts) throw oops('The end is before the start.'); }
  const link = clean(b.link, 500); if (link && !/^https?:\/\/\S+$/i.test(link)) throw oops('The link should start with https://');
  const ce = b.ce_credits === '' || b.ce_credits == null ? null : Number(b.ce_credits);
  return { title, organizer: clean(b.organizer, 200) || null, type, starts_at: starts, ends_at: ends, all_day: all ? 1 : 0, timezone: tz, format: FORMATS[b.format] ? b.format : null,
    city: clean(b.city, 100) || null, country: clean(b.country, 100) || null, link: link || null, cost: ['free', 'paid'].includes(b.cost) ? b.cost : null, description: clean(b.description, 3000) || null,
    ce_credits: Number.isFinite(ce) ? ce : null, status: suggest ? 'pending' : (STATUSES[b.status] ? b.status : 'published') };
}
const endOf = e => e.ends_at || (e.all_day ? e.starts_at : new Date(Date.parse(e.starts_at) + 3600e3).toISOString());
// Everything the calendar shows: published industry events plus CR Pro's webinars (no join links here; those stay on Webinars).
function merged({ includeAll = false } = {}) {
  const cal = db.prepare(`SELECT * FROM cal_events ${includeAll ? '' : "WHERE status IN ('published','canceled')"} ORDER BY starts_at`).all().map(e => ({ ...e, key: 'cal-' + e.id, source: 'calendar' }));
  let web = []; try { web = db.prepare('SELECT id, title, description, starts_at, duration_min, host, elite_only, ce_credits FROM events ORDER BY starts_at').all().map(w => ({
    key: 'web-' + w.id, id: w.id, source: 'webinar', title: w.title, organizer: w.host || getSetting('site_name'), type: 'CR Pro webinar', starts_at: w.starts_at, ends_at: new Date(Date.parse(w.starts_at) + w.duration_min * 60e3).toISOString(),
    all_day: 0, timezone: null, format: 'online', city: null, country: null, link: null, cost: w.elite_only ? 'paid' : 'free', description: w.description, ce_credits: w.ce_credits, status: 'published', elite: !!w.elite_only })); } catch {}
  return [...cal, ...web].sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
}
const stamp = iso => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = line => { const out = []; let s = line; while (Buffer.byteLength(s) > 75) { let n = 74; while (Buffer.byteLength(s.slice(0, n)) > 74) n--; out.push(s.slice(0, n)); s = ' ' + s.slice(n); } out.push(s); return out.join('\r\n'); };
function vevent(e, site) {
  const host = new URL(site).hostname, where = e.format === 'online' ? 'Online' : [e.city, e.country].filter(Boolean).join(', ') || (e.link || '');
  const when = e.all_day ? [`DTSTART;VALUE=DATE:${e.starts_at.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(endOf(e), 1).replace(/-/g, '')}`] : [`DTSTART:${stamp(e.starts_at)}`, `DTEND:${stamp(endOf(e))}`];
  return ['BEGIN:VEVENT', `UID:crpro-${e.key}@${host}`, `DTSTAMP:${stamp(new Date().toISOString())}`, ...when, `SUMMARY:${icsText((e.status === 'canceled' ? 'CANCELED: ' : '') + e.title)}`,
    `DESCRIPTION:${icsText([e.organizer && 'From ' + e.organizer, e.description, e.link, e.source === 'webinar' ? site + '/#webinars' : site + '/#calendar'].filter(Boolean).join('\n\n'))}`,
    `LOCATION:${icsText(where)}`, ...(e.status === 'canceled' ? ['STATUS:CANCELLED'] : []), 'END:VEVENT'];
}
const calendarFile = (events, site, name) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Clinical Research Pro//calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(name)}`, ...events.flatMap(e => vevent(e, site)), 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
function links(e, site) {
  const q = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'), details = [e.description, e.link].filter(Boolean).join('\n\n'), loc = e.format === 'online' ? 'Online' : [e.city, e.country].filter(Boolean).join(', ');
  const dates = e.all_day ? `${e.starts_at.replace(/-/g, '')}/${addDays(endOf(e), 1).replace(/-/g, '')}` : `${stamp(e.starts_at)}/${stamp(endOf(e))}`;
  return { google: 'https://calendar.google.com/calendar/render?' + q({ action: 'TEMPLATE', text: e.title, dates, details, location: loc }),
    outlook: 'https://outlook.live.com/calendar/0/deeplink/compose?' + q({ path: '/calendar/action/compose', rru: 'addevent', subject: e.title, startdt: e.starts_at, enddt: endOf(e), allday: e.all_day ? 'true' : 'false', body: details, location: loc }),
    ics: `/api/calendar/${e.key}/ics` };
}
const find = key => merged({ includeAll: false }).find(e => e.key === key);

const router = express.Router();
router.get('/', wrap(req => {
  const site = appUrl(req), mine = new Set(db.prepare('SELECT event_key FROM cal_reminders WHERE user_id = ? AND sent_at IS NULL').all(req.user.id).map(r => r.event_key));
  return { types: TYPES, formats: FORMATS, timezone: getSetting('timezone'), feed: `${site}/calendar.ics`,
    events: merged().map(e => ({ ...e, id: e.key, rowId: e.source === 'calendar' ? e.id : null, links: links(e, site), reminded: mine.has(e.key) })) };
}));
router.get('/:key/ics', (req, res) => { const e = find(String(req.params.key)); if (!e) return res.status(404).end();
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="crpro-${e.key}.ics"` }); res.send(calendarFile([e], appUrl(req), e.title)); });
// Remind me: an email this many minutes before (default a day), if the person keeps email on.
router.post('/:key/remind', wrap(req => { const e = find(String(req.params.key)); if (!e) throw oops('That event isn’t here.', 404);
  const before = Math.max(0, Math.min(60 * 24 * 30, Math.round(Number(req.body.before) || 1440))), start = e.all_day ? Date.parse(e.starts_at + 'T09:00:00Z') : Date.parse(e.starts_at), at = new Date(start - before * 60e3);
  if (at < new Date()) throw oops(start < Date.now() ? 'That event already started.' : 'That reminder time already passed. Pick a shorter time before.');
  db.prepare('INSERT INTO cal_reminders (user_id, event_key, remind_at) VALUES (?, ?, ?) ON CONFLICT(user_id, event_key) DO UPDATE SET remind_at = excluded.remind_at, sent_at = NULL').run(req.user.id, e.key, at.toISOString());
  return { ok: true, remind_at: at.toISOString(), emailOn: !!req.user.email_on }; }));
router.delete('/:key/remind', wrap(req => { db.prepare('DELETE FROM cal_reminders WHERE user_id = ? AND event_key = ?').run(req.user.id, String(req.params.key)); }));
// Members suggest an event: it waits for the owner's OK.
router.post('/suggest', wrap(req => {
  if (db.prepare("SELECT COUNT(*) n FROM cal_events WHERE submitted_by = ? AND created_at > datetime('now','-1 day')").get(req.user.id).n >= 5) throw oops('That’s five suggestions today. Thank you! Try again tomorrow.');
  const f = fields(req.body || {}, { suggest: true }), cols = [...Object.keys(f), 'submitted_by'];
  db.prepare(`INSERT INTO cal_events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(f), req.user.id); }));

// ---------- the owner ----------
router.get('/admin', ownerOnly, wrap(() => ({ types: OWN_TYPES, formats: FORMATS, statuses: STATUSES, timezone: getSetting('timezone'),
  events: db.prepare('SELECT c.*, u.email AS submitted_email FROM cal_events c LEFT JOIN users u ON u.id = c.submitted_by ORDER BY CASE c.status WHEN \'pending\' THEN 0 ELSE 1 END, c.starts_at').all() })));
router.post('/admin', ownerOnly, wrap(req => { const f = fields(req.body || {}), cols = Object.keys(f);
  return { id: Number(db.prepare(`INSERT INTO cal_events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(f)).lastInsertRowid) }; }));
router.put('/admin/:id', ownerOnly, wrap(req => { const f = fields(req.body || {});
  if (!db.prepare(`UPDATE cal_events SET ${Object.keys(f).map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(f), Number(req.params.id)).changes) throw oops('That event isn’t here.', 404); }));
router.delete('/admin/:id', ownerOnly, wrap(req => { db.prepare('DELETE FROM cal_events WHERE id = ?').run(Number(req.params.id)); db.prepare('DELETE FROM cal_reminders WHERE event_key = ?').run('cal-' + Number(req.params.id)); }));
router.post('/admin/:id/approve', ownerOnly, wrap(req => { db.prepare("UPDATE cal_events SET status = 'published', updated_at = datetime('now') WHERE id = ?").run(Number(req.params.id)); }));
// CSV import. Columns (any order, header row required): title, organizer, type, start, end, all_day, timezone, format, city,
// country, link, cost, description, ce_credits. start/end: "2026-11-03 09:00" (in that row's time zone) or "2026-11-03".
router.post('/admin/import', ownerOnly, wrap(req => {
  const rows = parseCsv(String((req.body || {}).text || '')); if (rows.length < 2) throw oops('The file needs a header row and at least one event.');
  const head = rows.shift().map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_')), col = n => head.indexOf(n);
  if (col('title') < 0 || col('start') < 0) throw oops('The file needs a title column and a start column.');
  const FMT = { 'in person': 'in_person', in_person: 'in_person', online: 'online', virtual: 'online', hybrid: 'hybrid' };
  let added = 0; const problems = [];
  tx(() => rows.forEach((r, i) => { const v = n => col(n) >= 0 ? String(r[col(n)] || '').trim() : '';
    try { const start = v('start'), end = v('end'), all = /^(yes|true|y|1)$/i.test(v('all_day')) || isDay(start);
      const type = TYPES.find(t => t.toLowerCase() === v('type').toLowerCase() && t !== 'CR Pro webinar') || 'Conference';
      const f = fields({ title: v('title'), organizer: v('organizer'), type, all_day: all, start_date: start.slice(0, 10), end_date: end.slice(0, 10), start_local: start.replace(' ', 'T'), end_local: end ? end.replace(' ', 'T') : '',
        timezone: v('timezone'), format: FMT[v('format').toLowerCase()] || '', city: v('city'), country: v('country'), link: v('link'), cost: v('cost').toLowerCase(), description: v('description'), ce_credits: v('ce_credits'), status: 'published' });
      const cols = Object.keys(f); db.prepare(`INSERT INTO cal_events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(f)); added++; }
    catch (err) { problems.push(`Row ${i + 2}: ${err.message}`); } }));
  return { ok: true, added, problems: problems.slice(0, 50) };
}));

// Reminder emails, every 5 minutes.
async function sendReminders() {
  const due = db.prepare(`SELECT r.*, u.email, u.name, u.timezone, u.email_on FROM cal_reminders r JOIN users u ON u.id = r.user_id WHERE r.sent_at IS NULL AND r.remind_at <= ?`).all(new Date().toISOString());
  for (const r of due) { db.prepare("UPDATE cal_reminders SET sent_at = datetime('now') WHERE user_id = ? AND event_key = ?").run(r.user_id, r.event_key);
    const e = find(r.event_key); if (!e || !r.email_on) continue;
    const when = e.all_day ? (e.starts_at === endOf(e) ? e.starts_at : `${e.starts_at} to ${endOf(e)}`) : new Date(e.starts_at).toLocaleString('en-US', { timeZone: r.timezone || getSetting('timezone'), weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    try { await mailer.send({ to: r.email, subject: `Reminder: ${e.title}`, text: `Hi${r.name ? ' ' + r.name : ''},\n\nYou asked for a reminder: "${e.title}"${e.organizer ? ' from ' + e.organizer : ''} is ${when}.\n\n${e.link ? e.link + '\n\n' : ''}${(process.env.APP_URL || '').replace(/\/$/, '')}/#calendar\n\n${getSetting('site_name')}\n(You can turn these emails off in My account.)` }); }
    catch (err) { console.error('Calendar reminder:', err.message); } }
}
setInterval(() => sendReminders().catch(err => console.error('Calendar reminders:', err.message)), 5 * 60e3).unref();

// One clearly marked sample event.
try { if (!db.prepare("SELECT 1 FROM settings WHERE key = 'seed_calendar_v1'").get()) {
  const d = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  db.prepare("INSERT INTO cal_events (title, organizer, type, starts_at, ends_at, all_day, timezone, format, cost, description, status) VALUES ('Sample event (delete me)', 'Made up', 'Conference', ?, ?, 1, ?, 'online', 'free', 'A placeholder so the calendar can be tried. Delete it before launch.', 'published')").run(d, d, getSetting('timezone'));
  db.prepare("INSERT INTO settings (key, value) VALUES ('seed_calendar_v1', 'done')").run(); } } catch (err) { console.error('Calendar sample:', err.message); }

// Public: the whole calendar as a subscribable feed (no sign-in), optionally one type: /calendar.ics?type=Conference
const mount = app => app.get('/calendar.ics', (req, res) => {
  const type = TYPES.includes(String(req.query.type || '')) ? String(req.query.type) : null;
  const events = merged().filter(e => (!type || e.type === type) && Date.parse(endOf(e).length === 10 ? endOf(e) + 'T23:59:59Z' : endOf(e)) > Date.now() - 90 * 864e5);
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'public, max-age=900' }); res.send(calendarFile(events, appUrl(req), `${getSetting('site_name')} calendar${type ? ': ' + type : ''}`));
});
module.exports = { router, mount, sendReminders };
