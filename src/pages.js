// Pages the server writes out itself: the public "verify a certificate" page and the printable certificate.
const { getSetting } = require('./db');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nice = d => d ? new Date(d.length === 10 ? d + 'T12:00:00Z' : d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '';
const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/logo.png"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/style.css"></head>
<body class="plain"><div class="stripe"></div><main class="plain-main">${body}</main></body></html>`;

function verifyPage(v, id, error) {
  const site = esc(getSetting('site_name'));
  const result = error ? `<p class="msg err">${esc(error)}</p>`
    : v === undefined ? ''
    : !v ? `<div class="verify-result bad"><h2>No certificate found</h2><p>No certificate has the ID <strong>${esc(String(id || '').toUpperCase())}</strong>. Check the ID and try again.</p></div>`
    : `<div class="verify-result ${v.status === 'valid' ? 'good' : 'bad'}"><h2>${v.status === 'valid' ? 'Valid certificate' : 'Expired certificate'}</h2>
      <table class="kv"><tr><th>Certificate ID</th><td>${esc(v.id)}</td></tr><tr><th>Issued to</th><td>${esc(v.name)}</td></tr><tr><th>Course</th><td>${esc(v.course)}</td></tr>
      ${v.version ? `<tr><th>Version</th><td>${esc(v.version)}</td></tr>` : ''}${v.ce_credits != null ? `<tr><th>CE credits</th><td>${esc(v.ce_credits)}</td></tr>` : ''}${v.pdus != null ? `<tr><th>PDUs</th><td>${esc(v.pdus)}</td></tr>` : ''}
      <tr><th>Issued</th><td>${esc(nice(v.issued))}</td></tr><tr><th>Expires</th><td>${v.expires ? esc(nice(v.expires)) : 'Does not expire'}</td></tr></table>
      ${v.notes.length ? `<h3>Notes on this record</h3><ul>${v.notes.map(n => `<li>${esc(nice(n.created_at.slice(0, 10)))}: ${esc(n.note)}</li>`).join('')}</ul>` : ''}</div>`;
  return shell(`Verify a certificate | ${getSetting('site_name')}`, `<div class="plain-head"><img src="/logo.png" alt="${site} logo" width="72" height="72"><div><h1>Verify a certificate</h1><p>${site}. Type the certificate ID to check it.</p></div></div>
    <form method="get" action="/verify" class="verify-form"><label for="vid">Certificate ID</label><div class="row"><input id="vid" name="id" placeholder="CRP-GCP-26-04271" value="${esc(id || '')}" autocomplete="off" required><button class="btn">Check</button></div></form>
    ${result}`);
}

// Placeholder layout. Jess's approved certificate template must be copied exactly from her file; only the variable fields
// (name, course, version, ID, dates, credits) come from here.
function certificatePage(c, base) {
  const site = esc(getSetting('site_name'));
  return shell(`Certificate ${c.id}`, `<div class="noprint placeholder-banner">Placeholder: Jess's approved template goes here. This layout only shows which details fill in.</div>
  <p class="noprint"><button class="btn" onclick="print()">Print or save as PDF</button> <a href="/#certificates">Back to My certificates</a></p>
  <section class="cert-sheet"><div class="cert-ph-tag">PLACEHOLDER LAYOUT</div><img src="/logo.png" alt="${site} logo" width="110" height="110">
    <p class="cert-small">${site} certifies that</p><h1 class="cert-name">${esc(c.recipient_name)}</h1><p class="cert-small">has completed</p>
    <h2 class="cert-course">${esc(c.course_title)}</h2>${c.course_version ? `<p>Version: ${esc(c.course_version)}</p>` : ''}
    <p>${c.ce_credits != null ? `${esc(c.ce_credits)} CE credit${c.ce_credits == 1 ? '' : 's'}` : ''}${c.ce_credits != null && c.pdus != null ? ' · ' : ''}${c.pdus != null ? `${esc(c.pdus)} PDUs` : ''}</p>
    <div class="cert-meta"><div><strong>Issued</strong><br>${esc(nice(c.issued_at))}</div><div><strong>Expires</strong><br>${c.expires_at ? esc(nice(c.expires_at)) : 'Does not expire'}</div><div><strong>Certificate ID</strong><br>${esc(c.id)}</div></div>
    <p class="cert-small">Check this certificate at ${esc(base)}/verify/${esc(c.id)}</p></section>`);
}
module.exports = { verifyPage, certificatePage, esc };
