// Academy (the LMS), adapted from psyrenne's School (src/school.js). Real structure: courses → modules → lessons.
// A lesson has a video (an upload, see media.js, or a plain link), a transcript, resources, an optional quiz in plain text,
// and an optional open date (drip). Progress is kept per lesson.
// GCP-ready records: every quiz attempt is stored and can never be changed or deleted (database triggers enforce it).
// A certificate is issued when every published lesson is done and the final quiz is passed. Issued certificates can't be
// changed or deleted either; corrections go in certificate_notes (also add-only). Anyone can check one at /verify.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, tx, getSetting, setSetting } = require('./db');
const { ownerOnly, isElite, nameOf, appUrl } = require('./auth');
const media = require('./media');
const mailer = require('./mailer');
const { parseCsv, toCsv } = require('./csv');

db.exec(`
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, summary TEXT,
  access TEXT NOT NULL DEFAULT 'free',              -- free | paid | elite
  price REAL, ce_credits REAL, pdus REAL, instructor TEXT, categories TEXT,
  status TEXT NOT NULL DEFAULT 'draft',             -- draft | published
  version TEXT,                                     -- e.g. ICH E6(R3); stamped on each certificate
  certificate INTEGER NOT NULL DEFAULT 1, certificate_valid_months INTEGER, pass_mark INTEGER NOT NULL DEFAULT 80,
  cert_code TEXT,                                   -- the short code in certificate IDs, like GCP in CRP-GCP-26-04271
  note TEXT, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE, title TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL, title TEXT NOT NULL, summary TEXT,
  video TEXT, video_url TEXT, transcript TEXT, resources TEXT, quiz TEXT, is_final INTEGER NOT NULL DEFAULT 0,
  opens_on TEXT, minutes INTEGER, sort INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS lesson_progress (user_id INTEGER NOT NULL, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  done_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, lesson_id));
CREATE TABLE IF NOT EXISTS course_grants (user_id INTEGER NOT NULL, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  granted_by INTEGER, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, course_id));
CREATE TABLE IF NOT EXISTS lesson_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL, body TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- Audit records. No foreign keys on purpose: they outlive any course or lesson edit.
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, course_id INTEGER NOT NULL, lesson_id INTEGER NOT NULL,
  course_version TEXT, score INTEGER NOT NULL, total INTEGER NOT NULL, percent INTEGER NOT NULL, pass_mark INTEGER NOT NULL,
  passed INTEGER NOT NULL, answers TEXT NOT NULL, questions TEXT NOT NULL, taken_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, course_id INTEGER NOT NULL, recipient_name TEXT NOT NULL,
  course_title TEXT NOT NULL, course_version TEXT, ce_credits REAL, pdus REAL, attempt_id INTEGER,
  issued_at TEXT NOT NULL, expires_at TEXT);
CREATE TABLE IF NOT EXISTS certificate_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, certificate_id TEXT NOT NULL, note TEXT NOT NULL,
  by_user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS cert_reminders (certificate_id TEXT NOT NULL, kind TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (certificate_id, kind));

CREATE TRIGGER IF NOT EXISTS quiz_attempts_no_update BEFORE UPDATE ON quiz_attempts BEGIN SELECT RAISE(ABORT, 'Quiz attempts are permanent records and cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS quiz_attempts_no_delete BEFORE DELETE ON quiz_attempts BEGIN SELECT RAISE(ABORT, 'Quiz attempts are permanent records and cannot be deleted.'); END;
CREATE TRIGGER IF NOT EXISTS certificates_no_update BEFORE UPDATE ON certificates BEGIN SELECT RAISE(ABORT, 'Issued certificates cannot be changed. Add a note instead.'); END;
CREATE TRIGGER IF NOT EXISTS certificates_no_delete BEFORE DELETE ON certificates BEGIN SELECT RAISE(ABORT, 'Issued certificates cannot be deleted. Add a note instead.'); END;
CREATE TRIGGER IF NOT EXISTS certificate_notes_no_update BEFORE UPDATE ON certificate_notes BEGIN SELECT RAISE(ABORT, 'Certificate notes cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS certificate_notes_no_delete BEFORE DELETE ON certificate_notes BEGIN SELECT RAISE(ABORT, 'Certificate notes cannot be deleted.'); END;
CREATE INDEX IF NOT EXISTS lessons_course ON lessons (course_id, sort);
CREATE INDEX IF NOT EXISTS attempts_user ON quiz_attempts (user_id, course_id);
CREATE INDEX IF NOT EXISTS certs_user ON certificates (user_id, course_id);
`);

// ---------- helpers ----------
const ACCESS = ['elite', 'free', 'paid'];
const clean = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);
const num = v => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const oops = (m, status = 400) => Object.assign(new Error(m), { status });
const wrap = fn => async (req, res) => { try { res.json((await fn(req, res)) || { ok: true }); } catch (err) { if (!err.status) console.error(err); res.status(err.status || 400).json({ error: err.status ? err.message : 'Something went wrong: ' + err.message }); } };
const today = () => new Date().toISOString().slice(0, 10);
const isOwner = req => !!(req.user && req.user.is_owner);

