// GLSL sources (WebGL2 / GLSL ES 3.00). All layer data is premultiplied RGBA.

export const QUAD_VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos; gl_Position = vec4(aPos*2.0-1.0, 0.0, 1.0); }`;

const STROKE_CHUNK = `
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
}`;

const BLEND_CHUNK = `
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
}`;

export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uPrev, uLayer, uClip;
uniform int uMode; uniform float uOpacity;
uniform int uClipMode; // 0 none, 1 clip, 2 clip with live-stroked base
uniform int uActive;
uniform vec4 uTint; // rgb + amount (onion skins)
uniform vec4 uLayerMap, uClipMap; // doc uv -> layer/clip texture uv (identity, or a tile's place in an atlas page)
${STROKE_CHUNK}
${BLEND_CHUNK}
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
}`;

export const BAKE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uLayer;
${STROKE_CHUNK}
void main(){ o = applyStroke(texture(uLayer, vUv), vUv); }`;

// Merge "upper" onto "lower" with the upper layer's blend mode and opacity.
export const MERGE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uPrev, uLayer;
uniform int uMode; uniform float uOpacity;
${BLEND_CHUNK}
void main(){ o = blendOver(texture(uPrev, vUv), texture(uLayer, vUv) * uOpacity, uMode); }`;

export const DAB_VS = `#version 300 es
in vec2 aCorner;
in vec4 aDab;   // x, y, radius, alpha
in vec2 aDab2;  // angle, aspect
uniform vec2 uDocSize;
out vec2 vUv; out vec2 vDoc; out float vA;
void main(){
  vec2 p = vec2(aCorner.x, aCorner.y * aDab2.y) * aDab.z;
  float ca = cos(aDab2.x), sa = sin(aDab2.x);
  p = vec2(p.x*ca - p.y*sa, p.x*sa + p.y*ca);
  vec2 d = aDab.xy + p;
  vDoc = d; vUv = aCorner * 0.5 + 0.5; vA = aDab.w;
  gl_Position = vec4(d / uDocSize * 2.0 - 1.0, 0.0, 1.0);
}`;

export const DAB_FS = `#version 300 es
precision highp float;
in vec2 vUv; in vec2 vDoc; in float vA; out vec4 o;
uniform sampler2D uShape, uGrain;
uniform float uGrainScale, uGrainDepth;
void main(){
  float a = texture(uShape, vUv).a * vA;
  if (uGrainDepth > 0.0) {
    float g = texture(uGrain, vDoc / (256.0 * uGrainScale)).r;
    g = smoothstep(0.12, 0.88, g);
    a *= mix(1.0, g, uGrainDepth);
  }
  o = vec4(a);
}`;

export const SMUDGE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uLayer, uPick, uShape;
uniform vec2 uDocSize, uDabPos; uniform float uDabR, uK;
uniform sampler2D uSel; uniform int uUseSel;
void main(){
  vec4 L = texture(uLayer, vUv);
  vec2 l = (vUv * uDocSize - uDabPos) / uDabR;
  if (abs(l.x) > 1.0 || abs(l.y) > 1.0) { o = L; return; }
  float m = texture(uShape, l * 0.5 + 0.5).a * uK;
  if (uUseSel == 1) m *= texture(uSel, vUv).r;
  o = mix(L, texture(uPick, l * 0.5 + 0.5), m);
}`;

export const PICKUP_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uPick, uLayer;
uniform vec2 uDocSize, uDabPos; uniform float uDabR, uRate;
void main(){
  vec2 doc = uDabPos + (vUv * 2.0 - 1.0) * uDabR;
  vec4 L = texture(uLayer, doc / uDocSize);
  o = mix(texture(uPick, vUv), L, uRate);
}`;

export const SCREEN_VS = `#version 300 es
in vec2 aPos;
uniform mat3 uM;     // doc px -> clip
uniform vec2 uDocSize;
out vec2 vUv;
void main(){
  vec2 d = aPos * uDocSize;
  vec3 c = uM * vec3(d, 1.0);
  vUv = aPos;
  gl_Position = vec4(c.xy, 0.0, 1.0);
}`;

