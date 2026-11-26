// GPU load for the burn-in test: a heavy fragment shader drawn at 1920x1080 every frame, whatever the window size.
const c = document.getElementById('c');
c.width = 1920; c.height = 1080;
const gl = c.getContext('webgl2', { antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
const hud = document.getElementById('hud');
if (!gl) { hud.textContent = 'WebGL2 not available'; }
else {
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
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr); gl.useProgram(pr);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const ut = gl.getUniformLocation(pr, 't'), ur = gl.getUniformLocation(pr, 'r');
  gl.viewport(0, 0, c.width, c.height); gl.uniform2f(ur, c.width, c.height);
  let frames = 0, last = performance.now();
  const loop = (now) => {
    gl.uniform1f(ut, now / 1000); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); frames++;
    if (now - last > 1000) { hud.textContent = `smartCheck GPU burn-in · ${Math.round(frames * 1000 / (now - last))} FPS`; frames = 0; last = now; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
