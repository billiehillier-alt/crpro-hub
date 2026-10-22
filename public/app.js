// Clinical Research Pro hub: the single-page app. Plain JavaScript, no build step.
// Screens register with CR.route(name, fn, { owner }); the left menu shows a screen only when it's registered.
// Other files (seo.js, social.js, directory.js, resources.js, calendar.js) add their screens the same way.
(function () {
const CR = window.CR = { routes: {}, me: null };
CR.render = () => render();
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
CR.$ = $; CR.$$ = $$; CR.esc = esc;

// ---------- talking to the server ----------
CR.api = async (url, opts = {}) => {
  const o = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: {} };
  if (opts.body instanceof FormData) o.body = opts.body;
  else if (opts.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  const r = await fetch(url, o);
  if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent('/' + location.hash); throw new Error('Please sign in.'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `That didn’t work (${r.status}).`);
  return d;
};
// Runs an action from a button: shows the error (or a short "Saved") next to it.
CR.act = async (btn, fn, okText) => {
  const box = btn && (btn.closest('form, .card, .panel, section') || document.body);
  let m = box && $(':scope > .msg-slot', box); if (box && !m) { m = document.createElement('div'); m.className = 'msg-slot'; box.appendChild(m); }
  if (btn) btn.disabled = true;
  try { const out = await fn(); if (m) m.innerHTML = okText ? `<p class="msg ok" role="status">${esc(okText)}</p>` : ''; return out; }
  catch (err) { if (m) m.innerHTML = `<p class="msg err" role="alert">${esc(err.message)}</p>`; else alert(err.message); }
  finally { if (btn) btn.disabled = false; }
};

// ---------- time: stored in UTC, shown in the viewer's own time zone ----------
CR.tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
CR.when = (iso, opts) => { if (!iso) return ''; const d = new Date(String(iso).includes('T') || String(iso).length === 10 ? iso : String(iso).replace(' ', 'T') + 'Z');
  return isNaN(d) ? String(iso) : d.toLocaleString('en-US', opts || { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); };
CR.day = iso => { if (!iso) return ''; const s = String(iso); const d = s.length === 10 ? new Date(s + 'T12:00:00Z') : new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(s.length === 10 ? { timeZone: 'UTC' } : {}) }); };
CR.toInput = iso => { if (!iso) return ''; const d = new Date(iso), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
CR.fromInput = v => v ? new Date(v).toISOString() : '';

// Form fields as an object; checkboxes come back true or false.
CR.formData = form => { const o = {}; for (const el of form.elements) { if (!el.name || el.disabled) continue; if (el.type === 'checkbox') o[el.name] = el.checked; else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; } else if (el.type !== 'file') o[el.name] = el.value; } return o; };
CR.opts = (list, cur) => list.map(x => { const [v, t] = Array.isArray(x) ? x : [x, x]; return `<option value="${esc(v)}"${String(v) === String(cur ?? '') ? ' selected' : ''}>${esc(t)}</option>`; }).join('');
CR.az = list => [...list].sort((a, b) => String(Array.isArray(a) ? a[1] : a).localeCompare(String(Array.isArray(b) ? b[1] : b), 'en', { sensitivity: 'base' }));
// Smart search: every word must show up somewhere, in any order.
CR.matches = (q, text) => { const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean); const t = String(text || '').toLowerCase(); return words.every(w => t.includes(w)); };

