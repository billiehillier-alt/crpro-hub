// Posting straight to Facebook, Instagram, Pinterest, and X with each platform's own official access, ported from psyrenne's
// meta.js, pinterest.js, and x.js. The app keys come only from the environment (they'll be Jess's own developer apps):
//   Facebook Page:  META_FB_APP_ID, META_FB_APP_SECRET (optional META_FB_CONFIG_ID for Facebook Login for Business)
//   Instagram:      META_IG_APP_ID, META_IG_APP_SECRET   (Instagram API with Instagram Login)
//   Pinterest:      PINTEREST_APP_ID, PINTEREST_APP_SECRET
//   X:              X_CLIENT_ID, X_CLIENT_SECRET          (OAuth 2.0, PKCE)
// Without a platform's keys, its Connect button explains what's missing and its posts become email reminders to post by hand.
// The sign-in tokens each platform hands back are kept in the social_tokens table (never in code or Git).
// Redirect addresses to add in each developer app: <APP_URL>/api/social/oauth/<facebook|instagram|pinterest|x>.
const crypto = require('crypto');
const { db } = require('./db');

db.exec('CREATE TABLE IF NOT EXISTS social_tokens (platform TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
const load = p => { try { return JSON.parse((db.prepare('SELECT data FROM social_tokens WHERE platform = ?').get(p) || {}).data || '{}'); } catch { return {}; } };
const save = (p, v) => db.prepare("INSERT INTO social_tokens (platform, data, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(platform) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").run(p, JSON.stringify(v));
const drop = p => db.prepare('DELETE FROM social_tokens WHERE platform = ?').run(p);
const APP = () => (process.env.APP_URL || 'http://localhost:4310').replace(/\/$/, '');
const redirect = p => `${APP()}/api/social/oauth/${p}`;
const env = (...k) => k.every(x => String(process.env[x] || '').trim()) ? k.map(x => String(process.env[x]).trim()) : null;
const KEYS = { facebook: ['META_FB_APP_ID', 'META_FB_APP_SECRET'], instagram: ['META_IG_APP_ID', 'META_IG_APP_SECRET'], pinterest: ['PINTEREST_APP_ID', 'PINTEREST_APP_SECRET'], x: ['X_CLIENT_ID', 'X_CLIENT_SECRET'] };
const hasKeys = p => !!(KEYS[p] && env(...KEYS[p]));
async function json(url, opts = {}, who = 'The platform') {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(45000) }); const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { const e = j.error || {}; throw new Error(e.error_user_msg || e.message || j.message || j.detail || j.error_description || (j.errors && j.errors[0] && j.errors[0].message) || `${who} said no (${r.status}).`); }
  return j;
}
const form = obj => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(obj).toString() });
const states = new Map();
const newState = (p, extra = {}) => { const st = crypto.randomBytes(16).toString('hex'); states.set(st, { p, at: Date.now(), ...extra }); return st; };
const takeState = (p, st) => { const s = states.get(String(st || '')); states.delete(String(st || '')); if (!s || s.p !== p || Date.now() - s.at > 15 * 60e3) throw new Error('That sign-in timed out. Tap Connect again.'); return s; };