export const SCREEN_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uComp, uSel;
uniform int uUseSel; uniform float uTime, uDpr;
void main(){
  vec4 c = texture(uComp, vUv);
  vec2 q = floor(gl_FragCoord.xy / (12.0 * uDpr));
  float ch = mod(q.x + q.y, 2.0) < 1.0 ? 0.86 : 0.74;
  vec3 col = c.rgb + vec3(ch) * (1.0 - c.a);
  if (uUseSel == 1) {
    float m = texture(uSel, vUv).r;
    // outside the selection: faint moving diagonal stripes
    float st = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / (14.0 * uDpr) - uTime * 0.25));
    col = mix(col, col * (0.86 + 0.06 * st), 1.0 - m);
    // marching ants on the 50 % contour, about 1.3 screen px wide
    float g = length(vec2(dFdx(m), dFdy(m)));
    if (g > 1e-4 && abs(m - 0.5) < g * 0.9 * uDpr) {
      float d = step(0.5, fract((gl_FragCoord.x - gl_FragCoord.y) / (10.0 * uDpr) + uTime * 0.6));
      col = vec3(d);
    }
  }
  o = vec4(col, 1.0);
}`;

// 4x4 supersampled downscale copy (thumbnails / export of a single layer)
export const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uStep; uniform vec4 uOver; // uOver.a = 1: flatten onto uOver.rgb
uniform int uTaps; // 4: 4×4 grid (any scale with mips); 2: 2×2 bilinear taps (an exact box filter at 1/2 scale)
void main(){
  vec4 acc = vec4(0.0);
  if (uTaps == 2) {
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++)
      acc += texture(uSrc, vUv + (vec2(float(x), float(y)) - 0.5) * uStep * 0.5);
    o = acc / 4.0;
  } else {
    for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++)
      acc += texture(uSrc, vUv + (vec2(float(x), float(y)) - 1.5) * uStep * 0.25);
    o = acc / 16.0;
  }
  if (uOver.a > 0.5) o = vec4(o.rgb + uOver.rgb * (1.0 - o.a), 1.0);
}`;

// Upload a straight-alpha image into premultiplied layer space.
export const PREMUL_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec4 uRect; // dest rect in uv
void main(){
  vec2 t = (vUv - uRect.xy) / uRect.zw;
  if (any(lessThan(t, vec2(0.0))) || any(greaterThan(t, vec2(1.0)))) { o = vec4(0.0); return; }
  vec4 c = texture(uSrc, t);
  o = vec4(c.rgb * c.a, c.a);
}`;

export const FILL_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uLayer; uniform vec3 uColor; uniform bool uLock;
void main(){ float a = uLock ? texture(uLayer, vUv).a : 1.0; o = vec4(uColor * a, a); }`;

// Draw a (premultiplied) source texture through an affine transform into a layer.
// The quad is grown by ~1 dest px and edges are faded by their distance in dest px, so rotated edges are anti-aliased.
export const XFORM_VS = `#version 300 es
in vec2 aPos;
uniform mat3 uM;      // source px -> doc px
uniform vec2 uSrcSize, uDocSize, uGrow;
out vec2 vUv;
void main(){
  vec2 uv = mix(-uGrow, 1.0 + uGrow, aPos);
  vec3 d = uM * vec3(uv * uSrcSize, 1.0);
  vUv = uv;
  gl_Position = vec4(d.xy / uDocSize * 2.0 - 1.0, 0.0, 1.0);
}`;

// Mesh variant (distort / warp): vertices carry doc position and source uv; the domain is grown past [0,1]
// so XFORM_FS can fade the edges in destination pixels exactly like the affine path.
export const MESH_VS = `#version 300 es
in vec2 aPos; in vec2 aUv;
uniform vec2 uDocSize;
out vec2 vUv;
void main(){ vUv = aUv; gl_Position = vec4(aPos / uDocSize * 2.0 - 1.0, 0.0, 1.0); }`;

