// Calendar screens: a month grid and a list (upcoming first), A-to-Z filters, smart search, one event's details (add to
// calendar, remind me), suggest an event, and the owner's editor with CSV import. The month grid follows psyrenne's
// calendar drawing (event chips in day boxes).
(function () {
const { api, esc, act, table, opts, route, onView, formData } = CR;
const $ = CR.$;
const pad = n => String(n).padStart(2, '0');
const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (day, n) => { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() + n); return localDay(d); };
// The days an event covers, in the viewer's own time zone.
const daysOf = e => { const s = e.all_day ? e.starts_at : localDay(new Date(e.starts_at)), end = e.all_day ? (e.ends_at || e.starts_at) : localDay(new Date(new Date(e.ends_at || e.starts_at).getTime() - 60e3)), out = [];
  for (let d = s, i = 0; d <= end && i < 60; d = addDays(d, 1), i++) out.push(d); return out.length ? out : [s]; };
const whenText = e => e.all_day ? (e.starts_at === (e.ends_at || e.starts_at) ? CR.day(e.starts_at) : `${CR.day(e.starts_at)} to ${CR.day(e.ends_at)}`)
  : `${CR.when(e.starts_at)}${e.ends_at ? ' to ' + new Date(e.ends_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''}`;
const where = (e, formats) => [formats[e.format] || '', [e.city, e.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
let state = { view: 'list', month: localDay(new Date()).slice(0, 7) };
try { state.view = localStorage.getItem('crp-cal-view') || 'list'; } catch {}

route('calendar', async (sub) => {
  if (sub === 'suggest') return suggest();
  const d = await api('/api/calendar');
  const countries = CR.az([...new Set(d.events.map(e => e.country).filter(Boolean))]);
  CR.view(`<div class="spread"><h1>Calendar</h1><div class="row"><a class="btn alt" href="#calendar/suggest">Suggest an event</a>${CR.me.owner ? '<a class="btn alt owner-only" href="#admin-calendar">Edit the calendar</a>' : ''}</div></div>
    <p class="small muted">Conferences, webinars, workshops, trainings, and deadlines in clinical research, plus CR Pro’s own webinars. Times are in your time zone (${esc(CR.tz)}).
      Subscribe in your calendar app: <a href="${esc(d.feed)}">${esc(d.feed)}</a></p>
    <div class="filters"><input type="search" id="q" placeholder="Search (every word counts)" aria-label="Search events" style="min-width:240px">
      <select id="ty" aria-label="Type"><option value="">Every type</option>${opts(d.types)}</select>
      <select id="fo" aria-label="Format"><option value="">In person and online</option>${opts(CR.az(Object.entries(d.formats)))}</select>
      <select id="co" aria-label="Country"><option value="">Every country</option>${opts(countries)}</select>
      <select id="cost" aria-label="Cost"><option value="">Free and paid</option>${opts([['free', 'Free'], ['paid', 'Paid']])}</select></div>
    <div class="tabs"><a href="#calendar" data-v="list" class="${state.view === 'list' ? 'on' : ''}">List</a><a href="#calendar" data-v="month" class="${state.view === 'month' ? 'on' : ''}">Month</a></div>
    <div id="cal"></div><div id="detail"></div>`);
  const filtered = () => { const q = $('#q').value, ty = $('#ty').value, fo = $('#fo').value, co = $('#co').value, cost = $('#cost').value;
    return d.events.filter(e => (!ty || e.type === ty) && (!fo || e.format === fo) && (!co || e.country === co) && (!cost || e.cost === cost) && CR.matches(q, [e.title, e.organizer, e.type, e.description, e.city, e.country].join(' '))); };
  const drawList = list => { const now = Date.now(), endMs = e => e.all_day ? new Date((e.ends_at || e.starts_at) + 'T23:59:59').getTime() : new Date(e.ends_at || e.starts_at).getTime();
    const up = list.filter(e => endMs(e) >= now), past = list.filter(e => endMs(e) < now).reverse().slice(0, 30);
    const row = e => `<tr><td data-sort="${esc(e.starts_at)}">${esc(whenText(e))}</td><td><a href="#calendar" data-ev="${esc(e.id)}">${esc(e.title)}</a>${e.status === 'canceled' ? ' <span class="tag">Canceled</span>' : ''}</td><td>${esc(e.type)}</td><td>${esc(e.organizer || '')}</td><td>${esc(where(e, d.formats))}</td><td>${e.cost === 'free' ? 'Free' : e.cost === 'paid' ? 'Paid' : ''}</td></tr>`;
    return `${table(['When', 'Event', 'Type', 'Organizer', 'Where', 'Cost'], up.map(row), { empty: d.events.length ? 'Nothing coming up matches.' : 'No events yet.' })}${past.length ? `<details style="margin-top:10px"><summary>Past events</summary>${table(['When', 'Event', 'Type', 'Organizer', 'Where', 'Cost'], past.map(row))}</details>` : ''}`; };
  const drawMonth = list => { const [y, m] = state.month.split('-').map(Number), first = new Date(y, m - 1, 1), start = addDays(localDay(first), -first.getDay()), today = localDay(new Date());
    const byDay = new Map(); for (const e of list) for (const day of daysOf(e)) { if (!byDay.has(day)) byDay.set(day, []); byDay.get(day).push(e); }
    const cells = []; for (let i = 0; i < 42; i++) { const day = addDays(start, i), evs = byDay.get(day) || [];
      cells.push(`<div class="day${day.slice(0, 7) !== state.month ? ' other' : ''}${day === today ? ' today' : ''}"><div class="num">${Number(day.slice(8))}</div>${evs.slice(0, 4).map(e => `<a href="#calendar" class="chip${e.source === 'webinar' ? ' ours' : ''}" data-ev="${esc(e.id)}" title="${esc(e.title)}">${e.all_day ? '' : esc(new Date(e.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) + ' '}${esc(e.title)}</a>`).join('')}${evs.length > 4 ? `<span class="small muted">+${evs.length - 4} more</span>` : ''}</div>`); }
    return `<div class="spread"><button class="btn alt small" data-mo="-1">← Previous</button><h2>${first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h2><button class="btn alt small" data-mo="1">Next →</button></div>
      <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(x => `<div class="dow">${x}</div>`).join('')}${cells.join('')}</div><p class="small muted cal-legend"><span class="chip ours">CR Pro webinars</span><span class="chip">Industry events</span></p>`; };
  const draw = () => { const list = filtered(); $('#cal').innerHTML = state.view === 'month' ? drawMonth(list) : drawList(list); };
  ['q', 'ty', 'fo', 'co', 'cost'].forEach(x => $('#' + x).addEventListener('input', draw)); draw();
  const show = id => { const e = d.events.find(x => x.id === id); if (!e) return;
    $('#detail').innerHTML = `<div class="card" style="margin-top:12px" id="evCard"><div class="spread"><h2>${esc(e.title)}</h2><button class="btn alt small" data-close>Close</button></div>
      <p><strong>${esc(whenText(e))}</strong>${e.timezone && !e.all_day && e.timezone !== CR.tz ? ` <span class="small muted">(set in ${esc(e.timezone)})</span>` : ''}</p>
      <p class="row small"><span class="tag">${esc(e.type)}</span>${e.organizer ? `<span>${esc(e.organizer)}</span>` : ''}${where(e, d.formats) ? `<span class="muted">${esc(where(e, d.formats))}</span>` : ''}${e.cost ? `<span class="tag ${e.cost}">${e.cost === 'free' ? 'Free' : 'Paid'}</span>` : ''}${e.ce_credits != null ? `<span>${e.ce_credits} CE</span>` : ''}</p>
      ${e.description ? `<p>${esc(e.description).replace(/\n/g, '<br>')}</p>` : ''}${e.link ? `<p><a href="${esc(e.link)}" target="_blank" rel="noopener">Event page</a></p>` : ''}${e.source === 'webinar' ? '<p><a href="#webinars">Sign up on Webinars</a></p>' : ''}
      <p class="small">Add to: <a href="${esc(e.links.google)}" target="_blank" rel="noopener">Google</a> · <a href="${esc(e.links.outlook)}" target="_blank" rel="noopener">Outlook.com</a> · <a href="${esc(e.links.ics)}">Apple or other (.ics)</a></p>
      <form id="remind" class="row"><label for="rb">Remind me by email</label><select id="rb" name="before" style="width:auto">${opts([[60, '1 hour before'], [1440, '1 day before'], [10080, '1 week before']], 1440)}</select><button class="btn small">${e.reminded ? 'Change reminder' : 'Remind me'}</button>${e.reminded ? '<button type="button" class="btn alt small" id="unremind">Cancel reminder</button>' : ''}</form></div>`;
    $('#evCard').scrollIntoView({ block: 'nearest' });
    $('#remind').addEventListener('submit', ev => { ev.preventDefault(); act(ev.submitter, async () => { const r = await api(`/api/calendar/${e.id}/remind`, { body: formData(ev.target) }); e.reminded = true;
      if (!r.emailOn) alert('Your reminder is saved, but emails are off in My account. Turn them on to get it.'); }, 'Reminder set.'); });
    const un = $('#unremind'); if (un) un.addEventListener('click', () => act(un, async () => { await api(`/api/calendar/${e.id}/remind`, { method: 'DELETE' }); e.reminded = false; show(id); })); };
  onView('click', ev => {
    const a = ev.target.closest('[data-ev]'); if (a) { ev.preventDefault(); show(a.dataset.ev); return; }
    const v = ev.target.closest('[data-v]'); if (v) { ev.preventDefault(); state.view = v.dataset.v; try { localStorage.setItem('crp-cal-view', state.view); } catch {} CR.$$('.tabs a').forEach(x => x.classList.toggle('on', x === v)); draw(); return; }
    const mo = ev.target.closest('[data-mo]'); if (mo) { const [y, m] = state.month.split('-').map(Number), n = new Date(y, m - 1 + Number(mo.dataset.mo), 1); state.month = `${n.getFullYear()}-${pad(n.getMonth() + 1)}`; draw(); return; }
    if (ev.target.closest('[data-close]')) $('#detail').innerHTML = ''; });
});
const eventForm = (d, f, { suggest = false } = {}) => `<div class="three"><label>Title<input type="text" name="title" value="${esc(f.title || '')}" required></label><label>Type<select name="type">${opts(d.types.filter(t => t !== 'CR Pro webinar'), f.type)}</select></label><label>Organizer<input type="text" name="organizer" value="${esc(f.organizer || '')}"></label></div>
  <label class="check"><input type="checkbox" name="all_day" id="allDay" ${f.all_day ? 'checked' : ''}> All day (or several days)</label>
  <div class="three timed"><label>Starts<input type="datetime-local" name="start_local" value="${esc(f.start_local || '')}"></label><label>Ends<input type="datetime-local" name="end_local" value="${esc(f.end_local || '')}"></label><label>Time zone of these times<input type="text" name="timezone" value="${esc(f.timezone || CR.tz)}"></label></div>
  <div class="two dated"><label>First day<input type="date" name="start_date" value="${esc(f.start_date || '')}"></label><label>Last day<input type="date" name="end_date" value="${esc(f.end_date || '')}"></label></div>
  <div class="three"><label>Format<select name="format"><option value="">Not set</option>${opts(CR.az(Object.entries(d.formats)), f.format)}</select></label><label>City<input type="text" name="city" value="${esc(f.city || '')}"></label><label>Country<input type="text" name="country" value="${esc(f.country || '')}"></label></div>
  <div class="three"><label>Link<input type="url" name="link" value="${esc(f.link || '')}" placeholder="https://"></label><label>Cost<select name="cost"><option value="">Not set</option>${opts([['free', 'Free'], ['paid', 'Paid']], f.cost)}</select></label><label>CE credits offered<input type="number" step="0.1" name="ce_credits" value="${f.ce_credits ?? ''}"></label></div>
  <label>Short description<textarea name="description">${esc(f.description || '')}</textarea></label>
  ${suggest ? '' : `<label>Status<select name="status">${opts(Object.entries(d.statuses), f.status || 'published')}</select></label>`}`;
const toggleDates = form => { const all = form.elements.all_day.checked; $('.timed', form).style.display = all ? 'none' : ''; $('.dated', form).style.display = all ? '' : 'none'; };
async function suggest() {
  const d = await api('/api/calendar');
  CR.view(`<p class="small"><a href="#calendar">Calendar</a></p><h1>Suggest an event</h1><p class="muted">The team checks every suggestion before it shows on the calendar.</p><form id="sf" class="form card">${eventForm(d, {}, { suggest: true })}<div><button class="btn">Send</button></div></form>`);
  const f = $('#sf'); toggleDates(f); f.elements.all_day.addEventListener('change', () => toggleDates(f));
  f.addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { await api('/api/calendar/suggest', { body: formData(e.target) }); e.target.reset(); toggleDates(f); }, 'Thank you. The team will check it.'); });
}
// Shows a stored time back in the event's own time zone, for editing.
const inZone = (iso, tz) => { try { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; } catch { return CR.toInput(iso); } };
route('admin-calendar', async (id) => {
  const d = await api('/api/calendar/admin'), e0 = id ? d.events.find(x => String(x.id) === id) : null;
  const f = e0 ? { ...e0, ...(e0.all_day ? { start_date: e0.starts_at, end_date: e0.ends_at } : { start_local: inZone(e0.starts_at, e0.timezone), end_local: e0.ends_at ? inZone(e0.ends_at, e0.timezone) : '' }) } : { status: 'published', timezone: d.timezone };
  const pending = d.events.filter(e => e.status === 'pending');
  CR.view(`<div class="owner-only" style="padding:4px"><h1>Calendar <span class="owner-tag">Admin</span></h1>
    ${pending.length ? `<div class="card"><h2>Suggested events (${pending.length})</h2>${table(['When', 'Event', 'From', ''], pending.map(e => `<tr><td>${esc(e.all_day ? e.starts_at : CR.when(e.starts_at))}</td><td><a href="#admin-calendar/${e.id}">${esc(e.title)}</a><br><span class="small muted">${esc(e.type)} · ${esc(e.organizer || '')}</span></td><td>${esc(e.submitted_email || '')}</td>
      <td><button class="btn small" data-ok="${e.id}">Publish</button> <button class="btn alt small" data-del="${e.id}">Decline</button></td></tr>`))}</div>` : ''}
    <form id="ef" class="form card" style="margin-top:10px"><h2>${e0 ? 'Edit: ' + esc(e0.title) : 'New event'}</h2>${eventForm({ ...d, types: [...d.types, 'CR Pro webinar'] }, f)}
      <div class="row"><button class="btn">${e0 ? 'Save' : 'Add event'}</button>${e0 ? '<a class="btn alt" href="#admin-calendar">New instead</a> <button type="button" class="btn danger" id="del">Delete</button>' : ''}</div></form>
    <details class="card" style="margin-top:10px"><summary><strong>Import from a CSV file</strong></summary><p class="small muted">Header row with: title, organizer, type, start, end, all_day, timezone, format, city, country, link, cost, description, ce_credits. Start and end look like 2026-11-03 09:00 (in that row’s time zone) or just 2026-11-03.</p>
      <form id="imp" class="row"><input type="file" accept=".csv,text/csv" name="file" style="width:auto"><button class="btn small">Import</button></form></details>
    <h2 style="margin-top:14px">All events</h2><p class="small muted">CR Pro webinars come from Webinars and aren’t listed here.</p>
    ${table(['When', 'Event', 'Type', 'Status', 'Where'], d.events.map(e => `<tr><td data-sort="${esc(e.starts_at)}">${esc(e.all_day ? e.starts_at : CR.when(e.starts_at))}</td><td><a href="#admin-calendar/${e.id}">${esc(e.title)}</a></td><td>${esc(e.type)}</td><td>${esc(d.statuses[e.status] || e.status)}</td><td>${esc([e.city, e.country].filter(Boolean).join(', '))}</td></tr>`), { empty: 'No events yet.' })}</div>`);
  const form = $('#ef'); toggleDates(form); form.elements.all_day.addEventListener('change', () => toggleDates(form));
  form.addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { await api('/api/calendar/admin' + (e0 ? '/' + e0.id : ''), { method: e0 ? 'PUT' : 'POST', body: formData(e.target) }); CR.go('admin-calendar'); }); });
  const del = $('#del'); if (del) del.addEventListener('click', () => { if (confirm('Delete this event?')) act(del, async () => { await api('/api/calendar/admin/' + e0.id, { method: 'DELETE' }); CR.go('admin-calendar'); }); });
  $('#imp').addEventListener('submit', e => { e.preventDefault(); act(e.submitter, async () => { const file = e.target.elements.file.files[0]; if (!file) throw new Error('Choose a CSV file.');
    const r = await api('/api/calendar/admin/import', { body: { text: await file.text() } }); alert(`${r.added} events added.${r.problems.length ? '\n\nSkipped:\n' + r.problems.join('\n') : ''}`); CR.render(); }); });
  onView('click', e => { const ok = e.target.closest('[data-ok]'); if (ok) act(ok, async () => { await api(`/api/calendar/admin/${ok.dataset.ok}/approve`, { body: {} }); CR.render(); });
    const x = e.target.closest('[data-del]'); if (x && confirm('Decline and delete this suggestion?')) act(x, async () => { await api('/api/calendar/admin/' + x.dataset.del, { method: 'DELETE' }); CR.render(); }); });
}, { owner: true });
})();
