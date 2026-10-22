// Directory screens: browse and search, one listing (reviews, suggest an edit), suggest a listing, and the owner's editor
// and approval queue.
(function () {
const { api, esc, act, table, opts, route, onView, formData } = CR;
const $ = CR.$;
const starLine = (s, n) => s ? `<span title="${s} of 5">${'★'.repeat(Math.round(s))}${'☆'.repeat(5 - Math.round(s))}</span> <span class="small muted">${s} (${n})</span>` : '';
const place = l => [l.city, l.state, l.country].filter(Boolean).join(', ');
let META = null;
route('directory', async (id) => {
  if (id === 'suggest') return suggestListing();
  if (id) return oneListing(id);
  const d = await api('/api/directory'); META = d;
  const countries = CR.az([...new Set(d.listings.map(l => l.country).filter(Boolean))]), states = CR.az([...new Set(d.listings.map(l => l.state).filter(Boolean))]);
  CR.view(`<div class="spread"><h1>Directory</h1><a class="btn alt" href="#directory/suggest">Suggest a listing</a></div>
    <p class="muted">Organizations, vendors, consultants, research sites, sponsors, and technology in clinical research.</p>
    <div class="filters"><input type="search" id="q" placeholder="Search (every word counts)" aria-label="Search the directory" style="min-width:260px">
      <select id="ty" aria-label="Type"><option value="">Every type</option>${opts(CR.az(Object.entries(d.types).map(([k, t]) => [k, t.name])))}</select>
      <select id="co" aria-label="Country"><option value="">Every country</option>${opts(countries)}</select>
      <select id="st" aria-label="State or region"><option value="">Every state or region</option>${opts(states)}</select></div><div id="list"></div>
    ${CR.me.owner ? '<p><a class="btn alt small owner-only" href="#admin-directory">Edit the directory</a></p>' : ''}`);
  const draw = () => { const q = $('#q').value, ty = $('#ty').value, co = $('#co').value, st = $('#st').value;
    const list = d.listings.filter(l => (!ty || l.type === ty) && (!co || l.country === co) && (!st || l.state === st) && CR.matches(q, [l.name, l.summary, l.description, l.typeName, place(l), Object.values(l.data).join(' ')].join(' ')));
    $('#list').innerHTML = list.length ? `<div class="cards">${list.map(l => `<div class="card">${l.logo_url ? `<img src="${esc(l.logo_url)}" alt="" style="max-height:48px;float:right">` : ''}<h3><a href="#directory/${l.id}">${esc(l.name)}</a></h3>
      <p class="row small"><span class="tag">${esc(l.typeName)}</span>${place(l) ? `<span class="muted">${esc(place(l))}</span>` : ''}</p>${l.summary ? `<p class="small">${esc(l.summary)}</p>` : ''}${starLine(l.stars, l.reviews)}</div>`).join('')}</div>`
      : `<p class="empty">${d.listings.length ? 'Nothing matches. Try fewer words or another filter.' : 'The directory is empty for now.'}</p>`; };
  ['q', 'ty', 'co', 'st'].forEach(x => $('#' + x).addEventListener('input', draw)); draw();
});
async function oneListing(id) {
  const [d, meta] = await Promise.all([api('/api/directory/item/' + id), META ? Promise.resolve(META) : api('/api/directory')]); META = meta;
  const l = d.listing, t = meta.types[l.type] || { fields: [] }, r = d.reviews;
  api(`/api/directory/item/${id}/opened`, { body: {} }).catch(() => {});
  const rows = [['Website', l.website ? `<a href="${esc(l.website)}" target="_blank" rel="noopener">${esc(l.website)}</a>` : ''], ['Email', l.contact_email ? esc(l.contact_email) : ''], ['Phone', esc(l.phone)], ['Where', esc(place(l))],
    ...t.fields.map(([k, label, kind]) => [label, kind === 'yesno' ? (l.data[k] ? 'Yes' : '') : esc(l.data[k] || '').replace(/\n/g, '<br>')])].filter(x => x[1]);
  CR.view(`<p class="small"><a href="#directory">Directory</a></p><div class="spread"><h1>${esc(l.name)}</h1>${l.logo_url ? `<img src="${esc(l.logo_url)}" alt="${esc(l.name)} logo" style="max-height:70px">` : ''}</div>
    <p class="row"><span class="tag">${esc(l.typeName)}</span>${starLine(l.stars, l.reviews)}${CR.me.owner ? ` <a class="btn alt small owner-only" href="#admin-directory/${l.id}">Edit</a>` : ''}</p>
    ${l.summary ? `<p><strong>${esc(l.summary)}</strong></p>` : ''}${l.description ? `<p>${esc(l.description).replace(/\n/g, '<br>')}</p>` : ''}
    ${rows.length ? `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table>` : ''}
    ${l.video_url ? CR.player(null, l.video_url) : ''}${l.photos.length ? `<div class="cards" style="margin-top:10px">${l.photos.map(p => `<img src="${esc(p)}" alt="Photo of ${esc(l.name)}" style="width:100%;border-radius:8px">`).join('')}</div>` : ''}
    ${l.links.length ? `<h2>${l.type === 'consultant' ? 'Work and presentations' : 'Links'}</h2><ul>${l.links.map(x => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></li>`).join('')}</ul>` : ''}
    <section class="card" style="margin-top:14px"><h2>Reviews</h2>${r.show ? (r.reviews.length ? r.reviews.map(x => `<div class="comment">${'★'.repeat(x.stars)}${'☆'.repeat(5 - x.stars)} <span class="small muted">${esc(x.relation)} · ${esc(x.when)}</span>${x.note ? `<p>${esc(x.note)}</p>` : ''}${x.reported ? '<span class="small muted">You reported this.</span>' : `<button class="btn alt small" data-report="${x.id}">Report</button>`}</div>`).join('') : '<p class="small muted">No other reviews yet.</p>')
      : `<p class="small muted">Reviews show once there are ${r.min} (so nobody can tell who said what). ${r.count} so far.</p>`}
      <form id="rf" class="form" style="margin-top:8px"><h3>${r.mine ? 'Your review' : 'Add your review'}</h3>${r.mine && r.mine.status === 'hidden' ? '<p class="msg warn small">Your review is hidden while the team looks at reports about it.</p>' : ''}
        <div class="two"><label>Stars<select name="stars">${opts([[5, '5 stars'], [4, '4 stars'], [3, '3 stars'], [2, '2 stars'], [1, '1 star']], r.mine ? r.mine.stars : 5)}</select></label><label>How you know them<select name="relation"><option value="">Pick one</option>${opts(CR.az(Object.entries(meta.relations)), r.mine ? r.mine.relation : '')}</select></label></div>
        <label>A short note (optional)<textarea name="note">${esc(r.mine ? r.mine.note : '')}</textarea></label><label class="check"><input type="checkbox" name="own"> This is my own experience</label>
        <div class="row"><button class="btn">Save review</button>${r.mine ? '<button type="button" class="btn alt" id="rmReview">Remove my review</button>' : ''}</div></form></section>
    <details class="card" style="margin-top:14px"><summary><strong>Suggest an edit</strong></summary><form id="sf" class="form" style="margin-top:8px"><label>What to fix<select name="field">${opts(CR.az([...meta.common, ...t.fields.map(f => [f[0], f[1]])]))}</select></label>
      <label>The right information<textarea name="value"></textarea></label><label>Where you saw it (optional)<input type="text" name="note"></label><div><button class="btn">Send to the team</button></div></form></details>`);
  $('#rf').addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { await api(`/api/directory/item/${id}/reviews`, { body: formData(e.target) }); CR.render(); }); });
  const rm = $('#rmReview'); if (rm) rm.addEventListener('click', () => act(rm, async () => { await api(`/api/directory/item/${id}/reviews`, { method: 'DELETE' }); CR.render(); }));
  $('#sf').addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { await api(`/api/directory/item/${id}/suggest`, { body: formData(e.target) }); e.target.reset(); }, 'Thank you. The team will check it.'); });
  onView('click', e => { const b = e.target.closest('[data-report]'); if (!b) return; const reason = prompt('What’s wrong with this review? (for example: not real, rude, private details)'); if (reason === null) return;
    act(b, async () => { await api(`/api/directory/reviews/${b.dataset.report}/report`, { body: { reason } }); CR.render(); }); });
}
async function suggestListing() {
  const d = META || await api('/api/directory');
  CR.view(`<p class="small"><a href="#directory">Directory</a></p><h1>Suggest a listing</h1><p class="muted">The team checks every suggestion before it shows.</p>
    <form id="nf" class="form card"><div class="two"><label>Type<select name="type">${opts(CR.az(Object.entries(d.types).map(([k, t]) => [k, t.one])))}</select></label><label>Name<input type="text" name="name" required></label></div>
      <label>What they do<textarea name="summary"></textarea></label><label>Website<input type="url" name="website" placeholder="https://"></label>
      <div class="three"><label>City<input type="text" name="city"></label><label>State or region<input type="text" name="state"></label><label>Country<input type="text" name="country"></label></div><div><button class="btn">Send</button></div></form>`);
  $('#nf').addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { await api('/api/directory/submit', { body: formData(e.target) }); e.target.reset(); }, 'Thank you. The team will check it.'); });
}

// ---------- the owner ----------
route('admin-directory', async (id) => {
  if (id) return editListing(id);
  const [d, q] = await Promise.all([api('/api/admin/directory'), api('/api/admin/directory/queue')]); META = META || await api('/api/directory');
  CR.view(`<div class="owner-only" style="padding:4px"><div class="spread"><h1>Directory <span class="owner-tag">Admin</span></h1><a class="btn" href="#admin-directory/new">New listing</a></div>
    <div class="card"><h2>Waiting for you</h2>
      ${q.pending.length ? `<h3>Suggested listings</h3>${table(['Name', 'Type', 'From', ''], q.pending.map(p => `<tr><td><a href="#admin-directory/${p.id}">${esc(p.name)}</a><br><span class="small muted">${esc(p.summary || '')}</span></td><td>${esc((META.types[p.type] || {}).one || p.type)}</td><td>${esc(p.email || '')}</td>
        <td><button class="btn small" data-pub="${p.id}">Publish</button> <button class="btn alt small" data-del="${p.id}">Decline</button></td></tr>`))}` : ''}
      ${q.suggestions.length ? `<h3>Suggested edits</h3>${table(['Listing', 'Field', 'Was', 'Suggested', 'Note', ''], q.suggestions.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.field)}</td><td>${esc(s.was || '')}</td><td>${esc(s.value)}</td><td>${esc(s.note || '')}</td>
        <td><button class="btn small" data-sug="${s.id}" data-ok="1">${s.field === 'other' ? 'Done' : 'Use it'}</button> <button class="btn alt small" data-sug="${s.id}" data-ok="0">Decline</button></td></tr>`))}` : ''}
      ${q.hiddenReviews.length ? `<h3>Reviews hidden by reports</h3>${table(['Listing', 'Stars', 'Note', 'Reports', ''], q.hiddenReviews.map(r => `<tr><td>${esc(r.name)}</td><td>${r.stars}</td><td>${esc(r.note || '')}</td><td>${esc(r.reasons || '')}</td>
        <td><button class="btn small" data-rev="${r.id}" data-a="restore">Put back</button> <button class="btn alt small" data-rev="${r.id}" data-a="remove">Remove</button></td></tr>`))}` : ''}
      ${!q.pending.length && !q.suggestions.length && !q.hiddenReviews.length ? '<p class="muted">Nothing waiting.</p>' : ''}
      <p class="small muted">${q.opens30} listing opens in the last 30 days${q.top.length ? '. Most opened: ' + q.top.map(t => `${esc(t.name)} (${t.n})`).join(', ') : ''}.</p></div>
    <div class="filters" style="margin-top:12px"><input type="search" id="q" placeholder="Search" aria-label="Search listings"></div><div id="list"></div></div>`);
  const draw = () => { $('#list').innerHTML = table(['Name', 'Type', 'Status', 'Where', 'Reviews', 'Opens (30 days)'], d.listings.filter(l => CR.matches($('#q').value, l.name + ' ' + l.typeName + ' ' + place(l))).map(l =>
    `<tr><td><a href="#admin-directory/${l.id}">${esc(l.name)}</a></td><td>${esc(l.typeName)}</td><td>${esc(l.status)}</td><td>${esc(place(l))}</td><td>${l.reviews}</td><td>${l.opens30}</td></tr>`), { empty: 'No listings yet.' }); };
  $('#q').addEventListener('input', draw); draw();
  onView('click', e => { const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.pub) act(b, async () => { await api(`/api/admin/directory/item/${b.dataset.pub}/publish`, { body: {} }); CR.render(); });
    if (b.dataset.del && confirm('Decline and delete this suggested listing?')) act(b, async () => { await api('/api/admin/directory/item/' + b.dataset.del, { method: 'DELETE' }); CR.render(); });
    if (b.dataset.sug) act(b, async () => { await api('/api/admin/directory/suggestions/' + b.dataset.sug, { body: { approve: b.dataset.ok === '1' } }); CR.render(); });
    if (b.dataset.rev) act(b, async () => { await api('/api/admin/directory/reviews/' + b.dataset.rev, { body: { action: b.dataset.a } }); CR.render(); }); });
}, { owner: true });
async function editListing(id) {
  META = META || await api('/api/directory');
  const isNew = id === 'new', l = isNew ? { type: 'organization', status: 'draft', data: {} } : (await api('/api/admin/directory/item/' + id)).listing;
  const typeFields = type => (META.types[type] || { fields: [] }).fields.map(([k, label, kind, help]) => kind === 'yesno' ? `<label class="check"><input type="checkbox" name="d_${k}" ${l.data[k] ? 'checked' : ''}> ${esc(label)}${help ? ` <span class="small muted">(${esc(help)})</span>` : ''}</label>`
    : `<div><div class="lbl-line"><label for="d_${k}">${esc(label)}</label>${help ? `<span class="muted">${esc(help)}</span>` : ''}</div>${kind === 'long' ? `<textarea id="d_${k}" name="d_${k}">${esc(l.data[k] || '')}</textarea>` : `<input id="d_${k}" type="text" name="d_${k}" value="${esc(l.data[k] || '')}">`}</div>`).join('');
  CR.view(`<div class="owner-only" style="padding:4px"><p class="small"><a href="#admin-directory">Directory</a>${isNew ? '' : ` · <a href="#directory/${l.id}">See it as a student</a>`}</p><h1>${isNew ? 'New listing' : esc(l.name)} <span class="owner-tag">Admin</span></h1>
    <form id="lf" class="form card"><div class="three"><label>Type<select name="type" id="ty">${opts(CR.az(Object.entries(META.types).map(([k, t]) => [k, t.one])), l.type)}</select></label><label>Name<input type="text" name="name" value="${esc(l.name || '')}" required></label>
      <label>Status<select name="status">${opts([['draft', 'Draft'], ['published', 'Published']], l.status === 'pending' ? 'draft' : l.status)}</select></label></div>
      <label>Short description<input type="text" name="summary" value="${esc(l.summary || '')}"></label><label>Full description<textarea name="description">${esc(l.description || '')}</textarea></label>
      <div class="three"><label>Website<input type="url" name="website" value="${esc(l.website || '')}"></label><label>Contact email<input type="email" name="contact_email" value="${esc(l.contact_email || '')}"></label><label>Phone<input type="text" name="phone" value="${esc(l.phone || '')}"></label></div>
      <div class="three"><label>City<input type="text" name="city" value="${esc(l.city || '')}"></label><label>State or region<input type="text" name="state" value="${esc(l.state || '')}"></label><label>Country<input type="text" name="country" value="${esc(l.country || '')}"></label></div>
      <div class="panel form" id="typeFields">${typeFields(l.type)}</div>
      <div class="two"><label>Logo link<input type="url" name="logo_url" value="${esc(l.logo_url || '')}"></label><label>Video link<input type="url" name="video_url" value="${esc(l.video_url || '')}"></label></div>
      <div><div class="lbl-line"><label for="ph">Picture links</label><span class="muted">One per line</span></div><textarea id="ph" name="photos">${esc(l.photosText || '')}</textarea></div>
      <div><div class="lbl-line"><label for="lk">Links (work, presentations, brochures)</label><span class="muted">One per line: Title | https://link</span></div><textarea id="lk" name="links">${esc(l.linksText || '')}</textarea></div>
      <label>Team note (only you see it)<textarea name="note">${esc(l.note || '')}</textarea></label>
      <div class="row"><button class="btn">Save</button>${isNew ? '' : '<button type="button" class="btn danger" id="del">Delete</button>'}</div></form></div>`);
  $('#ty').addEventListener('change', e => { $('#typeFields').innerHTML = typeFields(e.target.value); });
  $('#lf').addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { const b = formData(e.target);
    if (isNew) { const r = await api('/api/admin/directory', { body: b }); CR.go('admin-directory/' + r.id); } else await api('/api/admin/directory/item/' + id, { method: 'PUT', body: b }); }, 'Saved.'); });
  const del = $('#del'); if (del) del.addEventListener('click', () => { if (confirm('Delete this listing and its reviews?')) act(del, async () => { await api('/api/admin/directory/item/' + id, { method: 'DELETE' }); CR.go('admin-directory'); }); });
}
})();
