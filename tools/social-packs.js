// Social image packs for Clinical Research Pro, adapted from psyrenne's tools/social-packs.js. Run by hand on a computer
// with Google Chrome (or Edge) installed. It draws one title card per platform size in the CR Pro look (black, pink, cyan,
// gold, the logo, Montserrat), saves them as PNGs, and can send the app the JPEG sizes its Social posts use.
//   node tools/social-packs.js --title "GCP Training: The Complete Guide" [--post-id 101] [--category "Good Clinical Practice"]
//                              [--bg picture.jpg] [--out "folder"] [--upload]
// --upload sends the pictures to the app (APP_URL) through the signed endpoint, so set SITE_KEY and APP_URL first.
// No scheduled task and no server logins: psyrenne's ssh/WordPress steps are left out on purpose.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
// [code, width, height, what it's for]. FB, IGP, P1, X are the ones Social posts uses.
const SIZES = [['WP', 1200, 675, 'Website featured image'], ['FB', 1200, 630, 'Facebook and LinkedIn link post'], ['IGP', 1080, 1350, 'Instagram feed, 4:5'], ['SQ', 1080, 1080, 'Square (Instagram, LinkedIn)'],
  ['STORY', 1080, 1920, 'Stories and Reels covers'], ['P1', 1000, 1500, 'Pinterest pin'], ['X', 1600, 900, 'X post'], ['YT', 1280, 720, 'YouTube thumbnail']];
const UPLOAD = ['FB', 'IGP', 'P1', 'X', 'YT', 'WP'];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dataUrl = (file, type) => { try { return `data:${type};base64,` + fs.readFileSync(file).toString('base64'); } catch { return ''; } };
const LOGO = dataUrl(path.join(ROOT, 'public', 'logo.png'), 'image/png');
const FONT = w => dataUrl(path.join(ROOT, 'node_modules', '@fontsource', 'montserrat', 'files', `montserrat-latin-${w}-normal.woff2`), 'font/woff2');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'];
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
// Chrome first: a failed headless Edge start can leave hidden processes behind.
async function launchBrowser() {
  let puppeteer; try { puppeteer = require('puppeteer-core'); } catch { throw new Error('Run "npm install" in the app folder first (puppeteer-core is a dev dependency).'); }
  let last; for (const p of [...CHROME, ...EDGE].filter(x => fs.existsSync(x))) { try { return await puppeteer.launch({ executablePath: p, headless: true }); } catch (err) { last = err; } }
  throw last || new Error('No Chrome or Edge found.');
}
// Title and subtitle: the part after a colon (or inside parentheses) is the subtitle.
// A colon wins; parentheses count only when they hold a phrase (so "ICH E6(R3)" stays whole).
function parts(title) { let m = /^(.+?):\s*(.+)$/.exec(title); if (m) return [m[1], m[2]]; m = /^(.*?)\s+\(([^)]+\s[^)]+)\)\s*$/.exec(title); return m ? [m[1], m[2]] : [title, '']; }
// The CR Pro card: black with a faint picture (if any), the logo, a pink-to-cyan-to-gold stripe, white title, gold subtitle.
function poster(title, W, H, { bg = '', category = '', footer = 'CLINICALRESEARCHPRO.COM', line = '' } = {}) {
  const u = Math.min(W, H) / 100, tall = H / W > 1.2, [main, sub] = parts(String(title)), size = (tall ? 9.5 : 8.6) * u * (main.length > 60 ? 0.78 : main.length > 40 ? 0.9 : 1);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Montserrat;src:url(${FONT(800)}) format("woff2");font-weight:800}@font-face{font-family:Montserrat;src:url(${FONT(600)}) format("woff2");font-weight:600}
