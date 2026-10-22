// SEO screens (owner only): SEO plan, Topic map, Article map, Article ideas. Ported from psyrenne's showSeoPlan, showSeoTree,
// showArticleMap, and Article ideas, for one site.
(function () {
const { api, esc, act, table, opts, route, onView, formData } = CR;
const $ = CR.$;
const n = v => v == null ? '' : Number(v).toLocaleString('en-US');
let BANDS = null;
const bandOf = score => { if (!BANDS) return null; if (score == null) return BANDS.none; return BANDS.bands.find(b => score >= b.min) || BANDS.bands[BANDS.bands.length - 1]; };
const chip = a => { const b = bandOf(a ? a.score : null); return `<span class="band" style="background:${esc(b.color)}" title="${esc(b.label)}"></span>${a ? `<a href="${esc(a.url || a.edit || '#')}" target="_blank" rel="noopener">${esc(a.title)}</a> <span class="small muted">${a.score}% · ${a.status === 'publish' ? 'live' : esc(a.status || '')}</span>` : `<span class="small muted">${esc(b.label)}</span>`}`; };
const head = (title, extra = '') => `<div class="owner-only" style="padding:4px"><div class="tabs">${[['seo', 'SEO plan'], ['seotree', 'Topic map'], ['articlemap', 'Article map'], ['ideas', 'Article ideas']].map(([k, t]) => `<a href="#${k}" class="${location.hash.slice(1).split('/')[0] === k ? 'on' : ''}">${t}</a>`).join('')}</div><h1>${esc(title)} <span class="owner-tag">Admin</span></h1>${extra}`;
const readFile = file => new Promise((ok, no) => { const r = new FileReader(); r.onerror = () => no(new Error('Couldn’t read that file.'));
  if (/\.xlsx?$/i.test(file.name)) { r.onload = () => ok({ name: file.name, b64: String(r.result).split(',')[1] }); r.readAsDataURL(file); } else { r.onload = () => ok({ name: file.name, text: r.result }); r.readAsText(file); } });

// ---------- SEO plan ----------
route('seo', async (tab) => {
  const [d, sem] = await Promise.all([api('/api/seo'), api('/api/seo/semrush')]); BANDS = await api('/api/seo/bands');
  CR.view(head('SEO plan', `<p class="small muted">${d.articles.total} articles from ${esc(d.domain)} (${d.articles.published} live)${d.articles.at ? ', last sent ' + esc(CR.when(d.articles.at)) : ', none sent yet. WordPress sends them through the signed endpoint (see the notes)'}.</p>`) + `
    <details class="panel"${d.terms.length ? '' : ' open'}><summary><strong>Add search terms</strong></summary>
      <form id="up" class="form" style="margin-top:8px"><div class="three"><div><label for="uf">Semrush or Search Console export (CSV or Excel)</label><input id="uf" type="file" name="file" accept=".csv,.tsv,.txt,.xlsx,.xls" required></div>
        <div><label for="uw">Whose terms</label><select id="uw" name="whose">${opts([['competitor', 'A competitor’s'], ['research', 'Keyword research'], ['mine', 'Ours (' + d.domain + ')']], 'mine')}</select></div>
        <div><label for="uc">Competitor’s site</label><input id="uc" type="text" name="competitor" placeholder="example.org"></div></div><div><button class="btn">Upload</button></div></form>
      <hr><form id="sem" class="form"><p class="small">${sem.connected ? `Semrush is connected${sem.units != null ? ` (${n(sem.units)} API units left)` : ''}.` : esc(sem.why)}</p>
        <div class="three"><div><label for="sm">Import</label><select id="sm" name="mode">${opts([['competitor', 'A competitor’s rankings'], ['research', 'Keyword research'], ['mine', 'Our rankings']], 'mine')}</select></div>
          <div><label for="st">Site or keyword</label><input id="st" type="text" name="target"></div><div><label for="sl">How many rows</label><input id="sl" type="number" name="limit" value="100"></div></div>
        <div><button class="btn alt"${sem.connected ? '' : ' disabled'}>Import from Semrush</button></div></form></details>
    <div class="tabs"><a href="#seo" class="${tab ? '' : 'on'}">Plan</a><a href="#seo/terms" class="${tab === 'terms' ? 'on' : ''}">All terms (${d.terms.length})</a><a href="#seo/bands" class="${tab === 'bands' ? 'on' : ''}">Coverage colors</a></div>
    <div id="seoBody"><p class="muted">Loading…</p></div></div>`);
  $('#up').addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { const f = e.target.elements.file.files[0]; if (!f) throw new Error('Choose a file.');
    const r = await api('/api/seo/upload', { body: { ...(await readFile(f)), whose: e.target.elements.whose.value, competitor: e.target.elements.competitor.value } });
    alert(`${n(r.rows)} terms read: ${n(r.added)} new, ${n(r.updated)} updated, ${n(r.offtopic)} set aside as off-topic.`); CR.render(); }); });
  $('#sem').addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { const r = await api('/api/seo/semrush', { body: formData(e.target) }); alert(r.note || `${n(r.rows)} terms imported (${n(r.used)} API units).`); CR.render(); }); });
  const body = $('#seoBody');
  if (tab === 'bands') {
    body.innerHTML = `<form id="bf" class="form card"><p class="small muted">How well the best-matching article covers each term (a word-match score, not AI). Lowest score for each color:</p>
      ${BANDS.bands.map((b, i) => `<div class="three"><div><label>Score from</label><input type="number" name="min${i}" value="${b.min}"></div><div><label>Color</label><input type="color" name="color${i}" value="${esc(b.color)}"></div><div><label>Label</label><input type="text" name="label${i}" value="${esc(b.label)}"></div></div>`).join('')}
      <div class="row"><button class="btn">Save colors</button><button type="button" class="btn alt" id="reset">Back to the defaults</button></div></form>`;
    $('#bf').addEventListener('submit', e => { e.preventDefault(); const f = formData(e.target); act(e.submitter, () => api('/api/seo/bands', { method: 'PUT', body: { bands: BANDS.bands.map((_, i) => ({ min: f['min' + i], color: f['color' + i], label: f['label' + i] })), none: BANDS.none } }), 'Saved.'); });
    $('#reset').addEventListener('click', e => act(e.target, async () => { await api('/api/seo/bands', { method: 'PUT', body: { reset: true } }); CR.render(); }));
    return;
  }
  if (tab === 'terms') {
    body.innerHTML = `<div class="filters"><input type="search" id="tq" placeholder="Search terms" aria-label="Search terms"><select id="ts" aria-label="Status"><option value="">Every status</option>${opts(CR.az(Object.entries(d.statuses)))}</select></div>
      <div class="row" style="margin-bottom:8px"><button class="btn small" data-do="search">Find matching articles</button><button class="btn alt small" data-do="idea">New article idea</button><button class="btn alt small" data-do="skip">Skip</button><button class="btn alt small" data-do="new">Back to New</button></div>
      <div id="tl"></div><div id="matches"></div>`;
    const draw = () => { const q = $('#tq').value, s = $('#ts').value;
      $('#tl').innerHTML = table(['', 'Term', 'Source', 'Position', 'Clicks', 'Impressions', 'Searches/mo', 'Status'], d.terms.filter(t => CR.matches(q, t.term + ' ' + t.origin) && (!s || t.status === s)).slice(0, 1500).map(t =>
        `<tr><td><input type="checkbox" value="${t.id}" aria-label="Pick ${esc(t.term)}"></td><td>${esc(t.term)}</td><td>${esc(t.origin)}</td><td>${t.position ?? ''}</td><td>${n(t.clicks)}</td><td>${n(t.impressions)}</td><td>${n(t.volume)}</td><td>${esc(d.statuses[t.status] || t.status)}${t.note ? ` <span class="small muted">(${esc(t.note)})</span>` : ''}</td></tr>`), { empty: 'No terms yet. Upload an export above.' }); };
    $('#tq').addEventListener('input', draw); $('#ts').addEventListener('input', draw); draw();
    onView('click', e => { const b = e.target.closest('[data-do]'); if (!b) return; const ids = CR.$$('#tl input:checked').map(x => Number(x.value));
      act(b, async () => { if (!ids.length) throw new Error('Tick some terms first.');
        if (b.dataset.do === 'search') { const r = await api('/api/seo/search', { body: { ids } });
          $('#matches').innerHTML = `<div class="card"><h2>Closest articles for: ${esc(r.terms.join(', '))}</h2>${r.results.length ? r.results.map(a => `<p>${chip(a)} <button class="btn alt small" data-grow="${a.id}">Grow this article</button>${a.missing.length ? `<br><span class="small muted">Missing words: ${esc(a.missing.join(', '))}</span>` : ''}</p>`).join('') : '<p class="muted">No article covers these yet. Make it a new article idea.</p>'}</div>`; return; }
        await api('/api/seo/decide', { body: { ids, action: b.dataset.do } }); CR.render(); }); });
    onView('click', e => { const g = e.target.closest('[data-grow]'); if (!g) return; const ids = CR.$$('#tl input:checked').map(x => Number(x.value)); act(g, async () => { await api('/api/seo/decide', { body: { ids, action: 'grow', articleId: Number(g.dataset.grow) } }); alert('Added to Article ideas.'); CR.render(); }); });
    return;
  }
  const p = await api('/api/seo/plan');
  const row = (t, kid) => `<tr${kid ? ' class="kid"' : ''}><td>${kid ? '<span class="muted">↳</span> ' : `<button class="btn alt small" data-star="${esc(t.key)}" data-on="${t.target ? 1 : 0}" aria-label="${t.target ? 'Unstar' : 'Star'} ${esc(t.term)}">${t.target ? '★' : '☆'}</button> `}<strong>${esc(t.term)}</strong>${t.want ? ' <span class="tag">Not ranking yet</span>' : ''}</td>
    <td data-sort="${t.volume || 0}">${n(t.volume)}</td><td data-sort="${t.ours ?? 999}">${t.ours ?? ''}</td><td data-sort="${t.clicks || 0}">${n(t.clicks)}</td><td>${chip(t.article)}${t.article ? ` <button class="btn alt small" data-nm="${esc(t.key)}" data-a="${t.article.id}" title="Not a match">✕</button>` : ''}</td>
    <td><button class="btn small" data-req="${esc(t.key)}">Request a draft</button> <button class="btn alt small" data-dis="${esc(t.key)}">Dismiss</button></td></tr>`;
  body.innerHTML = `${p.requested.length ? `<div class="card"><h2>Drafts requested</h2>${p.requested.map(r => `<p><strong>${esc(r.term)}</strong> · ${esc((r.requested || {}).title || '')} <span class="tag">${esc((r.requested || {}).status || '')}</span>${r.children && r.children.length ? `<br><span class="small muted">Also covers: ${esc(r.children.map(c => c.term).join(', '))}</span>` : ''}</p>`).join('')}</div>` : ''}
    <p class="small muted">Main terms with the terms under them. ★ marks the ones to go after first. ${BANDS.bands.map(b => `<span class="band" style="background:${esc(b.color)}"></span>${esc(b.label)} (${b.min}+)`).join(' ')} <span class="band" style="background:${esc(BANDS.none.color)}"></span>${esc(BANDS.none.label)}</p>
    ${p.groups.length ? table(['Term', 'Searches/mo', 'Our position', 'Clicks', 'Best article', ''], p.groups.flatMap(g => [row(g, false), ...(g.children || []).slice(0, 40).map(c => row(c, true))])) : '<p class="empty">No terms in the plan yet. Upload a Semrush or Search Console export above.</p>'}`;
  const all = new Map(p.groups.flatMap(g => [[g.key, g], ...(g.children || []).map(c => [c.key, c])]));
  onView('click', e => {
    const s = e.target.closest('[data-star]'); if (s) return act(s, async () => { await api('/api/seo/plan', { method: 'PUT', body: { key: s.dataset.star, target: s.dataset.on !== '1' } }); CR.render(); });
    const r = e.target.closest('[data-req]'); if (r) { const g = all.get(r.dataset.req), title = prompt('Working title for the article', g.term); if (title === null) return;
      return act(r, async () => { await api('/api/seo/plan/request', { body: { key: g.key, title, children: (g.children || []).map(c => c.term) } }); CR.render(); }); }
    const x = e.target.closest('[data-dis]'); if (x) return act(x, async () => { await api('/api/seo/plan/dismiss', { body: { key: x.dataset.dis } }); CR.render(); });
    const m = e.target.closest('[data-nm]'); if (m) act(m, async () => { await api('/api/seo/plan/not-match', { body: { key: m.dataset.nm, article_id: Number(m.dataset.a) } }); CR.render(); });
  });
}, { owner: true });