export const XFORM_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform int uFilter;  // 0 nearest, 1 trilinear (downscale), 2 bicubic Catmull-Rom (upscale)
vec4 cubic(vec2 uv){
  vec2 p = uv * uSrcSize - 0.5, f = fract(p), i = floor(p);
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int y = -1; y <= 2; y++) for (int x = -1; x <= 2; x++) {
    vec2 t = vec2(float(x), float(y)) - f;
    vec2 a = abs(t);
    vec2 w = mix((1.5*a - 2.5)*a*a + 1.0, ((-0.5*a + 2.5)*a - 4.0)*a + 2.0, step(1.0, a));
    float ww = w.x * w.y;
    acc += texture(uSrc, (i + vec2(float(x), float(y)) + 0.5) / uSrcSize) * ww; wsum += ww;
  }
  vec4 c = acc / wsum;
  c.a = clamp(c.a, 0.0, 1.0);
  return vec4(clamp(c.rgb, vec3(0.0), vec3(c.a)), c.a); // keep premultiplied and ringing-free
}
void main(){
  vec2 px = vUv * uSrcSize;
  vec2 fw = max(fwidth(px), vec2(1e-4));
  vec2 dEdge = min(px, uSrcSize - px) / fw;           // distance to the source edge in dest px
  float aa = clamp(min(dEdge.x, dEdge.y) + 0.5, 0.0, 1.0);
  vec2 uv = clamp(vUv, 0.5 / uSrcSize, 1.0 - 0.5 / uSrcSize);
  vec4 c = uFilter == 2 ? cubic(uv) : texture(uSrc, uv);
  o = c * aa;
}`;

// Selection mask combine: uMode 0 replace, 1 add, 2 subtract, 3 invert, 4 intersect. Shape coverage in uNew.a.
export const MASKOP_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uOld, uNew; uniform int uMode, uHasOld, uNewRed;
void main(){
  float a = uHasOld == 1 ? texture(uOld, vUv).r : 0.0;
  float n = uNewRed == 1 ? texture(uNew, vUv).r : texture(uNew, vUv).a;
  float r = uMode == 0 ? n : uMode == 1 ? max(a, n) : uMode == 2 ? a * (1.0 - n) : uMode == 3 ? 1.0 - a : a * n;
  o = vec4(r, r, r, 1.0);
}`;

// Separable gaussian blur of the mask's red channel (feather). uDir = texel step along one axis.
export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uDir; uniform float uSigma; uniform int uTaps;
void main(){
  float acc = texture(uSrc, vUv).r, wsum = 1.0;
  for (int i = 1; i <= 64; i++) {
    if (i > uTaps) break;
    float x = float(i);
    float w = exp(-0.5 * x * x / (uSigma * uSigma));
    acc += (texture(uSrc, vUv + uDir * x).r + texture(uSrc, vUv - uDir * x).r) * w;
    wsum += 2.0 * w;
  }
  float r = acc / wsum;
  o = vec4(r, r, r, 1.0);
}`;

// Layer edits restricted by the selection: uMode 0 fill colour (optionally alpha-locked), 1 clear,
// 2 keep only selected (layer * m), 3 keep only unselected (layer * (1 - m)).
export const SELOP_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uLayer, uSel; uniform int uMode, uLock, uUseSel; uniform vec3 uColor;
void main(){
  vec4 L = texture(uLayer, vUv);
  float m = uUseSel == 1 ? texture(uSel, vUv).r : 1.0;
  if (uMode == 0) { float a = uLock == 1 ? L.a : 1.0; o = mix(L, vec4(uColor * a, a), m); }
  else if (uMode == 1) o = L * (1.0 - m);
  else if (uMode == 2) o = L * m;
  else o = L * (1.0 - m);
}`;


// Jump flooding (selection grow/shrink): every pixel finds its nearest seed pixel in log2(size) passes.
// Seed coordinates are packed into RGBA8 (16 bits per axis); all-ones means "no seed yet".
const JFA_PACK = `
vec4 pack(ivec2 p){ return vec4(float(p.x / 256), float(p.x % 256), float(p.y / 256), float(p.y % 256)) / 255.0; }
ivec2 unpack(vec4 c){ ivec4 b = ivec4(c * 255.0 + 0.5); return ivec2(b.r * 256 + b.g, b.b * 256 + b.a); }
const ivec2 NONE = ivec2(65535);`;
export const JFA_INIT_FS = `#version 300 es
precision highp float; precision highp int;
in vec2 vUv; out vec4 o;
uniform sampler2D uSel; uniform int uInside;
${JFA_PACK}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float m = texelFetch(uSel, p, 0).r;
  bool seed = uInside == 1 ? m >= 0.5 : m < 0.5;
  o = seed ? pack(p) : pack(NONE);
}`;
export const JFA_STEP_FS = `#version 300 es
precision highp float; precision highp int;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform int uStep; uniform ivec2 uSize;
${JFA_PACK}
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
}`;
// Grow (uR > 0) or shrink (uR < 0) the mask by |uR| px with a 1 px anti-aliased edge; soft interiors are kept.
export const GROW_FS = `#version 300 es
precision highp float; precision highp int;
in vec2 vUv; out vec4 o;
uniform sampler2D uSel, uIn, uOut; uniform float uR;
${JFA_PACK}
float dist(sampler2D t, ivec2 p){ ivec2 s = unpack(texelFetch(t, p, 0)); return s.x == 65535 ? 1e9 : length(vec2(s - p)); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float m = texelFetch(uSel, p, 0).r, r = m;
  if (uR > 0.0) r = max(m, clamp(uR + 1.0 - dist(uIn, p), 0.0, 1.0));
  else if (uR < 0.0) r = min(m, clamp(dist(uOut, p) + uR, 0.0, 1.0));
  o = vec4(r, r, r, 1.0);
}`;

