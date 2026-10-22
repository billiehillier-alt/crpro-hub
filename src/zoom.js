// Zoom (optional), ported from psyrenne's zoom.js. Uses Zoom's Server-to-Server OAuth app made under Jess's Zoom login.
// Env: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET. Scopes: meeting:write:meeting:admin, meeting:update:meeting:admin,
// meeting:delete:meeting:admin (or the older meeting:write:admin). A webinar with no join link gets a Zoom meeting; changing
// its time or title updates the meeting; deleting it cancels it. Without the env, nothing happens and links are typed by hand.
const { getSetting } = require('./db');
const cfg = () => { const e = process.env; return e.ZOOM_ACCOUNT_ID && e.ZOOM_CLIENT_ID && e.ZOOM_CLIENT_SECRET ? { acct: e.ZOOM_ACCOUNT_ID.trim(), id: e.ZOOM_CLIENT_ID.trim(), secret: e.ZOOM_CLIENT_SECRET.trim() } : null; };
let tok = null;
async function token() {
  const c = cfg(); if (!c) throw new Error('Zoom isn’t connected.');
  if (tok && tok.until > Date.now() + 60e3) return tok.value;
  const r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(c.acct)}`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${c.id}:${c.secret}`).toString('base64') } });
  const d = await r.json().catch(() => ({})); if (!r.ok || !d.access_token) throw new Error('Zoom said no to the keys: ' + (d.reason || d.error || r.status));
  tok = { value: d.access_token, until: Date.now() + (d.expires_in || 3600) * 1000 }; return tok.value;
}
async function call(method, path, body) {
  const r = await fetch('https://api.zoom.us/v2' + path, { method, headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return {}; const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error('Zoom: ' + (d.message || r.status)); return d;
}
// Zoom takes the start in UTC ("2026-10-19T18:00:00Z"); the time zone only changes how Zoom shows it.
const meetingOf = e => ({ topic: String(e.title || 'Webinar').slice(0, 200), type: 2, start_time: new Date(e.starts_at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  duration: Math.max(15, Math.min(600, Number(e.duration_min) || 60)), timezone: getSetting('timezone') || 'America/New_York', agenda: String(e.description || '').slice(0, 1900),
  settings: { join_before_host: false, waiting_room: true, mute_upon_entry: true, participant_video: false, host_video: true, approval_type: 2 } });
async function create(e) { const m = await call('POST', '/users/me/meetings', meetingOf(e)); return { id: String(m.id), link: m.join_url }; }
async function update(zoomId, e) { await call('PATCH', `/meetings/${encodeURIComponent(zoomId)}`, meetingOf(e)); }
async function remove(zoomId) { try { await call('DELETE', `/meetings/${encodeURIComponent(zoomId)}`); } catch (err) { if (!/3001|not found|does not exist/i.test(err.message)) throw err; } }
async function status() { if (!cfg()) return { on: false, why: 'Zoom isn’t set up (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET).' }; try { const u = await call('GET', '/users/me'); return { on: true, who: u.email || '' }; } catch (err) { return { on: false, why: err.message }; } }
module.exports = { ready: () => !!cfg(), create, update, remove, status };
