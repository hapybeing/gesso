"use strict";(()=>{var V=`
uniform sampler2D uStroke;
uniform int uStrokeMode;      // 0 none, 1 paint, 2 erase
uniform vec3 uColor;          // straight colour
uniform float uStrokeOpacity;
uniform float uWet;
uniform float uWetR;
uniform bool uAlphaLock;
uniform vec2 uTexel;
uniform sampler2D uSel;       // selection mask (r), active when uUseSel == 1
uniform int uUseSel;
float strokeCov(vec2 uv){
  float s = texture(uStroke, uv).r;
  if (uWet > 0.0) {
    float avg = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853982;
      avg += texture(uStroke, uv + vec2(cos(a), sin(a)) * uWetR * uTexel).r;
    }
    avg *= 0.125;
    s = s * (1.0 - 0.5 * uWet) + uWet * max(0.0, s - avg) * 4.0;
  }
  s = clamp(s, 0.0, 1.0) * uStrokeOpacity;
  if (uUseSel == 1) s *= texture(uSel, uv).r;
  return s;
}
vec4 applyStroke(vec4 L, vec2 uv){
  if (uStrokeMode == 0) return L;
  float s = strokeCov(uv);
  if (uStrokeMode == 2) return L * (1.0 - s);
  if (uAlphaLock) return vec4(mix(L.rgb, uColor * L.a, s), L.a);
  return vec4(uColor * s, s) + L * (1.0 - s);
}`,Y=`
float lum(vec3 c){ return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c){
  float l = lum(c); float n = min(min(c.r,c.g),c.b); float x = max(max(c.r,c.g),c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec3 setLum(vec3 c, float l){ return clipColor(c + (l - lum(c))); }
float sat(vec3 c){ return max(max(c.r,c.g),c.b) - min(min(c.r,c.g),c.b); }
vec3 setSat(vec3 c, float s){
  float mx = max(max(c.r,c.g),c.b), mn = min(min(c.r,c.g),c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float softL(float b, float s){
  if (s <= 0.5) return b - (1.0 - 2.0*s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0*b - 12.0)*b + 4.0)*b : sqrt(b);
  return b + (2.0*s - 1.0) * (d - b);
}
vec3 blendFn(int m, vec3 b, vec3 s){
  if (m == 1) return b * s;
  if (m == 2) return b + s - b * s;
  if (m == 3) return mix(2.0*b*s, 1.0 - 2.0*(1.0-b)*(1.0-s), step(0.5, b));
  if (m == 4) return min(b, s);
  if (m == 5) return max(b, s);
  if (m == 6) return mix(min(vec3(1.0), b / max(1.0 - s, 1e-5)), vec3(1.0), step(1.0, s)) * step(1e-5, b);
  if (m == 7) return mix(1.0 - min(vec3(1.0), (1.0 - b) / max(s, 1e-5)), vec3(1.0), step(1.0, b));
  if (m == 8) return mix(2.0*b*s, 1.0 - 2.0*(1.0-b)*(1.0-s), step(0.5, s));
  if (m == 9) return vec3(softL(b.r,s.r), softL(b.g,s.g), softL(b.b,s.b));
  if (m == 10) return abs(b - s);
  if (m == 11) return b + s - 2.0*b*s;
  if (m == 12) return min(vec3(1.0), b + s);
  if (m == 13) return max(vec3(0.0), b + s - 1.0);
  if (m == 14) return setLum(setSat(s, sat(b)), lum(b));
  if (m == 15) return setLum(setSat(b, sat(s)), lum(b));
  if (m == 16) return setLum(s, lum(b));
  if (m == 17) return setLum(b, lum(s));
  return s;
}
vec4 blendOver(vec4 b, vec4 s, int m){
  if (m == 0) return s + b * (1.0 - s.a);
  vec3 Cb = b.a > 0.0 ? b.rgb / b.a : vec3(0.0);
  vec3 Cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 Cr = (1.0 - b.a) * Cs + b.a * clamp(blendFn(m, Cb, Cs), 0.0, 1.0);
  return vec4(s.a * Cr + (1.0 - s.a) * b.rgb, s.a + b.a * (1.0 - s.a));
}`,$=`#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uPrev, uLayer, uClip;
uniform int uMode; uniform float uOpacity;
uniform int uClipMode; // 0 none, 1 clip, 2 clip with live-stroked base
uniform int uActive;
uniform vec4 uTint; // rgb + amount (onion skins)
uniform vec4 uLayerMap, uClipMap; // doc uv -> layer/clip texture uv (identity, or a tile's place in an atlas page)
${V}
${Y}
void main(){
  vec4 b = texture(uPrev, vUv);
  vec4 s = texture(uLayer, vUv * uLayerMap.xy + uLayerMap.zw);
  if (uActive == 1) s = applyStroke(s, vUv);
  s.rgb = mix(s.rgb, uTint.rgb * s.a, uTint.a);
  s *= uOpacity;
  if (uClipMode > 0) {
    vec4 c = texture(uClip, vUv * uClipMap.xy + uClipMap.zw);
    if (uClipMode == 2) c = applyStroke(c, vUv);
    s *= c.a;
  }
  o = blendOver(b, s, uMode);
}`,Z=`#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uLayer;
${V}
void main(){ o = applyStroke(texture(uLayer, vUv), vUv); }`,ee=`#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uPrev, uLayer;
uniform int uMode; uniform float uOpacity;
${Y}
void main(){ o = blendOver(texture(uPrev, vUv), texture(uLayer, vUv) * uOpacity, uMode); }`;var k=`
vec4 pack(ivec2 p){ return vec4(float(p.x / 256), float(p.x % 256), float(p.y / 256), float(p.y % 256)) / 255.0; }
ivec2 unpack(vec4 c){ ivec4 b = ivec4(c * 255.0 + 0.5); return ivec2(b.r * 256 + b.g, b.b * 256 + b.a); }
const ivec2 NONE = ivec2(65535);`,te=`#version 300 es
precision highp float; precision highp int;
in vec2 vUv; out vec4 o;
uniform sampler2D uSel; uniform int uInside;
${k}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float m = texelFetch(uSel, p, 0).r;
  bool seed = uInside == 1 ? m >= 0.5 : m < 0.5;
  o = seed ? pack(p) : pack(NONE);
}`,ie=`#version 300 es
precision highp float; precision highp int;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform int uStep; uniform ivec2 uSize;
${k}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 best = NONE; float bd = 1e20;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec2 q = p + ivec2(x, y) * uStep;
    if (q.x < 0 || q.y < 0 || q.x >= uSize.x || q.y >= uSize.y) continue;
    ivec2 s = unpack(texelFetch(uSrc, q, 0));
    if (s.x == 65535) continue;
    vec2 d = vec2(s - p); float dd = dot(d, d);
    if (dd < bd) { bd = dd; best = s; }
  }
  o = pack(best);
}`,re=`#version 300 es
precision highp float; precision highp int;
in vec2 vUv; out vec4 o;
uniform sampler2D uSel, uIn, uOut; uniform float uR;
${k}
float dist(sampler2D t, ivec2 p){ ivec2 s = unpack(texelFetch(t, p, 0)); return s.x == 65535 ? 1e9 : length(vec2(s - p)); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float m = texelFetch(uSel, p, 0).r, r = m;
  if (uR > 0.0) r = max(m, clamp(uR + 1.0 - dist(uIn, p), 0.0, 1.0));
  else if (uR < 0.0) r = min(m, clamp(dist(uOut, p) + uR, 0.0, 1.0));
  o = vec4(r, r, r, 1.0);
}`;var K={shape:"hard",grain:"none",mode:"paint",size:24,minSize:.15,opacity:1,flow:1,spacing:.08,sizeJitter:0,opacityJitter:0,scatter:0,rotJitter:0,followDir:!1,roundness:1,angle:0,taperStart:0,taperEnd:0,pressSize:1,pressOpacity:0,tiltSize:0,grainScale:1,grainDepth:0,wetEdges:0,smoothing:.25,smudge:.7},T=(n,e,t,i)=>({...K,id:n,name:e,group:t,...i}),Q=[T("ink-studio","Studio Ink","Inking",{size:14,minSize:.05,spacing:.05,taperStart:30,taperEnd:40,smoothing:.35}),T("ink-gel","Gel Pen","Inking",{size:8,minSize:.55,spacing:.05,smoothing:.3}),T("ink-brushpen","Brush Pen","Inking",{size:30,minSize:.02,spacing:.04,roundness:.55,angle:35,taperStart:60,taperEnd:90,smoothing:.45}),T("pencil-hb","HB Pencil","Sketching",{shape:"pencil",grain:"paper",size:7,minSize:.5,flow:.55,spacing:.12,pressSize:.4,pressOpacity:1,tiltSize:1.6,grainScale:.9,grainDepth:.85,rotJitter:1,smoothing:.1}),T("pencil-6b","6B Graphite","Sketching",{shape:"pencil",grain:"cold",size:16,minSize:.4,flow:.45,spacing:.1,pressSize:.5,pressOpacity:1,tiltSize:2.2,grainScale:1.1,grainDepth:.9,rotJitter:1,smoothing:.1}),T("charcoal","Willow Charcoal","Sketching",{shape:"chalk",grain:"paper",size:40,minSize:.35,flow:.5,spacing:.1,pressOpacity:.9,pressSize:.6,tiltSize:1.5,grainScale:1.6,grainDepth:.95,rotJitter:1,scatter:.05,smoothing:.05}),T("air-soft","Soft Air","Airbrush",{shape:"soft",size:160,minSize:.6,flow:.06,spacing:.06,pressSize:.4,pressOpacity:1,smoothing:.4}),T("air-hard","Hard Air","Airbrush",{shape:"soft",size:60,minSize:.7,flow:.18,spacing:.05,pressSize:.2,pressOpacity:1,smoothing:.3}),T("air-spatter","Speckle Can","Airbrush",{shape:"spatter",size:120,minSize:.6,flow:.5,spacing:.35,rotJitter:1,sizeJitter:.4,scatter:.3,pressOpacity:.7,smoothing:0}),T("wc-wash","Wet Wash","Watercolour",{shape:"wash",grain:"paper",size:90,minSize:.5,opacity:.75,flow:.25,spacing:.07,pressSize:.6,pressOpacity:.6,grainScale:3,grainDepth:.12,wetEdges:.9,rotJitter:1,smoothing:.35,wet:.8,granulation:.5}),T("wc-round","Round Sable","Watercolour",{shape:"soft",grain:"cold",size:36,minSize:.2,opacity:.8,flow:.35,spacing:.05,grainScale:2.5,grainDepth:.15,wetEdges:.7,taperStart:20,taperEnd:40,smoothing:.35,wet:.45,granulation:.35}),T("wc-bleed","Bleed Bloom","Watercolour",{shape:"wash",grain:"paper",size:140,minSize:.7,opacity:.55,flow:.14,spacing:.08,scatter:.06,sizeJitter:.2,rotJitter:1,grainScale:3,grainDepth:.15,wetEdges:1,smoothing:.3,wet:1,granulation:.6}),T("marker-chisel","Chisel Marker","Markers",{shape:"chisel",size:28,minSize:.85,opacity:.7,flow:1,spacing:.03,roundness:.3,angle:45,pressSize:.15,smoothing:.3}),T("marker-felt","Felt Tip","Markers",{shape:"hard",grain:"noise",size:12,minSize:.8,opacity:.85,flow:.9,spacing:.05,pressSize:.2,grainDepth:.25,smoothing:.25}),T("paint-bristle","Oil Bristle","Painting",{shape:"bristle",grain:"canvas",size:50,minSize:.4,flow:.85,spacing:.04,followDir:!0,pressSize:.6,pressOpacity:.4,grainDepth:.35,grainScale:1,taperEnd:40,smoothing:.2}),T("paint-gouache","Gouache Flat","Painting",{shape:"chalk",grain:"canvas",size:44,minSize:.6,flow:.7,opacity:1,spacing:.05,roundness:.6,followDir:!0,grainDepth:.3,pressOpacity:.5,smoothing:.2}),T("smudge-soft","Soft Blend","Smudge",{mode:"smudge",shape:"soft",size:70,minSize:.6,spacing:.08,smudge:.8,pressOpacity:1,smoothing:.2}),T("smudge-streak","Streaky Drag","Smudge",{mode:"smudge",shape:"bristle",size:50,minSize:.6,spacing:.06,followDir:!0,smudge:.9,pressOpacity:1,smoothing:.2})],ae=["hard","soft","pencil","chalk","spatter","chisel","bristle","wash"],ne=["none","paper","cold","canvas","noise"];var oe={size:[.5,1e3],minSize:[0,1],opacity:[0,1],flow:[0,1],spacing:[.01,2],sizeJitter:[0,1],opacityJitter:[0,1],scatter:[0,4],rotJitter:[0,1],roundness:[.05,1],angle:[-360,360],taperStart:[0,2e3],taperEnd:[0,2e3],pressSize:[0,1],pressOpacity:[0,1],tiltSize:[0,1],grainScale:[.1,20],grainDepth:[0,1],wetEdges:[0,1],smoothing:[0,1],smudge:[0,1],wet:[0,1],granulation:[0,1]};function le(n){if(!n||typeof n!="object")return null;let e=n,t={...K,id:"",name:"",group:"Imported"};t.name=String(e.name??"Brush").slice(0,40)||"Brush",t.id=String(e.id??"").replace(/[^\w-]/g,"").slice(0,40)||"brush",ae.includes(e.shape)&&(t.shape=e.shape),ne.includes(e.grain)&&(t.grain=e.grain),t.mode=e.mode==="smudge"?"smudge":"paint",t.followDir=!!e.followDir;for(let[i,[s,h]]of Object.entries(oe)){let r=Number(e[i]);Number.isFinite(r)&&(t[i]=Math.max(s,Math.min(h,r)))}return t}var he="gesso.brushes";var ue=["My brushes","Imported"];try{let n=JSON.parse(localStorage.getItem(he)||"[]");if(Array.isArray(n))for(let e of n){let t=le(e);t&&(t.id=String(e.id).replace(/[^\w-]/g,"")||t.id,t.group=ue.includes(e.group)?e.group:"Imported",Q.some(i=>i.id===t.id)||Q.push(t))}}catch{}var be=(()=>{let n=new Uint32Array(256);for(let e=0;e<256;e++){let t=e;for(let i=0;i<8;i++)t=t&1?3988292384^t>>>1:t>>>1;n[e]=t>>>0}return n})();function ge(n,e=0){let t=~e>>>0;for(let i=0;i<n.length;i++)t=be[(t^n[i])&255]^t>>>8;return~t>>>0}async function ye(n,e){let t=new Blob([n]).stream().pipeThrough(e);return new Uint8Array(await new Response(t).arrayBuffer())}var gt=new TextEncoder,yt=new TextDecoder;function C(n,e){let t=new Uint8Array(12+e.length),i=new DataView(t.buffer);i.setUint32(0,e.length);for(let s=0;s<4;s++)t[4+s]=n.charCodeAt(s);return t.set(e,8),i.setUint32(8+e.length,ge(t.subarray(4,8+e.length))),t}async function H(n,e,t){let i=e*4,s=new Uint8Array((i+1)*t),h=[new Uint8Array(i),new Uint8Array(i),new Uint8Array(i),new Uint8Array(i)];for(let a=0;a<t;a++){let o=n.subarray(a*i,(a+1)*i),u=a?n.subarray((a-1)*i,a*i):null,f=0,c=0;for(let E=0;E<i;E++)c+=o[E]<128?o[E]:256-o[E];let[x,S,,w]=h,m=0,v=0,R=0;for(let E=0;E<i;E++){let U=E>=4?o[E-4]:0,F=u?u[E]:0,B=u&&E>=4?u[E-4]:0,_=o[E]-U&255,D=o[E]-F&255,I=U+F-B,z=Math.abs(I-U),X=Math.abs(I-F),W=Math.abs(I-B),j=z<=X&&z<=W?U:X<=W?F:B,M=o[E]-j&255;x[E]=_,S[E]=D,w[E]=M,m+=_<128?_:256-_,v+=D<128?D:256-D,R+=M<128?M:256-M}let A=o;m<c&&(f=1,c=m,A=x),v<c&&(f=2,c=v,A=S),R<c&&(f=4,c=R,A=w);let G=a*(i+1);s[G]=f,s.set(A,G+1),(a&255)===255&&await new Promise(E=>setTimeout(E,0))}let r=new Uint8Array(13),p=new DataView(r.buffer);p.setUint32(0,e),p.setUint32(4,t),r[8]=8,r[9]=6,r[10]=0,r[11]=0,r[12]=0;let b=await ye(s,new CompressionStream("deflate")),y=[new Uint8Array([137,80,78,71,13,10,26,10]),C("IHDR",r),C("IDAT",b),C("IEND",new Uint8Array(0))],d=new Uint8Array(y.reduce((a,o)=>a+o.length,0)),l=0;for(let a of y)d.set(a,l),l+=a.length;return d}function J(n){let e=new Uint8Array(n.length);for(let t=0;t<n.length;t+=4){let i=n[t+3];if(e[t+3]=i,i===255)e[t]=n[t],e[t+1]=n[t+1],e[t+2]=n[t+2];else if(i){let s=255/i;e[t]=Math.min(255,Math.round(n[t]*s)),e[t+1]=Math.min(255,Math.round(n[t+1]*s)),e[t+2]=Math.min(255,Math.round(n[t+2]*s))}}return e}function ve(n,e){let t=n.length/3;if(!t)return new Uint8Array(3);let i=new Uint32Array(t);for(let l=0;l<t;l++)i[l]=l;let s=(l,a)=>{let o=[255,255,255],u=[0,0,0];for(let x=l;x<a;x++){let S=i[x]*3;for(let w=0;w<3;w++){let m=n[S+w];m<o[w]&&(o[w]=m),m>u[w]&&(u[w]=m)}}let f=[(u[0]-o[0])*1,(u[1]-o[1])*1.2,(u[2]-o[2])*.8],c=f[0]>=f[1]&&f[0]>=f[2]?0:f[1]>=f[2]?1:2;return{lo:l,hi:a,ch:c,score:f[c]*f[c]*Math.sqrt(a-l)}},h=[s(0,t)];for(;h.length<e;){let l=-1,a=0;if(h.forEach((c,x)=>{c.hi-c.lo>1&&c.score>a&&(a=c.score,l=x)}),l<0)break;let o=h[l],u=Array.from(i.subarray(o.lo,o.hi)).sort((c,x)=>n[c*3+o.ch]-n[x*3+o.ch]);i.set(u,o.lo);let f=o.lo+o.hi>>1;h.splice(l,1,s(o.lo,f),s(f,o.hi))}let r=h.map(l=>{let a=[0,0,0];for(let u=l.lo;u<l.hi;u++){let f=i[u]*3;a[0]+=n[f],a[1]+=n[f+1],a[2]+=n[f+2]}let o=l.hi-l.lo;return[a[0]/o,a[1]/o,a[2]/o]}),p=Math.max(1,Math.floor(t/6e4));for(let l=0;l<4;l++){let a=r.map(()=>[0,0,0,0]);for(let o=0;o<t;o+=p){let u=o*3,f=n[u],c=n[u+1],x=n[u+2],S=0,w=1/0;for(let v=0;v<r.length;v++){let R=r[v],A=(R[0]-f)**2*1+(R[1]-c)**2*1.44+(R[2]-x)**2*.64;A<w&&(w=A,S=v)}let m=a[S];m[0]+=f,m[1]+=c,m[2]+=x,m[3]++}r=r.map((o,u)=>a[u][3]?[a[u][0]/a[u][3],a[u][1]/a[u][3],a[u][2]/a[u][3]]:o)}let b=r.map(()=>new Map),g=r.map(()=>0);for(let l=0;l<t;l+=p){let a=l*3,o=n[a],u=n[a+1],f=n[a+2],c=0,x=1/0;for(let m=0;m<r.length;m++){let v=r[m],R=(v[0]-o)**2*1+(v[1]-u)**2*1.44+(v[2]-f)**2*.64;R<x&&(x=R,c=m)}let S=o<<16|u<<8|f,w=b[c];w.set(S,(w.get(S)||0)+1),g[c]++}r=r.map((l,a)=>{let o=-1,u=0;for(let[f,c]of b[a])c>u&&(u=c,o=f);return o>=0&&u>=g[a]*.25?[o>>16,o>>8&255,o&255]:l});let y=new Set;r=r.filter(l=>{let a=l.map(Math.round).join(",");return y.has(a)?!1:(y.add(a),!0)});let d=new Uint8Array(r.length*3);return r.forEach((l,a)=>{d[a*3]=Math.round(l[0]),d[a*3+1]=Math.round(l[1]),d[a*3+2]=Math.round(l[2])}),d}var xe=Float32Array.from([[0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],[12,44,4,36,14,46,6,38],[60,28,52,20,62,30,54,22],[3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],[15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21]].flat().map(e=>(e+.5)/64-.5)),O=class{constructor(e,t=e.length/3){this.pal=e;this.n=t}pal;n;exact=new Map;cache=new Int16Array(1<<18).fill(-1);search(e,t,i){let s=1/0,h=0;for(let r=0;r<this.n;r++){let p=(this.pal[r*3]-e)**2+(this.pal[r*3+1]-t)**2*1.44+(this.pal[r*3+2]-i)**2*.64;p<s&&(s=p,h=r)}return h}nearest(e,t,i){let s=e<<16|t<<8|i,h=this.exact.get(s);if(h!==void 0)return h;if(this.exact.size<4e5)return h=this.search(e,t,i),this.exact.set(s,h),h;let r=e>>2<<12|t>>2<<6|i>>2;return h=this.cache[r],h<0&&(h=this.search((e&-4)+2,(t&-4)+2,(i&-4)+2),this.cache[r]=h),h}map(e,t,i,s,h){let r=new Uint8Array(t*i),p=s?22:0;for(let b=0,g=0;b<i;b++)for(let y=0;y<t;y++,g++){let d=g*4;if(e[d+3]<128){r[g]=h;continue}if(p){let l=this.nearest(e[d],e[d+1],e[d+2]);if(Math.abs(this.pal[l*3]-e[d])+Math.abs(this.pal[l*3+1]-e[d+1])+Math.abs(this.pal[l*3+2]-e[d+2])<=3){r[g]=l;continue}let a=xe[(b&7)*8+(y&7)]*p,o=Math.min(255,Math.max(0,e[d]+a)),u=Math.min(255,Math.max(0,e[d+1]+a)),f=Math.min(255,Math.max(0,e[d+2]+a));r[g]=this.nearest(o|0,u|0,f|0)}else r[g]=this.nearest(e[d],e[d+1],e[d+2])}return r}};function we(n,e=8){let t=[],i=0,s=0,h=1<<e,r=h+1,p=e+1,b=r+1,g=5003,y=new Int32Array(g).fill(-1),d=new Int32Array(g),l=o=>{for(i|=o<<s,s+=p;s>=8;)t.push(i&255),i>>>=8,s-=8};if(l(h),!n.length)return l(r),s&&t.push(i&255),Uint8Array.from(t);let a=n[0];for(let o=1;o<n.length;o++){let u=n[o],f=u<<12|a,c=(u<<4^a)%g,x=c===0?1:g-c,S=-1;for(;y[c]>=0;){if(y[c]===f){S=d[c];break}c-=x,c<0&&(c+=g)}if(S>=0){a=S;continue}l(a),b<4096?(y[c]=f,d[c]=b++,b-1===1<<p&&p<12&&p++):(l(h),y.fill(-1),p=e+1,b=r+1),a=u}return l(a),l(r),s&&t.push(i&255),Uint8Array.from(t)}var N=class{constructor(e,t){this.o=e;let i=Math.min(255,t.length/3);this.trans=i;let s=new Uint8Array(256*3);s.set(t.subarray(0,i*3)),this.mapper=new O(s.subarray(0,i*3),i);let h=[..."GIF89a"].map(p=>p.charCodeAt(0)),r=[e.w&255,e.w>>8,e.h&255,e.h>>8,247,0,0];this.parts.push(Uint8Array.from([...h,...r]),s),e.loop&&this.parts.push(Uint8Array.from([33,255,11,...[..."NETSCAPE2.0"].map(p=>p.charCodeAt(0)),3,1,0,0,0]))}o;parts=[];prev=null;mapper;trans;addFrame(e,t){let{w:i,h:s}=this.o,h=this.mapper.map(e,i,s,this.o.dither,this.trans),r=0,p=0,b=i-1,g=s-1,y=1,d=h;if(this.o.transparent)y=2,[r,p,b,g]=q(h,i,s,m=>h[m]!==this.trans);else if(this.prev){let m=this.prev;[r,p,b,g]=q(h,i,s,v=>h[v]!==m[v]),d=h.slice();for(let v=0;v<d.length;v++)d[v]===m[v]&&(d[v]=this.trans)}b<r&&(r=p=b=g=0,d=new Uint8Array(i*s).fill(this.trans));let l=b-r+1,a=g-p+1,o=new Uint8Array(l*a);for(let m=0;m<a;m++)o.set(d.subarray((p+m)*i+r,(p+m)*i+r+l),m*l);this.o.transparent||(this.prev=h);let u=Math.max(2,Math.round(t)),f=[33,249,4,y<<2|1,u&255,u>>8,this.trans,0],c=[44,r&255,r>>8,p&255,p>>8,l&255,l>>8,a&255,a>>8,0],x=we(o,8),S=new Uint8Array(x.length+Math.ceil(x.length/255)+2),w=0;S[w++]=8;for(let m=0;m<x.length;m+=255){let v=Math.min(255,x.length-m);S[w++]=v,S.set(x.subarray(m,m+v),w),w+=v}S[w++]=0,this.parts.push(Uint8Array.from([...f,...c]),S.subarray(0,w))}finish(){this.parts.push(Uint8Array.of(59));let e=this.parts.reduce((s,h)=>s+h.length,0),t=new Uint8Array(e),i=0;for(let s of this.parts)t.set(s,i),i+=s.length;return t}};function q(n,e,t,i){let s=e,h=t,r=-1,p=-1;for(let b=0;b<t;b++){let g=b*e;for(let y=0;y<e;y++)i(g+y)&&(y<s&&(s=y),y>r&&(r=y),b<h&&(h=b),p=b)}return[s,h,r,p]}var P=class{constructor(e){this.o=e}o;samples=[];writer=null;sample(e,t){let i=e.length/4,s=24e3,h=Math.max(1,Math.floor(i/s));for(let r=Math.random()*h|0;r<i;r+=h){let p=r*4,b=e[p+3];if(b<128)continue;let g=t&&b<255?255/b:1;this.samples.push(Math.min(255,e[p]*g),Math.min(255,e[p+1]*g),Math.min(255,e[p+2]*g))}}frame(e,t,i){if(!this.writer){let s=Uint8Array.from(this.samples.length?this.samples:[0,0,0]);this.samples=[],this.writer=new N(this.o,ve(s,255))}if(t)for(let s=0;s<e.length;s+=4){let h=e[s+3];if(h&&h<255){let r=255/h;e[s]=Math.min(255,e[s]*r),e[s+1]=Math.min(255,e[s+1]*r),e[s+2]=Math.min(255,e[s+2]*r)}}this.writer.addFrame(e,i)}end(){return this.writer||this.frame(new Uint8Array(this.o.w*this.o.h*4),!1,10),this.writer.finish()}};var L=null;self.onmessage=async n=>{let e=n.data,t=(i,s=[])=>self.postMessage({id:e.id,...i},s);try{if(e.op==="png"){let i=await H(e.premul?J(e.px):e.px,e.w,e.h);t({png:i},[i.buffer])}else if(e.op==="gif-begin")L=new P(e.opts),t({});else if(e.op==="gif-sample")L.sample(e.px,e.premul),t({});else if(e.op==="gif-frame")L.frame(e.px,e.premul,e.delay),t({});else if(e.op==="gif-end"){let i=L.end();L=null,t({png:i},[i.buffer])}}catch(i){t({error:String(i?.message||i)})}};})();
//# sourceMappingURL=worker.js.map
