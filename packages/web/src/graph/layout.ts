/**
 * A force layout for the people graph, in typed arrays so it keeps up at ~11k nodes: Barnes–Hut repulsion (heavier
 * nodes push harder), springs along links, and a pull toward the middle so loose parts stay near. Runs in a worker
 * (layout.worker.ts); one tick() is one step, and it cools to a stop.
 */

export interface LayoutInput {
  n: number;
  /** Pairs of node indexes. */
  edges: Uint32Array;
  /** Where each node starts: x0, y0, x1, y1… */
  pos: Float32Array;
}

const THETA2 = 0.81;
const REPEL = 40;
const LINK = 34;
const GRAVITY = 0.012;
const DECAY = 0.62;
const ALPHA_MIN = 0.004;

export class Layout {
  readonly n: number;
  readonly pos: Float32Array;
  alpha = 1;
  private vel: Float32Array;
  private mass: Float32Array;
  private edges: Uint32Array;
  private bias: Float32Array;
  private strength: Float32Array;
  // The quadtree, rebuilt each tick: per cell its square, children, body (-1 none, -2 split), mass and its centre.
  private cap = 0;
  private x0 = new Float32Array(0);
  private y0 = new Float32Array(0);
  private w = new Float32Array(0);
  private kids = new Int32Array(0);
  private body = new Int32Array(0);
  private cm = new Float32Array(0);
  private cx = new Float32Array(0);
  private cy = new Float32Array(0);
  private cells = 0;

  constructor(inp: LayoutInput) {
    this.n = inp.n;
    this.pos = inp.pos;
    this.edges = inp.edges;
    this.vel = new Float32Array(this.n * 2);
    const deg = new Float32Array(this.n);
    for (let e = 0; e < this.edges.length; e++) deg[this.edges[e]]++;
    this.mass = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) this.mass[i] = 1 + Math.sqrt(deg[i]);
    // As d3's link force: a link pulls the end with fewer links more, and is weaker between busy nodes.
    const m = this.edges.length / 2;
    this.bias = new Float32Array(m);
    this.strength = new Float32Array(m);
    for (let k = 0; k < m; k++) {
      const a = deg[this.edges[2 * k]];
      const b = deg[this.edges[2 * k + 1]];
      this.bias[k] = a / (a + b);
      this.strength[k] = 1 / Math.min(a, b);
    }
    this.grow(this.n * 2 + 8);
  }

  get done() {
    return this.alpha < ALPHA_MIN;
  }

  /** Warm it up again, after the layout changed under it. */
  heat(a = 0.5) {
    this.alpha = Math.max(this.alpha, a);
  }

  tick() {
    const { n, pos, vel } = this;
    if (!n) return;
    const alpha = this.alpha;
    this.build();
    // Repulsion.
    const stack = new Int32Array(256);
    for (let i = 0; i < n; i++) {
      const xi = pos[2 * i];
      const yi = pos[2 * i + 1];
      let fx = 0;
      let fy = 0;
      let sp = 0;
      stack[sp++] = 0;
      while (sp) {
        const c = stack[--sp];
        if (this.body[c] === i) continue;
        const dx = this.cx[c] - xi;
        const dy = this.cy[c] - yi;
        let d2 = dx * dx + dy * dy;
        const leaf = this.body[c] !== -2;
        if (leaf || (this.w[c] * this.w[c]) / (d2 || 1e-9) < THETA2) {
          if (d2 < 1) d2 = 1;
          const f = (REPEL * this.cm[c]) / d2;
          fx -= dx * f;
          fy -= dy * f;
          continue;
        }
        for (let q = 0; q < 4; q++) {
          const k = this.kids[4 * c + q];
          if (k >= 0 && sp < stack.length) stack[sp++] = k;
        }
      }
      vel[2 * i] += fx * alpha;
      vel[2 * i + 1] += fy * alpha;
    }
    // Links.
    const e = this.edges;
    for (let k = 0; k < e.length / 2; k++) {
      const a = e[2 * k];
      const b = e[2 * k + 1];
      let dx = pos[2 * b] + vel[2 * b] - pos[2 * a] - vel[2 * a];
      let dy = pos[2 * b + 1] + vel[2 * b + 1] - pos[2 * a + 1] - vel[2 * a + 1];
      const l = Math.sqrt(dx * dx + dy * dy) || 1e-3;
      const f = ((l - LINK) / l) * alpha * this.strength[k];
      dx *= f;
      dy *= f;
      const bb = this.bias[k];
      vel[2 * b] -= dx * bb;
      vel[2 * b + 1] -= dy * bb;
      vel[2 * a] += dx * (1 - bb);
      vel[2 * a + 1] += dy * (1 - bb);
    }
    // Toward the middle, then move.
    for (let i = 0; i < n; i++) {
      vel[2 * i] -= pos[2 * i] * GRAVITY * alpha;
      vel[2 * i + 1] -= pos[2 * i + 1] * GRAVITY * alpha;
      vel[2 * i] *= DECAY;
      vel[2 * i + 1] *= DECAY;
      pos[2 * i] += vel[2 * i];
      pos[2 * i + 1] += vel[2 * i + 1];
    }
    this.alpha += (0 - this.alpha) * 0.02;
  }

  private grow(cap: number) {
    const keep = (a: Float32Array) => {
      const b = new Float32Array(cap);
      b.set(a.subarray(0, Math.min(a.length, cap)));
      return b;
    };
    this.x0 = keep(this.x0);
    this.y0 = keep(this.y0);
    this.w = keep(this.w);
    this.cm = keep(this.cm);
    this.cx = keep(this.cx);
    this.cy = keep(this.cy);
    const kids = new Int32Array(cap * 4).fill(-1);
    kids.set(this.kids.subarray(0, Math.min(this.kids.length, cap * 4)));
    this.kids = kids;
    const body = new Int32Array(cap).fill(-1);
    body.set(this.body.subarray(0, Math.min(this.body.length, cap)));
    this.body = body;
    this.cap = cap;
  }

  private cell(x0: number, y0: number, w: number): number {
    if (this.cells >= this.cap) this.grow(this.cap * 2);
    const c = this.cells++;
    this.x0[c] = x0;
    this.y0[c] = y0;
    this.w[c] = w;
    this.body[c] = -1;
    this.kids.fill(-1, 4 * c, 4 * c + 4);
    return c;
  }

  private build() {
    const { n, pos } = this;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[2 * i];
      const y = pos[2 * i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        pos[2 * i] = Math.random() * 10;
        pos[2 * i + 1] = Math.random() * 10;
        i--;
        continue;
      }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    this.cells = 0;
    const w = Math.max(maxX - minX, maxY - minY, 1) * 1.001 + 1;
    this.cell(minX, minY, w);
    for (let i = 0; i < n; i++) this.insert(i);
    // Mass and centres, children before parents (cells are made after their parent).
    for (let c = this.cells - 1; c >= 0; c--) {
      const b = this.body[c];
      if (b >= 0) {
        this.cm[c] = this.mass[b];
        this.cx[c] = pos[2 * b];
        this.cy[c] = pos[2 * b + 1];
        continue;
      }
      let m = 0;
      let x = 0;
      let y = 0;
      for (let q = 0; q < 4; q++) {
        const k = this.kids[4 * c + q];
        if (k < 0) continue;
        m += this.cm[k];
        x += this.cx[k] * this.cm[k];
        y += this.cy[k] * this.cm[k];
      }
      this.cm[c] = m;
      this.cx[c] = m ? x / m : 0;
      this.cy[c] = m ? y / m : 0;
    }
  }

  private insert(i: number) {
    const { pos } = this;
    let c = 0;
    for (let depth = 0; ; depth++) {
      const b = this.body[c];
      if (b === -1) {
        this.body[c] = i;
        return;
      }
      if (b >= 0) {
        // Two in one place: nudge this one, so the tree can tell them apart.
        if (depth > 40 || (pos[2 * b] === pos[2 * i] && pos[2 * b + 1] === pos[2 * i + 1])) {
          pos[2 * i] += (Math.random() - 0.5) * 1e-2 * this.w[c] + 1e-3;
          pos[2 * i + 1] += (Math.random() - 0.5) * 1e-2 * this.w[c] + 1e-3;
          if (depth > 40) return;
        }
        this.body[c] = -2;
        this.place(c, b);
      }
      c = this.child(c, i);
    }
  }

  /** Puts body b into its quadrant of split cell c. */
  private place(c: number, b: number) {
    const k = this.child(c, b);
    this.body[k] = b;
  }

  /** The child of c that i falls into, made if needed. */
  private child(c: number, i: number): number {
    const h = this.w[c] / 2;
    const right = this.pos[2 * i] >= this.x0[c] + h ? 1 : 0;
    const down = this.pos[2 * i + 1] >= this.y0[c] + h ? 1 : 0;
    const q = right + 2 * down;
    let k = this.kids[4 * c + q];
    if (k < 0) {
      k = this.cell(this.x0[c] + right * h, this.y0[c] + down * h, h);
      this.kids[4 * c + q] = k;
    }
    return k;
  }
}

