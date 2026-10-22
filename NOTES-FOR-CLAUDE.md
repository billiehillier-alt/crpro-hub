# CR Pro hub app: notes for Claude

The first version of the Clinical Research Pro hub (Jess Thompson's clinical research course business). Built 2026-10-22 by
copying and adapting features from Billie's psyrenne app (`C:\Users\billi\OneDrive\Documents\App Project`, which was only
read, never changed). Business decisions live in `..\CLAUDE.md`. Billie isn't a developer: explain in plain words, and ask
before anything hard to undo. Nothing is pushed or deployed yet (local git only, no remote).

## Run it

```
npm install
npm start                      # http://localhost:4310 (PORT to change)
```

- Copy `.env.example` to `.env` (never committed) or set the variables in the host. Every variable is optional for a local
  try-out. Without SMTP, emails print in the server log.
- First visit: with no users, `/login` shows a one-time "Create the owner account" page (set `SETUP_CODE` online so nobody
  else can claim it first). After that, students make their own free accounts (Settings can close sign-up).
- Data: one SQLite file at `$CRPRO_DATA/crpro.db` (default `./data`, git-ignored), plus `social-images/` next to it.
  Local videos (no bucket set) go in `./media-local` (git-ignored).
- Tests (use a throwaway data folder, never real data):
  ```
  CRPRO_DATA=/tmp/crpro-test SITE_KEY=test-site-key-0123456789abcdef npm start
  SITE_KEY=test-site-key-0123456789abcdef node test/smoke.js      # core, Academy, Webinars, SEO, Social
  node test/smoke-more.js                                         # Directory, Resources, Calendar (after smoke.js)
  ```
- Image tools (run by hand; need Chrome or Edge and `npm install` for puppeteer-core):
  `node tools/social-packs.js --title "…" [--post-id N --upload]` and `node tools/lesson-covers.js lessons.json "Course" out/`.

## Stack decision

Same stack as psyrenne so the proven code carried over: Node 24, Express 4, `node:sqlite` (DatabaseSync), plain-JS front
end in `public/` (no build step). **One** database (no per-creator databases, no AsyncLocalStorage proxy). The plan in
`..\CLAUDE.md` says Postgres at this size; to keep that move easy, every query sits in its feature's own module
(`src/auth.js`, `academy.js`, `webinars.js`, `seo.js`, `articlemap.js`, `ideas.js`, `social.js`, `social-platforms.js`,
`directory.js`, `resources.js`, `calendar.js`, `media.js`), and only `src/db.js` opens the database. Times are UTC
(ISO strings for scheduled things, SQLite `datetime('now')` UTC stamps for records). Migrating = swap `db.js` for a pg pool
and rewrite those modules' SQL (watch `INSERT … ON CONFLICT`, `datetime('now')`, `GROUP_CONCAT`, and the triggers below).

## Folder layout

```
server.js            Express app: security headers, JSON body (raw text kept for signed requests), sign-in guard, fonts,
                     routes, /verify and /certificate pages, Settings API, static files
src/db.js            the database, settings (getSetting/setSetting with defaults), addColumn, tx
src/auth.js          accounts, sessions, setup, sign-up, login, password reset, people (owner), the guard and ownerOnly
src/mailer.js        nodemailer with SMTP_*; prints to the log when SMTP isn't set
src/media.js         video uploads: R2/S3 presigned upload and play links, or local media-local/
src/academy.js       courses, modules, lessons, progress, quizzes, attempts, certificates, verify, transcript, seeds
src/pages.js         server-made HTML: public verify page and the placeholder certificate
src/webinars.js      webinars, RSVP, calendar links, ICS, reminders, attendance report, recordings, ratings
src/zoom.js          optional Zoom Server-to-Server OAuth
src/ai.js            Anthropic SDK client (ANTHROPIC_API_KEY, model AI_MODEL default claude-sonnet-5-5)
src/seo.js           SEO terms, uploads, Semrush, plan, topic map, coverage bands, article matching
src/articlemap.js    the article tree (header / subheader / article), coverage, draft requests
src/ideas.js         article ideas and draft requests
src/sitesync.js      the signed WordPress endpoints (/api/site/*)
src/social.js        social posts, captions, slots, tracked links /l/:code, share pictures /si/…, results
src/social-platforms.js  Facebook, Instagram, Pinterest, X posting (env keys + OAuth tokens in social_tokens)
src/directory.js     directory listings, reviews, reports, suggestions, opens
src/resources.js     resources library
src/calendar.js      industry events + webinars merged, reminders, ICS, public /calendar.ics feed, CSV import
src/csv.js           CSV read and write (formula-safe)
public/index.html    the single-page app shell; app.js (core, Academy, Webinars, admin, people, settings),
                     seo.js, social.js, directory.js, resources.js, calendar.js; login.html; style.css; logo.png
seed/course-list.csv Jess's LearnWorlds course list (copied from ..\Course Information)
tools/               social-packs.js, lesson-covers.js (by hand, CR Pro look)
test/                smoke.js, smoke-more.js
```

