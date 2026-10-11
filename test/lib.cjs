// Shared harness: static server for dist/ + headless Chromium (SwiftShader) page.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.map': 'application/json' };
async function start({ port = 8125, width = 1280, height = 800, dsf = 2, touch = true } = {}) {
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, p);
    fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
  }).listen(port);
  const browser = await chromium.launch({ executablePath: require('./chrome.cjs'), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, hasTouch: touch, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message + ' @ ' + (e.stack || '').split('\n').slice(1, 4).join(' | ')));
  const shot = (n) => page.screenshot({ path: path.join(__dirname, '..', 'shots', n + '.png') });
  const close = async () => { await browser.close(); srv.close(); };
  return { browser, ctx, page, errs, shot, close, url: `http://localhost:${port}/` };
}
module.exports = { start };