// The quiz is plain text, psyrenne's format: "Q: question", then one line per choice, "* " before the right one, "- " for the others.
function parseQuiz(text) {
  const out = []; let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) { const line = raw.trim(); if (!line) continue;
    if (/^q[:.)]/i.test(line)) { cur = { q: line.replace(/^q[:.)]\s*/i, '').slice(0, 500), options: [], answer: -1 }; out.push(cur); continue; }
    if (cur && /^[*\-•]/.test(line)) { if (line[0] === '*') cur.answer = cur.options.length; cur.options.push(line.replace(/^[*\-•]\s*/, '').slice(0, 300)); } }
  return out.filter(x => x.q && x.options.length >= 2 && x.options.length <= 8 && x.answer >= 0).slice(0, 100);
}
// Resources: one per line, "Title | https://link" or just a link.
const cleanResources = v => String(v || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 30).map(l => { const [t, u] = l.includes('|') ? l.split('|').map(x => x.trim()) : ['', l];
  return /^https?:\/\/\S+$/i.test(u) ? { title: (t || u).slice(0, 160), url: u.slice(0, 500) } : null; }).filter(Boolean);
const resourcesOf = l => { try { return JSON.parse(l.resources || '[]'); } catch { return []; } };
const resourcesText = l => resourcesOf(l).map(r => r.title && r.title !== r.url ? `${r.title} | ${r.url}` : r.url).join('\n');

const courseRow = id => db.prepare('SELECT * FROM courses WHERE id = ?').get(Number(id));
const hasGrant = (userId, courseId) => !!db.prepare('SELECT 1 FROM course_grants WHERE user_id = ? AND course_id = ?').get(userId, courseId);
// Who may open a course: the owner always; students only published courses, and paid or Elite ones need access.
function canOpen(user, c) {
  if (!c) return false; if (user && user.is_owner) return true; if (c.status !== 'published') return false;
  if (c.access === 'free') return true;
  if (c.access === 'elite') return isElite(user) || hasGrant(user.id, c.id);
  return hasGrant(user.id, c.id);
}
const lockReason = c => c.access === 'elite' ? 'Part of Elite membership.' : 'A paid course. Ask the CR Pro team for access.';
const publishedLessons = courseId => db.prepare("SELECT * FROM lessons WHERE course_id = ? AND status = 'published' ORDER BY sort, id").all(courseId);
const doneSet = (userId, courseId) => new Set(db.prepare('SELECT p.lesson_id FROM lesson_progress p JOIN lessons l ON l.id = p.lesson_id WHERE p.user_id = ? AND l.course_id = ?').all(userId, courseId).map(r => r.lesson_id));
// The final quiz: the lesson marked final, else the last published lesson with a quiz.
function finalLesson(courseId) {
  const ls = publishedLessons(courseId).filter(l => parseQuiz(l.quiz).length);
  return ls.find(l => l.is_final) || ls[ls.length - 1] || null;
}
const lockedByDate = (l, req) => !!(l.opens_on && l.opens_on > today() && !isOwner(req));