## Front end rules followed

Left sidebar (top menu on phones). Student menu: Home, Academy, Webinars, Calendar, Directory, Resources, My certificates,
My account. Owner-only Admin group (purple outline, "only you see this"): Courses, Webinars, Calendar, Certificates,
Directory, Resources, SEO plan, Topic map, Article map, Article ideas, Social posts, People, Settings. Owner-only buttons
inside pages get `.owner-only` (purple outline). Black text on white, pink #FF3399 main buttons, cyan/gold accents, the
brand gradient only as the 4px stripe. Montserrat self-hosted from `@fontsource/montserrat` (`/fonts.css`, `/fonts/…`),
system stack for body text (no Google services: China). Light and dark themes (system + toggle). 8px corners, no pills.
Links underlined. Drop-downs A to Z (time lists in time order). Every table sorts by its headings (`table.sortable`).
Smart search everywhere = every word must match somewhere (`CR.matches`). Screens register with `CR.route(name, fn, {owner})`;
page listeners use `CR.onView` so they reset per screen.

## Tables

Accounts: `users` (email, scrypt pass_hash, name, last_name, is_owner, is_elite, elite_until, email_on, timezone),
`sessions` (sha256 of the token only), `password_resets`, `settings` (key/value).
Academy: `courses` (title, summary, access free|paid|elite, price, ce_credits, pdus, instructor, categories, status
draft|published, version, certificate, certificate_valid_months, pass_mark, cert_code, note, sort), `modules`, `lessons`
(module_id, video "media:<id>", video_url, transcript, resources JSON, quiz text, is_final, opens_on, minutes, sort, status),
`lesson_progress`, `course_grants` (manual access to paid/Elite courses until Stripe), `lesson_comments`,
`quiz_attempts` (user, course, lesson, course_version, score, total, percent, pass_mark, passed, answers JSON, questions JSON
snapshot, taken_at), `certificates` (id like CRP-GCP-26-04271, user, course, recipient_name, course_title, course_version,
ce_credits, pdus, attempt_id, issued_at, expires_at), `certificate_notes` (corrections), `cert_reminders`.
**Triggers block UPDATE and DELETE on quiz_attempts, certificates, and certificate_notes**; there are no routes that change
or delete them. Courses or lessons with attempts or certificates can't be deleted (set them to Draft).
Media: `media`. Webinars: `events` (title, description, starts_at UTC, duration_min, link, zoom_id, host, topic, recording
"media:<id>", recording_url, elite_only, free_until, admin_notes, ce_credits), `event_rsvps` (attended, minutes),
`event_ratings`, `event_reminders`.
SEO: `seo_terms`, `seo_articles` (from WordPress), `seo_plan`, `seo_topics`, `article_ideas`, `am_nodes`.
Social: `social_posts`, `social_clicks`, `social_images` (files in `$CRPRO_DATA/social-images`), `social_auto`, `social_tokens`.
Directory: `dir_listings` (type consultant|organization|site|sponsor|technology|vendor, data JSON for type fields, photos,
links), `dir_suggestions`, `dir_reviews`, `dir_review_reports`, `dir_opens`.
Resources: `resources`. Calendar: `cal_events` (all_day events store plain dates), `cal_reminders`.

## Key behaviors

- **Certificates** are issued when every published lesson is done and the final quiz (the lesson marked final, else the last
  lesson with a quiz) is passed. No final quiz = no certificate (the course editor warns). Renewal: within 90 days of expiry
  (or after), passing the final quiz again issues a new certificate with a new ID; the old record stays. GCP courses seed
  with 36 months and version "ICH E6(R3)". Expiry emails go 60 and 7 days before.
- `/verify` and `/verify/:id` (no sign-in, 30 lookups a minute per address) show name, course, version, credits, dates,
  status, and any correction notes. `/certificate/:id` is a **placeholder layout** with the banner "Placeholder: Jess's
  approved template goes here." Jess's template must be reproduced exactly from her file; only the variable fields fill in.
- Quiz answers never leave the server; grading is server-side; 10 tries an hour per lesson.
- Course seed: 61 draft shells from `seed/course-list.csv` ("(1.0 CE Credit)" style suffixes split into ce_credits, PDUs into
  pdus; the "[second copy]" row skipped and noted in `settings.seed_courses_skipped`; private → paid with a note; "Elite
  Member Area" → access elite with a note; truncated instructor names noted). No lessons. Plus "Sample course (delete me)".
- Webinar join links show only to people who RSVP'd (and the owner). `elite_only` and `free_until` (open to all until that
  date, then Elite) gate the link and recording. Reminders 24h and 1h before, only to people with email on.