// ---------- Topic map (AI) ----------
route('seotree', async () => {
  const [st, p] = await Promise.all([api('/api/seo/plan/topics'), api('/api/seo/plan?tree=1&by=topic')]); BANDS = await api('/api/seo/bands');
  const kids = new Map(); for (const t of p.tree) { const k = t.parent || ''; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(t); }
  for (const l of kids.values()) l.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  const heads = p.tree.filter(t => t.level === 1 || t.level === 2).sort((a, b) => a.term.localeCompare(b.term));
  const draw = (k, depth) => (kids.get(k) || []).map(t => `<li><div class="node"><span class="tag">${t.level === 1 ? 'Pillar' : t.level === 2 ? 'Cluster' : t.level === 3 ? 'Detail' : 'Not mapped'}</span><span class="grow lvl${Math.min(3, depth + 1)}">${esc(t.term)} <span class="small muted">${n(t.volume)}</span></span>
    <span class="small">${chip(t.article)}</span><select data-move="${esc(t.key)}" aria-label="Move ${esc(t.term)}" style="width:auto;max-width:200px"><option value="">Move under…</option><option value="__top">Make it a pillar</option>${opts(heads.filter(h => h.key !== t.key).map(h => [h.key, h.term]))}</select></div>
    ${depth < 6 && kids.has(t.key) ? `<ul class="tree">${draw(t.key, depth + 1)}</ul>` : ''}</li>`).join('');
  CR.view(head('Topic map', `<p class="small muted">Claude sorts your search terms into pillars (like an H1), clusters (H2), and details (H3) by topic and intent. Your own moves are kept when it rebuilds.</p>`) + `
    <div class="row"><button class="btn" id="build"${st.running ? ' disabled' : ''}>${st.running ? 'Building…' : st.mapped ? 'Rebuild the topic map' : 'Build the topic map'}</button>
      <span class="small muted">${!st.ai ? 'AI isn’t set up yet: add ANTHROPIC_API_KEY to the server’s environment.' : st.running ? `${esc(st.step)} (${st.done} of ${st.total})` : st.error ? 'Last try: ' + esc(st.error) : st.mapped ? `${n(st.mapped)} terms mapped${st.at ? ' on ' + esc(CR.when(st.at)) : ''}.` : ''}</span></div>
    <div style="margin-top:12px">${p.tree.length ? `<ul class="tree" style="padding-left:0">${draw('', 0)}</ul>` : '<p class="empty">No terms yet. Upload search terms on the SEO plan first.</p>'}</div></div>`);
  $('#build').addEventListener('click', e => act(e.target, async () => { await api('/api/seo/plan/topics', { body: {} }); setTimeout(() => { if (location.hash === '#seotree') CR.render(); }, 4000); CR.render(); }));
  if (st.running) setTimeout(() => { if (location.hash === '#seotree') CR.render(); }, 5000);
  onView('change', e => { const s = e.target.closest('[data-move]'); if (!s || !s.value) return; act(s, async () => { await api('/api/seo/plan/topics', { method: 'PUT', body: { key: s.dataset.move, under: s.value === '__top' ? '' : s.value } }); CR.render(); }); });
}, { owner: true });

