// 見るときにきれいにする（プレイヤー shorts-view.js が使う）。動画のファイルはそのままで、映すときだけ GPU で整える。
// - 拡大: 小さい動画を画面いっぱいに広げるとき、ぼやけにくい拡大（Catmull-Rom の 3 次補間）
// - くっきり: 輪郭を少し立てる（まわりの明るさの幅を超えないようにして、白いふちどり・ギラつきを出さない）
// 動画の上に同じ大きさの canvas を重ねて描く。描けないとき（WebGL2 が無い・別のサイトの動画で中身を読めない）は何もしない
//
// svxCreate() → { supported, attach(video, host), detach(), dispose() }
//   attach … host（動画の入れ物。position: relative）の中の video を、きれいにして映し始める
//   detach … やめる（canvas を外して、元の動画が見える）
//   dispose … もう使わない（プレイヤーを閉じたとき）。WebGL を手放す（開くたびに作るので、残すと数が増え続ける）

const SVX_VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const SVX_FS = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 srcSize;
uniform float strength;
in vec2 uv;
out vec4 outColor;

// Catmull-Rom の 3 次補間を、なめらかな拡大 9 回分で（16 回読むのと同じ結果）
vec3 bicubic(vec2 at) {
  vec2 sp = at * srcSize;
  vec2 tp = floor(sp - 0.5) + 0.5;
  vec2 f = sp - tp;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (tp - 1.0) / srcSize;
  vec2 t3 = (tp + 2.0) / srcSize;
  vec2 t12 = (tp + w2 / w12) / srcSize;
  vec3 r = vec3(0.0);
  r += texture(tex, vec2(t0.x, t0.y)).rgb * w0.x * w0.y;
  r += texture(tex, vec2(t12.x, t0.y)).rgb * w12.x * w0.y;
  r += texture(tex, vec2(t3.x, t0.y)).rgb * w3.x * w0.y;
  r += texture(tex, vec2(t0.x, t12.y)).rgb * w0.x * w12.y;
  r += texture(tex, vec2(t12.x, t12.y)).rgb * w12.x * w12.y;
  r += texture(tex, vec2(t3.x, t12.y)).rgb * w3.x * w12.y;
  r += texture(tex, vec2(t0.x, t3.y)).rgb * w0.x * w3.y;
  r += texture(tex, vec2(t12.x, t3.y)).rgb * w12.x * w3.y;
  r += texture(tex, vec2(t3.x, t3.y)).rgb * w3.x * w3.y;
  return r;
}

void main() {
  vec2 px = 1.0 / srcSize;
  vec3 c = bicubic(uv);
  vec3 n = texture(tex, uv + vec2(0.0, -px.y)).rgb;
  vec3 s = texture(tex, uv + vec2(0.0, px.y)).rgb;
  vec3 e = texture(tex, uv + vec2(px.x, 0.0)).rgb;
  vec3 w = texture(tex, uv + vec2(-px.x, 0.0)).rgb;
  vec3 mn = min(min(min(n, s), min(e, w)), c);
  vec3 mx = max(max(max(n, s), max(e, w)), c);
  // もともと強い輪郭ほど弱く、ぼやけた所ほど強く立てる（CAS と同じ考え方）
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
  vec3 blur = (n + s + e + w) * 0.25;
  vec3 r = c + (c - blur) * strength * amp * 2.0;
  outColor = vec4(clamp(r, mn, mx), 1.0);
}`;

// 描く大きさの上限（スマホで重くなりすぎないよう、長い辺をここまでに）
const SVX_MAX_SIDE = 2560;

function svxCreate() {
  const canvas = document.createElement("canvas");
  canvas.className = "sv-enhance";
  let gl = null;
  try {
    gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
  } catch {}
  if (!gl) return { supported: false, attach() {}, detach() {}, dispose() {} };

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader");
    return sh;
  };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, SVX_VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, SVX_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
  } catch {
    try {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {}
    return { supported: false, attach() {}, detach() {}, dispose() {} };
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const uSrc = gl.getUniformLocation(prog, "srcSize");
  const uStrength = gl.getUniformLocation(prog, "strength");

  let video = null;
  let host = null;
  let frameReq = 0;
  let failed = false;
  let onFail = null;
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => place() && draw()) : null;

  // 動画が実際に映っている四角（object-fit: contain の内側）に canvas を合わせる
  function place() {
    if (!video || !video.videoWidth) return false;
    const W = video.offsetWidth;
    const H = video.offsetHeight;
    if (!W || !H) return false;
    const k = Math.min(W / video.videoWidth, H / video.videoHeight);
    const dw = video.videoWidth * k;
    const dh = video.videoHeight * k;
    Object.assign(canvas.style, { left: `${video.offsetLeft + (W - dw) / 2}px`, top: `${video.offsetTop + (H - dh) / 2}px`, width: `${dw}px`, height: `${dh}px` });
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let cw = Math.round(dw * dpr);
    let ch = Math.round(dh * dpr);
    const over = Math.max(cw, ch) / SVX_MAX_SIDE;
    if (over > 1) {
      cw = Math.round(cw / over);
      ch = Math.round(ch / over);
    }
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    return true;
  }

  function draw() {
    if (!video || failed || video.readyState < 2 || !video.videoWidth) return;
    if (!place()) return;
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch {
      // 別のサイトの動画など、中身を読めないもの: やめて元の動画を見せる
      failed = true;
      canvas.hidden = true;
      if (onFail) onFail();
      return;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uSrc, video.videoWidth, video.videoHeight);
    // 小さい動画を大きく広げるときほど、少し強めに
    const up = canvas.width / video.videoWidth;
    gl.uniform1f(uStrength, up > 1.15 ? 0.55 : 0.35);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    canvas.hidden = false;
  }

  function loop() {
    if (!video) return;
    draw();
    frameReq = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (!frameReq) return;
    if (video && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameReq);
    else cancelAnimationFrame(frameReq);
    frameReq = 0;
  }

  const onEmpty = () => (canvas.hidden = true); // 動画を外したら、前の絵を残さない
  const onRedraw = () => draw(); // 止まっているときに位置を変えた・読み込めたとき

  function detach() {
    stopLoop();
    if (video) {
      video.removeEventListener("emptied", onEmpty);
      video.removeEventListener("seeked", onRedraw);
      video.removeEventListener("loadeddata", onRedraw);
      if (ro) ro.unobserve(video);
    }
    video = null;
    host = null;
    canvas.hidden = true;
    canvas.remove();
  }

  function attach(v, h, fail) {
    if (video === v && canvas.isConnected) return;
    detach();
    video = v;
    host = h;
    failed = false;
    onFail = fail || null;
    canvas.hidden = true;
    video.after(canvas);
    video.addEventListener("emptied", onEmpty);
    video.addEventListener("seeked", onRedraw);
    video.addEventListener("loadeddata", onRedraw);
    if (ro) ro.observe(video);
    loop();
  }

  function dispose() {
    detach();
    if (ro) ro.disconnect();
    try {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {}
  }

  return { supported: true, attach, detach, dispose };
}
