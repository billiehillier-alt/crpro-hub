// Second smoke test: Directory, Resources, and Calendar. Run it after test/smoke.js, against the same throwaway server:
//   node test/smoke-more.js http://localhost:4310
const { client, check, results } = require('./smoke');
(async () => {
  const owner = client(), anon = client(), people = [];
  let r = await owner.call('/api/auth/login', { body: { email: 'owner@example.com', password: 'owner-password-123' } }); check('Owner logs in', r.status === 200);
  for (let i = 1; i <= 4; i++) { const c = client(); r = await c.call('/api/auth/signup', { body: { email: `dir${i}@example.com`, password: 'student-password-1', name: 'Test' + i, lastName: 'Person' } });
    if (r.status !== 200) r = await c.call('/api/auth/login', { body: { email: `dir${i}@example.com`, password: 'student-password-1' } }); people.push(c); }
  const [s1, s2, s3, s4] = people;

  // ---------- Directory ----------
  r = await s1.call('/api/directory'); check('Directory lists the sample listing', r.status === 200 && r.json.listings.some(l => l.name === 'Sample listing (delete me)'));
  check('Directory types from the dream board', r.json && ['consultant', 'organization', 'site', 'sponsor', 'technology', 'vendor'].every(k => r.json.types[k]));
  r = await owner.call('/api/admin/directory', { body: { type: 'vendor', name: 'Smoke Test Vendor', status: 'published', summary: 'Made-up vendor for the test.', city: 'Springfield', country: 'United States', d_services: 'Patient recruitment', d_rfp: true } });
  const vid = r.json && r.json.id; check('Owner adds a listing', !!vid, r.text.slice(0, 80));
  r = await s1.call('/api/directory/item/' + vid); check('Student opens it; vendor fields kept', r.status === 200 && r.json.listing.data.rfp === true && r.json.listing.data.services === 'Patient recruitment');
  await s1.call(`/api/directory/item/${vid}/opened`, { body: {} }); await s2.call(`/api/directory/item/${vid}/opened`, { body: {} });
  r = await s1.call(`/api/directory/item/${vid}/reviews`, { body: { stars: 5, relation: 'client', note: 'Great to work with.', own: true } });
  check('Review saved; scores hidden until there are 3', r.status === 200 && r.json.count === 1 && !r.json.show);
  await s2.call(`/api/directory/item/${vid}/reviews`, { body: { stars: 4, own: true } }); r = await s3.call(`/api/directory/item/${vid}/reviews`, { body: { stars: 3, own: true } });
  check('Scores show at 3 reviews', r.json.show && r.json.stars === 4, JSON.stringify({ show: r.json.show, stars: r.json.stars }));
  r = await s4.call(`/api/directory/item/${vid}/reviews`, { body: { stars: 5 } }); check('Review needs the own-experience box', r.status === 400);
  r = await s2.call('/api/directory/item/' + vid); const rid = r.json.reviews.reviews.find(x => x.note === 'Great to work with.').id;
  for (const c of [s2, s3, s4]) await c.call(`/api/directory/reviews/${rid}/report`, { body: { reason: 'test' } });
  r = await owner.call('/api/admin/directory/queue'); check('Three reports hide a review and it lands in the queue', r.json.hiddenReviews.some(x => x.id === rid));
  r = await owner.call('/api/admin/directory/reviews/' + rid, { body: { action: 'restore' } }); check('Owner puts the review back', r.status === 200);
  r = await s2.call(`/api/directory/item/${vid}/suggest`, { body: { field: 'phone', value: '555-0100', note: 'From their site' } }); check('Suggest an edit', r.status === 200);
  r = await owner.call('/api/admin/directory/queue'); const sug = r.json.suggestions.find(s => s.listing_id === vid); check('Suggestion waits in the queue', !!sug);
  r = await owner.call('/api/admin/directory/suggestions/' + sug.id, { body: { approve: true } }); r = await s1.call('/api/directory/item/' + vid); check('Approved suggestion updates the listing', r.json.listing.phone === '555-0100');
  r = await s3.call('/api/directory/submit', { body: { type: 'site', name: 'Smoke Suggested Site', summary: 'A test site.' } }); check('Student suggests a listing', r.status === 200);
  r = await s1.call('/api/directory'); check('Suggested listing hidden until approved', !r.json.listings.some(l => l.name === 'Smoke Suggested Site'));
  r = await owner.call('/api/admin/directory/queue'); const pend = r.json.pending.find(p => p.name === 'Smoke Suggested Site'); check('Owner sees it in the queue', !!pend);
  await owner.call(`/api/admin/directory/item/${pend.id}/publish`, { body: {} }); r = await s1.call('/api/directory'); check('Published after approval', r.json.listings.some(l => l.name === 'Smoke Suggested Site'));
  r = await owner.call('/api/admin/directory'); check('Open counts (owner visits not counted)', r.json.listings.find(l => l.id === vid).opens30 === 2);
  r = await s1.call('/api/admin/directory'); check('Students blocked from directory admin', r.status === 403);

  // ---------- Resources ----------
  r = await s1.call('/api/resources'); check('Resources list with the dream-board categories', r.status === 200 && ['Certifications', 'Conferences', 'Links to other resources', 'Organizations', 'Regulations and guidelines', 'Universities', 'Webinars'].every(c => r.json.categories.includes(c)));
  check('Sample resource present', r.json.resources.some(x => x.title === 'Sample resource (delete me)'));
  r = await owner.call('/api/resources/admin', { body: { category: 'Regulations and guidelines', title: 'Smoke ICH E6(R3) guideline', url: 'https://www.ich.org/page/efficacy-guidelines', summary: 'The GCP guideline.', status: 'published' } });
  const resId = r.json && r.json.id; check('Owner adds a resource', !!resId, r.text.slice(0, 80));
  r = await owner.call('/api/resources/admin', { body: { category: 'Nope', title: 'Bad' } }); check('Unknown category refused', r.status === 400);
  r = await owner.call('/api/resources/admin/' + resId, { method: 'PUT', body: { category: 'Regulations and guidelines', title: 'Smoke ICH E6(R3) guideline', url: 'https://www.ich.org/page/efficacy-guidelines', summary: 'Edited.', status: 'published' } }); check('Owner edits a resource', r.status === 200);
  r = await s1.call('/api/resources'); check('Student sees the edit', r.json.resources.some(x => x.id === resId && x.summary === 'Edited.'));
  r = await s1.call('/api/resources/admin', { body: { category: 'Webinars', title: 'x' } }); check('Students cannot add resources', r.status === 403);

  // ---------- Calendar ----------
  const day = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  r = await owner.call('/api/calendar/admin', { body: { title: 'Smoke Clinical Research Conference', organizer: 'Smoke Organizer', type: 'Conference', start_local: day + 'T09:00', end_local: day + 'T17:00', timezone: 'America/Chicago', format: 'in_person', city: 'Chicago', country: 'United States', cost: 'paid', ce_credits: 6, status: 'published', link: 'https://example.org/conf' } });
  const ceid = r.json && r.json.id; check('Owner adds an industry event', !!ceid, r.text.slice(0, 100));
  r = await owner.call('/api/calendar/admin', { body: { title: 'Smoke comment deadline', type: 'Deadline', all_day: true, start_date: day, status: 'published', format: 'online', cost: 'free' } }); check('All-day event', r.status === 200);
  r = await s1.call('/api/calendar'); const ev = r.json && r.json.events.find(e => e.id === 'cal-' + ceid);
  check('Calendar merges industry events and CR Pro webinars', ev && r.json.events.some(e => e.source === 'webinar'), r.json && r.json.events.map(e => e.id).join(','));
  check('Time zone converted to UTC (9:00 Chicago = 14:00 or 15:00 UTC)', ev && /T1[45]:00:00/.test(ev.starts_at), ev && ev.starts_at);
  r = await s1.call(`/api/calendar/cal-${ceid}/ics`); check('Event ICS', r.status === 200 && r.text.includes('SUMMARY:Smoke Clinical Research Conference'));
  r = await anon.call('/calendar.ics'); check('Public calendar feed without login', r.status === 200 && r.text.includes('BEGIN:VCALENDAR') && r.text.includes('Smoke Clinical Research Conference'));
  r = await anon.call('/calendar.ics?type=Deadline'); check('Feed filtered by type', r.text.includes('Smoke comment deadline') && !r.text.includes('Smoke Clinical Research Conference'));
  r = await s1.call(`/api/calendar/cal-${ceid}/remind`, { body: { before: 1440 } }); check('Remind me', r.status === 200, r.text.slice(0, 80));
  r = await s1.call('/api/calendar/suggest', { body: { title: 'Smoke Suggested Workshop', type: 'Workshop', start_local: day + 'T10:00', timezone: 'UTC', format: 'online', cost: 'free' } }); check('Student suggests an event', r.status === 200, r.text.slice(0, 80));
  r = await s1.call('/api/calendar'); check('Suggested event hidden until approved', !r.json.events.some(e => e.title === 'Smoke Suggested Workshop'));
  r = await owner.call('/api/calendar/admin'); const sugg = r.json.events.find(e => e.title === 'Smoke Suggested Workshop'); check('Owner sees it waiting', sugg && sugg.status === 'pending');
  r = await owner.call(`/api/calendar/admin/${sugg.id}/approve`, { body: {} }); r = await s1.call('/api/calendar'); check('Approved suggestion shows', r.json.events.some(e => e.title === 'Smoke Suggested Workshop'));
  const csv = `title,organizer,type,start,end,all_day,timezone,format,city,country,link,cost,description,ce_credits\n"Smoke CSV Summit",Org A,Conference,${day} 08:00,${day} 12:00,no,America/New_York,hybrid,Boston,United States,https://example.org/a,paid,From CSV,3\nSmoke CSV Day,Org B,Training,${day},,yes,,online,,,,free,,\n`;
  r = await owner.call('/api/calendar/admin/import', { body: { text: csv } }); check('CSV import', r.status === 200 && r.json.added === 2, r.text.slice(0, 120));
  r = await s1.call('/api/calendar/admin', { body: { title: 'x' } }); check('Students cannot add events directly', r.status === 403);

  const fails = results.filter(x => !x.ok).length; console.log(`\n${results.length - fails} passed, ${fails} failed`); process.exitCode = fails ? 1 : 0;
})().catch(err => { console.error(err); process.exitCode = 1; });
