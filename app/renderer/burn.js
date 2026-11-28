// GPU load for the burn-in test.
// 1. Full load on any card: a heavy ray-marched fractal drawn at 1920x1080, several times per frame. The number of
//    passes adjusts itself until the frame rate drops to about 30 FPS, so the GPU stays busy the whole time
//    (one pass per frame would stop at the screen refresh rate and leave fast cards half idle).
// 2. VRAM check: most of the card's memory is filled with 256 MB blocks of a known pattern, then read back and
//    compared on the GPU, over and over with a new pattern each round. Any difference = a bad VRAM chip or an
//    unstable memory overclock.
const c = document.getElementById('c');
c.width = 1920; c.height = 1080;
const hud = document.getElementById('hud');
const api = window.burnGpu || { config: async () => ({}), report: () => {} };
const st = { ok: false, fps: 0, passes: 1, vramTargetMB: 0, vramTestedMB: 0, rounds: 0, errors: 0, badMB: [], lost: false };
const gl = c.getContext('webgl2', { antialias: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
c.addEventListener('webglcontextlost', e => { e.preventDefault(); st.lost = true; api.report(st); hud.textContent = 'GPU driver reset (WebGL context lost)'; }, false);
if (!gl) { hud.textContent = 'WebGL2 not available'; api.report(st); }
else start();

function prog(vsrc, fsrc) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vsrc)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsrc)); gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

