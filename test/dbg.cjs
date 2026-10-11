const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'dist');
const srv = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; fs.readFile(path.join(root, p), (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, {'content-type': p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'}); r.end(d); }); }).listen(8124);
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  page.on('pageerror', (e) => console.log('ERR', e.message));
  await page.goto('http://localhost:8124/?w=800&h=600'); await page.waitForTimeout(500);
  const r = await page.evaluate(fs => { eval(fs); return run(); }, `
    function run(){
    const g = window.gesso, e = g.engine, cv = document.querySelector('#view');
    const ev = (t,o)=>cv.dispatchEvent(new PointerEvent(t,{bubbles:true,isPrimary:true,...o}));
    const stroke = (pts)=>{ ev('pointerdown',{pointerId:5,pointerType:'pen',clientX:pts[0][0],clientY:pts[0][1],pressure:1,buttons:1}); for(const p of pts.slice(1)) ev('pointermove',{pointerId:5,pointerType:'pen',clientX:p[0],clientY:p[1],pressure:1,buttons:1}); ev('pointerup',{pointerId:5,pointerType:'pen',clientX:pts.at(-1)[0],clientY:pts.at(-1)[1]}); };
    const sum = (l)=>{ const px = e.layerPixels(l,{x:0,y:0,w:e.w,h:e.h}); let a=0; for(let i=3;i<px.length;i+=4) a+=px[i]; return a; };
    const out = {};
    g.state.toolBrush.brush='ink-studio'; g.tool='brush';
    const c = e.docToScreen(400,300);
    stroke([[c.x-200,c.y,1],[c.x-100,c.y+5,1],[c.x+200,c.y,1]]);
    out.l1 = sum(e.layers[0]);
    e.addLayer(); e.setProp(e.activeLayer,'clip',true);
    g.state.toolBrush.brush='air-soft'; g.state.color=[1,0,0];
    stroke([[c.x-300,c.y,1],[c.x-150,c.y,1],[c.x,c.y,1],[c.x+300,c.y,1]]);
    out.l2 = sum(e.layers[1]); out.hist = e.history.list.length;
    out.sample = e.sample(400,300);
    return out; }`);
  console.log(JSON.stringify(r));
  await page.screenshot({ path: 'shots/dbg.png' });
  await browser.close(); srv.close();
})();