// ---------- every table sorts by clicking a column heading ----------
document.addEventListener('click', e => {
  const th = e.target.closest('table.sortable th'); if (!th || th.dataset.nosort !== undefined) return;
  const table = th.closest('table'), i = [...th.parentNode.children].indexOf(th), body = table.tBodies[0]; if (!body) return;
  const dir = th.classList.contains('asc') ? 'desc' : 'asc';
  $$('th', table).forEach(x => x.classList.remove('asc', 'desc')); th.classList.add(dir);
  const val = tr => { const td = tr.children[i]; const s = td ? (td.dataset.sort ?? td.textContent.trim()) : ''; const n = Number(String(s).replace(/[$,%]/g, '')); return s !== '' && Number.isFinite(n) ? n : s.toLowerCase(); };
  const rows = [...body.rows].sort((a, b) => { const x = val(a), y = val(b); const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)); return dir === 'asc' ? c : -c; });
  rows.forEach(r => body.appendChild(r));
});
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('table.sortable th')) { e.preventDefault(); e.target.click(); } });
CR.table = (cols, rows, opts = {}) => rows.length ? `<div class="table-wrap"><table class="sortable${opts.cls ? ' ' + opts.cls : ''}"><thead><tr>${cols.map(c => `<th tabindex="0" scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="empty">${esc(opts.empty || 'Nothing here yet.')}</p>`;

// ---------- video upload (to cloud storage when it's set up, else to the app's own folder) ----------
CR.uploadVideo = async (file, status) => {
  const start = await CR.api('/api/media/upload', { body: { name: file.name, type: file.type, size: file.size } });
  await new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open('PUT', start.url);
    for (const [k, v] of Object.entries(start.headers || {})) x.setRequestHeader(k, v);
    x.upload.onprogress = e => { if (status && e.lengthComputable) status.textContent = `Uploading… ${Math.round(e.loaded / e.total * 100)}%`; };
    x.onload = () => x.status < 300 ? ok() : no(new Error('The upload stopped. Try again.')); x.onerror = () => no(new Error('The upload stopped. Try again.')); x.send(file); });
  const done = await CR.api(`/api/media/${start.id}/done`, { body: {} });
  if (status) status.textContent = 'Uploaded.'; return done.token;
};
// A video field: upload a file, or paste a link. Fills a hidden input named `name` with "media:<id>".
CR.videoField = (name, token, urlName, url, label) => `<div class="panel"><div class="lbl-line"><label>${esc(label || 'Video')}</label><span class="muted">Upload a file (MP4, MOV, WebM) or paste a link.</span></div>
  <input type="hidden" name="${name}" value="${esc(token || '')}"><div class="row"><input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-m4v" data-video-for="${name}" style="width:auto">
  <span class="small muted" data-video-status="${name}">${token ? 'A video is uploaded. Pick a new file to replace it.' : ''}</span>${token ? ` <button type="button" class="btn alt small" data-video-clear="${name}">Remove upload</button>` : ''}</div>
  <div style="margin-top:6px"><label for="f-${urlName}">Or a video link</label><input id="f-${urlName}" type="url" name="${urlName}" value="${esc(url || '')}" placeholder="https://"></div></div>`;
document.addEventListener('change', async e => {
  const inp = e.target.closest('input[data-video-for]'); if (!inp || !inp.files[0]) return;
  const name = inp.dataset.videoFor, form = inp.form, st = $(`[data-video-status="${name}"]`, form);
  try { form.elements[name].value = await CR.uploadVideo(inp.files[0], st); } catch (err) { st.textContent = err.message; }
});
document.addEventListener('click', e => { const b = e.target.closest('[data-video-clear]'); if (!b) return; const f = b.form; f.elements[b.dataset.videoClear].value = ''; $(`[data-video-status="${b.dataset.videoClear}"]`, f).textContent = 'Removed. Save to keep the change.'; b.remove(); });
// Plays an uploaded video, or embeds a link (a direct video file plays in the page; other links open in a new tab).
CR.player = (src, url) => {
  if (src) return `<div class="video-box"><video controls preload="metadata" src="${esc(src)}"></video></div>`;
  if (!url) return '';
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)) return `<div class="video-box"><video controls preload="metadata" src="${esc(url)}"></video></div>`;
  if (/^https:\/\/(iframe\.mediadelivery\.net|player\.vimeo\.com)\//i.test(url)) return `<div class="video-box"><iframe src="${esc(url)}" allow="fullscreen; picture-in-picture" allowfullscreen title="Video"></iframe></div>`;
  return `<p><a href="${esc(url)}" target="_blank" rel="noopener">Watch the video</a> (opens in a new tab)</p>`;
};

// ---------- menu and routing ----------
CR.route = (name, fn, opts = {}) => { CR.routes[name] = { fn, ...opts }; };
const MENU = [
  ['home', 'Home'], ['academy', 'Academy'], ['webinars', 'Webinars'], ['calendar', 'Calendar'], ['directory', 'Directory'], ['resources', 'Resources'], ['certificates', 'My certificates'], ['account', 'My account'],
];
const ADMIN = [
  ['admin-courses', 'Courses'], ['admin-webinars', 'Webinars'], ['admin-calendar', 'Calendar'], ['admin-certificates', 'Certificates'], ['admin-directory', 'Directory'], ['admin-resources', 'Resources'],
  ['seo', 'SEO plan'], ['seotree', 'Topic map'], ['articlemap', 'Article map'], ['ideas', 'Article ideas'], ['social', 'Social posts'], ['people', 'People'], ['settings', 'Settings'],
];
function drawMenu(cur) {
  const link = ([k, t]) => CR.routes[k] ? `<a href="#${k}" class="${cur === k ? 'on' : ''}"${cur === k ? ' aria-current="page"' : ''}>${esc(t)}</a>` : '';
  $('#menu').innerHTML = MENU.map(link).join('') + (CR.me && CR.me.owner ? `<div class="group">Admin <span class="small" style="text-transform:none;letter-spacing:0">(only you see this)</span></div><div class="owner-menu">${ADMIN.map(link).join('')}</div>` : '');
  $('#sideFoot').innerHTML = `<p>${esc(CR.me ? (CR.me.name || CR.me.email) : '')}</p><div class="row"><button id="themeBtn">${document.documentElement.dataset.theme === 'dark' ? 'Light' : 'Dark'} mode</button><button id="logoutBtn">Sign out</button></div>`;
}
document.addEventListener('click', async e => {
  if (e.target.id === 'logoutBtn') { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login'; }
  if (e.target.id === 'themeBtn') { const dark = !(document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches));
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'; try { localStorage.setItem('crp-theme', dark ? 'dark' : 'light'); } catch {} drawMenu(location.hash.slice(1).split('/')[0]); }
  if (e.target.id === 'menuToggle') { const s = $('#side'); s.classList.toggle('open'); e.target.setAttribute('aria-expanded', s.classList.contains('open')); }
  if (e.target.closest('#menu a')) { $('#side').classList.remove('open'); $('#menuToggle').setAttribute('aria-expanded', 'false'); }
});
CR.view = html => { $('#view').innerHTML = html; };
CR.go = hash => { if (location.hash === '#' + hash) render(); else location.hash = hash; };
CR.ctl = new AbortController();
// Listeners on the page area for one screen; they're removed when the next screen draws.
CR.onView = (type, fn) => $('#view').addEventListener(type, fn, { signal: CR.ctl.signal });
async function render() {
  CR.ctl.abort(); CR.ctl = new AbortController();
  const [name, ...rest] = (location.hash.slice(1) || 'home').split('/'), r = CR.routes[name] || CR.routes.home;
  drawMenu(CR.routes[name] ? name : 'home');
  if (r.owner && !(CR.me && CR.me.owner)) { CR.view('<p class="empty">That page is for the CR Pro team.</p>'); return; }
  CR.view('<p class="muted">Loading…</p>');
  try { await r.fn(...rest.map(decodeURIComponent)); } catch (err) { CR.view(`<p class="msg err" role="alert">${esc(err.message)}</p>`); }
  const h1 = $('#view h1'); document.title = (h1 ? h1.textContent + ' | ' : '') + 'Clinical Research Pro';
  $('#view').focus({ preventScroll: true });
}
window.addEventListener('hashchange', render);
CR.start = async () => {
  const s = await (await fetch('/api/auth/status')).json();
  if (!s.user) { location.href = '/login'; return; }
  CR.me = s.user;
  if (!CR.me.timezone && CR.tz) CR.api('/api/auth/me', { method: 'PUT', body: { timezone: CR.tz } }).catch(() => {});
  render();
};

// ---------- Home ----------
CR.route('home', async () => {
  const [a, w, c] = await Promise.all([CR.api('/api/academy/courses'), CR.api('/api/webinars'), CR.api('/api/academy/my/certificates')]);
  const going = a.courses.filter(x => x.open && x.done > 0 && x.done < x.lessons), next = w.events.filter(e => new Date(e.ends_at) > new Date()).slice(0, 3);
  CR.view(`<h1>Welcome${CR.me.name ? ', ' + esc(CR.me.name) : ''}</h1><p class="muted">Collaborate. Educate. Empower.</p>
    <div class="cards">
      <div class="card accent"><h2>Keep learning</h2>${going.length ? going.map(x => `<p><a href="#course/${x.id}">${esc(x.title)}</a><br><span class="small muted">${x.done} of ${x.lessons} lessons done</span></p>`).join('') : '<p class="muted">Nothing in progress. <a href="#academy">Browse the Academy</a>.</p>'}</div>
      <div class="card accent"><h2>Next webinars</h2>${next.length ? next.map(e => `<p><a href="#webinars">${esc(e.title)}</a><br><span class="small muted">${esc(CR.when(e.starts_at))}</span></p>`).join('') : '<p class="muted">No webinars on the schedule yet.</p>'}</div>
      <div class="card accent"><h2>My certificates</h2>${c.certificates.length ? `<p>${c.certificates.length} earned. <a href="#certificates">See them</a>.</p>` : '<p class="muted">Finish a course and pass its final quiz to earn one.</p>'}</div>
    </div>`);
});

// ---------- Academy (students) ----------
const accessTag = c => `<span class="tag ${c.access}">${c.access === 'free' ? 'Free' : c.access === 'elite' ? 'Elite' : 'Paid'}</span>`;
const credits = c => [c.ce_credits != null ? `${c.ce_credits} CE` : '', c.pdus != null ? `${c.pdus} PDUs` : ''].filter(Boolean).join(' · ');
CR.route('academy', async () => {
  const d = await CR.api('/api/academy/courses');
  const cats = CR.az([...new Set(d.courses.flatMap(c => String(c.categories || '').split(';').map(s => s.trim()).filter(Boolean)))]);
  CR.view(`<h1>Academy</h1><div class="filters"><input type="search" id="q" placeholder="Search courses" aria-label="Search courses">
    <select id="cat" aria-label="Category"><option value="">All categories</option>${CR.opts(cats)}</select>
    <select id="acc" aria-label="Access"><option value="">Free, paid, and Elite</option>${CR.opts([['elite', 'Elite'], ['free', 'Free'], ['paid', 'Paid']])}</select></div><div id="list"></div>`);
  const draw = () => { const q = $('#q').value, cat = $('#cat').value, acc = $('#acc').value;
    const list = d.courses.filter(c => CR.matches(q, [c.title, c.summary, c.instructor, c.categories].join(' ')) && (!cat || String(c.categories || '').includes(cat)) && (!acc || c.access === acc));
    $('#list').innerHTML = list.length ? `<div class="cards">${list.map(c => `<div class="card"><h3><a href="#course/${c.id}">${esc(c.title)}</a></h3>
      <p class="row small">${accessTag(c)} ${credits(c) ? `<span>${esc(credits(c))}</span>` : ''}${c.version ? `<span class="muted">${esc(c.version)}</span>` : ''}</p>
      ${c.summary ? `<p class="small">${esc(c.summary.slice(0, 180))}</p>` : ''}${c.instructor ? `<p class="small muted">With ${esc(c.instructor)}</p>` : ''}
      ${c.open && c.lessons ? `<div class="bar" title="${c.done} of ${c.lessons} done"><span style="width:${Math.round(c.done / c.lessons * 100)}%"></span></div>` : c.lock ? `<p class="small muted">${esc(c.lock)}</p>` : ''}</div>`).join('')}</div>`
      : `<p class="empty">${d.courses.length ? 'No courses match. Try fewer words.' : 'No courses are published yet.'}</p>`; };
  ['q', 'cat', 'acc'].forEach(id => $('#' + id).addEventListener('input', draw)); draw();
});
CR.route('course', async id => {
  const d = await CR.api('/api/academy/courses/' + id), c = d.course;
  const byMod = m => d.lessons.filter(l => (l.module_id || 0) === m);
  const li = l => `<li><span class="tick" aria-label="${l.done ? 'Done' : 'Not done'}">${l.done ? '✓' : '·'}</span>${d.open && !l.locked ? `<a href="#lesson/${l.id}">${esc(l.title)}</a>` : esc(l.title)}
    ${l.quiz ? `<span class="tag">${l.final ? 'Final quiz' : 'Quiz'}</span>` : ''}${l.locked ? `<span class="small muted">Opens ${esc(CR.day(l.opens_on))}</span>` : ''}${l.minutes ? `<span class="small muted">${l.minutes} min</span>` : ''}${l.status === 'draft' ? '<span class="tag draft">Draft</span>' : ''}</li>`;
  const groups = [...d.modules.map(m => [m.title, byMod(m.id)]), ['', byMod(0)]].filter(([, ls]) => ls.length);
  CR.view(`<p class="small"><a href="#academy">Academy</a></p><h1>${esc(c.title)}</h1>
    <p class="row">${accessTag(c)} ${credits(c) ? esc(credits(c)) : ''} ${c.version ? `<span class="muted">Version: ${esc(c.version)}</span>` : ''}${CR.me.owner ? ` <a class="btn alt small owner-only" href="#admin-course/${c.id}">Edit course</a>` : ''}</p>
    ${c.summary ? `<p>${esc(c.summary)}</p>` : ''}${c.instructor ? `<p class="muted">Instructor: ${esc(c.instructor)}</p>` : ''}
    ${!d.open ? `<p class="msg warn">${esc(c.lock)}</p>` : ''}
    ${c.lessons ? `<div class="bar" style="max-width:400px"><span style="width:${Math.round(c.done / c.lessons * 100)}%"></span></div><p class="small muted">${c.done} of ${c.lessons} lessons done. ${c.certificate ? `Finish every lesson and pass the final quiz (${d.passMark}% or more) to earn your certificate.` : ''}</p>` : '<p class="empty">Lessons are on the way.</p>'}
    ${d.certificates.length ? `<div class="panel"><h2>Your certificate</h2>${d.certificates.map(x => `<p><a href="/certificate/${esc(x.id)}" target="_blank" rel="noopener">${esc(x.id)}</a> · issued ${esc(CR.day(x.issued_at))}${x.expires_at ? ` · ${x.status === 'expired' ? 'expired' : 'expires'} ${esc(CR.day(x.expires_at))}` : ''}</p>`).join('')}</div>` : ''}
    ${groups.map(([t, ls]) => `${t ? `<h3 class="module-title">${esc(t)}</h3>` : ''}<ul class="lesson-list">${ls.map(li).join('')}</ul>`).join('')}`);
});
CR.route('lesson', async id => {
  const l = await CR.api('/api/academy/lessons/' + id);
  const best = l.attempts.find(a => a.passed);
  CR.view(`<p class="small"><a href="#course/${l.course_id}">${esc(l.course)}</a></p><h1>${esc(l.title)}</h1>
    ${CR.me.owner ? `<p><a class="btn alt small owner-only" href="#admin-lesson/${l.id}">Edit lesson</a></p>` : ''}
    ${l.summary ? `<p>${esc(l.summary)}</p>` : ''}${CR.player(l.video, l.video_url)}
    ${l.transcript ? `<details open><summary><strong>Transcript</strong></summary><div class="transcript">${esc(l.transcript)}</div></details>` : ''}
    ${l.resources.length ? `<h2>Resources</h2><ul>${l.resources.map(r => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></li>`).join('')}</ul>` : ''}
    <section id="quizBox"></section>
    ${!l.quiz.length ? `<p><button class="btn" id="doneBtn">${l.done ? 'Done ✓ (mark not done)' : 'Mark this lesson done'}</button></p>` : ''}
    <section><h2>Questions and comments</h2><div id="comments"></div><form id="cform" class="form"><label for="cbody">Add a comment</label><textarea id="cbody" name="body" required></textarea><div><button class="btn">Post</button></div></form></section>`);
  const quizBox = $('#quizBox');
  const drawQuiz = () => { if (!l.quiz.length) return;
    quizBox.innerHTML = `<h2>${l.final ? 'Final quiz' : 'Quiz'}</h2><p class="small muted">You need ${l.passMark}% to pass. Every try is saved. ${best ? `<strong>You passed on ${esc(CR.day(best.taken_at))} (${best.percent}%).</strong>` : ''}</p>
      <form id="qform">${l.quiz.map((q, i) => `<fieldset class="quiz-q"><legend><strong>${i + 1}. ${esc(q.q)}</strong></legend>${q.options.map((o, j) => `<label><input type="radio" name="q${i}" value="${j}" required> ${esc(o)}</label>`).join('')}</fieldset>`).join('')}
      <button class="btn">Submit my answers</button></form><div id="qres"></div>
      ${l.attempts.length ? `<details><summary>My tries (${l.attempts.length})</summary>${CR.table(['When', 'Score', 'Result'], l.attempts.map(a => `<tr><td data-sort="${esc(a.taken_at)}">${esc(CR.when(a.taken_at))}</td><td data-sort="${a.percent}">${a.score} of ${a.total} (${a.percent}%)</td><td>${a.passed ? 'Passed' : 'Not passed'}</td></tr>`))}</details>` : ''}`;
    $('#qform').addEventListener('submit', async e => { e.preventDefault();
      const answers = l.quiz.map((_, i) => { const x = $(`input[name=q${i}]:checked`, e.target); return x ? Number(x.value) : null; });
      await CR.act(e.submitter, async () => { const r = await CR.api(`/api/academy/lessons/${l.id}/quiz`, { body: { answers } });
        $('#qres').innerHTML = r.passed ? `<p class="msg ok" role="status">You passed: ${r.score} of ${r.total} (${r.percent}%).${r.certificate ? ` Your certificate is ready: <a href="/certificate/${esc(r.certificate.id)}" target="_blank" rel="noopener">${esc(r.certificate.id)}</a>.` : ''}</p>`
          : `<p class="msg err" role="alert">${r.score} of ${r.total} (${r.percent}%). You need ${r.passMark}%. Check question${r.wrong.length > 1 ? 's' : ''} ${r.wrong.join(', ')}, review the lesson, and try again.</p>`;
        $('#qres').scrollIntoView({ block: 'nearest' }); });
    }); };
  drawQuiz();
  const db = $('#doneBtn'); if (db) db.addEventListener('click', () => CR.act(db, async () => { const r = await CR.api(`/api/academy/lessons/${l.id}/done`, { body: { done: !l.done } }); l.done = !l.done;
    db.textContent = l.done ? 'Done ✓ (mark not done)' : 'Mark this lesson done'; if (r.certificate) alert('Your certificate is ready: ' + r.certificate.id); }));
  const drawComments = async () => { const c = await CR.api(`/api/academy/lessons/${l.id}/comments`);
    $('#comments').innerHTML = c.comments.length ? c.comments.map(x => `<div class="comment"><strong>${esc(x.by)}</strong> <span class="small muted">${esc(CR.when(x.at))}</span>${x.canHide ? ` <button class="btn alt small" data-hide="${x.id}">Remove</button>` : ''}<p>${esc(x.body)}</p></div>`).join('') : '<p class="muted small">No comments yet.</p>'; };
  $('#comments').addEventListener('click', e => { const b = e.target.closest('[data-hide]'); if (b) CR.act(b, async () => { await CR.api('/api/academy/comments/' + b.dataset.hide, { method: 'DELETE' }); drawComments(); }); });
  $('#cform').addEventListener('submit', e => { e.preventDefault(); CR.act(e.submitter, async () => { await CR.api(`/api/academy/lessons/${l.id}/comments`, { body: CR.formData(e.target) }); e.target.reset(); drawComments(); }); });
  drawComments();
});
CR.route('certificates', async () => {
  const d = await CR.api('/api/academy/my/certificates');
  CR.view(`<h1>My certificates</h1><p><a class="btn alt" href="/api/academy/my/transcript.csv">Download my transcript (CSV)</a></p>
    ${CR.table(['Certificate ID', 'Course', 'Version', 'Credits', 'Issued', 'Expires', 'Status'], d.certificates.map(c => `<tr><td><a href="/certificate/${esc(c.id)}" target="_blank" rel="noopener">${esc(c.id)}</a></td><td>${esc(c.course_title)}</td><td>${esc(c.course_version || '')}</td>
      <td>${esc(credits(c))}</td><td data-sort="${esc(c.issued_at)}">${esc(CR.day(c.issued_at))}</td><td data-sort="${esc(c.expires_at || '9999')}">${c.expires_at ? esc(CR.day(c.expires_at)) : 'Does not expire'}</td><td>${c.status === 'valid' ? 'Valid' : 'Expired'}</td></tr>`), { empty: 'No certificates yet. Finish a course and pass its final quiz to earn one.' })}
    <p class="small muted">Anyone can check a certificate at <a href="/verify" target="_blank" rel="noopener">${esc(location.origin)}/verify</a>.</p>`);
});
CR.route('account', async () => {
  const s = await CR.api('/api/auth/status'), u = s.user;
  CR.view(`<h1>My account</h1><div class="cards">
    <form class="card form" id="me"><h2>Profile</h2><p class="small muted">Your name goes on your certificates.</p>
      <div class="two"><div><label for="n1">First name</label><input id="n1" type="text" name="name" value="${esc(u.name || '')}"></div><div><label for="n2">Last name</label><input id="n2" type="text" name="lastName" value="${esc(u.lastName || '')}"></div></div>
      <div><label for="tz">Time zone</label><input id="tz" type="text" name="timezone" value="${esc(u.timezone || CR.tz)}"></div>
      <label class="check"><input type="checkbox" name="emailOn" ${u.emailOn ? 'checked' : ''}> Send me emails (webinar reminders, certificate renewals)</label>
      <div><button class="btn">Save</button></div></form>
    <form class="card form" id="pw"><h2>Change password</h2><div><label for="p1">Current password</label><input id="p1" type="password" name="current" autocomplete="current-password"></div>
      <div><label for="p2">New password (at least 12 characters)</label><input id="p2" type="password" name="password" autocomplete="new-password"></div><div><button class="btn">Change password</button></div></form></div>
    <p class="small muted">Signed in as ${esc(u.email)}.</p>`);
  $('#me').addEventListener('submit', e => { e.preventDefault(); CR.act(e.submitter, async () => { await CR.api('/api/auth/me', { method: 'PUT', body: CR.formData(e.target) }); Object.assign(CR.me, (await CR.api('/api/auth/status')).user); }, 'Saved.'); });
  $('#pw').addEventListener('submit', e => { e.preventDefault(); CR.act(e.submitter, async () => { await CR.api('/api/auth/password', { method: 'PUT', body: CR.formData(e.target) }); e.target.reset(); }, 'Password changed. Other devices are signed out.'); });
});

