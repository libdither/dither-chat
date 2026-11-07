/**
 * Draws the people graph: links as lines and nodes as points in WebGL, so ~11k nodes stay smooth, with a 2D canvas
 * when WebGL is not there. Labels go on a 2D canvas above (drawLabels).
 */

export interface Scene {
  n: number;
  /** World positions: x0, y0, x1, y1… */
  pos: Float32Array;
  /** World radius of each node. */
  size: Float32Array;
  /** RGBA, 0–255, four per node. */
  color: Uint8Array;
  /** 0 a circle (a person), 1 a rounded square (a server), 2 a diamond (a group). */
  shape: Uint8Array;
  /** Pairs of node indexes. */
  edges: Uint32Array;
  /** 1 for a link to what is hovered or picked. */
  edgeHi: Uint8Array;
}

/** Screen = world × k + (x, y), in CSS pixels. */
export interface View {
  x: number;
  y: number;
  k: number;
}

export type RGBA = [number, number, number, number];
export interface Palette {
  edge: RGBA;
  edgeHi: RGBA;
  /** Around each node, to set it off: the background. */
  ring: RGBA;
}

export interface Renderer {
  kind: 'webgl' | '2d';
  resize(w: number, h: number, dpr: number): void;
  draw(s: Scene, v: View, p: Palette): void;
  destroy(): void;
}

/** The smallest a node is drawn, in CSS pixels, however far out. */
export const MIN_PX = { person: 4, place: 7 };

/** Any CSS colour as RGBA 0–255. */
export function cssColor(c: string, alpha = 1): RGBA {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const x = cv.getContext('2d', { willReadFrequently: true });
  if (!x) return [128, 128, 128, 255 * alpha];
  x.fillStyle = '#808080';
  x.fillStyle = c;
  x.fillRect(0, 0, 1, 1);
  const d = x.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], Math.round(d[3] * alpha)];
}

const EDGE_VS = `
attribute vec2 a_pos;
uniform vec2 u_res;
uniform vec3 u_view;
void main() {
  vec2 s = a_pos * u_view.z + u_view.xy;
  gl_Position = vec4(s.x / u_res.x * 2.0 - 1.0, 1.0 - s.y / u_res.y * 2.0, 0.0, 1.0);
}`;
const EDGE_FS = `
precision mediump float;
uniform vec4 u_col;
void main() { gl_FragColor = u_col; }`;
const NODE_VS = `
attribute vec4 a_p;
attribute vec4 a_c;
uniform vec2 u_res;
uniform vec3 u_view;
uniform float u_dpr;
uniform vec2 u_min;
varying vec4 v_c;
varying float v_shape;
varying float v_px;
void main() {
  vec2 s = a_p.xy * u_view.z + u_view.xy;
  gl_Position = vec4(s.x / u_res.x * 2.0 - 1.0, 1.0 - s.y / u_res.y * 2.0, 0.0, 1.0);
  float px = min(max(a_p.z * 2.0 * u_view.z, a_p.w > 0.5 ? u_min.y : u_min.x), 96.0) * u_dpr;
  gl_PointSize = px;
  v_px = px;
  v_c = a_c;
  v_shape = a_p.w;
}`;
const NODE_FS = `
precision mediump float;
uniform vec4 u_ring;
varying vec4 v_c;
varying float v_shape;
varying float v_px;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d;
  if (v_shape > 1.5) d = abs(p.x) + abs(p.y);
  else if (v_shape > 0.5) d = length(max(abs(p) - 0.6, 0.0)) + 0.6;
  else d = length(p);
  float aa = 2.0 / max(v_px, 1.0);
  float a = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  if (a <= 0.0) discard;
  float rim = v_px > 7.0 ? smoothstep(1.0 - 3.0 * aa, 1.0 - 2.0 * aa, d) : 0.0;
  gl_FragColor = vec4(mix(v_c.rgb, u_ring.rgb, rim), a * v_c.a);
}`;

function compile(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
  return prog;
}

const norm = (c: RGBA): [number, number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255];