- Social: drafts need approval; due posts publish by themselves when that platform is connected, otherwise the owner gets an
  email with the caption. The brand hashtag (Settings, default #ClinicalResearchPro) is always first. Slots use the business
  time zone (Settings, default America/New_York).

## Environment variables

See `.env.example` (each with a one-line explanation): PORT, CRPRO_DATA, APP_URL, SETUP_CODE; SMTP_HOST, SMTP_PORT,
SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_REPLY_TO; MEDIA_S3_ENDPOINT, MEDIA_S3_KEY_ID, MEDIA_S3_SECRET, MEDIA_S3_BUCKET,
MEDIA_S3_REGION, MEDIA_LOCAL_DIR; ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET; ANTHROPIC_API_KEY, AI_MODEL;
SEMRUSH_API_KEY, SITE_KEY; META_FB_APP_ID, META_FB_APP_SECRET, META_FB_CONFIG_ID, META_IG_APP_ID, META_IG_APP_SECRET,
PINTEREST_APP_ID, PINTEREST_APP_SECRET, X_CLIENT_ID, X_CLIENT_SECRET.
Social OAuth redirect addresses: `<APP_URL>/api/social/oauth/<facebook|instagram|pinterest|x>`.

## What the WordPress side must send

All requests are signed with `SITE_KEY` (24+ characters, the same value saved in WordPress):
- Header `X-CRPro-Timestamp`: current Unix time in seconds (refused if more than 5 minutes off).
- Header `X-CRPro-Signature`: `sha256=` + hex HMAC-SHA256 of `"<timestamp>.<exact request body>"` (GET: empty body).
  PHP: `'sha256=' . hash_hmac('sha256', $ts . '.' . $body, $key)`; send `$body` byte-for-byte as signed, `Content-Type: application/json`.

1. `POST /api/site/articles` with `{"articles":[{"id":123,"title":"…","status":"publish|future|draft|pending|private",
   "url":"https://…/slug/","edit":"https://…/wp-admin/post.php?post=123&action=edit","keyphrase":"Yoast focus keyphrase",
   "text":"plain text of the post (up to 60,000 chars)","slug":"slug","date_gmt":"2026-10-22T15:00:00Z"}]}` — the full list
   each time (it replaces what's there). Send on every save and hourly. Drafts included (the Article map uses them).
2. `GET /api/site/requests` → `{"requests":[{id, topic, note, notes, status, source, keyphrase, terms[], ai, article_id, url, edit}]}`
   (draft requests waiting or drafting).
3. `PUT /api/site/requests/:id` with `{"status":"drafting|published","articleId":123,"edit":"…","url":"…"}` to report back.
4. `POST /api/site/social-images` with `{"post_id":123,"files":[{"code":"FB|IGP|P1|X|YT|WP","name":"…","data":"data:image/jpeg;base64,…"}]}`
   (used by tools/social-packs.js `--upload`; WordPress may use it too).
Nothing on the WordPress side is built yet: it needs a small plugin that does 1 on save/hourly, plus a settings field for SITE_KEY.

## Dropped from psyrenne, and why

- Multi-creator databases, AsyncLocalStorage proxy, "no user = owner" laptop mode, demo visitors, helpers, roles beyond
  owner/student: CR Pro is one business with one database and sign-in always on.
- School: credits/earn, badges, rooms, levels, member types, plan tiers (Molpe/Ligeia/Thelxiope), From the Pool member
  lessons, assignments (tp_reviews), YouTube-only video, the seeded psyrenne course and covers, cover-image blobs.
- Events: pitches, gifts/treasure chest, credits, the onboarding series and its Central-time code, rooms, the welcome-event
  seed and psyrenne's real Zoom links, public site sync and busy times.
- SEO: sites.js multi-site and X-Psy-Site; psyrenne's one-time article moves; Aho-Corasick phrase scan and gzip plan cache
  (not needed at this size); the article-map "send family links to the website" panel (needs a WordPress plugin first);
  question trends (no community chat data yet). Off-topic words and AI prompts rewritten for clinical research.
- Social: Buffer, extra pins and re-pins, repeats of old posts, Keep promoting (keeppromo.js), "fill my calendar", phone push
  (emails instead), keys typed into the app (env only now). LinkedIn, Threads, and YouTube are reminder-only.
- Directory: WordPress sync and its editor queue, TikTok/brand/affiliate fields, credits and rooms, the AI webinar-from-email
  extraction, nudges, members' private contacts, tester gating.
- Resources: affiliate buttons and "I use this".

## Placeholders and next steps

- Certificate layout is a placeholder until Jess's approved template file is reproduced exactly.
- Payments (Stripe, Alipay, WeChat Pay) aren't built: paid and Elite access is granted by hand (Course → Who has access;
  People → Elite). `users.elite_until` is ready for Stripe to set.
- Company seats, group admins, in-person check-in, instructor sales tracking, newsletter/segments, "Sign in with CR Pro",
  per-project opt-ins, PIPL/GDPR exports: not built yet (see `..\CLAUDE.md`).
- Postgres move (see Stack decision). Rate limits are in memory (one server).
- Lesson comments are simple (no replies, no moderation queue beyond hiding).