// ---------- Meta: Facebook Page and Instagram ----------
const V = 'v23.0';
function metaStart(p) {
  if (p === 'facebook') { const [id] = env(...KEYS.facebook); const q = { client_id: id, redirect_uri: redirect('facebook'), state: newState('facebook'), response_type: 'code' };
    if (process.env.META_FB_CONFIG_ID) q.config_id = process.env.META_FB_CONFIG_ID; else q.scope = 'pages_manage_posts,pages_read_engagement,pages_show_list,read_insights';
    return `https://www.facebook.com/${V}/dialog/oauth?${new URLSearchParams(q)}`; }
  const [id] = env(...KEYS.instagram);
  return `https://www.instagram.com/oauth/authorize?${new URLSearchParams({ client_id: id, redirect_uri: redirect('instagram'), response_type: 'code', state: newState('instagram'), scope: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights', enable_fb_login: '0', force_authentication: '1' })}`;
}
async function metaFinish(p, q) {
  takeState(p, q.state); if (q.error) throw new Error(q.error_description || q.error_reason || 'Meta didn’t connect it.');
  const code = String(q.code || '').replace(/#_$/, '');
  if (p === 'facebook') { const [id, secret] = env(...KEYS.facebook);
    const t = await json(`https://graph.facebook.com/${V}/oauth/access_token?${new URLSearchParams({ client_id: id, client_secret: secret, redirect_uri: redirect('facebook'), code })}`, {}, 'Meta');
    const long = await json(`https://graph.facebook.com/${V}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: id, client_secret: secret, fb_exchange_token: t.access_token })}`, {}, 'Meta');
    const pages = (await json(`https://graph.facebook.com/${V}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token', limit: '50', access_token: long.access_token })}`, {}, 'Meta')).data || [];
    if (!pages.length) throw new Error('Meta didn’t share any Pages. Tap Connect again and tick your Page.');
    const list = pages.map(x => ({ id: x.id, name: x.name, token: x.access_token })); save('facebook', { pages: list, page: list.length === 1 ? list[0] : null }); return; }
  const [id, secret] = env(...KEYS.instagram);
  const short = await json('https://api.instagram.com/oauth/access_token', form({ client_id: id, client_secret: secret, grant_type: 'authorization_code', redirect_uri: redirect('instagram'), code }), 'Instagram');
  const long = await json(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: secret, access_token: short.access_token })}`, {}, 'Instagram');
  const me = await json(`https://graph.instagram.com/${V}/me?${new URLSearchParams({ fields: 'user_id,username', access_token: long.access_token })}`, {}, 'Instagram');
  save('instagram', { id: String(me.user_id || short.user_id), username: me.username || '', token: long.access_token, expires: new Date(Date.now() + (Number(long.expires_in) || 5184000) * 1000).toISOString() });
}
async function refreshIg() { const m = load('instagram'); if (!m.token || Date.parse(m.expires) - Date.now() > 50 * 864e5) return;
  const r = await json(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: m.token })}`, {}, 'Instagram');
  m.token = r.access_token; m.expires = new Date(Date.now() + (Number(r.expires_in) || 5184000) * 1000).toISOString(); save('instagram', m); }
async function metaPublish(p) {
  if (p.platform === 'facebook') { const m = load('facebook'); if (!m.page) throw new Error('Facebook isn’t connected (or no Page is picked).');
    if (p.image) { const r = await json(`https://graph.facebook.com/${V}/${m.page.id}/photos`, form({ url: p.image, caption: p.text, access_token: m.page.token }), 'Facebook'); return r.post_id || r.id; }
    const body = { message: p.text, access_token: m.page.token }; if (p.link) body.link = p.link; return (await json(`https://graph.facebook.com/${V}/${m.page.id}/feed`, form(body), 'Facebook')).id; }
  const m = load('instagram'); if (!m.token) throw new Error('Instagram isn’t connected.'); if (!p.image) throw new Error('Instagram needs a picture. Add one on the post.');
  const c = await json(`https://graph.instagram.com/${V}/${m.id}/media`, form({ image_url: p.image, caption: p.text, access_token: m.token }), 'Instagram');
  for (let i = 0; i < 12; i++) { const s = await json(`https://graph.instagram.com/${V}/${c.id}?${new URLSearchParams({ fields: 'status_code', access_token: m.token })}`, {}, 'Instagram');
    if (s.status_code === 'FINISHED') break; if (s.status_code === 'ERROR') throw new Error('Instagram couldn’t use that picture. Try a JPG.'); await new Promise(r => setTimeout(r, 5000)); }
  return (await json(`https://graph.instagram.com/${V}/${m.id}/media_publish`, form({ creation_id: c.id, access_token: m.token }), 'Instagram')).id;
}
async function metaStats(p) {
  if (p.platform === 'facebook') { const m = load('facebook'); if (!m.page) return null;
    const j = await json(`https://graph.facebook.com/${V}/${p.remote_id}?${new URLSearchParams({ fields: 'shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)', access_token: m.page.token })}`, {}, 'Facebook');
    return { likes: ((j.reactions || {}).summary || {}).total_count || 0, comments: ((j.comments || {}).summary || {}).total_count || 0, shares: (j.shares || {}).count || 0 }; }
  const m = load('instagram'); if (!m.token) return null;
  const j = await json(`https://graph.instagram.com/${V}/${p.remote_id}/insights?${new URLSearchParams({ metric: 'reach,likes,comments,shares,saved', access_token: m.token })}`, {}, 'Instagram');
  return Object.fromEntries((j.data || []).map(x => [x.name, ((x.values || [])[0] || {}).value || 0]));
}

