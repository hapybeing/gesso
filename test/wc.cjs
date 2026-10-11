const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'dist');
const srv = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; fs.readFile(path.join(root, p), (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, {'content-type': p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'}); r.end(d); }); }).listen(8125);
(async () => {
  const browser = await chromium.launch({ executablePath: require('./chrome.cjs'), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
  page.on('pageerror', (e) => console.log('ERR', e.message));
  await page.goto('http://localhost:8125/?w=1000&h=700'); await page.waitForTimeout(500);
  await page.evaluate(() => {
    const g = window.gesso, e = g.engine, cv = document.querySelector('#view');
    e.view = { x: 50, y: 30, scale: 1, rot: 0 };
    const ev = (t,o)=>cv.dispatchEvent(new PointerEvent(t,{bubbles:true,isPrimary:true,...o}));
    const stroke = (pts)=>{ ev('pointerdown',{pointerId:5,pointerType:'pen',clientX:pts[0][0],clientY:pts[0][1],pressure:pts[0][2],buttons:1}); for(const p of pts.slice(1)) ev('pointermove',{pointerId:5,pointerType:'pen',clientX:p[0],clientY:p[1],pressure:p[2],buttons:1}); ev('pointerup',{pointerId:5,pointerType:'pen',clientX:pts.at(-1)[0],clientY:pts.at(-1)[1]}); };
    const wave=(x0,y0,len,amp,n=90)=>{const a=[];for(let i=0;i<=n;i++){const t=i/n;a.push([x0+t*len,y0+Math.sin(t*6.28)*amp,0.3+0.7*Math.sin(Math.PI*t)])}return a};
    const use=(id,c)=>{g.state.toolBrush.brush=id;g.tool='brush';g.state.color=c};
    use('wc-wash',[0.2,0.4,0.75]); stroke(wave(100,120,800,30)); stroke(wave(150,170,700,40));
    use('wc-round',[0.8,0.3,0.35]); stroke(wave(100,300,800,25));
    use('wc-bleed',[0.3,0.6,0.35]); stroke(wave(100,450,800,30));
    use('ink-brushpen',[0.1,0.1,0.1]); stroke(wave(100,600,800,30));
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'shots/10-watercolour.png' });
  await browser.close(); srv.close();
})();