// ---------- certificates ----------
// "GCP" for Good Clinical Practice courses, "PMP" for PMP ones, else the first letters of the title's main words.
function defaultCode(title) {
  const t = String(title || '');
  if (/\bGCP\b|good clinical practice/i.test(t)) return 'GCP';
  if (/\bPMP\b/i.test(t)) return 'PMP';
  const SMALL = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'with', 'your', 'you', 'vs', 'from', 'all', 'is', 'what', 'how']);
  return t.replace(/\([^)]*\)/g, ' ').split(/[^A-Za-z0-9]+/).filter(w => w && !SMALL.has(w.toLowerCase())).slice(0, 3).map(w => w[0].toUpperCase()).join('') || 'CRP';
}
const certCode = c => (String(c.cert_code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)) || defaultCode(c.title);
function newCertId(c) {
  const yy = new Date().toISOString().slice(2, 4);
  for (;;) { const id = `CRP-${certCode(c)}-${yy}-${String(crypto.randomInt(0, 100000)).padStart(5, '0')}`; if (!db.prepare('SELECT 1 FROM certificates WHERE id = ?').get(id)) return id; }
}
const addMonths = (iso, m) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString(); };
// Issues a certificate if this student has earned one and doesn't already hold a current one. Returns the new one, or null.
// Renewal (GCP every 3 years): once the last one is within 90 days of expiring (or expired), passing the final quiz again
// issues a new certificate with a new ID; the old record stays as it was.
function maybeIssue(userId, courseId) {
  const c = courseRow(courseId); if (!c || !c.certificate) return null;
  const ls = publishedLessons(courseId); if (!ls.length) return null;
  const fin = finalLesson(courseId); if (!fin) return null;   // no final quiz yet: no certificate (the course editor says so)
  const done = doneSet(userId, courseId); if (!ls.every(l => done.has(l.id))) return null;
  const pass = db.prepare('SELECT * FROM quiz_attempts WHERE user_id = ? AND lesson_id = ? AND passed = 1 ORDER BY id DESC LIMIT 1').get(userId, fin.id);
  if (!pass) return null;
  const last = db.prepare('SELECT * FROM certificates WHERE user_id = ? AND course_id = ? ORDER BY issued_at DESC LIMIT 1').get(userId, courseId);
  if (last) {
    const renewWindow = last.expires_at && Date.parse(last.expires_at) - Date.now() < 90 * 864e5;
    const passIso = new Date(pass.taken_at.replace(' ', 'T') + 'Z').toISOString();
    if (!renewWindow || passIso <= last.issued_at) return null;
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId), issued = new Date().toISOString();
  const cert = { id: newCertId(c), user_id: userId, course_id: c.id, recipient_name: nameOf(u), course_title: c.title, course_version: c.version || null,
    ce_credits: c.ce_credits, pdus: c.pdus, attempt_id: pass.id, issued_at: issued, expires_at: c.certificate_valid_months ? addMonths(issued, c.certificate_valid_months) : null };
  db.prepare('INSERT INTO certificates (id, user_id, course_id, recipient_name, course_title, course_version, ce_credits, pdus, attempt_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(cert.id, cert.user_id, cert.course_id, cert.recipient_name, cert.course_title, cert.course_version, cert.ce_credits, cert.pdus, cert.attempt_id, cert.issued_at, cert.expires_at);
  return cert;
}
const certStatus = c => c.expires_at && c.expires_at < new Date().toISOString() ? 'expired' : 'valid';
const certOut = c => ({ ...c, status: certStatus(c) });

// Expiry reminders: 60 days and 7 days before a certificate expires, for students who keep email on. Only the newest
// certificate for each course counts (a renewed one replaces the old reminder).
async function remindExpiring() {
  const rows = db.prepare(`SELECT c.*, u.email, u.name, u.email_on FROM certificates c JOIN users u ON u.id = c.user_id
    WHERE c.expires_at IS NOT NULL AND c.expires_at > ? AND c.expires_at < ?
    AND c.issued_at = (SELECT MAX(issued_at) FROM certificates x WHERE x.user_id = c.user_id AND x.course_id = c.course_id)`).all(new Date().toISOString(), new Date(Date.now() + 60 * 864e5).toISOString());
  for (const c of rows) {
    const days = Math.ceil((Date.parse(c.expires_at) - Date.now()) / 864e5), kind = days <= 7 ? '7' : '60';
    if (db.prepare('SELECT 1 FROM cert_reminders WHERE certificate_id = ? AND kind = ?').get(c.id, kind)) continue;
    db.prepare('INSERT INTO cert_reminders (certificate_id, kind) VALUES (?, ?)').run(c.id, kind);
    if (!c.email_on) continue;
    try { await mailer.send({ to: c.email, subject: `Your ${c.course_title} certificate expires in ${days} days`,
      text: `Hi${c.name ? ' ' + c.name : ''},\n\nYour certificate ${c.id} for "${c.course_title}" expires on ${c.expires_at.slice(0, 10)}.\n\nTo renew it, sign in and take the course's final quiz again. You'll get a new certificate with a new ID.\n\n${(process.env.APP_URL || '').replace(/\/$/, '')}/#academy\n\n${getSetting('site_name')}\n(You can turn these emails off in My account.)` }); }
    catch (err) { console.error('Certificate reminder:', err.message); }
  }
}
setInterval(() => remindExpiring().catch(err => console.error('Certificate reminders:', err.message)), 6 * 3600e3).unref();
setTimeout(() => remindExpiring().catch(() => {}), 90e3).unref();

// ---------- students ----------
const router = express.Router();
const courseBrief = (c, user) => {
  const ls = publishedLessons(c.id), done = doneSet(user.id, c.id);
  return { id: c.id, title: c.title, summary: c.summary || '', access: c.access, price: c.price, ce_credits: c.ce_credits, pdus: c.pdus, instructor: c.instructor || '',
    categories: c.categories || '', status: c.status, version: c.version || '', certificate: !!c.certificate, lessons: ls.length, done: ls.filter(l => done.has(l.id)).length,
    open: canOpen(user, c), lock: canOpen(user, c) ? null : lockReason(c) };
};
router.get('/courses', wrap(req => {
  const rows = db.prepare(`SELECT * FROM courses WHERE status = 'published' ORDER BY sort, title COLLATE NOCASE`).all();
  return { courses: rows.map(c => courseBrief(c, req.user)) };
}));
router.get('/courses/:id', wrap(req => {
  const c = courseRow(req.params.id); if (!c || (c.status !== 'published' && !isOwner(req))) throw oops('That course isn’t here.', 404);
  const open = canOpen(req.user, c), done = doneSet(req.user.id, c.id), fin = finalLesson(c.id);
  const mods = db.prepare('SELECT * FROM modules WHERE course_id = ? ORDER BY sort, id').all(c.id);
  const ls = (isOwner(req) ? db.prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY sort, id').all(c.id) : publishedLessons(c.id))
    .map(l => ({ id: l.id, title: l.title, minutes: l.minutes, module_id: l.module_id, status: l.status, done: done.has(l.id), quiz: parseQuiz(l.quiz).length > 0, final: !!(fin && fin.id === l.id), opens_on: l.opens_on, locked: lockedByDate(l, req) }));
  const certs = db.prepare('SELECT * FROM certificates WHERE user_id = ? AND course_id = ? ORDER BY issued_at DESC').all(req.user.id, c.id).map(certOut);
  return { course: courseBrief(c, req.user), open, modules: mods.map(m => ({ id: m.id, title: m.title })), lessons: ls, certificates: certs, passMark: c.pass_mark };
}));
function lessonFor(req) {
  const l = db.prepare('SELECT * FROM lessons WHERE id = ?').get(Number(req.params.id)); if (!l) throw oops('That lesson isn’t here.', 404);
  const c = courseRow(l.course_id);
  if (!isOwner(req) && (l.status !== 'published' || !canOpen(req.user, c))) throw oops(c && c.status === 'published' && l.status === 'published' ? lockReason(c) : 'That lesson isn’t here.', c && c.status === 'published' && l.status === 'published' ? 403 : 404);
  if (lockedByDate(l, req)) throw oops(`This lesson opens on ${l.opens_on}.`, 403);
  return { l, c };
}
router.get('/lessons/:id', wrap(async req => {
  const { l, c } = lessonFor(req), quiz = parseQuiz(l.quiz), fin = finalLesson(c.id);
  const mid = media.mediaId(l.video);
  const attempts = db.prepare('SELECT id, score, total, percent, passed, taken_at FROM quiz_attempts WHERE user_id = ? AND lesson_id = ? ORDER BY id DESC').all(req.user.id, l.id);
  // Questions only: the right answers never leave the server.
  return { id: l.id, course_id: c.id, course: c.title, title: l.title, summary: l.summary || '', minutes: l.minutes, transcript: l.transcript || '', resources: resourcesOf(l),
    video: mid ? await media.playUrl(mid) : null, video_url: l.video_url || '', quiz: quiz.map(x => ({ q: x.q, options: x.options })), final: !!(fin && fin.id === l.id),
    passMark: c.pass_mark, attempts, done: !!db.prepare('SELECT 1 FROM lesson_progress WHERE user_id = ? AND lesson_id = ?').get(req.user.id, l.id),
    ...(isOwner(req) ? { edit: { module_id: l.module_id, video: l.video || '', quizText: l.quiz || '', resourcesText: resourcesText(l), opens_on: l.opens_on || '', status: l.status, sort: l.sort, is_final: !!l.is_final } } : {}) };
}));
// Mark a lesson without a quiz done (or not done). A lesson with a quiz is done once the quiz is passed.
router.post('/lessons/:id/done', wrap(req => {
  const { l, c } = lessonFor(req);
  if (parseQuiz(l.quiz).length && req.body.done !== false) throw oops('Pass this lesson’s quiz to finish it.');
  if (req.body.done === false) db.prepare('DELETE FROM lesson_progress WHERE user_id = ? AND lesson_id = ?').run(req.user.id, l.id);
  else db.prepare('INSERT OR IGNORE INTO lesson_progress (user_id, lesson_id) VALUES (?, ?)').run(req.user.id, l.id);
  return { ok: true, certificate: req.body.done === false ? null : maybeIssue(req.user.id, c.id) };
}));
// Take the quiz. Graded here; every attempt is stored for good (questions as they were, answers, score, pass or fail).
router.post('/lessons/:id/quiz', wrap(req => {
  const { l, c } = lessonFor(req), quiz = parseQuiz(l.quiz); if (!quiz.length) throw oops('This lesson has no quiz.');
  const given = Array.isArray(req.body.answers) ? req.body.answers.map(a => (a === null || a === '' ? null : Number(a))) : [];
  if (given.length !== quiz.length || given.some(a => a === null || !Number.isInteger(a))) throw oops('Answer every question first.');
  const recent = db.prepare("SELECT COUNT(*) n FROM quiz_attempts WHERE user_id = ? AND lesson_id = ? AND taken_at > datetime('now', '-1 hour')").get(req.user.id, l.id).n;
  if (recent >= 10) throw oops('That’s 10 tries in an hour. Take a break, review the lesson, and try again later.', 429);
  const right = quiz.map((x, i) => given[i] === x.answer), score = right.filter(Boolean).length, percent = Math.round(score / quiz.length * 100), passed = percent >= c.pass_mark ? 1 : 0;
  const result = tx(() => {
    const id = Number(db.prepare('INSERT INTO quiz_attempts (user_id, course_id, lesson_id, course_version, score, total, percent, pass_mark, passed, answers, questions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, c.id, l.id, c.version || null, score, quiz.length, percent, c.pass_mark, passed, JSON.stringify(given), JSON.stringify(quiz)).lastInsertRowid);
    if (passed) db.prepare('INSERT OR IGNORE INTO lesson_progress (user_id, lesson_id) VALUES (?, ?)').run(req.user.id, l.id);
    return { attempt: id, certificate: passed ? maybeIssue(req.user.id, c.id) : null };
  });
  return { ...result, score, total: quiz.length, percent, passed: !!passed, passMark: c.pass_mark, wrong: right.map((ok, i) => ok ? null : i + 1).filter(Boolean) };
}));
router.get('/lessons/:id/comments', wrap(req => { const { l } = lessonFor(req);
  return { comments: db.prepare('SELECT c.*, u.name, u.last_name, u.email FROM lesson_comments c JOIN users u ON u.id = c.user_id WHERE c.lesson_id = ? AND c.hidden = 0 ORDER BY c.id').all(l.id)
    .map(c => ({ id: c.id, by: c.name ? [c.name, (c.last_name || '').slice(0, 1)].filter(Boolean).join(' ') : 'A student', body: c.body, at: c.created_at, canHide: isOwner(req) || c.user_id === req.user.id })) }; }));
const recentComments = new Map();
router.post('/lessons/:id/comments', wrap(req => { const { l } = lessonFor(req), body = clean(req.body.body, 2000); if (body.length < 2) throw oops('Write a comment first.');
  const now = Date.now(), list = (recentComments.get(req.user.id) || []).filter(t => now - t < 3600e3); if (list.length >= 20) throw oops('That’s a lot of comments for one hour. Take a breather.'); list.push(now); recentComments.set(req.user.id, list);
  db.prepare('INSERT INTO lesson_comments (lesson_id, user_id, body) VALUES (?, ?, ?)').run(l.id, req.user.id, body); }));
router.delete('/comments/:id', wrap(req => { const c = db.prepare('SELECT * FROM lesson_comments WHERE id = ?').get(Number(req.params.id)); if (!c) return;
  if (!isOwner(req) && c.user_id !== req.user.id) throw oops('Only the team or the person who wrote it can remove it.', 403);
  db.prepare('UPDATE lesson_comments SET hidden = 1 WHERE id = ?').run(c.id); }));
// My certificates and transcript.
router.get('/my/certificates', wrap(req => ({ certificates: db.prepare('SELECT * FROM certificates WHERE user_id = ? ORDER BY issued_at DESC').all(req.user.id).map(certOut) })));
router.get('/my/transcript.csv', (req, res) => {
  const rows = [['Certificate ID', 'Course', 'Course version', 'CE credits', 'PDUs', 'Issued (UTC)', 'Expires (UTC)', 'Status', 'Verify at']];
  const base = appUrl(req);
  for (const c of db.prepare('SELECT * FROM certificates WHERE user_id = ? ORDER BY issued_at').all(req.user.id))
    rows.push([c.id, c.course_title, c.course_version || '', c.ce_credits ?? '', c.pdus ?? '', c.issued_at.slice(0, 10), c.expires_at ? c.expires_at.slice(0, 10) : 'Does not expire', certStatus(c), `${base}/verify/${c.id}`]);
  // Courses finished without a certificate (certificates off for that course).
  for (const c of db.prepare("SELECT * FROM courses WHERE certificate = 0").all()) { const ls = publishedLessons(c.id), done = doneSet(req.user.id, c.id);
    if (ls.length && ls.every(l => done.has(l.id))) rows.push(['', c.title, c.version || '', c.ce_credits ?? '', c.pdus ?? '', '', '', 'Completed (no certificate)', '']); }
  res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', 'attachment; filename="crpro-transcript.csv"'); res.send('﻿' + toCsv(rows));
});

// ---------- the owner: courses, modules, lessons ----------
const admin = express.Router();
admin.use(ownerOnly);
admin.get('/courses', wrap(() => ({ courses: db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) lessons,
  (SELECT COUNT(*) FROM certificates x WHERE x.course_id = c.id) certs, (SELECT COUNT(DISTINCT user_id) FROM lesson_progress p JOIN lessons l ON l.id = p.lesson_id WHERE l.course_id = c.id) students
  FROM courses c ORDER BY c.title COLLATE NOCASE`).all().map(c => ({ ...c, code: certCode(c) })) })));
const courseFields = b => {
  const title = clean(b.title, 200); if (!title) throw oops('Give the course a title.');
  const access = ACCESS.includes(b.access) ? b.access : 'free', pass = Math.round(num(b.pass_mark) ?? 80);
  if (pass < 1 || pass > 100) throw oops('The pass mark is a percent from 1 to 100.');
  const months = num(b.certificate_valid_months); if (months != null && (months < 1 || months > 240)) throw oops('Certificate valid for: 1 to 240 months, or leave it empty for no expiry.');
  return { title, summary: clean(b.summary, 4000) || null, access, price: num(b.price), ce_credits: num(b.ce_credits), pdus: num(b.pdus), instructor: clean(b.instructor, 200) || null,
    categories: clean(b.categories, 400) || null, status: b.status === 'published' ? 'published' : 'draft', version: clean(b.version, 80) || null, certificate: b.certificate ? 1 : 0,
    certificate_valid_months: months == null ? null : Math.round(months), pass_mark: pass, cert_code: clean(b.cert_code, 6).toUpperCase().replace(/[^A-Z0-9]/g, '') || null, note: clean(b.note, 2000) || null, sort: Math.round(num(b.sort) || 0) };
};
admin.post('/courses', wrap(req => { const f = courseFields(req.body || {}), cols = Object.keys(f);
  return { id: Number(db.prepare(`INSERT INTO courses (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(f)).lastInsertRowid) }; }));
admin.get('/courses/:id', wrap(req => { const c = courseRow(req.params.id); if (!c) throw oops('That course isn’t here.', 404);
  const fin = finalLesson(c.id);
  return { course: { ...c, code: certCode(c) }, modules: db.prepare('SELECT * FROM modules WHERE course_id = ? ORDER BY sort, id').all(c.id),
    lessons: db.prepare('SELECT id, module_id, title, status, sort, minutes, opens_on, is_final, quiz IS NOT NULL AND quiz <> \'\' AS has_quiz FROM lessons WHERE course_id = ? ORDER BY sort, id').all(c.id),
    finalLesson: fin ? fin.id : null, warnings: [c.certificate && !fin ? 'Certificates are on, but there’s no published lesson with a quiz yet. Nobody can earn this certificate until there is one.' : null].filter(Boolean),
    grants: db.prepare('SELECT g.user_id, g.created_at, g.note, u.email, u.name, u.last_name FROM course_grants g JOIN users u ON u.id = g.user_id WHERE g.course_id = ? ORDER BY u.email').all(c.id),
    attempts: db.prepare('SELECT a.id, a.lesson_id, a.score, a.total, a.percent, a.passed, a.taken_at, u.email, u.name, u.last_name FROM quiz_attempts a JOIN users u ON u.id = a.user_id WHERE a.course_id = ? ORDER BY a.id DESC LIMIT 500').all(c.id) }; }));
admin.put('/courses/:id', wrap(req => { const c = courseRow(req.params.id); if (!c) throw oops('That course isn’t here.', 404);
  const f = courseFields({ ...c, ...req.body, certificate: 'certificate' in req.body ? req.body.certificate : c.certificate });
  db.prepare(`UPDATE courses SET ${Object.keys(f).map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(f), c.id); }));
// A course with quiz attempts or certificates can't be deleted (those are permanent records). Set it to Draft instead.
admin.delete('/courses/:id', wrap(req => { const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM quiz_attempts WHERE course_id = ? LIMIT 1').get(id) || db.prepare('SELECT 1 FROM certificates WHERE course_id = ? LIMIT 1').get(id)) throw oops('Students have quiz records or certificates in this course, and those are kept for good. Set the course to Draft instead.');
  db.prepare('DELETE FROM courses WHERE id = ?').run(id); }));
admin.post('/courses/:id/modules', wrap(req => { const c = courseRow(req.params.id); if (!c) throw oops('That course isn’t here.', 404);
  const title = clean(req.body.title, 200); if (!title) throw oops('Give the module a title.');
  const sort = (db.prepare('SELECT MAX(sort) s FROM modules WHERE course_id = ?').get(c.id).s || 0) + 1;
  return { id: Number(db.prepare('INSERT INTO modules (course_id, title, sort) VALUES (?, ?, ?)').run(c.id, title, sort).lastInsertRowid) }; }));
admin.put('/modules/:id', wrap(req => { const title = clean(req.body.title, 200); if (!title) throw oops('Give the module a title.');
  db.prepare('UPDATE modules SET title = ?, sort = COALESCE(?, sort) WHERE id = ?').run(title, num(req.body.sort), Number(req.params.id)); }));
admin.delete('/modules/:id', wrap(req => { db.prepare('DELETE FROM modules WHERE id = ?').run(Number(req.params.id)); }));   // its lessons stay, without a module
const lessonFields = (b, courseId) => {
  const title = clean(b.title, 200); if (!title) throw oops('Give the lesson a title.');
  const video = clean(b.video, 200); if (video && !media.mediaId(video)) throw oops('The uploaded video didn’t come through. Upload it again.');
  const url = clean(b.video_url, 500); if (url && !/^https:\/\/\S+$/i.test(url)) throw oops('The video link should start with https://');
  const quiz = clean(b.quiz, 30000); if (quiz && !parseQuiz(quiz).length) throw oops('The quiz didn’t read right. Each question starts with “Q:”, then one line per choice: “* ” before the right one, “- ” before the others.');
  const mod = num(b.module_id); if (mod && !db.prepare('SELECT 1 FROM modules WHERE id = ? AND course_id = ?').get(mod, courseId)) throw oops('Pick a module from this course.');
  const opens = /^\d{4}-\d{2}-\d{2}$/.test(String(b.opens_on || '')) ? b.opens_on : null;
  return { module_id: mod || null, title, summary: clean(b.summary, 4000) || null, video: video || null, video_url: url || null, transcript: clean(b.transcript, 200000) || null,
    resources: JSON.stringify(cleanResources(b.resources)), quiz: quiz || null, is_final: b.is_final ? 1 : 0, opens_on: opens, minutes: Math.max(0, Math.min(1000, Math.round(num(b.minutes) || 0))) || null,
    sort: Math.round(num(b.sort) ?? 0), status: b.status === 'published' ? 'published' : 'draft' };
};
admin.post('/courses/:id/lessons', wrap(req => { const c = courseRow(req.params.id); if (!c) throw oops('That course isn’t here.', 404);
  const f = lessonFields(req.body || {}, c.id); if (!('sort' in req.body) || req.body.sort === '') f.sort = (db.prepare('SELECT MAX(sort) s FROM lessons WHERE course_id = ?').get(c.id).s || 0) + 1;
  if (f.is_final) db.prepare('UPDATE lessons SET is_final = 0 WHERE course_id = ?').run(c.id);
  const cols = ['course_id', ...Object.keys(f)];
  return { id: Number(db.prepare(`INSERT INTO lessons (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(c.id, ...Object.values(f)).lastInsertRowid) }; }));
admin.put('/lessons/:id', wrap(req => { const l = db.prepare('SELECT * FROM lessons WHERE id = ?').get(Number(req.params.id)); if (!l) throw oops('That lesson isn’t here.', 404);
  const f = lessonFields(req.body || {}, l.course_id); if (f.is_final) db.prepare('UPDATE lessons SET is_final = 0 WHERE course_id = ?').run(l.course_id);
  db.prepare(`UPDATE lessons SET ${Object.keys(f).map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(f), l.id); }));
admin.get('/lessons/:id', wrap(req => { const l = db.prepare('SELECT * FROM lessons WHERE id = ?').get(Number(req.params.id)); if (!l) throw oops('That lesson isn’t here.', 404);
  return { ...l, resourcesText: resourcesText(l), quizCount: parseQuiz(l.quiz).length }; }));
admin.delete('/lessons/:id', wrap(req => { const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM quiz_attempts WHERE lesson_id = ? LIMIT 1').get(id)) throw oops('Students have taken this lesson’s quiz, and those records are kept for good. Set the lesson to Draft instead.');
  db.prepare('DELETE FROM lessons WHERE id = ?').run(id); }));
// Give a student access to a paid or Elite course (until payments are connected), or take it away.
admin.post('/courses/:id/grants', wrap(req => { const c = courseRow(req.params.id); if (!c) throw oops('That course isn’t here.', 404);
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(clean(req.body.email, 200).toLowerCase()); if (!u) throw oops('No account has that email yet. They need to sign up first.');
  db.prepare('INSERT OR IGNORE INTO course_grants (user_id, course_id, granted_by, note) VALUES (?, ?, ?, ?)').run(u.id, c.id, req.user.id, clean(req.body.note, 300) || null); }));
admin.delete('/courses/:id/grants/:uid', wrap(req => { db.prepare('DELETE FROM course_grants WHERE course_id = ? AND user_id = ?').run(Number(req.params.id), Number(req.params.uid)); }));
// Certificates: list and search. There are no routes that change or delete one; corrections are notes.
admin.get('/certificates', wrap(req => { const q = '%' + clean(req.query.q, 100).toLowerCase() + '%';
  return { certificates: db.prepare(`SELECT c.*, u.email, (SELECT COUNT(*) FROM certificate_notes n WHERE n.certificate_id = c.id) notes FROM certificates c JOIN users u ON u.id = c.user_id
    WHERE lower(c.id) LIKE ? OR lower(c.recipient_name) LIKE ? OR lower(u.email) LIKE ? OR lower(c.course_title) LIKE ? ORDER BY c.issued_at DESC LIMIT 1000`).all(q, q, q, q).map(certOut) }; }));
admin.get('/certificates/:id', wrap(req => { const c = db.prepare('SELECT c.*, u.email FROM certificates c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(String(req.params.id)); if (!c) throw oops('No certificate has that ID.', 404);
  return { certificate: certOut(c), attempt: c.attempt_id ? db.prepare('SELECT id, score, total, percent, pass_mark, passed, taken_at, course_version FROM quiz_attempts WHERE id = ?').get(c.attempt_id) : null,
    notes: db.prepare('SELECT n.*, u.email AS by_email FROM certificate_notes n LEFT JOIN users u ON u.id = n.by_user_id WHERE n.certificate_id = ? ORDER BY n.id').all(c.id) }; }));
admin.post('/certificates/:id/notes', wrap(req => { const c = db.prepare('SELECT id FROM certificates WHERE id = ?').get(String(req.params.id)); if (!c) throw oops('No certificate has that ID.', 404);
  const note = clean(req.body.note, 2000); if (note.length < 3) throw oops('Write the note first.');
  db.prepare('INSERT INTO certificate_notes (certificate_id, note, by_user_id) VALUES (?, ?, ?)').run(c.id, note, req.user.id); }));

// ---------- public: verify a certificate (no sign-in) ----------
const verifyTries = new Map();
function lookup(id, ip) {
  const t = (verifyTries.get(ip) || []).filter(x => Date.now() - x < 60e3); if (t.length >= 30) throw oops('Too many lookups. Wait a minute and try again.', 429); t.push(Date.now()); verifyTries.set(ip, t);
  const c = db.prepare('SELECT * FROM certificates WHERE id = ?').get(String(id || '').trim().toUpperCase());
  if (!c) return null;
  const notes = db.prepare('SELECT note, created_at FROM certificate_notes WHERE certificate_id = ? ORDER BY id').all(c.id);
  return { id: c.id, name: c.recipient_name, course: c.course_title, version: c.course_version, ce_credits: c.ce_credits, pdus: c.pdus, issued: c.issued_at.slice(0, 10), expires: c.expires_at ? c.expires_at.slice(0, 10) : null, status: certStatus(c), notes };
}
const publicRouter = express.Router();
publicRouter.get('/:id', (req, res) => { try { const v = lookup(req.params.id, req.ip); if (!v) return res.status(404).json({ found: false }); res.json({ found: true, ...v }); } catch (err) { res.status(err.status || 400).json({ error: err.message }); } });

// ---------- seed: Jess's course list as draft shells, plus one sample course ----------
function splitTitle(raw) {
  let title = String(raw || '').trim(), ce = null, pdus = null;
  const m = /\s*\(\s*(\d+(?:\.\d+)?)\s*(CE Credits?|CEs?|Credit Hours?|PDUs?)\s*\)\s*$/i.exec(title);
  if (m) { title = title.slice(0, m.index).trim(); if (/pdu/i.test(m[2])) pdus = Number(m[1]); else ce = Number(m[1]); }
  return { title, ce, pdus };
}
function seedCourses() {
  if (getSetting('seed_courses_v1') === 'done') return;
  const file = path.join(__dirname, '..', 'seed', 'course-list.csv'); if (!fs.existsSync(file)) return;
  const rows = parseCsv(fs.readFileSync(file, 'utf8')), head = rows.shift().map(h => h.trim().toLowerCase()), col = n => head.indexOf(n);
  let added = 0; const skipped = [];
  tx(() => {
    for (const r of rows) {
      const raw = r[col('course')]; if (!raw) continue;
      if (/\[second copy\]/i.test(raw)) { skipped.push(raw); continue; }
      const { title, ce, pdus } = splitTitle(raw), accessRaw = String(r[col('access')] || '').toLowerCase(), gcp = /good clinical practice|\bGCP\b/i.test(title);
      const notes = [`Imported from the LearnWorlds course list (${r[col('enrollments')] || 0} enrollments there; created ${r[col('created')] || '?'}).`];
      let access = accessRaw === 'paid' ? 'paid' : 'free';
      if (accessRaw === 'private') { access = 'paid'; notes.push('Private in LearnWorlds: only students given access can open it.'); }
      if (/^elite member area$/i.test(title)) { access = 'elite'; notes.push('This is the Elite membership area in LearnWorlds, not a regular course. Decide what it becomes here.'); }
      const instr = String(r[col('instructor')] || '').trim(); if (/\.\.\.$/.test(instr)) notes.push('Instructor name was cut off in the export; check the full name.');
      const listPrice = Number(r[col('list price')]) || null, price = Number(r[col('price')]) || null; if (listPrice && price && listPrice !== price) notes.push(`List price was $${listPrice}.`);
      db.prepare(`INSERT INTO courses (title, access, price, ce_credits, pdus, instructor, categories, status, version, certificate, certificate_valid_months, pass_mark, cert_code, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 1, ?, 80, ?, ?)`).run(title, access, price, ce, pdus, instr || null, String(r[col('categories')] || '').trim() || null,
        gcp && /E6\s*\(?R3\)?/i.test(title + ' ' + raw) ? 'ICH E6(R3)' : null, gcp ? 36 : null, gcp ? 'GCP' : null, notes.join(' '));
      added++;
    }
  });
  setSetting('seed_courses_v1', 'done'); setSetting('seed_courses_skipped', JSON.stringify(skipped));
  console.log(`Academy: ${added} draft course shells added from the course list. Skipped: ${skipped.join('; ') || 'none'}.`);
}
function seedSample() {
  if (getSetting('seed_sample_v1') === 'done') return;
  tx(() => {
    const cid = Number(db.prepare(`INSERT INTO courses (title, summary, access, ce_credits, status, version, certificate, certificate_valid_months, pass_mark, cert_code, note, sort)
      VALUES ('Sample course (delete me)', 'A practice course to try the flow: two short lessons and a 3-question final quiz. Delete it before launch.', 'free', NULL, 'published', 'Sample v1', 1, 36, 80, 'SMP', 'Made by the app so the flow can be tried. Delete it (or set it to Draft) before launch.', -1)`).run().lastInsertRowid);
    const mid = Number(db.prepare("INSERT INTO modules (course_id, title, sort) VALUES (?, 'Module 1: Try it out', 1)").run(cid).lastInsertRowid);
    db.prepare(`INSERT INTO lessons (course_id, module_id, title, summary, transcript, resources, sort, status, minutes) VALUES (?, ?, 'Lesson 1: How lessons work', ?, ?, ?, 1, 'published', 2)`)
      .run(cid, mid, 'Watch the video (when there is one), read the transcript, then mark the lesson done.', 'This is a sample transcript. Real lessons show the words of the video here, for anyone watching with the sound off.', JSON.stringify([{ title: 'ICH E6(R3) guideline (ICH website)', url: 'https://www.ich.org/page/efficacy-guidelines' }]));
    db.prepare(`INSERT INTO lessons (course_id, module_id, title, summary, transcript, quiz, is_final, sort, status, minutes) VALUES (?, ?, 'Lesson 2: Final quiz', ?, ?, ?, 1, 2, 'published', 3)`)
      .run(cid, mid, 'Answer three questions. You need 80% to pass, which means all three here.', 'A sample final quiz. Every try is saved, pass or fail.',
        'Q: Which document gives the guidelines for Good Clinical Practice?\n- FDA Form 1572\n* ICH E6\n- The informed consent form\n\nQ: Who gives ethical approval for a study at a site?\n- The sponsor\n- The CRO\n* The IRB or ethics committee\n\nQ: How often must GCP training be renewed in this course?\n- Every year\n* Every 3 years\n- Never');
  });
  setSetting('seed_sample_v1', 'done');
}
try { seedCourses(); } catch (err) { console.error('Course seed:', err.message); }
try { seedSample(); } catch (err) { console.error('Sample course:', err.message); }

module.exports = { router, admin, publicRouter, lookup, parseQuiz, certStatus };
