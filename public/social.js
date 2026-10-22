// Social posts screens (owner only), ported from psyrenne's showSocial: the queue, one article's planner, one post,
// results, coverage, the picture library, and connections.
(function () {
const { api, esc, act, table, opts, route, onView, formData } = CR;
const $ = CR.$;
const STATUS = { draft: 'Needs your OK', planned: 'Scheduled', posting: 'Posting', due: 'Post it yourself', posted: 'Posted', skipped: 'Skipped' };
const tabs = cur => `<div class="tabs">${[['social', 'Queue'], ['social/new', 'Share an article'], ['social/results', 'Results'], ['social/coverage', 'Coverage'], ['social/library', 'Pictures'], ['social/conn', 'Connections']].map(([k, t]) => `<a href="#${k}" class="${cur === k ? 'on' : ''}">${t}</a>`).join('')}</div>`;
const wrapOwner = (cur, title, inner) => `<div class="owner-only" style="padding:4px"><h1>${esc(title)} <span class="owner-tag">Admin</span></h1>${tabs(cur)}${inner}</div>`;
const toJpeg = file => new Promise((ok, no) => { const img = new Image(), url = URL.createObjectURL(file); img.onload = () => { const c = document.createElement('canvas'), k = Math.min(1, 2000 / Math.max(img.width, img.height));
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); ok(c.toDataURL('image/jpeg', 0.85)); };
  img.onerror = () => no(new Error('That picture didn’t open. Try a JPG or PNG.')); img.src = url; });

route('social', async (sub, arg) => {
  if (sub === 'new') return newShare();
  if (sub === 'article') return planner(arg);
  if (sub === 'results') return results();
  if (sub === 'coverage') return coverage();
  if (sub === 'library') return library();
  if (sub === 'conn') return connections(arg);
  if (sub && /^\d+$/.test(sub)) return onePost(sub);
  const d = await api('/api/social');
  const drafts = d.posts.filter(p => p.status === 'draft'), due = d.posts.filter(p => p.status === 'due'), sched = d.posts.filter(p => ['planned', 'posting'].includes(p.status)), done = d.posts.filter(p => ['posted', 'skipped'].includes(p.status));
  const row = p => `<tr><td data-sort="${esc(p.at || '')}">${esc(CR.when(p.at))}</td><td>${esc(p.platformName)}</td><td><a href="#social/${p.id}">${esc((p.title || p.text).slice(0, 80))}</a>${p.note ? `<br><span class="small muted">${esc(p.note)}</span>` : ''}</td><td>${esc(STATUS[p.status] || p.status)}</td><td>${p.how === 'self' ? 'Posts itself' : 'Email reminder'}</td><td>${p.clicks}</td></tr>`;
  CR.view(wrapOwner('social', 'Social posts', `<p class="small muted">Every post starts with ${esc(d.brandTag)}. Posting times use ${esc(d.timezone)}; you see them in your own time zone. ${d.hasKey ? '' : esc(d.aiWhy)}</p>
    ${due.length ? `<div class="card" style="border-color:var(--pink)"><h2>Post these yourself (${due.length})</h2>${table(['When', 'Platform', 'Post', 'Status', 'How', 'Clicks'], due.map(row))}</div>` : ''}
    <div class="card" style="margin-top:10px"><div class="spread"><h2>Needs your OK (${drafts.length})</h2>${drafts.length ? '<button class="btn" id="approveAll">Approve all</button>' : ''}</div>${table(['When', 'Platform', 'Post', 'Status', 'How', 'Clicks'], drafts.map(row), { empty: 'No drafts waiting.' })}</div>
    <div class="card" style="margin-top:10px"><div class="spread"><h2>Scheduled (${sched.length})</h2><button class="btn alt small" id="catchup">Move late posts to the next open times</button></div>${table(['When', 'Platform', 'Post', 'Status', 'How', 'Clicks'], sched.map(row), { empty: 'Nothing scheduled.' })}</div>
    ${done.length ? `<div class="card" style="margin-top:10px"><h2>Done in the last 2 weeks</h2>${table(['When', 'Platform', 'Post', 'Status', 'How', 'Clicks'], done.map(row))}</div>` : ''}
    <form id="auto" class="panel form"><label class="check"><input type="checkbox" name="auto" ${d.auto.on ? 'checked' : ''}> Draft posts by themselves when a new article goes live (they wait for your OK)</label>
      <div class="row">${Object.entries(d.platforms).map(([k, v]) => `<label class="check"><input type="checkbox" name="p_${k}" ${d.auto.platforms.includes(k) ? 'checked' : ''}> ${esc(v.name)}</label>`).join('')}</div><div><button class="btn small">Save</button></div></form>`));
  const a = $('#approveAll'); if (a) a.addEventListener('click', () => act(a, async () => { await api('/api/social/approve', { body: {} }); CR.render(); }));
  $('#catchup').addEventListener('click', e => act(e.target, async () => { const r = await api('/api/social/catchup', { body: {} }); alert(`${r.moved.length} posts moved.`); CR.render(); }));
  $('#auto').addEventListener('submit', e => { e.preventDefault(); const f = formData(e.target); act(e.submitter, () => api('/api/social/settings', { method: 'PUT', body: { auto: f.auto, platforms: Object.keys(d.platforms).filter(k => f['p_' + k]) } }), 'Saved.'); });
}, { owner: true });

async function newShare() {
  const d = await api('/api/social');
  CR.view(wrapOwner('social/new', 'Share an article', `<div class="filters"><input type="search" id="q" placeholder="Search articles" aria-label="Search articles"></div><div id="list"></div>`));
  const draw = () => { const q = $('#q').value; $('#list').innerHTML = table(['Article', 'Status', 'Published', ''], d.articles.filter(a => CR.matches(q, a.title)).map(a => `<tr><td><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></td><td>${a.status === 'future' ? 'Scheduled' : 'Live'}</td><td data-sort="${esc(a.date_gmt || '')}">${esc(CR.day(a.date_gmt))}</td><td><a class="btn small" href="#social/article/${a.id}">Plan posts</a></td></tr>`),
    { empty: 'No published articles yet. They arrive from the WordPress site through the signed endpoint.' }); };
  $('#q').addEventListener('input', draw); draw();
}
async function planner(pid) {
  const d = await api('/api/social/article/' + pid);
  const box = (k, v) => { const p = d.posts[k] || {}, on = !!d.posts[k] ? !['posted', 'skipped'].includes(p.status) : d.auto.includes(k);
    return `<fieldset class="card" data-pl="${k}"><legend><label class="check"><input type="checkbox" name="on" ${on ? 'checked' : ''}> ${esc(v.name)}</label></legend>
      <p class="small muted">${esc(v.tip)} ${v.how === 'self' ? 'Posts by itself.' : 'You’ll get an email reminder to post it.'}${p.status ? ' Now: ' + esc(STATUS[p.status]) : ''}</p>
      <input type="hidden" name="id" value="${p.id || ''}"><label>Caption <span class="small muted">(up to ${v.max} characters)</span><textarea name="text">${esc(p.text || '')}</textarea></label>
      <label>Hashtags<input type="text" name="hashtags" value="${esc(p.hashtags || '')}"></label>
      <div class="two"><label>When<input type="datetime-local" name="at" value="${esc(CR.toInput(p.at || v.suggestAt))}"></label><label>Picture link<input type="url" name="image" value="${esc(p.picked ? p.image : '')}" placeholder="${esc(v.image || 'From the picture library')}"></label></div></fieldset>`; };
  CR.view(wrapOwner('social/new', 'Plan posts', `<h2>${esc(d.article.title)}</h2><p><a href="${esc(d.article.url)}" target="_blank" rel="noopener">Open the article</a></p>
    <div class="row" style="margin-bottom:10px"><button class="btn alt" id="ai"${d.hasKey ? '' : ' disabled title="Add ANTHROPIC_API_KEY first"'}>Write captions with AI for the ticked platforms</button>${d.hasKey ? '' : '<span class="small muted">AI isn’t set up yet (ANTHROPIC_API_KEY).</span>'}</div>
    <form id="pf" class="form">${Object.entries(d.platforms).map(([k, v]) => box(k, v)).join('')}<div><button class="btn">Save and schedule</button></div></form>`));
  $('#ai').addEventListener('click', e => act(e.target, async () => { const ticked = CR.$$('[data-pl]').filter(f => f.querySelector('[name=on]').checked).map(f => f.dataset.pl);
    const r = await api('/api/social/draft', { body: { post_id: Number(pid), platforms: ticked } });
    for (const p of r.posts) { const f = $(`[data-pl="${p.platform}"]`); f.querySelector('[name=text]').value = p.text; f.querySelector('[name=hashtags]').value = p.hashtags; } }));
  $('#pf').addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => {
    const windows = CR.$$('[data-pl]').map(f => ({ platform: f.dataset.pl, on: f.querySelector('[name=on]').checked, id: f.querySelector('[name=id]').value, text: f.querySelector('[name=text]').value, hashtags: f.querySelector('[name=hashtags]').value, at: CR.fromInput(f.querySelector('[name=at]').value), image: f.querySelector('[name=image]').value }));
    const r = await api('/api/social/article/' + pid, { body: { windows } }); alert(`${r.saved} posts scheduled.`); CR.go('social'); }); });
}
async function onePost(id) {
  const { post: p, platform } = await api('/api/social/' + id);
  CR.view(wrapOwner('social', 'Post', `<div class="card social-post ${p.status}"><p><strong>${esc(p.platformName)}</strong> · ${esc(STATUS[p.status])} · ${esc(CR.when(p.at))} · ${p.clicks} clicks</p>${p.note ? `<p class="msg warn">${esc(p.note)}</p>` : ''}
    ${p.image ? `<p><img class="pic-thumb" src="${esc(p.image)}" alt="Post picture"> <a href="${esc(p.image)}?download=1">Download the picture</a></p>` : ''}
    <form id="ef" class="form"><label>Caption<textarea name="text" style="min-height:160px">${esc(p.text)}</textarea></label><label>Hashtags<input type="text" name="hashtags" value="${esc(p.hashtags || '')}"></label>
      <div class="two"><label>When<input type="datetime-local" name="at" value="${esc(CR.toInput(p.at))}"></label><label>Picture link<input type="url" name="image" value="${esc(p.picked ? p.image : '')}"></label></div>
      <div class="row"><button class="btn">Save</button>${p.status === 'draft' ? '<button type="button" class="btn" data-st="planned">Approve</button>' : ''}
        <button type="button" class="btn alt" id="copy">Copy caption</button><a class="btn alt" href="${esc(platform.open || '#')}" target="_blank" rel="noopener">Open ${esc(p.platformName)}</a>
        <button type="button" class="btn alt" data-st="posted">I posted it</button><button type="button" class="btn alt" data-st="skipped">Skip</button><button type="button" class="btn danger" id="del">Delete</button></div></form>
    ${p.short ? `<p class="small">Tracked link: <a href="${esc(p.short)}" target="_blank" rel="noopener">${esc(p.short)}</a> → ${esc(p.link)}</p>` : ''}</div>`));
  $('#ef').addEventListener('submit', e => { e.preventDefault(); const b = formData(e.target); b.at = CR.fromInput(b.at); act(e.submitter, () => api('/api/social/' + id, { method: 'PUT', body: b }), 'Saved.'); });
  $('#copy').addEventListener('click', async e => { try { await navigator.clipboard.writeText(p.caption); e.target.textContent = 'Copied'; } catch { prompt('Copy the caption:', p.caption); } });
  $('#del').addEventListener('click', e => { if (confirm('Delete this post?')) act(e.target, async () => { await api('/api/social/' + id, { method: 'DELETE' }); CR.go('social'); }); });
  onView('click', e => { const b = e.target.closest('[data-st]'); if (b) act(b, async () => { await api('/api/social/' + id, { method: 'PUT', body: { status: b.dataset.st } }); CR.render(); }); });
}
async function results() {
  const d = await api('/api/social/results');
  CR.view(wrapOwner('social/results', 'Results', `<p>${d.total30} clicks on tracked links in the last 30 days. Link-preview robots aren’t counted.</p>
    <div class="cards"><div class="card"><h2>Last 30 days</h2>${table(['Platform', 'Posts', 'Clicks'], d.d30.map(r => `<tr><td>${esc(r.name)}</td><td>${r.posts}</td><td>${r.clicks}</td></tr>`), { empty: 'No clicks yet.' })}</div>
      <div class="card"><h2>Last 90 days</h2>${table(['Platform', 'Posts', 'Clicks'], d.d90.map(r => `<tr><td>${esc(r.name)}</td><td>${r.posts}</td><td>${r.clicks}</td></tr>`), { empty: 'No clicks yet.' })}</div></div>
    <h2 style="margin-top:12px">Posts</h2>${table(['Posted', 'Platform', 'Post', 'Clicks', 'Likes', 'Comments', 'Shares', 'Reach'], d.posts.map(p => `<tr><td data-sort="${esc(p.posted)}">${esc(CR.day(p.posted))}</td><td>${esc(p.name)}</td><td><a href="#social/${p.id}">${esc(p.title)}</a></td><td>${p.clicks}</td><td>${p.likes ?? ''}</td><td>${p.comments ?? ''}</td><td>${p.shares ?? ''}</td><td>${p.reach ?? ''}</td></tr>`), { empty: 'Nothing posted yet.' })}`));
}
async function coverage() {
  const d = await api('/api/social/coverage'), mark = c => !c ? '<span class="muted">–</span>' : `<a href="#social/${c.id}" title="${esc(STATUS[c.status] || c.status)}">${c.status === 'posted' ? '✓' : c.status === 'draft' ? 'OK?' : c.status === 'skipped' ? 'skip' : '⏱'}</a>`;
  CR.view(wrapOwner('social/coverage', 'Coverage', `<p class="small muted">Each published article against each platform. ✓ posted, ⏱ scheduled, OK? waiting for you, – not yet.</p>
    ${table(['Article', ...d.platforms.map(p => p.name)], d.articles.map(a => `<tr><td><a href="#social/article/${a.id}">${esc(a.title)}</a></td>${d.platforms.map(p => `<td>${mark(a.cells[p.key])}</td>`).join('')}</tr>`), { empty: 'No published articles yet.' })}`));
}
async function library() {
  const d = await api('/api/social/library');
  CR.view(wrapOwner('social/library', 'Pictures', `<form id="lf" class="row panel"><label for="pf">Add a picture</label><input id="pf" type="file" accept="image/*" style="width:auto"><input type="text" name="name" placeholder="Name" style="max-width:220px" aria-label="Picture name"><button class="btn small">Upload</button></form>
    <p class="small muted">Image packs made with tools/social-packs.js arrive here by themselves, one size per platform.</p>
    ${d.pictures.length ? `<div class="cards">${d.pictures.map(p => `<div class="card"><img class="pic-thumb" src="${esc(p.url)}" alt="${esc(p.label)}" style="width:100%;height:150px"><p class="small"><strong>${esc(p.label)}</strong><br>${esc(p.size)}</p>
      <div class="row"><button class="btn alt small" data-copy="${esc(p.url)}">Copy link</button>${p.own ? `<button class="btn alt small" data-rm="${esc(p.code)}">Remove</button>` : ''}</div></div>`).join('')}</div>` : '<p class="empty">No pictures yet.</p>'}`));
  $('#lf').addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { const f = $('#pf').files[0]; if (!f) throw new Error('Choose a picture.'); await api('/api/social/library', { body: { data: await toJpeg(f), name: e.target.elements.name.value || f.name } }); CR.render(); }); });
  onView('click', e => { const c = e.target.closest('[data-copy]'); if (c) { navigator.clipboard.writeText(c.dataset.copy).then(() => { c.textContent = 'Copied'; }, () => prompt('Copy the link:', c.dataset.copy)); }
    const r = e.target.closest('[data-rm]'); if (r && confirm('Remove this picture?')) act(r, async () => { await api('/api/social/library/' + r.dataset.rm, { method: 'DELETE' }); CR.render(); }); });
}
async function connections(msg) {
  const c = await api('/api/social/connections'), NAMES = { facebook: 'Facebook Page', instagram: 'Instagram', pinterest: 'Pinterest', x: 'X' };
  CR.view(wrapOwner('social/conn', 'Connections', `${msg ? `<p class="msg ${msg === 'connected' ? 'ok' : 'err'}">${msg === 'connected' ? 'Connected.' : esc(msg)}</p>` : ''}
    <p class="small muted">Each platform needs its own developer app (Jess’s accounts). Its keys go in the server’s environment; then Connect signs in. LinkedIn, Threads, and YouTube posts come as email reminders for now.</p>
    <div class="cards">${Object.entries(c).map(([k, v]) => `<div class="card"><h2>${NAMES[k]}</h2>
      ${!v.keys ? `<p class="msg warn small">Not set up. Add ${v.need.map(esc).join(' and ')} to the environment.</p><p class="small">Redirect address for the developer app:<br><code>${esc(v.redirect)}</code></p>`
        : v.connected ? `<p><strong>Connected</strong>${v.account ? ' as ' + esc(v.account) : ''}.</p>` : `<p>Keys are set. <a class="btn small" href="/api/social/oauth/${k}/start">Connect</a></p>`}
      ${k === 'facebook' && v.pages && v.pages.length > 1 ? `<label>Page<select data-pick="facebook">${opts(CR.az(v.pages.map(p => [p.id, p.name])), '')}</select></label>` : ''}
      ${k === 'pinterest' && v.boards && v.boards.length ? `<label>Board<select data-pick="pinterest"><option value="">Pick a board</option>${opts(v.boards.map(b => [b.id, b.name]), v.board ? v.board.id : '')}</select></label>` : ''}
      ${v.connected || (v.pages && v.pages.length) ? `<p><button class="btn alt small" data-disc="${k}">Disconnect</button></p>` : ''}</div>`).join('')}</div>`));
  onView('change', e => { const s = e.target.closest('[data-pick]'); if (s && s.value) act(s, async () => { await api(`/api/social/connections/${s.dataset.pick}/pick`, { body: { id: s.value } }); CR.render(); }); });
  onView('click', e => { const b = e.target.closest('[data-disc]'); if (b && confirm('Disconnect? Posts for it become reminders.')) act(b, async () => { await api('/api/social/connections/' + b.dataset.disc, { method: 'DELETE' }); CR.go('social/conn'); }); });
}
})();