// ---------- Webinars ----------
const stars = (id, cur) => `<span class="stars" data-rate="${id}">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">${n <= cur ? '★' : '☆'}</button>`).join('')}</span>`;
CR.route('webinars', async () => {
  const d = await CR.api('/api/webinars'), now = new Date();
  const up = d.events.filter(e => new Date(e.ends_at) > now), past = d.events.filter(e => new Date(e.ends_at) <= now).reverse();
  const card = e => `<div class="card"><h3>${esc(e.title)}</h3><p class="small"><strong>${esc(CR.when(e.starts_at))}</strong> · ${e.duration_min} min${e.topic ? ` · ${esc(e.topic)}` : ''}${e.ce_credits != null ? ` · ${e.ce_credits} CE` : ''}</p>
    <p class="row">${e.elite_only ? '<span class="tag elite">Elite</span>' : ''}${e.free_until ? `<span class="tag free">Free until ${esc(CR.day(e.free_until))}</span>` : ''}<span class="small muted">Host: ${esc(e.host)}</span></p>
    ${e.description ? `<p class="small">${esc(e.description).replace(/\n/g, '<br>')}</p>` : ''}
    ${e.lock ? `<p class="msg warn small">${esc(e.lock)}</p>` : new Date(e.ends_at) > now ? `<div class="row">${e.going ? `<strong>You’re going.</strong> <button class="btn alt small" data-rsvp="${e.id}" data-going="0">Can’t make it</button>` : `<button class="btn small" data-rsvp="${e.id}" data-going="1">I’ll be there</button>`}</div>
      ${e.going && e.link ? `<p class="small">Join link: <a href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.link)}</a></p>` : ''}
      <p class="small">Add to: <a href="${esc(e.links.google)}" target="_blank" rel="noopener">Google</a> · <a href="${esc(e.links.outlook)}" target="_blank" rel="noopener">Outlook.com</a> · <a href="${esc(e.links.office)}" target="_blank" rel="noopener">Office 365</a> · <a href="/api/webinars/${e.id}/ics">Apple or other (.ics)</a></p>`
      : `${e.recording || e.recording_url ? `<details><summary>Watch the recording</summary>${CR.player(e.recording, e.recording_url)}</details>` : '<p class="small muted">No recording yet.</p>'}${e.going ? `<p class="small">Rate it: ${stars(e.id, e.myStars)}</p>` : ''}`}</div>`;
  CR.view(`<h1>Webinars</h1><p class="small muted">Times are in your time zone (${esc(CR.tz)}).</p>${CR.me.owner ? '<p><a class="btn alt small owner-only" href="#admin-webinars">Manage webinars</a></p>' : ''}
    <h2>Coming up</h2>${up.length ? `<div class="cards">${up.map(card).join('')}</div>` : '<p class="empty">No webinars on the schedule yet.</p>'}
    ${past.length ? `<h2 style="margin-top:20px">Past webinars</h2><div class="cards">${past.map(card).join('')}</div>` : ''}`);
  CR.onView('click', e => {
    const b = e.target.closest('[data-rsvp]'); if (b) return CR.act(b, async () => { await CR.api(`/api/webinars/${b.dataset.rsvp}/rsvp`, { body: { going: b.dataset.going === '1' } }); render(); });
    const s = e.target.closest('[data-rate] button'); if (s) CR.act(s, async () => { await CR.api(`/api/webinars/${s.parentNode.dataset.rate}/rate`, { body: { stars: Number(s.dataset.n) } }); render(); });
  });
});

// ---------- Admin: courses ----------
CR.route('admin-courses', async () => {
  const d = await CR.api('/api/admin/academy/courses');
  CR.view(`<div class="owner-only" style="padding:4px"><div class="spread"><h1>Courses <span class="owner-tag">Admin</span></h1><button class="btn" id="newCourse">New course</button></div>
    <div class="filters"><input type="search" id="q" placeholder="Search" aria-label="Search courses"><select id="st" aria-label="Status"><option value="">Draft and published</option>${CR.opts([['draft', 'Draft'], ['published', 'Published']])}</select></div>
    <div id="list"></div></div>`);
  const draw = () => { const q = $('#q').value, st = $('#st').value;
    $('#list').innerHTML = CR.table(['Course', 'Status', 'Access', 'Price', 'CE', 'PDUs', 'Lessons', 'Students', 'Certificates', 'ID code'], d.courses.filter(c => CR.matches(q, c.title + ' ' + (c.instructor || '') + ' ' + (c.categories || '')) && (!st || c.status === st)).map(c =>
      `<tr><td><a href="#admin-course/${c.id}">${esc(c.title)}</a></td><td><span class="tag ${c.status}">${c.status === 'published' ? 'Published' : 'Draft'}</span></td><td>${esc(c.access)}</td><td>${c.price != null ? '$' + c.price : ''}</td><td>${c.ce_credits ?? ''}</td><td>${c.pdus ?? ''}</td><td>${c.lessons}</td><td>${c.students}</td><td>${c.certs}</td><td>${esc(c.code)}</td></tr>`), { empty: 'No courses match.' }); };
  $('#q').addEventListener('input', draw); $('#st').addEventListener('input', draw); draw();
  $('#newCourse').addEventListener('click', e => CR.act(e.target, async () => { const r = await CR.api('/api/admin/academy/courses', { body: { title: 'New course', status: 'draft', certificate: true } }); CR.go('admin-course/' + r.id); }));
});
CR.route('admin-course', async id => {
  const d = await CR.api('/api/admin/academy/courses/' + id), c = d.course;
  const modName = mid => (d.modules.find(m => m.id === mid) || {}).title || 'No module';
  CR.view(`<div class="owner-only" style="padding:4px"><p class="small"><a href="#admin-courses">Courses</a> · <a href="#course/${c.id}">See it as a student</a></p><h1>${esc(c.title)} <span class="owner-tag">Admin</span></h1>
    ${d.warnings.map(w => `<p class="msg warn">${esc(w)}</p>`).join('')}
    <form id="cf" class="form card"><h2>Course details</h2>
      <div><label for="t">Title</label><input id="t" type="text" name="title" value="${esc(c.title)}" required></div>
      <div><label for="s">Summary</label><textarea id="s" name="summary">${esc(c.summary || '')}</textarea></div>
      <div class="three"><div><label for="st">Status</label><select id="st" name="status">${CR.opts([['draft', 'Draft (students can’t see it)'], ['published', 'Published']], c.status)}</select></div>
        <div><label for="ac">Access</label><select id="ac" name="access">${CR.opts([['elite', 'Elite members'], ['free', 'Free'], ['paid', 'Paid']], c.access)}</select></div>
        <div><label for="pr">Price ($)</label><input id="pr" type="number" step="0.01" name="price" value="${c.price ?? ''}"></div></div>
      <div class="three"><div><label for="ce">CE credits</label><input id="ce" type="number" step="0.1" name="ce_credits" value="${c.ce_credits ?? ''}"></div>
        <div><label for="pd">PDUs</label><input id="pd" type="number" step="0.1" name="pdus" value="${c.pdus ?? ''}"></div>
        <div><label for="in">Instructor</label><input id="in" type="text" name="instructor" value="${esc(c.instructor || '')}"></div></div>
      <div class="two"><div><label for="ve">Version (on each certificate)</label><input id="ve" type="text" name="version" value="${esc(c.version || '')}" placeholder="ICH E6(R3)"></div>
        <div><label for="ca">Categories (separate with ;)</label><input id="ca" type="text" name="categories" value="${esc(c.categories || '')}"></div></div>
      <div class="panel form"><label class="check"><input type="checkbox" name="certificate" ${c.certificate ? 'checked' : ''}> Issue a certificate when a student finishes and passes the final quiz</label>
        <div class="three"><div><label for="pm">Pass mark (%)</label><input id="pm" type="number" name="pass_mark" min="1" max="100" value="${c.pass_mark}"></div>
          <div><label for="vm">Valid for (months, empty = never expires)</label><input id="vm" type="number" name="certificate_valid_months" value="${c.certificate_valid_months ?? ''}"></div>
          <div><label for="cc">Certificate ID code</label><input id="cc" type="text" name="cert_code" value="${esc(c.cert_code || '')}" placeholder="${esc(c.code)}" maxlength="6"></div></div>
        <p class="small muted">IDs look like CRP-${esc(c.code)}-${new Date().getFullYear() % 100}-04271. GCP renews every 36 months.</p></div>
      <div class="two"><div><label for="so">Sort order</label><input id="so" type="number" name="sort" value="${c.sort}"></div><div><label for="no">Team note (students don’t see it)</label><textarea id="no" name="note">${esc(c.note || '')}</textarea></div></div>
      <div class="row"><button class="btn">Save course</button><button type="button" class="btn danger" id="delCourse">Delete course</button></div></form>
    <section class="card" style="margin-top:12px"><h2>Modules and lessons</h2>
      <form id="mf" class="row"><label for="mt">New module</label><input id="mt" type="text" name="title" style="max-width:340px" placeholder="Module 1: Getting started"><button class="btn small">Add module</button></form>
      ${d.modules.length ? `<ul>${d.modules.map(m => `<li>${esc(m.title)} <button class="btn alt small" data-ren="${m.id}">Rename</button> <button class="btn alt small" data-delmod="${m.id}">Delete</button></li>`).join('')}</ul>` : '<p class="small muted">No modules yet. Lessons can sit without one.</p>'}
      <p><a class="btn" href="#admin-lesson/new/${c.id}">New lesson</a></p>
      ${CR.table(['#', 'Lesson', 'Module', 'Status', 'Quiz', 'Opens', 'Minutes'], d.lessons.map(l => `<tr><td>${l.sort}</td><td><a href="#admin-lesson/${l.id}">${esc(l.title)}</a></td><td>${esc(modName(l.module_id))}</td><td><span class="tag ${l.status}">${l.status}</span></td>
        <td>${l.has_quiz ? (d.finalLesson === l.id ? 'Final quiz' : 'Quiz') : ''}</td><td>${esc(l.opens_on || '')}</td><td>${l.minutes || ''}</td></tr>`), { empty: 'No lessons yet.' })}</section>
    <section class="card" style="margin-top:12px"><h2>Who has access</h2><p class="small muted">Paid and Elite courses: add a student by email until payments are connected. Elite members open Elite courses on their own (set Elite in People).</p>
      <form id="gf" class="row"><input type="email" name="email" placeholder="student@example.com" style="max-width:300px" aria-label="Student email"><button class="btn small">Give access</button></form>
      ${CR.table(['Student', 'Email', 'Added', ''], d.grants.map(g => `<tr><td>${esc([g.name, g.last_name].filter(Boolean).join(' '))}</td><td>${esc(g.email)}</td><td>${esc(CR.day(g.created_at))}</td><td><button class="btn alt small" data-ungrant="${g.user_id}">Remove</button></td></tr>`), { empty: 'Nobody added by hand.' })}</section>
    <section class="card" style="margin-top:12px"><h2>Quiz attempts</h2><p class="small muted">Every try is kept for good, pass or fail.</p>
      ${CR.table(['When', 'Student', 'Lesson', 'Score', 'Result'], d.attempts.map(a => `<tr><td data-sort="${esc(a.taken_at)}">${esc(CR.when(a.taken_at))}</td><td>${esc([a.name, a.last_name].filter(Boolean).join(' ') || a.email)}</td><td>${esc((d.lessons.find(l => l.id === a.lesson_id) || {}).title || 'Lesson ' + a.lesson_id)}</td><td data-sort="${a.percent}">${a.score}/${a.total} (${a.percent}%)</td><td>${a.passed ? 'Passed' : 'Not passed'}</td></tr>`), { empty: 'No attempts yet.' })}</section></div>`);
  $('#cf').addEventListener('submit', e => { e.preventDefault(); CR.act(e.submitter, () => CR.api('/api/admin/academy/courses/' + c.id, { method: 'PUT', body: CR.formData(e.target) }), 'Saved.'); });
  $('#delCourse').addEventListener('click', e => { if (confirm('Delete this course and its lessons? This can’t be undone.')) CR.act(e.target, async () => { await CR.api('/api/admin/academy/courses/' + c.id, { method: 'DELETE' }); CR.go('admin-courses'); }); });
  $('#mf').addEventListener('submit', e => { e.preventDefault(); CR.act(e.submitter, async () => { await CR.api(`/api/admin/academy/courses/${c.id}/modules`, { body: CR.formData(e.target) }); render(); }); });
  $('#gf').addEventListener('submit', e => { e.preventDefault(); CR.act(e.submitter, async () => { await CR.api(`/api/admin/academy/courses/${c.id}/grants`, { body: CR.formData(e.target) }); render(); }); });
  CR.onView('click', e => {
    const r = e.target.closest('[data-ren]'); if (r) { const t = prompt('New module name', (d.modules.find(m => m.id == r.dataset.ren) || {}).title); if (t) CR.act(r, async () => { await CR.api('/api/admin/academy/modules/' + r.dataset.ren, { method: 'PUT', body: { title: t } }); render(); }); }
    const m = e.target.closest('[data-delmod]'); if (m && confirm('Delete this module? Its lessons stay, without a module.')) CR.act(m, async () => { await CR.api('/api/admin/academy/modules/' + m.dataset.delmod, { method: 'DELETE' }); render(); });
    const g = e.target.closest('[data-ungrant]'); if (g) CR.act(g, async () => { await CR.api(`/api/admin/academy/courses/${c.id}/grants/${g.dataset.ungrant}`, { method: 'DELETE' }); render(); });
  });
});
CR.route('admin-lesson', async (id, courseId) => {
  const isNew = id === 'new', l = isNew ? { course_id: Number(courseId), status: 'draft', resourcesText: '', quiz: '' } : await CR.api('/api/admin/academy/lessons/' + id);
  const cd = await CR.api('/api/admin/academy/courses/' + l.course_id);
  CR.view(`<div class="owner-only" style="padding:4px"><p class="small"><a href="#admin-course/${l.course_id}">${esc(cd.course.title)}</a>${isNew ? '' : ` · <a href="#lesson/${l.id}">See it as a student</a>`}</p><h1>${isNew ? 'New lesson' : esc(l.title)} <span class="owner-tag">Admin</span></h1>
    <form id="lf" class="form card">
      <div><label for="t">Title</label><input id="t" type="text" name="title" value="${esc(l.title || '')}" required></div>
      <div class="three"><div><label for="mo">Module</label><select id="mo" name="module_id"><option value="">No module</option>${CR.opts(cd.modules.map(m => [m.id, m.title]), l.module_id)}</select></div>
        <div><label for="st">Status</label><select id="st" name="status">${CR.opts([['draft', 'Draft'], ['published', 'Published']], l.status)}</select></div>
        <div><label for="so">Order</label><input id="so" type="number" name="sort" value="${l.sort ?? ''}"></div></div>
      <div><label for="su">Summary</label><textarea id="su" name="summary">${esc(l.summary || '')}</textarea></div>
      ${CR.videoField('video', l.video, 'video_url', l.video_url, 'Video')}
      <div><label for="tr">Transcript</label><textarea id="tr" name="transcript" style="min-height:160px">${esc(l.transcript || '')}</textarea></div>
      <div><div class="lbl-line"><label for="re">Resources</label><span class="muted">One per line: Title | https://link</span></div><textarea id="re" name="resources">${esc(l.resourcesText || '')}</textarea></div>
      <div><div class="lbl-line"><label for="qz">Quiz</label><span class="muted">“Q: question”, then one line per choice: “* ” before the right one, “- ” before the others. A blank line between questions.</span></div>
        <textarea id="qz" class="code" name="quiz" placeholder="Q: Who approves a study at a site?&#10;- The sponsor&#10;* The IRB&#10;- The CRO">${esc(l.quiz || '')}</textarea></div>
      <label class="check"><input type="checkbox" name="is_final" ${l.is_final ? 'checked' : ''}> This is the course’s final quiz (passing it is needed for the certificate)</label>
      <div class="two"><div><div class="lbl-line"><label for="op">Opens on</label><span class="muted">Empty = open now</span></div><input id="op" type="date" name="opens_on" value="${esc(l.opens_on || '')}"></div>
        <div><label for="mi">Minutes</label><input id="mi" type="number" name="minutes" value="${l.minutes ?? ''}"></div></div>
      <div class="row"><button class="btn">Save lesson</button>${isNew ? '' : '<button type="button" class="btn danger" id="delLesson">Delete lesson</button>'}</div></form></div>`);
  $('#lf').addEventListener('submit', e => { e.preventDefault(); CR.act(e.submitter, async () => {
    const body = CR.formData(e.target);
    if (isNew) { const r = await CR.api(`/api/admin/academy/courses/${l.course_id}/lessons`, { body }); CR.go('admin-lesson/' + r.id); }
    else await CR.api('/api/admin/academy/lessons/' + l.id, { method: 'PUT', body }); }, 'Saved.'); });
  const del = $('#delLesson'); if (del) del.addEventListener('click', () => { if (confirm('Delete this lesson?')) CR.act(del, async () => { await CR.api('/api/admin/academy/lessons/' + l.id, { method: 'DELETE' }); CR.go('admin-course/' + l.course_id); }); });
});

// ---------- Admin: certificates (read only; corrections are notes) ----------
CR.route('admin-certificates', async () => {
  CR.view(`<div class="owner-only" style="padding:4px"><h1>Certificates <span class="owner-tag">Admin</span></h1><p class="small muted">Issued certificates can’t be changed or deleted. To correct one, add a note; it shows on the public check too.</p>
    <div class="filters"><input type="search" id="q" placeholder="Search by ID, name, email, or course" aria-label="Search certificates" style="min-width:320px"></div><div id="list"></div></div>`);
  let t; const draw = async () => { const d = await CR.api('/api/admin/academy/certificates?q=' + encodeURIComponent($('#q').value));
    $('#list').innerHTML = CR.table(['ID', 'Name', 'Email', 'Course', 'Version', 'Issued', 'Expires', 'Status', 'Notes'], d.certificates.map(c => `<tr><td><a href="#admin-cert/${esc(c.id)}">${esc(c.id)}</a></td><td>${esc(c.recipient_name)}</td><td>${esc(c.email)}</td><td>${esc(c.course_title)}</td><td>${esc(c.course_version || '')}</td>
      <td data-sort="${esc(c.issued_at)}">${esc(CR.day(c.issued_at))}</td><td data-sort="${esc(c.expires_at || '9999')}">${c.expires_at ? esc(CR.day(c.expires_at)) : 'Never'}</td><td>${c.status}</td><td>${c.notes || ''}</td></tr>`), { empty: 'No certificates issued yet.' }); };
  $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(draw, 250); }); draw();
});
CR.route('admin-cert', async id => {
  const d = await CR.api('/api/admin/academy/certificates/' + encodeURIComponent(id)), c = d.certificate;
  CR.view(`<div class="owner-only" style="padding:4px"><p class="small"><a href="#admin-certificates">Certificates</a></p><h1>${esc(c.id)} <span class="owner-tag">Admin</span></h1>
    <table class="kv"><tr><th>Name</th><td>${esc(c.recipient_name)} (${esc(c.email)})</td></tr><tr><th>Course</th><td>${esc(c.course_title)}</td></tr><tr><th>Version</th><td>${esc(c.course_version || '')}</td></tr>
    <tr><th>Issued</th><td>${esc(CR.when(c.issued_at))}</td></tr><tr><th>Expires</th><td>${c.expires_at ? esc(CR.day(c.expires_at)) : 'Never'}</td></tr><tr><th>Status</th><td>${c.status}</td></tr>
    ${d.attempt ? `<tr><th>Passing quiz</th><td>${d.attempt.score}/${d.attempt.total} (${d.attempt.percent}%, pass mark ${d.attempt.pass_mark}%) on ${esc(CR.when(d.attempt.taken_at))}</td></tr>` : ''}</table>
    <p><a href="/certificate/${esc(c.id)}" target="_blank" rel="noopener">Open the certificate</a> · <a href="/verify/${esc(c.id)}" target="_blank" rel="noopener">Public check</a></p>
    <h2>Notes</h2>${d.notes.length ? `<ul>${d.notes.map(n => `<li>${esc(CR.when(n.created_at))} (${esc(n.by_email || '')}): ${esc(n.note)}</li>`).join('')}</ul>` : '<p class="small muted">No notes.</p>'}
    <form id="nf" class="form"><label for="nn">Add a note (it can’t be edited or removed later)</label><textarea id="nn" name="note"></textarea><div><button class="btn">Add note</button></div></form></div>`);
  $('#nf').addEventListener('submit', e => { e.preventDefault(); CR.act(e.submitter, async () => { await CR.api(`/api/admin/academy/certificates/${encodeURIComponent(c.id)}/notes`, { body: CR.formData(e.target) }); render(); }); });
});

// ---------- Admin: webinars ----------
CR.route('admin-webinars', async (editId) => {
  const d = await CR.api('/api/webinars'), e0 = editId ? d.events.find(x => String(x.id) === editId) || null : null;
  const f = e0 || { duration_min: 60 };
  CR.view(`<div class="owner-only" style="padding:4px"><h1>Manage webinars <span class="owner-tag">Admin</span></h1>
    <p class="small muted">Times are typed in your time zone (${esc(CR.tz)}) and shown to each student in theirs. ${d.zoom ? 'Zoom is connected: a webinar without a link gets a Zoom meeting.' : 'Zoom isn’t connected, so paste the meeting link yourself.'}</p>
    <form id="wf" class="form card"><h2>${e0 ? 'Edit: ' + esc(e0.title) : 'New webinar'}</h2>
      <div><label for="t">Title</label><input id="t" type="text" name="title" value="${esc(f.title || '')}" required></div>
      <div class="three"><div><label for="sa">Starts</label><input id="sa" type="datetime-local" name="starts_local" value="${esc(CR.toInput(f.starts_at))}" required></div>
        <div><label for="du">Minutes</label><input id="du" type="number" name="duration_min" value="${f.duration_min}"></div>
        <div><label for="tp">Topic</label><select id="tp" name="topic"><option value="">None</option>${CR.opts(d.topics, f.topic)}</select></div></div>
      <div><label for="de">Description</label><textarea id="de" name="description">${esc(f.description || '')}</textarea></div>
      <div class="three"><div><label for="ho">Host</label><input id="ho" type="text" name="host" value="${esc(e0 ? f.host : '')}"></div><div><label for="li">Meeting link</label><input id="li" type="url" name="link" value="${esc(f.link || '')}" placeholder="https://"></div>
        <div><label for="ce">CE credits</label><input id="ce" type="number" step="0.1" name="ce_credits" value="${f.ce_credits ?? ''}"></div></div>
      <div class="two"><label class="check"><input type="checkbox" name="elite_only" ${f.elite_only ? 'checked' : ''}> Elite members only</label>
        <div><div class="lbl-line"><label for="fu">Free for everyone until</label><span class="muted">then Elite only</span></div><input id="fu" type="date" name="free_until" value="${esc(f.free_until || '')}"></div></div>
      ${CR.videoField('recording', f.recordingToken, 'recording_url', f.recording_url, 'Recording')}
      <div><label for="an">Team notes (students never see these)</label><textarea id="an" name="admin_notes">${esc(f.admin_notes || '')}</textarea></div>
      <div class="row"><button class="btn">${e0 ? 'Save changes' : 'Add webinar'}</button>${e0 ? '<a class="btn alt" href="#admin-webinars">New webinar instead</a> <button type="button" class="btn danger" id="delW">Delete</button>' : ''}</div></form>
    <h2 style="margin-top:16px">All webinars</h2>
    ${CR.table(['When', 'Title', 'Signed up', 'Attended', 'Rating', 'Recording', ''], d.events.slice().reverse().map(e => `<tr><td data-sort="${esc(e.starts_at)}">${esc(CR.when(e.starts_at))}</td><td>${esc(e.title)}${e.elite_only ? ' <span class="tag elite">Elite</span>' : ''}</td><td>${e.rsvps}</td><td>${e.attendedCount}</td><td>${e.ratings ? e.avgStars + ' (' + e.ratings + ')' : ''}</td><td>${e.hasRecording ? 'Yes' : ''}</td>
      <td><a class="btn alt small" href="#admin-webinars/${e.id}">Edit</a> <button class="btn alt small" data-people="${e.id}">People</button></td></tr>`), { empty: 'No webinars yet.' })}
    <section id="peopleBox"></section></div>`);
  $('#wf').addEventListener('submit', ev => { ev.preventDefault(); CR.act(ev.submitter, async () => { const b = CR.formData(ev.target); b.starts_at = CR.fromInput(b.starts_local);
    const r = await CR.api('/api/webinars' + (e0 ? '/' + e0.id : ''), { method: e0 ? 'PUT' : 'POST', body: b }); if (r.zoom) alert(r.zoom); CR.go('admin-webinars'); }); });
  const del = $('#delW'); if (del) del.addEventListener('click', () => { if (confirm('Delete this webinar? Sign-ups and ratings go with it.')) CR.act(del, async () => { await CR.api('/api/webinars/' + e0.id, { method: 'DELETE' }); CR.go('admin-webinars'); }); });
  CR.onView('click', ev => { const b = ev.target.closest('[data-people]'); if (!b) return; CR.act(b, async () => {
    const id = b.dataset.people, p = await CR.api(`/api/webinars/${id}/people`), ev0 = d.events.find(x => String(x.id) === id);
    $('#peopleBox').innerHTML = `<div class="card" style="margin-top:12px"><h2>${esc(ev0.title)}: people</h2>
      <form id="rep" class="row"><label for="rf">Zoom attendance report (CSV or Excel)</label><input id="rf" type="file" name="file" accept=".csv,.xlsx,.xls" style="width:auto"><button class="btn small">Upload</button></form>
      <p class="small muted">Anyone whose email matches an account and who stayed at least ${Math.round(d.fullShare * 100)}% of the time counts as attended.</p>
      ${CR.table(['Name', 'Email', 'Signed up', 'Minutes', 'Attended'], p.people.map(x => `<tr><td>${esc([x.name, x.last_name].filter(Boolean).join(' '))}</td><td>${esc(x.email)}</td><td>${esc(CR.day(x.rsvp_at))}</td><td>${x.minutes ?? ''}</td><td>${x.attended ? 'Yes' : ''}</td></tr>`), { empty: 'Nobody signed up yet.' })}</div>`;
    $('#rep').addEventListener('submit', e2 => { e2.preventDefault(); CR.act(e2.submitter, async () => { const r = await CR.api(`/api/webinars/${id}/report`, { body: new FormData(e2.target) });
      alert(`${r.full} attended the whole webinar, ${r.partial} left early, ${r.unknown} emails didn’t match an account.`); b.click(); }); });
  }); });
});

// ---------- Admin: people and settings ----------
CR.route('people', async () => {
  CR.view(`<div class="owner-only" style="padding:4px"><h1>People <span class="owner-tag">Admin</span></h1><div class="filters"><input type="search" id="q" placeholder="Search by name or email" aria-label="Search people" style="min-width:280px"></div><div id="list"></div></div>`);
  let t; const draw = async () => { const d = await CR.api('/api/auth/people?q=' + encodeURIComponent($('#q').value));
    $('#list').innerHTML = CR.table(['Name', 'Email', 'Joined', 'Emails', 'Elite', 'Admin'], d.people.map(p => `<tr><td>${esc([p.name, p.last_name].filter(Boolean).join(' '))}</td><td>${esc(p.email)}</td><td data-sort="${esc(p.created_at)}">${esc(CR.day(p.created_at))}</td><td>${p.email_on ? 'On' : 'Off'}</td>
      <td><label class="check"><input type="checkbox" data-elite="${p.id}" ${p.is_elite ? 'checked' : ''}> Elite</label></td><td>${p.is_owner ? 'Admin' : ''}</td></tr>`), { empty: 'Nobody yet.' }); };
  $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(draw, 250); });
  $('#list').addEventListener('change', e => { const c = e.target.closest('[data-elite]'); if (c) CR.api('/api/auth/people/' + c.dataset.elite, { method: 'PUT', body: { elite: c.checked } }).catch(err => alert(err.message)); });
  draw();
});
CR.route('settings', async () => {
  const d = await CR.api('/api/settings'), s = d.settings, on = v => v ? '<strong style="color:var(--good)">Set up</strong>' : '<span class="muted">Not set up</span>';
  CR.view(`<div class="owner-only" style="padding:4px"><h1>Settings <span class="owner-tag">Admin</span></h1>
    <form id="sf" class="form card"><div class="two"><div><label for="sn">Site name</label><input id="sn" type="text" name="site_name" value="${esc(s.site_name)}"></div><div><label for="su">Public website</label><input id="su" type="url" name="site_url" value="${esc(s.site_url)}"></div></div>
      <div class="two"><div><label for="bh">Brand hashtag (first on every social post)</label><input id="bh" type="text" name="brand_hashtag" value="${esc(s.brand_hashtag)}"></div>
        <div><div class="lbl-line"><label for="tz">Business time zone</label><span class="muted">for posting slots and Zoom</span></div><input id="tz" type="text" name="timezone" value="${esc(s.timezone)}"></div></div>
      <label class="check"><input type="checkbox" name="open_signup" ${s.open_signup === '1' ? 'checked' : ''}> Anyone can create a free student account</label>
      <div><button class="btn">Save settings</button></div></form>
    <div class="card" style="margin-top:12px"><h2>Connections</h2><p class="small muted">These are set in the server’s environment (see .env.example), never typed here.</p>
      <table class="kv"><tr><th>Email (SMTP)</th><td>${on(d.env.email)}${d.env.email ? '' : ' · emails are printed in the server log instead'}</td></tr><tr><th>Video storage</th><td>${on(d.env.video)}${d.env.video ? '' : ' · videos are saved on the server itself'}</td></tr>
      <tr><th>Zoom</th><td>${on(d.env.zoom)}</td></tr><tr><th>AI (Anthropic)</th><td>${on(d.env.ai)}</td></tr><tr><th>Semrush</th><td>${on(d.env.semrush)}</td></tr><tr><th>WordPress key (SITE_KEY)</th><td>${on(d.env.siteKey)}</td></tr><tr><th>App address (APP_URL)</th><td>${esc(d.env.appUrl || 'Not set')}</td></tr></table></div></div>`);
  $('#sf').addEventListener('submit', e => { e.preventDefault(); CR.act(e.submitter, () => CR.api('/api/settings', { method: 'PUT', body: CR.formData(e.target) }), 'Saved.'); });
});
})();