// ---------- Article map ----------
route('articlemap', async () => {
  const d = await api('/api/articlemap'), arts = new Map(d.articles.map(a => [a.id, a]));
  const kids = new Map(); for (const x of d.nodes) { const k = x.parent || 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(x); }
  const placed = new Set(d.nodes.filter(x => x.post_id).map(x => x.post_id)), loose = d.articles.filter(a => !placed.has(a.id));
  const COLORS = { red: '#c93a3a', yellow: '#c99a00', green: '#1f8a4c', blue: '#0077A8' };
  const card = x => { const a = x.post_id ? arts.get(x.post_id) : null, title = a ? a.title : x.title || '(article no longer on the site)';
    return `<div class="node ${x.kind || (x.post_id ? '' : 'missing')}" draggable="true" data-node="${x.id}">
      ${x.cov ? `<span class="band" style="background:${COLORS[x.cov.band]}" title="${esc(x.cov.tip)}"></span>` : ''}
      <span class="grow">${x.kind === 'header' ? esc(title.toUpperCase()) : a ? `<a href="${esc(a.url || a.edit)}" target="_blank" rel="noopener">${esc(title)}</a> ${a.status !== 'publish' ? `<span class="tag draft">${esc(a.status)}</span>` : ''}` : `${esc(title)} ${x.kind ? '' : '<span class="tag">Missing</span>'}`}
      ${x.cov ? `<span class="small muted"> ${x.cov.n} under it${x.cov.missing ? `, ${x.cov.missing} missing` : ''}</span>` : ''}${x.idea ? ` <span class="tag">${esc(x.idea.statusName)}</span>` : ''}</span>
      <button class="btn alt small" data-nudge="up" data-id="${x.id}" aria-label="Move up">▲</button><button class="btn alt small" data-nudge="down" data-id="${x.id}" aria-label="Move down">▼</button>
      ${x.kind === 'header' ? '' : `<button class="btn alt small" data-indent="in" data-id="${x.id}" title="Tuck under the card above">→</button><button class="btn alt small" data-indent="out" data-id="${x.id}" title="Move out a level">←</button>`}
      ${!x.post_id && !x.kind && !x.idea ? `<button class="btn small" data-draft="${x.id}">Request a draft</button>` : ''}
      ${x.kind === 'subheader' && x.custom_order ? `<button class="btn alt small" data-az="${x.id}">A to Z</button>` : ''}
      ${!x.post_id ? `<button class="btn alt small" data-rename="${x.id}">Rename</button>` : ''}<button class="btn alt small" data-unplace="${x.id}">${x.post_id ? 'Take off' : 'Delete'}</button></div>`; };
  const tree = p => (kids.get(p) || []).map(x => `<li>${card(x)}${kids.has(x.id) ? `<ul class="tree">${tree(x.id)}</ul>` : ''}</li>`).join('');
  const L = d.legend;
  CR.view(head('Article map', `<p class="small muted">Three levels: header, subheader, article. Drag an article onto a card to put it inside, or use the arrows. Colors: suggested ${esc(L.main.ideal)} articles under a main topic (red ${esc(L.main.red)}, yellow ${esc(L.main.yellow)}, green ${esc(L.main.green)}, blue ${esc(L.main.blue)}), ${esc(L.sub.ideal)} under a smaller group.</p>`) + `
    ${d.deep ? `<p class="msg warn">${d.deep} cards sit deeper than three levels. <button class="btn small" id="fix">Fix levels</button></p>` : ''}
    <form id="add" class="row panel"><label for="at">Add</label><select name="kind" style="width:auto">${opts([['header', 'Header'], ['subheader', 'Subheader'], ['', 'Missing article']])}</select>
      <input id="at" type="text" name="title" placeholder="Title" style="max-width:320px"><select name="parent" style="width:auto;max-width:260px" aria-label="Under"><option value="">At the top level</option>${opts(d.nodes.filter(x => x.kind || (!x.post_id && x.level < 3) || x.level < 3).map(x => [x.id, (x.post_id ? (arts.get(x.post_id) || {}).title : x.title) || '?']))}</select><button class="btn small">Add</button>
      <button type="button" class="btn alt small" id="match">Match articles to headers</button></form>
    <div style="display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:14px" class="am-grid">
      <div><ul class="tree" style="padding-left:0" id="amTree">${tree(0) || '<li class="empty">Nothing on the map yet. Add a header, then drag articles under it.</li>'}</ul></div>
      <div><h2>Not on the map (${loose.length})</h2><input type="search" id="lq" placeholder="Search" aria-label="Search articles not on the map"><div id="loose"></div></div></div></div>`);
  const drawLoose = () => { const q = $('#lq').value; $('#loose').innerHTML = loose.filter(a => CR.matches(q, a.title)).map(a => `<div class="node" draggable="true" data-post="${a.id}"><span class="grow">${esc(a.title)}</span>${a.status !== 'publish' ? `<span class="tag draft">${esc(a.status)}</span>` : ''}</div>`).join('') || `<p class="small muted">${d.articles.length ? 'Every article is on the map.' : 'No articles yet. WordPress sends them through the signed endpoint.'}</p>`; };
  $('#lq').addEventListener('input', drawLoose); drawLoose();
  const post = (url, body) => act(null, async () => { const r = await api('/api/articlemap' + url, { body }); if (r.note) alert(r.note); CR.render(); });
  $('#add').addEventListener('submit', e => { e.preventDefault(); const f = formData(e.target); act(e.submitter, async () => { await api('/api/articlemap/missing', { body: { title: f.title, kind: f.kind || null, parent: Number(f.parent) || 0 } }); CR.render(); }); });
  $('#match').addEventListener('click', e => act(e.target, async () => { const r = await api('/api/articlemap/match', { body: {} }); alert(r.total ? `${r.total} articles placed under ${r.placed.length} headers.` : 'No unplaced article matched a header name.'); CR.render(); }));
  const fix = $('#fix'); if (fix) fix.addEventListener('click', () => act(fix, async () => { const r = await api('/api/articlemap/fix-levels'); if (confirm(`${r.moves.length} cards move up a level. Go ahead?`)) { await api('/api/articlemap/fix-levels', { body: {} }); CR.render(); } }));
  onView('click', e => { const b = e.target.closest('button'); if (!b || !b.closest('.node')) return; const id = Number(b.dataset.id || b.dataset.draft || b.dataset.az || b.dataset.rename || b.dataset.unplace);
    if (b.dataset.nudge) post('/nudge', { node: id, dir: b.dataset.nudge });
    else if (b.dataset.indent) post('/indent', { node: id, dir: b.dataset.indent });
    else if (b.dataset.az) post('/subsort/' + id, {});
    else if (b.dataset.unplace) { if (confirm('Take this card off the map?')) post('/unplace', { node: id }); }
    else if (b.dataset.rename) { const t = prompt('New title', (d.nodes.find(x => x.id === id) || {}).title || ''); if (t) act(b, async () => { await api('/api/articlemap/missing/' + id, { method: 'PUT', body: { title: t } }); CR.render(); }); }
    else if (b.dataset.draft) { const x = d.nodes.find(y => y.id === id), title = prompt('Working title', x.title); if (title === null) return; const keyphrase = prompt('Keyphrase (optional)', '') || ''; post(`/missing/${id}/draft`, { title, keyphrase }); } });
  // Drag and drop: top third of a card = before it, bottom third = after, middle = inside.
  let drag = null;
  onView('dragstart', e => { const el = e.target.closest('[data-node],[data-post]'); if (!el) return; drag = el.dataset.node ? { node: Number(el.dataset.node) } : { post_id: Number(el.dataset.post) }; e.dataTransfer.effectAllowed = 'move'; });
  const zone = (el, e) => { const r = el.getBoundingClientRect(), y = (e.clientY - r.top) / r.height; return y < .3 ? 'before' : y > .7 ? 'after' : 'in'; };
  onView('dragover', e => { const el = e.target.closest('#amTree [data-node]'); CR.$$('.drop-before,.drop-after,.drop-in').forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-in')); if (!el || !drag) return; e.preventDefault(); el.classList.add('drop-' + zone(el, e)); });
  onView('drop', e => { const el = e.target.closest('#amTree [data-node]'); if (!el || !drag) return; e.preventDefault(); post('/move', { ...drag, target: Number(el.dataset.node), where: zone(el, e) }); drag = null; });
}, { owner: true });

// ---------- Article ideas ----------
route('ideas', async () => {
  const d = await api('/api/ideas');
  CR.view(head('Article ideas', '<p class="small muted">Draft requests from the SEO plan, the search terms, and the Article map, plus your own ideas. WordPress or a writer picks up the waiting ones through the signed endpoint.</p>') + `
    <form id="nf" class="row panel"><label for="it">New idea</label><input id="it" type="text" name="topic" placeholder="Topic or working title" style="max-width:360px"><input type="text" name="keyphrase" placeholder="Keyphrase (optional)" style="max-width:220px" aria-label="Keyphrase"><button class="btn small">Add</button></form>
    <div class="filters"><select id="fs" aria-label="Status"><option value="">Every status</option>${opts(CR.az(Object.entries(d.statuses)))}</select></div><div id="list"></div></div>`);
  const draw = () => { const s = $('#fs').value;
    $('#list').innerHTML = table(['Added', 'Topic', 'Keyphrase', 'From', 'Status', ''], d.ideas.filter(i => !s || i.status === s).map(i => `<tr><td data-sort="${esc(i.created_at)}">${esc(CR.day(i.created_at))}</td>
      <td><strong>${esc(i.topic)}</strong>${i.note ? `<br><span class="small muted">${esc(i.note)}</span>` : ''}${i.edit || i.url ? `<br><a class="small" href="${esc(i.edit || i.url)}" target="_blank" rel="noopener">Open the article</a>` : ''}</td><td>${esc(i.keyphrase || '')}</td><td>${esc(i.source)}</td>
      <td><select data-st="${i.id}" aria-label="Status">${opts(Object.entries(d.statuses), i.status)}</select></td><td><button class="btn alt small" data-del="${i.id}">Delete</button></td></tr>`), { empty: 'No ideas yet.' }); };
  $('#fs').addEventListener('input', draw); draw();
  $('#nf').addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { await api('/api/ideas', { body: formData(e.target) }); CR.render(); }); });
  onView('change', e => { const s = e.target.closest('[data-st]'); if (s) api('/api/ideas/' + s.dataset.st, { method: 'PUT', body: { status: s.value } }).catch(err => alert(err.message)); });
  onView('click', e => { const b = e.target.closest('[data-del]'); if (b && confirm('Delete this idea?')) act(b, async () => { await api('/api/ideas/' + b.dataset.del, { method: 'DELETE' }); CR.render(); }); });
}, { owner: true });
})();
