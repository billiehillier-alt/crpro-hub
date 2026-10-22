// Smoke test: starts nothing itself. Run the server on an empty, throwaway data folder first, then:
//   node test/smoke.js http://localhost:4310
// It creates the owner and a student, walks the Academy (fail once, pass once, certificate, public verify), Webinars
// (create, RSVP, ICS), and pokes the other features' endpoints. Never point it at real data.
const BASE = process.argv[2] || 'http://localhost:4310';
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
function client() {
  let cookie = '';
  const call = async (path, { method, body, raw, headers } = {}) => {
    const h = { ...(headers || {}) }; if (cookie) h.Cookie = cookie;
    let b; if (body instanceof FormData) b = body; else if (body !== undefined) { h['Content-Type'] = 'application/json'; b = typeof body === 'string' ? body : JSON.stringify(body); }
    const r = await fetch(BASE + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: h, body: b, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; for (const c of sc) { const m = /^(crp_session=[^;]*)/.exec(c); if (m) cookie = m[1]; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  return { call };
}
module.exports = { client, check, results, BASE };
if (require.main !== module) return;
(async () => {
  const owner = client(), student = client(), anon = client();
  let r = await owner.call('/api/auth/setup', { body: { email: 'owner@example.com', password: 'owner-password-123', name: 'Owner' } });
  check('Create owner on first run', r.status === 200, r.text.slice(0, 80));
  r = await anon.call('/api/auth/setup', { body: { email: 'x@example.com', password: 'another-password-1' } });
  check('Setup page refuses a second owner', r.status === 400);
  r = await owner.call('/api/auth/logout', { body: {} });
  r = await owner.call('/api/auth/login', { body: { email: 'owner@example.com', password: 'owner-password-123' } });
  check('Owner logs in', r.status === 200);
  r = await anon.call('/api/academy/courses'); check('API needs sign-in', r.status === 401);
  r = await student.call('/api/auth/signup', { body: { email: 'student@example.com', password: 'student-password-1', name: 'Sam', lastName: 'Student' } });
  check('Student signs up', r.status === 200, r.text.slice(0, 80));
  r = await student.call('/api/admin/academy/courses'); check('Student blocked from admin', r.status === 403);

  // Academy
  r = await owner.call('/api/admin/academy/courses'); const seeded = r.json.courses;
  check('Course list seeded as drafts (61 + sample)', seeded.length === 62 && seeded.filter(c => c.status === 'draft').length === 61, `${seeded.length} courses`);
  check('Second copy skipped', !seeded.some(c => /second copy/i.test(c.title)));
  const gcp = seeded.find(c => /^Good Clinical Practice ICH GCP E6\(R3\)$/.test(c.title)); check('GCP course: version, 36 months, GCP code', gcp && gcp.version === 'ICH E6(R3)' && gcp.certificate_valid_months === 36 && gcp.code === 'GCP');
  const pmp = seeded.find(c => /PMI-Authorized PMP Prep Course/.test(c.title)); check('PDUs split from title', pmp && pmp.pdus === 35 && pmp.title === 'PMI-Authorized PMP Prep Course');
  r = await owner.call('/api/admin/academy/courses', { body: { title: 'Smoke GCP Course', status: 'published', access: 'free', certificate: true, certificate_valid_months: 36, pass_mark: 100, version: 'ICH E6(R3)', cert_code: 'GCP', ce_credits: 1 } });
  const cid = r.json.id; check('Create course', !!cid);
  r = await owner.call(`/api/admin/academy/courses/${cid}/modules`, { body: { title: 'Module 1' } }); const mid = r.json.id; check('Create module', !!mid);
  r = await owner.call(`/api/admin/academy/courses/${cid}/lessons`, { body: { title: 'Intro', module_id: mid, status: 'published', transcript: 'Hello', video_url: 'https://example.com/video.mp4' } }); const l1 = r.json.id; check('Create lesson', !!l1);
  r = await owner.call(`/api/admin/academy/courses/${cid}/lessons`, { body: { title: 'Final quiz', module_id: mid, status: 'published', is_final: true, quiz: 'Q: Who approves a study?\n- Sponsor\n* IRB\n\nQ: GCP renews every?\n- 1 year\n* 3 years' } }); const l2 = r.json.id; check('Create lesson with quiz', !!l2);
  r = await student.call('/api/academy/lessons/' + l2); check('Quiz questions sent without answers', r.json && r.json.quiz.length === 2 && r.json.quiz.every(q => !('answer' in q)));
  r = await student.call(`/api/academy/lessons/${l1}/done`, { body: {} }); check('Mark lesson done', r.status === 200);
  r = await student.call(`/api/academy/lessons/${l2}/quiz`, { body: { answers: [0, 1] } }); check('Quiz attempt 1 fails', r.status === 200 && r.json.passed === false && !r.json.certificate, `${r.json && r.json.percent}%`);
  r = await student.call(`/api/academy/lessons/${l2}/quiz`, { body: { answers: [1, 1] } }); const cert = r.json && r.json.certificate;
  check('Quiz attempt 2 passes and issues certificate', r.json && r.json.passed && cert && /^CRP-GCP-\d{2}-\d{5}$/.test(cert.id), cert && cert.id);
  check('Certificate stamped with version and 36-month expiry', cert && cert.course_version === 'ICH E6(R3)' && cert.expires_at && (new Date(cert.expires_at).getFullYear() - new Date(cert.issued_at).getFullYear()) === 3);
  r = await owner.call(`/api/admin/academy/courses/${cid}`); check('Both attempts stored', r.json.attempts.length === 2 && r.json.attempts.filter(a => a.passed).length === 1);
  r = await student.call(`/api/academy/lessons/${l2}/quiz`, { body: { answers: [1, 1] } }); check('Passing again does not issue a duplicate', r.json && !r.json.certificate);
  r = await anon.call('/api/verify/' + cert.id); check('Public verify API without login', r.status === 200 && r.json.found && r.json.status === 'valid' && r.json.name === 'Sam Student');
  r = await anon.call('/verify/' + cert.id); check('Public verify page without login', r.status === 200 && r.text.includes('Valid certificate') && r.text.includes(cert.id));
  r = await anon.call('/verify/CRP-XXX-00-00000'); check('Unknown certificate shows not found', r.status === 404 && r.text.includes('No certificate found'));
  for (const [m, p] of [['PUT', '/api/admin/academy/certificates/' + cert.id], ['DELETE', '/api/admin/academy/certificates/' + cert.id], ['PATCH', '/api/admin/academy/certificates/' + cert.id], ['DELETE', '/api/verify/' + cert.id], ['PUT', '/api/academy/my/certificates/' + cert.id]]) {
    r = await owner.call(p, { method: m, body: m === 'DELETE' ? undefined : { recipient_name: 'Changed' } });
    check(`No ${m} route changes a certificate (${p.replace(cert.id, ':id')})`, r.status === 404);
  }
  r = await anon.call('/api/verify/' + cert.id); check('Certificate unchanged afterwards', r.json.name === 'Sam Student');
  r = await owner.call(`/api/admin/academy/certificates/${cert.id}/notes`, { body: { note: 'Smoke test note.' } }); check('Correction note can be added', r.status === 200);
  r = await owner.call(`/api/admin/academy/courses/${cid}`, { method: 'DELETE' }); check('Course with records cannot be deleted', r.status === 400);
  r = await owner.call(`/api/admin/academy/lessons/${l2}`, { method: 'DELETE' }); check('Lesson with quiz attempts cannot be deleted', r.status === 400);
  r = await student.call('/api/academy/my/transcript.csv'); check('Transcript CSV download', r.status === 200 && r.text.includes(cert.id) && /text\/csv/.test(r.headers.get('content-type')));
  r = await student.call('/certificate/' + cert.id); check('Certificate page shows the placeholder note', r.status === 200 && r.text.includes("Placeholder: Jess's approved template goes here"));

  // Webinars
  const start = new Date(Date.now() + 3 * 864e5).toISOString();
  r = await owner.call('/api/webinars', { body: { title: 'Smoke webinar, with a comma; and semicolon', starts_at: start, duration_min: 60, link: 'https://example.com/meet', topic: 'Regulatory', description: 'Line one\nLine two' } });
  const wid = r.json && r.json.id; check('Create webinar', !!wid, r.text.slice(0, 80));
  r = await student.call('/api/webinars'); let ev = r.json.events.find(e => e.id === wid); check('Student sees webinar; no join link before RSVP', ev && !ev.link);
  r = await student.call(`/api/webinars/${wid}/rsvp`, { body: { going: true } }); check('RSVP', r.status === 200);
  r = await student.call('/api/webinars'); ev = r.json.events.find(e => e.id === wid); check('Join link and calendar links after RSVP', ev.going && ev.link === 'https://example.com/meet' && ev.links.google.includes('calendar.google.com') && ev.links.outlook.includes('outlook'));
  r = await student.call(`/api/webinars/${wid}/ics`); check('ICS file', r.status === 200 && r.text.startsWith('BEGIN:VCALENDAR') && r.text.includes('DTSTART:') && r.text.includes('SUMMARY:Smoke webinar\\, with a comma\\; and semicolon') && /text\/calendar/.test(r.headers.get('content-type')));
  r = await owner.call('/api/webinars', { body: { title: 'Elite only', starts_at: start, elite_only: true, link: 'https://example.com/elite' } }); const eid = r.json.id;
  r = await student.call(`/api/webinars/${eid}/rsvp`, { body: { going: true } }); check('Elite-only webinar blocks non-Elite RSVP', r.status === 403);
  r = await owner.call('/api/webinars/zoom/status'); check('Zoom status answers "not set up" without keys', r.status === 200 && r.json.on === false);

  // SEO: the signed WordPress push, an export upload, the plan, a draft request, the article map.
  if (process.env.SITE_KEY) {
    const crypto = require('crypto'), sign = b => { const ts = Math.floor(Date.now() / 1000); return { 'X-CRPro-Timestamp': String(ts), 'X-CRPro-Signature': 'sha256=' + crypto.createHmac('sha256', process.env.SITE_KEY).update(ts + '.' + b).digest('hex') }; };
    const body = JSON.stringify({ articles: [{ id: 101, title: 'GCP Training: The Complete Guide to ICH E6(R3)', status: 'publish', url: 'https://example.org/gcp-training/', keyphrase: 'gcp training', text: 'Good clinical practice training for sites and CRCs.', date_gmt: new Date().toISOString() },
      { id: 102, title: 'How to Become a Clinical Research Coordinator', status: 'draft', url: '', edit: 'https://example.org/wp-admin/post.php?post=102&action=edit', keyphrase: 'become a crc', text: 'CRC career steps.' }] });
    r = await anon.call('/api/site/articles', { body, headers: sign(body) }); check('Signed WordPress article push accepted', r.status === 200 && r.json.articles === 2, r.text.slice(0, 80));
    r = await anon.call('/api/site/articles', { body, headers: { ...sign(body), 'X-CRPro-Signature': 'sha256=' + '0'.repeat(64) } }); check('Badly signed push refused', r.status === 403);
    const csv = 'Keyword,Position,Search Volume,Keyword Difficulty,URL\ngcp training,4,1900,40,https://example.org/gcp-training/\ngcp training online free,9,320,30,\nhow to become a clinical research coordinator,15,880,35,\nraspberry pi projects,50,9000,20,\n';
    r = await owner.call('/api/seo/upload', { body: { name: 'semrush-competitor.csv', text: csv, whose: 'competitor', competitor: 'example.net' } });
    check('Semrush CSV upload (competitor)', r.status === 200 && r.json.rows === 4, r.text.slice(0, 100));
    check('Off-topic term set aside', r.json && r.json.offtopic === 1);
    r = await owner.call('/api/seo/plan'); const g = r.json && r.json.groups.find(x => x.key === 'gcp training');
    check('SEO plan groups terms and matches an article', g && g.article && g.article.id === 101 && (g.children || []).some(c => c.key === 'gcp training online free'), g && JSON.stringify(g.article));
    r = await owner.call('/api/seo/plan/request', { body: { key: 'how to become a clinical research coordinator', title: 'How to Become a CRC' } }); check('Request a draft from the plan', r.status === 200);
    const rb = ''; r = await anon.call('/api/site/requests', { headers: sign(rb) }); check('WordPress reads waiting draft requests (signed)', r.status === 200 && r.json.requests.some(i => i.keyphrase === 'how to become a clinical research coordinator'));
    r = await owner.call('/api/articlemap/missing', { body: { title: 'GOOD CLINICAL PRACTICE', kind: 'header' } }); const hid = r.json && r.json.id; check('Article map: add a header', !!hid);
    r = await owner.call('/api/articlemap/match', { body: {} }); check('Article map: match articles to headers', r.status === 200 && r.json.total === 1, r.text.slice(0, 100));
    r = await owner.call('/api/articlemap/missing', { body: { title: 'GCP Renewal FAQ', parent: hid } }); const mid2 = r.json && r.json.id;
    r = await owner.call(`/api/articlemap/missing/${mid2}/draft`, { body: { keyphrase: 'gcp renewal' } }); check('Article map: request a draft for a missing card', r.status === 200, r.text.slice(0, 80));
    r = await owner.call('/api/ideas'); check('Article ideas list has both requests', r.status === 200 && r.json.ideas.length >= 2);

    // Social: plan posts for the live article by hand (no AI key), tracked link, clicks, approval.
    r = await owner.call('/api/social/article/101'); check('Social planner suggests a time per platform', r.status === 200 && r.json.platforms.linkedin.suggestAt);
    const at = new Date(Date.now() + 2 * 864e5).toISOString();
    r = await owner.call('/api/social/article/101', { body: { windows: [{ platform: 'linkedin', on: true, text: 'Need GCP training? Read the guide: https://example.org/gcp-training/', hashtags: '#GCP', at }, { platform: 'x', on: true, text: 'GCP basics https://example.org/gcp-training/', hashtags: '', at }] } });
    check('Schedule posts for an article', r.status === 200 && r.json.saved === 2, r.text.slice(0, 80));
    r = await owner.call('/api/social'); const post = r.json.posts.find(p => p.platform === 'linkedin');
    check('Brand hashtag added first, tracked link swapped in', post && post.hashtags.startsWith('#ClinicalResearchPro') && post.text.includes('/l/' + post.code), post && post.hashtags);
    r = await anon.call('/l/' + post.code, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' } }); check('Tracked link redirects with UTM tags', r.status === 302 && /utm_source=linkedin/.test(r.headers.get('location')));
    r = await anon.call('/l/' + post.code, { headers: { 'User-Agent': 'LinkedInBot/1.0' } });
    r = await owner.call('/api/social/' + post.id); check('Robot visit not counted (1 click)', r.json.post.clicks === 1, String(r.json.post.clicks));
    r = await owner.call('/api/social/' + post.id, { method: 'PUT', body: { status: 'posted' } }); check('Mark a post as posted', r.status === 200);
    r = await owner.call('/api/social/results'); check('Results count the click', r.status === 200 && r.json.total30 === 1);
    r = await owner.call('/api/social/oauth/x/start'); check('Connect without keys explains what is missing', r.status === 302 && /X_CLIENT_ID/.test(decodeURIComponent(r.headers.get('location') || '')));
  }

  // Other features: they should answer, and say "not set up" where keys are missing.
  for (const p of ['/api/seo', '/api/seo/semrush', '/api/seo/plan', '/api/seo/plan?tree=1&by=topic', '/api/seo/bands', '/api/articlemap', '/api/ideas', '/api/social', '/api/social/results', '/api/social/coverage', '/api/social/connections', '/api/settings']) {
    r = await owner.call(p); check(`GET ${p} answers`, r.status === 200, r.status + ' ' + r.text.slice(0, 60));
  }
  r = await owner.call('/api/seo/plan/topics', { body: {} }); check('SEO topic map says the AI key is missing', r.status === 400 && /ANTHROPIC_API_KEY/.test(r.json.error), r.json && r.json.error);
  r = await owner.call('/api/seo/semrush', { body: { mode: 'mine' } }); check('Semrush import says it is not set up', r.status === 400 && /SEMRUSH_API_KEY/.test(r.json.error));
  r = await owner.call('/api/social/draft', { body: { post_id: 1, platforms: ['x'] } }); check('Social draft explains missing article or key (no crash)', r.status === 400 && r.json && r.json.error, r.json && r.json.error);
  r = await student.call('/api/seo'); check('Student blocked from SEO', r.status === 403);
  r = await anon.call('/api/site/articles', { body: { articles: [] } }); check('Unsigned WordPress push refused', r.status === 403 || r.status === 503);

  const fails = results.filter(x => !x.ok).length;
  console.log(`\n${results.length - fails} passed, ${fails} failed`);
  process.exitCode = fails ? 1 : 0;
})().catch(err => { console.error(err); process.exitCode = 1; });