/**
 * Starting places: the busiest places in the middle on a sunflower spiral, the rest outward, and each person beside
 * the places they are in. `kept` carries positions over from the last layout, by node key.
 */
export function seed(n: number, isPlace: (i: number) => boolean, degree: Uint32Array, edges: Uint32Array, kept?: Map<string, [number, number]>, key?: (i: number) => string): Float32Array {
  const pos = new Float32Array(n * 2).fill(NaN);
  const have = new Uint8Array(n);
  if (kept && key)
    for (let i = 0; i < n; i++) {
      const p = kept.get(key(i));
      if (p) {
        pos[2 * i] = p[0];
        pos[2 * i + 1] = p[1];
        have[i] = 1;
      }
    }
  const places = [...Array(n).keys()].filter((i) => isPlace(i) && !have[i]).sort((a, b) => degree[b] - degree[a]);
  const golden = Math.PI * (3 - Math.sqrt(5));
  places.forEach((p, k) => {
    const r = 60 * Math.sqrt(k + 1);
    pos[2 * p] = r * Math.cos(k * golden);
    pos[2 * p + 1] = r * Math.sin(k * golden);
    have[p] = 1;
  });
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  const cnt = new Uint32Array(n);
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e];
    const b = edges[e + 1];
    if (have[b] && !have[a]) {
      sx[a] += pos[2 * b];
      sy[a] += pos[2 * b + 1];
      cnt[a]++;
    }
    if (have[a] && !have[b]) {
      sx[b] += pos[2 * a];
      sy[b] += pos[2 * a + 1];
      cnt[b]++;
    }
  }
  for (let i = 0; i < n; i++) {
    if (have[i]) continue;
    const t = Math.random() * Math.PI * 2;
    const r = 8 + Math.random() * 30;
    const bx = cnt[i] ? sx[i] / cnt[i] : (Math.random() - 0.5) * 400;
    const by = cnt[i] ? sy[i] / cnt[i] : (Math.random() - 0.5) * 400;
    pos[2 * i] = bx + r * Math.cos(t);
    pos[2 * i + 1] = by + r * Math.sin(t);
  }
  return pos;
}