function webgl(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
  if (!gl) return null;
  let edgeProg: WebGLProgram;
  let nodeProg: WebGLProgram;
  try {
    edgeProg = compile(gl, EDGE_VS, EDGE_FS);
    nodeProg = compile(gl, NODE_VS, NODE_FS);
  } catch {
    return null;
  }
  const eBuf = gl.createBuffer();
  const pBuf = gl.createBuffer();
  const cBuf = gl.createBuffer();
  let lines = new Float32Array(0);
  let pts = new Float32Array(0);
  let w = 1;
  let h = 1;
  let dpr = 1;
  const loc = {
    eRes: gl.getUniformLocation(edgeProg, 'u_res'),
    eView: gl.getUniformLocation(edgeProg, 'u_view'),
    eCol: gl.getUniformLocation(edgeProg, 'u_col'),
    ePos: gl.getAttribLocation(edgeProg, 'a_pos'),
    nRes: gl.getUniformLocation(nodeProg, 'u_res'),
    nView: gl.getUniformLocation(nodeProg, 'u_view'),
    nDpr: gl.getUniformLocation(nodeProg, 'u_dpr'),
    nMin: gl.getUniformLocation(nodeProg, 'u_min'),
    nRing: gl.getUniformLocation(nodeProg, 'u_ring'),
    nP: gl.getAttribLocation(nodeProg, 'a_p'),
    nC: gl.getAttribLocation(nodeProg, 'a_c'),
  };
  return {
    kind: 'webgl',
    resize(cw, ch, d) {
      w = cw;
      h = ch;
      dpr = d;
      canvas.width = Math.max(1, Math.round(cw * d));
      canvas.height = Math.max(1, Math.round(ch * d));
    },
    draw(s, v, p) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      // Links: the plain ones, then the lit ones over them.
      const m = s.edges.length / 2;
      if (lines.length < m * 4) lines = new Float32Array(Math.max(m * 4, lines.length * 2));
      let lo = 0;
      let hi = m * 4;
      for (let k = 0; k < m; k++) {
        const a = s.edges[2 * k];
        const b = s.edges[2 * k + 1];
        const o = s.edgeHi[k] ? (hi -= 4) : (lo += 4) - 4;
        lines[o] = s.pos[2 * a];
        lines[o + 1] = s.pos[2 * a + 1];
        lines[o + 2] = s.pos[2 * b];
        lines[o + 3] = s.pos[2 * b + 1];
      }
      gl.useProgram(edgeProg);
      gl.uniform2f(loc.eRes, w, h);
      gl.uniform3f(loc.eView, v.x, v.y, v.k);
      gl.bindBuffer(gl.ARRAY_BUFFER, eBuf);
      gl.bufferData(gl.ARRAY_BUFFER, lines.subarray(0, m * 4), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc.ePos);
      gl.vertexAttribPointer(loc.ePos, 2, gl.FLOAT, false, 0, 0);
      if (lo) {
        gl.uniform4f(loc.eCol, ...norm(p.edge));
        gl.drawArrays(gl.LINES, 0, lo / 2);
      }
      if (hi < m * 4) {
        gl.uniform4f(loc.eCol, ...norm(p.edgeHi));
        gl.drawArrays(gl.LINES, hi / 2, (m * 4 - hi) / 2);
      }
      gl.disableVertexAttribArray(loc.ePos);
      // Nodes.
      if (pts.length < s.n * 4) pts = new Float32Array(Math.max(s.n * 4, pts.length * 2));
      for (let i = 0; i < s.n; i++) {
        pts[4 * i] = s.pos[2 * i];
        pts[4 * i + 1] = s.pos[2 * i + 1];
        pts[4 * i + 2] = s.size[i];
        pts[4 * i + 3] = s.shape[i];
      }
      gl.useProgram(nodeProg);
      gl.uniform2f(loc.nRes, w, h);
      gl.uniform3f(loc.nView, v.x, v.y, v.k);
      gl.uniform1f(loc.nDpr, dpr);
      gl.uniform2f(loc.nMin, MIN_PX.person, MIN_PX.place);
      gl.uniform4f(loc.nRing, ...norm(p.ring));
      gl.bindBuffer(gl.ARRAY_BUFFER, pBuf);
      gl.bufferData(gl.ARRAY_BUFFER, pts.subarray(0, s.n * 4), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc.nP);
      gl.vertexAttribPointer(loc.nP, 4, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, cBuf);
      gl.bufferData(gl.ARRAY_BUFFER, s.color.subarray(0, s.n * 4), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc.nC);
      gl.vertexAttribPointer(loc.nC, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.drawArrays(gl.POINTS, 0, s.n);
      gl.disableVertexAttribArray(loc.nP);
      gl.disableVertexAttribArray(loc.nC);
    },
    destroy() {
      for (const b of [eBuf, pBuf, cBuf]) gl.deleteBuffer(b);
      gl.deleteProgram(edgeProg);
      gl.deleteProgram(nodeProg);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

function canvas2d(canvas: HTMLCanvasElement): Renderer {
  const x = canvas.getContext('2d')!;
  let dpr = 1;
  const rgba = (c: RGBA | Uint8Array, o = 0) => `rgba(${c[o]},${c[o + 1]},${c[o + 2]},${c[o + 3] / 255})`;
  return {
    kind: '2d',
    resize(w, h, d) {
      dpr = d;
      canvas.width = Math.max(1, Math.round(w * d));
      canvas.height = Math.max(1, Math.round(h * d));
    },
    draw(s, v, p) {
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, canvas.width, canvas.height);
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.lineWidth = 1;
      for (const lit of [0, 1]) {
        x.beginPath();
        for (let k = 0; k < s.edges.length / 2; k++) {
          if (s.edgeHi[k] !== lit) continue;
          const a = s.edges[2 * k];
          const b = s.edges[2 * k + 1];
          x.moveTo(s.pos[2 * a] * v.k + v.x, s.pos[2 * a + 1] * v.k + v.y);
          x.lineTo(s.pos[2 * b] * v.k + v.x, s.pos[2 * b + 1] * v.k + v.y);
        }
        x.strokeStyle = rgba(lit ? p.edgeHi : p.edge);
        x.stroke();
      }
      for (let i = 0; i < s.n; i++) {
        const r = Math.min(Math.max(s.size[i] * v.k, (s.shape[i] ? MIN_PX.place : MIN_PX.person) / 2), 48);
        const sx = s.pos[2 * i] * v.k + v.x;
        const sy = s.pos[2 * i + 1] * v.k + v.y;
        x.fillStyle = rgba(s.color, 4 * i);
        if (s.shape[i]) x.fillRect(sx - r, sy - r, 2 * r, 2 * r);
        else {
          x.beginPath();
          x.arc(sx, sy, r, 0, Math.PI * 2);
          x.fill();
        }
      }
    },
    destroy() {},
  };
}

export function renderer(canvas: HTMLCanvasElement, prefer2d = false): Renderer {
  return (!prefer2d && webgl(canvas)) || canvas2d(canvas);
}

export interface Label {
  x: number;
  y: number;
  text: string;
  /** Drawn bolder, and before the rest so it wins a collision. */
  strong?: boolean;
}

/** Labels at screen positions, skipping any that would overlap one already drawn. */
export function drawLabels(c: HTMLCanvasElement, labels: Label[], dpr: number, ink: string, halo: string, font: string) {
  const x = c.getContext('2d');
  if (!x) return;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, c.width, c.height);
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.textBaseline = 'middle';
  x.lineJoin = 'round';
  const taken: [number, number, number, number][] = [];
  for (const l of [...labels.filter((l) => l.strong), ...labels.filter((l) => !l.strong)]) {
    x.font = `${l.strong ? 600 : 500} ${l.strong ? 13 : 12}px ${font}`;
    const t = l.text.length > 40 ? l.text.slice(0, 39) + '…' : l.text;
    const w = x.measureText(t).width;
    const box: [number, number, number, number] = [l.x + 8, l.y - 8, l.x + 12 + w, l.y + 8];
    if (taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    taken.push(box);
    x.strokeStyle = halo;
    x.lineWidth = 3.5;
    x.strokeText(t, l.x + 10, l.y);
    x.fillStyle = ink;
    x.fillText(t, l.x + 10, l.y);
  }
}
