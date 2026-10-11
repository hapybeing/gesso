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
  return clamp(s, 0.0, 1.0) * uStrokeOpacity;
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
${STROKE_CHUNK}
${BLEND_CHUNK}
void main(){
  vec4 b = texture(uPrev, vUv);
  vec4 s = texture(uLayer, vUv);
  if (uActive == 1) s = applyStroke(s, vUv);
  s *= uOpacity;
  if (uClipMode > 0) {
    vec4 c = texture(uClip, vUv);
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
void main(){
  vec4 L = texture(uLayer, vUv);
  vec2 l = (vUv * uDocSize - uDabPos) / uDabR;
  if (abs(l.x) > 1.0 || abs(l.y) > 1.0) { o = L; return; }
  float m = texture(uShape, l * 0.5 + 0.5).a * uK;
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
uniform sampler2D uComp;
void main(){
  vec4 c = texture(uComp, vUv);
  vec2 q = floor(gl_FragCoord.xy / 12.0);
  float ch = mod(q.x + q.y, 2.0) < 1.0 ? 0.86 : 0.74;
  o = vec4(c.rgb + vec3(ch) * (1.0 - c.a), 1.0);
}`;

// 4x4 supersampled downscale copy (thumbnails / export of a single layer)
export const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uStep;
void main(){
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++)
    acc += texture(uSrc, vUv + (vec2(float(x), float(y)) - 1.5) * uStep * 0.25);
  o = acc / 16.0;
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