async function start() {
  const vs = `#version 300 es
  in vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
  // Ray-marched fractal: lots of ALU work per pixel.
  const fs = `#version 300 es
  precision highp float; uniform float t; uniform vec2 r; out vec4 o;
  float de(vec3 p){ vec3 z=p; float dr=1.0, rr=0.0;
    for(int i=0;i<12;i++){ rr=length(z); if(rr>2.0) break; float th=acos(z.z/rr)*8.0+t*0.3, ph=atan(z.y,z.x)*8.0;
      dr=pow(rr,7.0)*8.0*dr+1.0; z=pow(rr,8.0)*vec3(sin(th)*cos(ph),sin(ph)*sin(th),cos(th))+p; }
    return 0.5*log(rr)*rr/dr; }
  void main(){ vec2 uv=(gl_FragCoord.xy-0.5*r)/r.y; vec3 ro=vec3(0.0,0.0,-2.6+0.2*sin(t*0.2)), rd=normalize(vec3(uv,1.5));
    float d=0.0; int s=0; for(int i=0;i<160;i++){ float h=de(ro+rd*d); d+=h; s=i; if(h<0.0005||d>6.0) break; }
    float g=1.0-float(s)/160.0; o=vec4(g*vec3(0.3,0.6,1.0)+0.1*vec3(sin(t),0.2,cos(t)),1.0); }`;
  const HASH = `uint h(uint x){ x^=x>>16; x*=0x7feb352du; x^=x>>15; x*=0x846ca68bu; x^=x>>16; return x; }
  uvec4 pat(uvec2 q, uint seed){ uint b=h(q.x*4099u + q.y*0x9E3779B1u + seed); return uvec4(b, ~b, h(b), b^0xA5A5A5A5u); }`;
  const wfs = `#version 300 es
  precision highp float; precision highp int; uniform uint seed; out uvec4 o; ${HASH}
  void main(){ o = pat(uvec2(gl_FragCoord.xy), seed); }`;
  const vfs = `#version 300 es
  precision highp float; precision highp int; precision highp usampler2D; uniform usampler2D tx; uniform uint seed; out vec4 o; ${HASH}
  void main(){ ivec2 q=ivec2(gl_FragCoord.xy); if (texelFetch(tx,q,0)==pat(uvec2(q),seed)) discard; o=vec4(1.0); }`;

  let pBurn, pW, pV;
  try { pBurn = prog(vs, fs); pW = prog(vs, wfs); pV = prog(vs, vfs); } catch (e) { hud.textContent = 'Shader error: ' + e.message; api.report(st); return; }
  st.ok = true;
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const ut = gl.getUniformLocation(pBurn, 't'), ur = gl.getUniformLocation(pBurn, 'r');
  const uwSeed = gl.getUniformLocation(pW, 'seed'), uvSeed = gl.getUniformLocation(pV, 'seed'), uvTx = gl.getUniformLocation(pV, 'tx');

  // How much VRAM to test: about 70% of the card's memory (Windows, the desktop and the burn-in itself need the rest).
  let cfg = {};
  try { cfg = (await api.config()) || {}; } catch {}
  const CH = 4096, CHMB = 256;   // one block: 4096 x 4096 RGBA32UI = 256 MB
  st.vramTargetMB = cfg.vramMB > 0 ? Math.max(CHMB, Math.min(32768, Math.floor(cfg.vramMB * 0.7 / CHMB) * CHMB)) : 512;
  const blocks = [];
  const chk = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, chk); gl.renderbufferStorage(gl.RENDERBUFFER, gl.R8, CH, CH);
  const chkFb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, chkFb); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, chk);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  let allocDone = false;
  const addBlock = () => {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    while (gl.getError()) {}
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, CH, CH);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const okFb = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (gl.getError() || !okFb) { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); return false; }
    blocks.push({ tex, fb, seed: 0 });
    st.vramTestedMB = blocks.length * CHMB;
    return true;
  };
  // Write / verify one block per frame: round r writes every block, then reads every block back.
  let round = 0, idx = 0, phase = 'write';
  const pending = [];
  const vramStep = () => {
    if (!allocDone) { if (st.vramTestedMB >= st.vramTargetMB || !addBlock()) allocDone = true; }
    // Finished queries: any pixel that did not match = VRAM error.
    for (let i = pending.length - 1; i >= 0; i--) {
      const q = pending[i];
      if (!gl.getQueryParameter(q.q, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (gl.getQueryParameter(q.q, gl.QUERY_RESULT)) { st.errors++; if (st.badMB.length < 20) st.badMB.push(q.block * CHMB); }
      gl.deleteQuery(q.q); pending.splice(i, 1);
    }
    if (!blocks.length || pending.length > 8) return;
    if (idx >= blocks.length) { idx = 0; if (phase === 'write') phase = 'verify'; else { phase = 'write'; round++; st.rounds = round; } }
    const bl = blocks[idx];
    gl.viewport(0, 0, CH, CH);
    if (phase === 'write') {
      bl.seed = (round * 2654435761 + idx * 40503 + 17) >>> 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, bl.fb); gl.useProgram(pW); gl.uniform1ui(uwSeed, bl.seed);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, chkFb); gl.useProgram(pV); gl.uniform1ui(uvSeed, bl.seed);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, bl.tex); gl.uniform1i(uvTx, 0);
      const q = gl.createQuery(); gl.beginQuery(gl.ANY_SAMPLES_PASSED, q);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.endQuery(gl.ANY_SAMPLES_PASSED); pending.push({ q, block: idx });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    idx++;
  };

  let frames = 0, last = performance.now(), lastReport = 0;
  const loop = (now) => {
    if (st.lost) return;
    vramStep();
    gl.viewport(0, 0, c.width, c.height); gl.useProgram(pBurn); gl.uniform2f(ur, c.width, c.height);
    for (let i = 0; i < st.passes; i++) { gl.uniform1f(ut, now / 1000 + i * 0.37); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
    frames++;
    if (now - last > 1000) {
      st.fps = Math.round(frames * 1000 / (now - last)); frames = 0; last = now;
      // Keep the GPU busy: more passes while it still keeps up, fewer if the window gets sluggish.
      if (st.fps >= 40) st.passes = Math.min(64, Math.ceil(st.passes * 1.3));
      else if (st.fps < 22 && st.passes > 1) st.passes = Math.max(1, Math.floor(st.passes * 0.8));
      hud.textContent = `smartCheck GPU burn-in · ${st.fps} FPS · x${st.passes} · VRAM ${st.vramTestedMB} MB · round ${st.rounds} · errors ${st.errors}`;
    }
    if (now - lastReport > 2000) { lastReport = now; api.report(st); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
