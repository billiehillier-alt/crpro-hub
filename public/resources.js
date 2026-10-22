// Resources library: students browse and search by category; the owner adds and edits.
(function () {
const { api, esc, act, table, opts, route, formData } = CR;
const $ = CR.$;
route('resources', async () => {
  const d = await api('/api/resources');
  CR.view(`<h1>Resources</h1><p class="muted">Conferences, webinars, universities, organizations, regulations, certifications, and more for clinical research.</p>
    <div class="filters"><input type="search" id="q" placeholder="Search (every word counts)" aria-label="Search resources" style="min-width:260px">
      <select id="cat" aria-label="Category"><option value="">Every category</option>${opts(d.categories)}</select>
      <select id="cost" aria-label="Cost"><option value="">Free and paid</option>${opts(CR.az(Object.entries(d.costs)))}</select></div><div id="list"></div>
    ${CR.me.owner ? '<p><a class="btn alt small owner-only" href="#admin-resources">Edit resources</a></p>' : ''}`);
  const draw = () => { const q = $('#q').value, c = $('#cat').value, k = $('#cost').value;
    const list = d.resources.filter(r => r.status === 'published' && (!c || r.category === c) && (!k || r.cost === k) && CR.matches(q, [r.title, r.summary, r.source, r.location, r.tags, r.category, r.dates].join(' ')));
    const groups = d.categories.map(cat => [cat, list.filter(r => r.category === cat)]).filter(([, l]) => l.length);
    $('#list').innerHTML = groups.length ? groups.map(([cat, l]) => `<h2 style="margin-top:14px">${esc(cat)}</h2><div class="cards">${l.map(r => `<div class="card"><h3>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}</h3>
      <p class="row small">${r.cost ? `<span class="tag ${r.cost === 'free' ? 'free' : 'paid'}">${esc(d.costs[r.cost])}</span>` : ''}${r.dates ? `<span>${esc(r.dates)}</span>` : ''}${r.location ? `<span class="muted">${esc(r.location)}</span>` : ''}</p>
      ${r.summary ? `<p class="small">${esc(r.summary)}</p>` : ''}${r.source ? `<p class="small muted">From ${esc(r.source)}</p>` : ''}</div>`).join('')}</div>`).join('')
      : `<p class="empty">${d.resources.length ? 'Nothing matches. Try fewer words or another filter.' : 'No resources yet.'}</p>`; };
  ['q', 'cat', 'cost'].forEach(x => $('#' + x).addEventListener('input', draw)); draw();
});
route('admin-resources', async (id) => {
  const d = await api('/api/resources'), r = id && id !== 'new' ? d.resources.find(x => String(x.id) === id) : null, f = r || { status: 'published', category: d.categories[0] };
  CR.view(`<div class="owner-only" style="padding:4px"><h1>Resources <span class="owner-tag">Admin</span></h1>
    <form id="rf" class="form card"><h2>${r ? 'Edit: ' + esc(r.title) : 'New resource'}</h2>
      <div class="three"><label>Category<select name="category">${opts(d.categories, f.category)}</select></label><label>Status<select name="status">${opts([['draft', 'Draft'], ['published', 'Published']], f.status)}</select></label><label>Cost<select name="cost"><option value="">Not set</option>${opts(CR.az(Object.entries(d.costs)), f.cost)}</select></label></div>
      <label>Title<input type="text" name="title" value="${esc(f.title || '')}" required></label><label>Link<input type="url" name="url" value="${esc(f.url || '')}" placeholder="https://"></label>
      <label>Short description<textarea name="summary">${esc(f.summary || '')}</textarea></label>
      <div class="three"><label>From (organization)<input type="text" name="source" value="${esc(f.source || '')}"></label><label>Where<input type="text" name="location" value="${esc(f.location || '')}" placeholder="Online, or a city"></label><label>When<input type="text" name="dates" value="${esc(f.dates || '')}" placeholder="Every spring, or a date"></label></div>
      <div class="three"><label>Search words<input type="text" name="tags" value="${esc(f.tags || '')}"></label><label>Last checked<input type="date" name="checked_on" value="${esc(f.checked_on || '')}"></label><label>Order<input type="number" name="sort" value="${f.sort || 0}"></label></div>
      <div class="row"><button class="btn">${r ? 'Save' : 'Add resource'}</button>${r ? '<a class="btn alt" href="#admin-resources">New instead</a> <button type="button" class="btn danger" id="del">Delete</button>' : ''}</div></form>
    <h2 style="margin-top:14px">All resources</h2>${table(['Title', 'Category', 'Status', 'Cost', 'Last checked'], d.resources.map(x => `<tr><td><a href="#admin-resources/${x.id}">${esc(x.title)}</a></td><td>${esc(x.category)}</td><td>${esc(x.status)}</td><td>${esc(d.costs[x.cost] || '')}</td><td>${esc(x.checked_on || '')}</td></tr>`), { empty: 'No resources yet.' })}</div>`);
  $('#rf').addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { await api('/api/resources/admin' + (r ? '/' + r.id : ''), { method: r ? 'PUT' : 'POST', body: formData(e.target) }); CR.go('admin-resources'); }); });
  const del = $('#del'); if (del) del.addEventListener('click', () => { if (confirm('Delete this resource?')) act(del, async () => { await api('/api/resources/admin/' + r.id, { method: 'DELETE' }); CR.go('admin-resources'); }); });
}, { owner: true });
})();