// ---------------------------------------------------------------- wet media (watercolour drying)
// Field texel: r = pigment suspended in water, g = water, b = pigment deposited on the paper, a = initial wetness.
export const WET_INIT_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uStroke; uniform float uWet;
void main(){ float c = texture(uStroke, vUv).r; float w = uWet * smoothstep(0.08, 0.7, c); o = vec4(c, w, 0.0, w); }`;
// One drying step. Water spreads to neighbours (slowly into dry paper, guided by the paper grain) and evaporates,
// fastest at the wet edge. Suspended pigment rides the water downhill: as the rim dries first, water flows
// outward and carries pigment to it (the dark "coffee ring" edge). Pigment deposits as the water leaves,
// more in the grain's valleys (granulation).
export const WET_STEP_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uF, uGrain; uniform vec2 uTexel; uniform float uOff, uEvap, uFlow, uGran, uGrainScale, uLast; uniform vec2 uDocSize;
void main(){
  vec4 f = texture(uF, vUv);
  vec2 d = uTexel * uOff;
  vec4 n0 = texture(uF, vUv + vec2(d.x, 0.0)), n1 = texture(uF, vUv - vec2(d.x, 0.0)), n2 = texture(uF, vUv + vec2(0.0, d.y)), n3 = texture(uF, vUv - vec2(0.0, d.y));
  float g = texture(uGrain, vUv * uDocSize / (256.0 * uGrainScale)).r;   // paper height 0..1
  float p = f.r, w = f.g, dep = f.b;
  // water: diffusion inside the wet area; dry paper only wicks a little along the fibres (soft, feathery bleed)
  float wn = (n0.g + n1.g + n2.g + n3.g) * 0.25;
  float spread = w > 0.03 ? 0.45 : 0.06 * g * g;
  float edge = step(0.03, w) * (1.0 - smoothstep(0.0, 0.2, min(min(n0.g, n1.g), min(n2.g, n3.g))));
  float w2 = max(0.0, w + spread * (wn - w) - uEvap * (1.0 + 3.0 * edge));
  // pigment flux along the water gradient between wet cells only (from wetter to drier), conserving pigment:
  // the rim evaporates first, water flows outward to replace it and carries pigment to the edge
  float wet0 = step(0.03, n0.g), wet1 = step(0.03, n1.g), wet2 = step(0.03, n2.g), wet3 = step(0.03, n3.g), wetc = step(0.03, w);
  float inflow = wetc * (n0.r * max(0.0, n0.g - w) + n1.r * max(0.0, n1.g - w) + n2.r * max(0.0, n2.g - w) + n3.r * max(0.0, n3.g - w));
  float outflow = p * (wet0 * max(0.0, w - n0.g) + wet1 * max(0.0, w - n1.g) + wet2 * max(0.0, w - n2.g) + wet3 * max(0.0, w - n3.g));
  float p2 = max(0.0, p + uFlow * (inflow - outflow));
  // gentle diffusion of suspended pigment inside the wet area
  float pn = (n0.r + n1.r + n2.r + n3.r) * 0.25;
  p2 += 0.45 * min(w, wn) * (pn - p);
  // deposition as the water leaves; granulation settles more pigment in the valleys of the paper
  float dry = clamp((w - w2) / max(w, 1e-3), 0.0, 1.0);
  float settle = p2 * clamp(dry * mix(1.0, 1.7 * (1.0 - g) + 0.15, uGran) + 0.01, 0.0, 1.0);
  if (uLast > 0.5 || w2 <= 0.001) settle = p2;
  o = vec4(p2 - settle, w2, dep + settle, f.a);
}`;
export const WET_OUT_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uF;
void main(){ vec4 f = texture(uF, vUv); o = vec4(clamp(f.r + f.b, 0.0, 1.0), 0.0, 0.0, 1.0); }`;
