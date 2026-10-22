// Lesson covers for the Academy, adapted from psyrenne's tools/lesson-covers.js: the CR Pro card from social-packs.js at
// 1280 x 720 (the size lesson pictures and YouTube-style thumbnails use), with "<COURSE> · LESSON n" along the bottom.
//   node tools/lesson-covers.js <lessons.json> "<Course name>" "<output folder>" [comma list of lesson numbers] [--bg-folder pictures]
// lessons.json: an array, in course order, of { "t": "lesson title" } (or { "title": ... }). Backgrounds (optional) rotate
// through the pictures in --bg-folder so a course doesn't look like one picture over and over.
const fs = require('fs'), path = require('path');
const sp = require('./social-packs.js');
async function makeCovers(lessons, course, outDir, { only = null, bgFolder = null } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const bgs = bgFolder ? fs.readdirSync(bgFolder).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort().map(f => path.join(bgFolder, f)) : [];
  const b = await sp.launchBrowser(), made = [];
  try {
    for (let i = 0; i < lessons.length; i++) { const n = i + 1; if (only && !only.includes(n)) continue;
      const title = String(lessons[i].t || lessons[i].title || '').trim(), bgFile = bgs.length ? bgs[i % bgs.length] : null;
      const bg = bgFile ? 'data:image/' + (/\.png$/i.test(bgFile) ? 'png' : 'jpeg') + ';base64,' + fs.readFileSync(bgFile).toString('base64') : '';
      const file = path.join(outDir, `Lesson ${String(n).padStart(2, '0')} - ${title.replace(/[\\/:*?"<>|]/g, '').slice(0, 70)}.png`);
      await sp.render(b, sp.poster(title, 1280, 720, { bg, line: `${course} · Lesson ${n}`.toUpperCase(), footer: 'CLINICALRESEARCHPRO.COM' }), 1280, 720, file);
      made.push(file); console.log(file);
    }
  } finally { await b.close(); }
  return made;
}
module.exports = { makeCovers };
if (require.main === module) {
  const a = process.argv.slice(2), bi = a.indexOf('--bg-folder'), bgFolder = bi > -1 ? a.splice(bi, 2)[1] : null, [list, course, out, onlyArg] = a;
  if (!list || !course || !out) { console.log('node tools/lesson-covers.js <lessons.json> "<Course name>" "<output folder>" [comma list of lesson numbers] [--bg-folder pictures]'); process.exit(1); }
  makeCovers(JSON.parse(fs.readFileSync(list, 'utf8')), course, out, { only: onlyArg ? onlyArg.split(',').map(Number) : null, bgFolder }).catch(e => { console.error(e.message); process.exit(1); });
}