*{box-sizing:border-box;margin:0}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000;color:#fff;font-family:Montserrat,Arial,sans-serif}
.bg{position:absolute;inset:0;background:${bg ? `url(${bg}) center/cover` : 'radial-gradient(circle at 80% 20%,#16323f 0,#000 60%)'};opacity:${bg ? .28 : 1}}
.stripe{position:absolute;left:0;right:0;top:0;height:${1.4 * u}px;background:linear-gradient(90deg,#FF3399,#9B4DFF,#0DB8F8,#F4C257)}
.wrap{position:absolute;inset:${7 * u}px ${7 * u}px ${12 * u}px;display:flex;flex-direction:column;justify-content:center;gap:${2.4 * u}px}
.logo{width:${(tall ? 20 : 16) * u}px;height:auto;border-radius:${1.2 * u}px}
.cat{font-weight:600;font-size:${2.8 * u}px;letter-spacing:.2em;text-transform:uppercase;color:#0DB8F8}
h1{font-weight:800;font-size:${size}px;line-height:1.05;letter-spacing:-.01em;text-wrap:balance}
.sub{font-weight:600;font-size:${size * .45}px;line-height:1.25;color:#F4C257;text-wrap:balance}
.bar{width:${14 * u}px;height:${.9 * u}px;background:#FF3399}
.foot{position:absolute;left:${7 * u}px;right:${7 * u}px;bottom:${(tall ? 9 : 5) * u}px;display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:${2.6 * u}px;letter-spacing:.18em}
.foot .tag{color:#F4C257;letter-spacing:.06em}${tall ? ".foot{flex-direction:column;align-items:flex-start;gap:" + (1.4 * u) + "px}" : ""}</style></head><body><div class="bg"></div><div class="stripe"></div>
<div class="wrap">${LOGO ? `<img class="logo" src="${LOGO}" alt="">` : ''}${category ? `<p class="cat">${esc(category)}</p>` : ''}<h1>${esc(main)}</h1><span class="bar"></span>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}</div>
<div class="foot"><span class="tag">${esc(line || 'Collaborate. Educate. Empower.')}</span><span>${esc(footer)}</span></div></body></html>`;
}
async function render(browser, html, W, H, file) { const pg = await browser.newPage(); await pg.setViewport({ width: W, height: H }); await pg.setContent(html, { waitUntil: 'load' }); await pg.evaluate(() => document.fonts.ready); await pg.screenshot({ path: file }); await pg.close(); }
async function toJpeg(browser, file) { const pg = await browser.newPage(); await pg.setContent(`<img id="i" src="${dataUrl(file, 'image/png')}">`); await pg.waitForFunction(() => document.getElementById('i').complete);
  const d = await pg.evaluate(() => { const i = document.getElementById('i'), c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; c.getContext('2d').drawImage(i, 0, 0); return c.toDataURL('image/jpeg', 0.82); }); await pg.close(); return d; }
async function upload(postId, files) {
  const app = (process.env.APP_URL || '').replace(/\/$/, ''), key = process.env.SITE_KEY || ''; if (!app || key.length < 24) throw new Error('Set APP_URL and SITE_KEY (24+ characters) to upload.');
  const body = JSON.stringify({ post_id: postId, files }), ts = Math.floor(Date.now() / 1000);
  const r = await fetch(`${app}/api/site/social-images`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CRPro-Timestamp': String(ts), 'X-CRPro-Signature': 'sha256=' + crypto.createHmac('sha256', key).update(`${ts}.${body}`).digest('hex') }, body });
  if (!r.ok) throw new Error('Upload failed (' + r.status + '): ' + (await r.text()).slice(0, 200));
}
async function makePack({ title, postId, category, bgFile, out }) {
  const dir = out || path.join(process.cwd(), 'social-packs', title.replace(/[<>:"/\\|?*]/g, '').slice(0, 70).trim()); fs.mkdirSync(dir, { recursive: true });
  const bg = bgFile ? dataUrl(bgFile, /\.png$/i.test(bgFile) ? 'image/png' : 'image/jpeg') : '', b = await launchBrowser(), made = [];
  try { for (const [code, W, H] of SIZES) { const file = path.join(dir, `${code}.png`); await render(b, poster(title, W, H, { bg, category }), W, H, file); made.push([code, file]); console.log(file); }
    if (args.includes('--upload')) { if (!postId) throw new Error('--upload needs --post-id (the WordPress article ID).');
      const files = []; for (const [code, file] of made) if (UPLOAD.includes(code)) files.push({ code: code, name: `${code}-${title.slice(0, 40)}`, data: await toJpeg(b, file) });
      await upload(postId, files); console.log(`Sent ${files.length} pictures to the app for article ${postId}.`); } }
  finally { await b.close(); }
  fs.writeFileSync(path.join(dir, 'sizes.txt'), SIZES.map(s => `${s[0]}.png  ${s[1]} x ${s[2]}  ${s[3]}`).join('\r\n'));
  return dir;
}
module.exports = { poster, launchBrowser, render, SIZES };
if (require.main === module) {
  const title = arg('title'); if (!title) { console.log('node tools/social-packs.js --title "Article title" [--post-id 101] [--category "Topic"] [--bg picture.jpg] [--out folder] [--upload]'); process.exit(1); }
  makePack({ title, postId: Number(arg('post-id')) || null, category: arg('category', ''), bgFile: arg('bg'), out: arg('out') }).catch(e => { console.error(e.message); process.exit(1); });
}
