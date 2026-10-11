// Small WebGL2 helpers.
export type GL = WebGL2RenderingContext;

export function compile(gl: GL, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      throw new Error('Shader compile failed: ' + log + '\n' + src.split('\n').map((l, i) => i + 1 + ': ' + l).join('\n'));
    }
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link failed: ' + gl.getProgramInfoLog(p));
  return p;
}

export class Program {
  prog: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(private gl: GL, vs: string, fs: string) {
    this.prog = compile(gl, vs, fs);
  }
  use() { this.gl.useProgram(this.prog); return this; }
  u(name: string) {
    let l = this.locs.get(name);
    if (l === undefined) { l = this.gl.getUniformLocation(this.prog, name); this.locs.set(name, l); }
    return l;
  }
  f(name: string, ...v: number[]) {
    const gl = this.gl, l = this.u(name);
    if (v.length === 1) gl.uniform1f(l, v[0]);
    else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
    else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
    else gl.uniform4f(l, v[0], v[1], v[2], v[3]);
    return this;
  }
  i(name: string, v: number) { this.gl.uniform1i(this.u(name), v); return this; }
  m3(name: string, m: Float32Array | number[]) { this.gl.uniformMatrix3fv(this.u(name), false, m); return this; }
  tex(name: string, unit: number, t: WebGLTexture | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(this.u(name), unit);
    return this;
  }
}

export interface Target { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number; }

export function makeTexture(gl: GL, w: number, h: number, opts: { internal?: number; format?: number; type?: number; filter?: number; wrap?: number; data?: ArrayBufferView | null } = {}): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  const filter = opts.filter ?? gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.LINEAR_MIPMAP_LINEAR ? gl.LINEAR : filter);
  const wrap = opts.wrap ?? gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texImage2D(gl.TEXTURE_2D, 0, opts.internal ?? gl.RGBA8, w, h, 0, opts.format ?? gl.RGBA, opts.type ?? gl.UNSIGNED_BYTE, opts.data ?? null);
  return t;
}

export function makeTarget(gl: GL, w: number, h: number, opts: Parameters<typeof makeTexture>[3] = {}): Target {
  const tex = makeTexture(gl, w, h, opts);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete ' + st);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { tex, fb, w, h };
}

export function freeTarget(gl: GL, t: Target) {
  gl.deleteFramebuffer(t.fb);
  gl.deleteTexture(t.tex);
}

export function bindTarget(gl: GL, t: Target | null, w?: number, h?: number) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
  gl.viewport(0, 0, t ? t.w : w!, t ? t.h : h!);
}

export function textureFromCanvas(gl: GL, c: TexImageSource, repeat = false, mip = true): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
  if (mip) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const w = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w);
  return t;
}

/** Asynchronous pixel readback through a PIXEL_PACK_BUFFER + fence: never stalls the GPU pipeline. */
export class Readback {
  private buf: WebGLBuffer | null;
  private sync: WebGLSync | null;
  data: Uint8Array | null = null;
  readonly bytes: number;
  constructor(private gl: GL, fb: WebGLFramebuffer, x: number, y: number, w: number, h: number) {
    this.bytes = w * h * 4;
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.bytes, gl.STREAM_READ);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }
  /** true once the data has arrived (copies it out of the buffer on the first true) */
  poll(): boolean {
    if (this.data) return true;
    if (!this.sync) return false;
    const gl = this.gl;
    const st = gl.clientWaitSync(this.sync, 0, 0);
    if (st === gl.TIMEOUT_EXPIRED || st === gl.WAIT_FAILED) return false;
    const out = new Uint8Array(this.bytes);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.data = out;
    this.dispose();
    return true;
  }
  /** resolves when the data has arrived (polled on animation frames / timers) */
  wait(): Promise<Uint8Array> {
    return new Promise((res) => {
      const tick = () => { if (this.poll()) res(this.data!); else setTimeout(tick, 8); };
      tick();
    });
  }
  dispose() {
    const gl = this.gl;
    if (this.sync) { gl.deleteSync(this.sync); this.sync = null; }
    if (this.buf) { gl.deleteBuffer(this.buf); this.buf = null; }
  }
}