// ---------- Pinterest ----------
const PAPI = 'https://api.pinterest.com/v5';
const pBasic = () => { const [id, s] = env(...KEYS.pinterest); return 'Basic ' + Buffer.from(`${id}:${s}`).toString('base64'); };
const pToken = body => json(`${PAPI}/oauth/token`, { method: 'POST', headers: { Authorization: pBasic(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }, 'Pinterest');
const pinStart = () => `https://www.pinterest.com/oauth/?${new URLSearchParams({ client_id: env(...KEYS.pinterest)[0], redirect_uri: redirect('pinterest'), response_type: 'code', scope: 'boards:read,boards:write,pins:read,pins:write,user_accounts:read', state: newState('pinterest') })}`;
async function pinBoards(m) { const items = []; let bookmark = '';
  for (let i = 0; i < 20; i++) { const j = await json(`${PAPI}/boards?page_size=250${bookmark ? '&bookmark=' + encodeURIComponent(bookmark) : ''}`, { headers: { Authorization: `Bearer ${m.token}` } }, 'Pinterest'); items.push(...(j.items || [])); bookmark = j.bookmark || ''; if (!bookmark) break; }
  m.boards = items.map(b => ({ id: String(b.id), name: b.name || 'Board' })).sort((a, b) => a.name.localeCompare(b.name)); if (!m.board || !m.boards.some(b => b.id === m.board.id)) m.board = m.boards.length === 1 ? m.boards[0] : null; }
async function pinFinish(q) { takeState('pinterest', q.state); if (q.error) throw new Error(q.error_description || q.error || 'Pinterest didn’t connect it.');
  const t = await pToken({ grant_type: 'authorization_code', code: String(q.code || ''), redirect_uri: redirect('pinterest') });
  const m = { token: t.access_token, refresh: t.refresh_token, expires: new Date(Date.now() + (Number(t.expires_in) || 30 * 86400) * 1000).toISOString() };
  try { m.username = (await json(`${PAPI}/user_account`, { headers: { Authorization: `Bearer ${m.token}` } }, 'Pinterest')).username || ''; } catch {}
  await pinBoards(m); save('pinterest', m); }
async function pinRefresh() { const m = load('pinterest'); if (!m.token || !m.refresh || Date.parse(m.expires) - Date.now() > 5 * 864e5) return;
  const t = await pToken({ grant_type: 'refresh_token', refresh_token: m.refresh }); m.token = t.access_token; if (t.refresh_token) m.refresh = t.refresh_token; m.expires = new Date(Date.now() + (Number(t.expires_in) || 30 * 86400) * 1000).toISOString(); save('pinterest', m); }
async function pinPublish(p) { await pinRefresh().catch(() => {}); const m = load('pinterest'); if (!m.token || !m.board) throw new Error('Pinterest isn’t connected (or no board is picked).');
  if (!p.image) throw new Error('A pin needs a picture. Add one on the post.');
  const lines = String(p.text || '').split('\n').map(s => s.trim()).filter(Boolean), title = (lines[0] || p.title || '').slice(0, 100);
  const body = { board_id: m.board.id, title, description: lines.slice(1).join('\n').slice(0, 500), alt_text: String(p.title || title).slice(0, 500), media_source: { source_type: 'image_url', url: p.image } }; if (p.link) body.link = p.link;
  return (await json(`${PAPI}/pins`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Pinterest')).id; }

// ---------- X ----------
const XAPI = 'https://api.x.com/2';
const xToken = body => { const [id, s] = env(...KEYS.x); return json(`${XAPI}/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${s}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, ...body }).toString() }, 'X'); };
function xStart() { const verifier = crypto.randomBytes(48).toString('base64url'), st = newState('x', { verifier });
  return `https://x.com/i/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: env(...KEYS.x)[0], redirect_uri: redirect('x'), scope: 'tweet.read tweet.write users.read media.write offline.access', state: st, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString().replace(/\+/g, '%20')}`; }
const xKeep = (m, t) => { m.token = t.access_token; if (t.refresh_token) m.refresh = t.refresh_token; m.expires = new Date(Date.now() + (Number(t.expires_in) || 7200) * 1000).toISOString(); };
async function xFinish(q) { const s = takeState('x', q.state); if (q.error) throw new Error(q.error_description || q.error || 'X didn’t connect it.');
  const m = {}; xKeep(m, await xToken({ grant_type: 'authorization_code', code: String(q.code || ''), redirect_uri: redirect('x'), code_verifier: s.verifier }));
  try { m.username = ((await json(`${XAPI}/users/me`, { headers: { Authorization: `Bearer ${m.token}` } }, 'X')).data || {}).username || ''; } catch {}
  save('x', m); }
async function xFresh() { const m = load('x'); if (!m.token) throw new Error('X isn’t connected.'); if (m.refresh && Date.parse(m.expires) - Date.now() < 10 * 60e3) { xKeep(m, await xToken({ grant_type: 'refresh_token', refresh_token: m.refresh })); save('x', m); } return load('x'); }
// X counts any link as 23 characters; keep the post to 280.
function xFit(text) { const t = String(text || '').trim(), len = s => s.replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length; if (len(t) <= 280) return t;
  const lines = t.split('\n'), link = lines.find(l => /https?:\/\//.test(l)) || '', tags = lines.filter(l => /^#/.test(l.trim())).join(' ');
  let body = lines.filter(l => l !== link && !/^#/.test(l.trim())).join('\n').trim(), out; do { out = [body, link, tags].filter(Boolean).join('\n\n'); body = body.slice(0, -10).trim() + '…'; } while (len(out) > 280 && body.length > 20); return out; }
async function xPublish(p) { const m = await xFresh(); let media = [];
  if (p.image) try { const img = await fetch(p.image, { signal: AbortSignal.timeout(30000) }); if (!img.ok) throw new Error('picture ' + img.status);
    const f = new FormData(); f.append('media', new Blob([Buffer.from(await img.arrayBuffer())], { type: img.headers.get('content-type') || 'image/jpeg' }), 'post.jpg'); f.append('media_category', 'tweet_image');
    const up = await json(`${XAPI}/media/upload`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}` }, body: f }, 'X'); if (up.data && up.data.id) media = [String(up.data.id)]; } catch (err) { console.error('X picture upload (posting without it):', err.message); }
  const body = { text: xFit(p.text) }; if (media.length) body.media = { media_ids: media };
  return ((await json(`${XAPI}/tweets`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'X')).data || {}).id; }

setInterval(() => { refreshIg().catch(e => console.error('Instagram refresh:', e.message)); pinRefresh().catch(e => console.error('Pinterest refresh:', e.message)); if (load('x').refresh) xFresh().catch(e => console.error('X refresh:', e.message)); }, 6 * 3600e3).unref();

// ---------- one interface for social.js ----------
const POSTABLE = ['facebook', 'instagram', 'pinterest', 'x'];
const connected = p => { if (!hasKeys(p)) return false; const m = load(p); return p === 'facebook' ? !!m.page : p === 'pinterest' ? !!(m.token && m.board) : !!m.token; };
function startUrl(p) { if (!POSTABLE.includes(p)) throw new Error('Posting straight to that platform isn’t built yet. Its posts come as reminders.');
  if (!hasKeys(p)) throw new Error(`${p} isn’t set up: add ${KEYS[p].join(' and ')} to the server’s environment first.`);
  return p === 'pinterest' ? pinStart() : p === 'x' ? xStart() : metaStart(p); }
const finish = (p, q) => p === 'pinterest' ? pinFinish(q) : p === 'x' ? xFinish(q) : metaFinish(p, q);
const publish = p => p.platform === 'pinterest' ? pinPublish(p) : p.platform === 'x' ? xPublish(p) : metaPublish(p);
const stats = p => ['facebook', 'instagram'].includes(p.platform) ? metaStats(p) : Promise.resolve(null);
function status() {
  const out = {}; for (const p of POSTABLE) { const m = load(p);
    out[p] = { keys: hasKeys(p), need: KEYS[p], redirect: redirect(p), connected: connected(p), account: p === 'facebook' ? (m.page ? m.page.name : null) : p === 'pinterest' ? (m.username || null) : (m.username || null),
      pages: p === 'facebook' ? (m.pages || []).map(x => ({ id: x.id, name: x.name })) : undefined, boards: p === 'pinterest' ? (m.boards || []) : undefined, board: p === 'pinterest' && m.board ? m.board : undefined }; }
  return out;
}
function pick(p, id) { const m = load(p);
  if (p === 'facebook') { const x = (m.pages || []).find(y => y.id === String(id)); if (!x) throw new Error('Pick one of your Pages.'); m.page = x; }
  else if (p === 'pinterest') { const x = (m.boards || []).find(y => y.id === String(id)); if (!x) throw new Error('Pick one of your boards.'); m.board = x; }
  save(p, m); }
module.exports = { POSTABLE, connected, startUrl, finish, publish, stats, status, pick, disconnect: drop };
