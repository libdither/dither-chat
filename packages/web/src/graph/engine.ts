/**
 * The people graph's canvas: owns the renderer, the layout worker, the view (pan and zoom), picking and labels.
 * The pane (GraphView.tsx) gives it what to draw and hears what was hovered, picked or opened.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { Layout, seed } from './layout.ts';
import type { FromWorker, ToWorker } from './layout.worker.ts';
import { neighbours, type Index, type Visible } from './model.ts';
import { drawDiscs, Pictures, type Disc, type Shape } from './pictures.ts';
import { cssColor, drawLabels, renderer, screenR, type Label, type Palette, type Renderer, type RGBA, type Scene, type View } from './render.ts';

interface EngineEvents {
  hover(node: number | null, x: number, y: number): void;
  pick(node: number | null): void;
  open(node: number): void;
  /** What to call a node. */
  label(node: number): string;
}

/** World radius from its links: places above their people, and someone you have chats with above someone only seen. */
const radius = (place: boolean, deg: number, known: boolean) => (place ? 6 + 2.4 * Math.sqrt(deg) : known ? 6 + 1.2 * Math.sqrt(deg) : 2.6 + 0.8 * Math.sqrt(deg));
/** A person's world radius from how much they matter (importance.ts), 0 to 1. */
const radiusOf = (score: number) => 2.4 + 10 * Math.sqrt(score);
/** A place's smallest size, however far out: by how many are in it. */
const placeMin = (deg: number) => Math.min(3.5 + 1.6 * Math.log2(1 + deg), 22);
/**
 * How far from you someone sits, in world units, by their rank: room for everyone before them round you, each about
 * as much as a big picture needs at the overview's zoom. Past the ranks drawn big, far enough not to crowd them.
 */
const nearness = (rank: number) => 150 * Math.sqrt((Math.min(rank, 400) + 4) / Math.PI);
const LINK = 34;
/**
 * The sizes a person can be drawn at however far out: a picture with a badge, a picture, a dot. Each frame the people
 * who matter most get the biggest that fits where they are without covering anyone already drawn (fitSizes); at most
 * so many times the screen's room (against a computer's 1200 × 800) at each, and only above a score.
 */
const TIERS = [
  { rank: 14, score: 0.2, r: 15 },
  { rank: 70, score: 0.1, r: 9 },
  { rank: 260, score: 0.05, r: 5 },
];

/** Pictures show once a node is drawn at least this wide, in CSS pixels; at most this many a frame, biggest first. */
const PIC_MIN_R = 6.5;
const PIC_MAX = 700;

export class Engine {
  private r: Renderer;
  private view: View = { x: 0, y: 0, k: 1 };
  private w = 1;
  private h = 1;
  private dpr = 1;
  private scene: Scene = { n: 0, pos: new Float32Array(0), size: new Float32Array(0), color: new Uint8Array(0), shape: new Uint8Array(0), minR: new Uint8Array(0), edges: new Uint32Array(0), edgeHi: new Uint8Array(0), edgeColor: new Uint8Array(0) };
  private ix: Index | null = null;
  private vis: Visible | null = null;
  /** Global node id → position in the scene. */
  private local = new Map<number, number>();
  private palette: Palette = { ring: [0, 0, 0, 255] };
  /** A plain link's opacity, 0–255: fainter the more links there are. */
  private edgeA = 80;
  private accent = '#58f';
  /** The theme's colours as RGBA, kept from theme() so a hover does not read them again. */
  private rgb: { accent: RGBA; faint: RGBA; nets: Map<string, RGBA> } = { accent: [90, 120, 255, 255], faint: [136, 136, 136, 255], nets: new Map() };
  /** How much each person matters (graph index → 0 to 1), from setScores; null until then. */
  private scores: Float32Array | null = null;
  /** Each shown person's place among those shown, by how much they matter (scene index → rank). */
  private rank = new Uint32Array(0);
  /** The people who may be drawn bigger than a speck, most important first (scene indexes). */
  private byRank: number[] = [];
  private room = 1;
  private ink = '#ccc';
  private halo = '#000';
  private font = 'sans-serif';
  private worker: Worker | null = null;
  private inline: Layout | null = null;
  private frame = 0;
  private settled = false;
  /** Fit the view to the graph until someone moves it. */
  private autoFit = true;
  /** Keep this node in the middle while the layout moves it, until someone moves the view. */
  private follow: number | null = null;
  private selected: number | null = null;
  private hovered: number | null = null;
  /** Places, busiest first, for labels when nothing is picked. */
  private byDegree: number[] = [];
  private kept = new Map<string, [number, number]>();
  /** Same person? suggestions, as pairs of global node ids and their odds: dashed lines (drawSame). */
  private same: { a: number; b: number; p: number }[] = [];
  private sameInk = '#58f';
  /** What is picked and its neighbours (paint), for dimming the rest. */
  private near: Set<number> | null = null;
  /** Per shown node, what its disc needs: names, pictures, networks, and whether you have chats with them. */
  private info: { id: string; pic?: string; networks: P.Network[]; strong: boolean }[] = [];
  private pics = new Pictures(() => this.dirty());
  /** Each node's smallest size when nothing is picked; a picked node and its neighbours are drawn bigger. */
  private baseMinR = new Uint8Array(0);

  /**
   * Who gets the room: people ranked by how much they matter, the top so many (more on a bigger screen) drawn big
   * enough for their picture, the next as dots you can tell apart, the rest as specks. Places by how many are in them,
   * smaller on a phone.
   */
  private tiers() {
    const { ix, vis } = this;
    if (!ix || !vis) return;
    const np = ix.graph.people.length;
    const n = vis.nodes.length;
    const room = (this.room = Math.min(Math.max((this.w * this.h) / (1200 * 800), 0.35), 2.5));
    const f = this.w < 600 ? 0.7 : 1;
    const min = new Uint8Array(n);
    const people: number[] = [];
    for (let i = 0; i < n; i++) {
      const g = vis.nodes[i];
      if (i === vis.me) min[i] = Math.round(22 * f);
      else if (g >= np) min[i] = Math.max(2, Math.round(placeMin(vis.degree[i]) * f));
      else people.push(i);
    }
    const sc = this.scores;
    const s = (i: number) => sc?.[vis.nodes[i]] ?? 0;
    people.sort((a, b) => s(b) - s(a) || a - b);
    this.rank = new Uint32Array(n).fill(n);
    people.forEach((i, r) => {
      this.rank[i] = r;
      const pe = ix.graph.people[vis.nodes[i]];
      const t = sc ? TIERS.find((t) => r < t.rank * room && s(i) >= t.score) : null;
      min[i] = !sc && (pe.dm.length || pe.networks.length > 1) ? 4 : 2;
      this.info[i].strong = !!pe.dm.length || (t?.r ?? 0) >= 9;
    });
    this.byRank = sc ? people.filter((i, r) => r < TIERS[TIERS.length - 1].rank * room && s(i) >= TIERS[TIERS.length - 1].score) : [];
    this.baseMinR = min;
  }

  /** How much each person matters (importance.ts), per graph person: sizes, who gets pictures and names, and how near you. */
  setScores(score: Float32Array) {
    this.scores = score;
    const { ix, vis } = this;
    if (!ix || !vis) return;
    this.sizes();
    this.tiers();
    this.paint();
    const len = this.lengths();
    const mass = this.masses();
    if (this.worker) this.worker.postMessage({ t: 'tune', len, mass } satisfies ToWorker, [len.buffer, mass.buffer]);
    else if (this.inline) {
      this.inline.tune(len, mass);
      this.inline.heat(0.25);
    }
    this.dirty();
  }

  private sizes() {
    const { ix, vis } = this;
    if (!ix || !vis) return;
    const np = ix.graph.people.length;
    for (let i = 0; i < vis.nodes.length; i++) {
      const g = vis.nodes[i];
      if (i === vis.me) this.scene.size[i] = 18;
      else if (g >= np) this.scene.size[i] = radius(true, vis.degree[i], false);
      else this.scene.size[i] = this.scores ? radiusOf(this.scores[g]) : radius(false, vis.degree[i], !!ix.graph.people[g].dm.length);
    }
  }

  /** Each link's length for the layout: yours by how much the other end matters, the rest as usual. */
  private lengths(): Float32Array {
    const vis = this.vis!;
    const e = vis.edges;
    const len = new Float32Array(e.length / 2).fill(1);
    if (vis.me < 0) return len;
    for (let k = 0; k < len.length; k++) {
      const a = e[2 * k];
      const b = e[2 * k + 1];
      if (a !== vis.me && b !== vis.me) continue;
      const o = a === vis.me ? b : a;
      // The layout makes a link to someone with no other links shorter (layout.ts): undo that here.
      const usual = Math.min(vis.degree[a], vis.degree[b]) <= 1 ? 0.45 : 1;
      len[k] = nearness(this.rank[o] ?? 999) / LINK / usual;
    }
    return len;
  }

  /** The people who may be drawn big push harder, so their pictures do not pile up. */
  private masses(): Float32Array {
    const mass = new Float32Array(this.scene.n);
    for (const i of this.byRank) mass[i] = this.rank[i] < TIERS[0].rank * this.room ? 12 : this.rank[i] < TIERS[1].rank * this.room ? 4 : 0;
    return mass;
  }

  /**
   * Every node's smallest size for this frame. Places and you as set; then people, most important first, each at the
   * biggest size its rank and score allow that does not cover anything already placed on screen; what is picked and
   * its neighbours bigger still.
   */
  private fitSizes() {
    const { vis } = this;
    if (!vis) return;
    const { minR, shape, size } = this.scene;
    minR.set(this.baseMinR);
    const k = this.view.k;
    const CELL = 48;
    const grid = new Map<number, number[]>();
    const cellOf = (cx: number, cy: number) => cx * 65536 + cy;
    const put = (x: number, y: number, r: number) => {
      const key = cellOf(Math.floor(x / CELL), Math.floor(y / CELL));
      const list = grid.get(key);
      if (list) list.push(x, y, r);
      else grid.set(key, [x, y, r]);
    };
    const free = (x: number, y: number, r: number) => {
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const list = grid.get(cellOf(cx + dx, cy + dy));
          if (!list) continue;
          for (let j = 0; j < list.length; j += 3) {
            const d = r + list[j + 2] + 2;
            if ((list[j] - x) ** 2 + (list[j + 1] - y) ** 2 < d * d) return false;
          }
        }
      return true;
    };
    const inView = (x: number, y: number) => x > -40 && y > -40 && x < this.w + 40 && y < this.h + 40;
    // You and the bigger places are in the way; a small place's marker may be drawn over.
    for (let i = 0; i < this.scene.n; i++) {
      if (!shape[i] && i !== vis.me) continue;
      const r = screenR(this.scene, i, k);
      if (r < 10 && i !== vis.me) continue;
      const [x, y] = this.screen(i);
      if (inView(x, y)) put(x, y, r);
    }
    const sc = this.scores;
    for (const i of this.byRank) {
      const [x, y] = this.screen(i);
      if (!inView(x, y)) continue;
      const s = sc?.[vis.nodes[i]] ?? 0;
      const own = Math.min(size[i] * k, 48);
      for (const t of TIERS) {
        if (this.rank[i] >= t.rank * this.room || s < t.score) continue;
        const r = Math.max(t.r, own);
        if (!free(x, y, r)) continue;
        minR[i] = t.r;
        put(x, y, r);
        break;
      }
    }
    if (this.selected === null || !this.near) return;
    const many = this.near.size;
    for (let i = 0; i < this.scene.n; i++) {
      const g = vis.nodes[i];
      if (g === this.selected) minR[i] = Math.max(minR[i], 18);
      else if (this.near.has(g)) minR[i] = Math.max(minR[i], many > 150 ? 0 : many > 50 ? 6 : 11);
    }
  }
  private ro: ResizeObserver;
  private off: (() => void)[] = [];

  constructor(
    private host: HTMLElement,
    gl: HTMLCanvasElement,
    private text: HTMLCanvasElement,
    private ev: EngineEvents,
    opts: { prefer2d?: boolean } = {},
  ) {
    this.r = renderer(gl, opts.prefer2d);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.theme();
    this.listen();
  }

  get kind() {
    return this.r.kind;
  }
  get done() {
    return this.settled;
  }

  /** Draw this part of the graph, keeping where nodes already were. */
  setData(ix: Index, vis: Visible) {
    const np = ix.graph.people.length;
    // Remember where everything was, by what it is, so a filter change does not scatter what stays.
    for (const [g, i] of this.local) this.kept.set(this.key(g), [this.scene.pos[2 * i], this.scene.pos[2 * i + 1]]);
    this.ix = ix;
    this.vis = vis;
    const n = vis.nodes.length;
    this.local = new Map([...vis.nodes].map((g, i) => [g, i]));
    const isPlace = (i: number) => vis.nodes[i] >= np && i !== vis.me;
    const pos = seed(n, isPlace, vis.degree, vis.edges, this.kept, (i) => this.key(vis.nodes[i]));
    const shape = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (isPlace(i)) shape[i] = ix.graph.places[vis.nodes[i] - np].kind === 'group' ? 2 : 1;
    this.info = [...vis.nodes].map((g, i) => {
      if (i === vis.me) return { id: 'me', pic: ix.graph.me?.pic, networks: [], strong: true };
      if (g >= np) {
        const pl = ix.graph.places[g - np];
        return { id: pl.id, pic: pl.pic, networks: [pl.network], strong: true };
      }
      const pe = ix.graph.people[g];
      return { id: pe.id, pic: pe.pic, networks: pe.networks, strong: pe.dm.length > 0 || pe.networks.length > 1 };
    });
    const m = vis.edges.length / 2;
    this.scene = { n, pos, size: new Float32Array(n), shape, minR: new Uint8Array(n), color: new Uint8Array(n * 4), edges: vis.edges, edgeHi: new Uint8Array(m), edgeColor: new Uint8Array(m * 4) };
    this.byDegree = [...Array(n).keys()].filter(isPlace).sort((a, b) => vis.degree[b] - vis.degree[a]);
    this.sizes();
    this.tiers();
    if (this.selected !== null && !this.local.has(this.selected)) this.selected = null;
    this.theme();
    this.start(pos);
    if (this.autoFit) this.fit();
    this.dirty();
  }

  /** Show these suggested same-person links (none: hide them). */
  setSame(pairs: { a: number; b: number; p: number }[]) {
    this.same = pairs;
    this.dirty();
  }

  select(node: number | null) {
    this.selected = node;
    if (node === null) this.follow = null;
    this.paint();
    this.dirty();
  }

  /**
   * Bring a node to the middle, near enough to read, and keep it there while the layout settles. With Same person?
   * links shown, the people it may be are kept in view with it.
   */
  center(node: number) {
    if (!this.local.has(node)) return;
    this.autoFit = false;
    this.follow = node;
    this.aim(Math.max(this.view.k, 1.4));
    this.dirty();
  }

  /** The followed node and its Same person? partners in the middle, zoomed out as far as needed to show them all. */
  private aim(most: number) {
    const i = this.follow !== null ? this.local.get(this.follow) : undefined;
    if (i === undefined) return;
    const pts = [i, ...this.same.flatMap((s) => (s.a === this.follow ? [s.b] : s.b === this.follow ? [s.a] : [])).map((g) => this.local.get(g)).filter((j): j is number => j !== undefined)];
    const xs = pts.map((j) => this.scene.pos[2 * j]);
    const ys = pts.map((j) => this.scene.pos[2 * j + 1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 90;
    // On a phone the card covers the lower half: aim at the half above it.
    const h = this.w < 600 ? this.h * 0.45 : this.h;
    const k = Math.min(most, (this.w - 2 * pad) / Math.max(x1 - x0, 1), (h - pad) / Math.max(y1 - y0, 1));
    this.view = { k, x: this.w / 2 - ((x0 + x1) / 2) * k, y: h / 2 + (this.w < 600 ? 20 : 0) - ((y0 + y1) / 2) * k };
  }

  /** The layout moved things: keep what is followed in the middle, or everything in view. */
  private moved(done: boolean) {
    this.settled = done;
    this.host.dataset.settled = done ? '1' : '';
    if (this.follow !== null && this.local.has(this.follow)) this.aim(this.view.k);
    else if (this.autoFit) this.fit();
  }

  fit() {
    const { n, pos } = this.scene;
    if (!n) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[2 * i];
      const y = pos[2 * i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (!Number.isFinite(x0)) return;
    const pad = 40;
    const k = Math.min((this.w - 2 * pad) / Math.max(x1 - x0, 1), (this.h - 2 * pad) / Math.max(y1 - y0, 1), 3);
    this.view = { k, x: this.w / 2 - ((x0 + x1) / 2) * k, y: this.h / 2 - ((y0 + y1) / 2) * k };
    this.dirty();
  }

  zoom(by: number, cx = this.w / 2, cy = this.h / 2) {
    this.autoFit = false;
    if (cx !== this.w / 2 || cy !== this.h / 2) this.follow = null;
    const k = Math.min(Math.max(this.view.k * by, 0.02), 40);
    const f = k / this.view.k;
    this.view = { k, x: cx - (cx - this.view.x) * f, y: cy - (cy - this.view.y) * f };
    this.dirty();
  }

  /** Move the view by this much, as a drag does. */
  panBy(dx: number, dy: number) {
    if (!dx && !dy) return;
    this.autoFit = false;
    this.follow = null;
    this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy };
    this.dirty();
  }

  refit() {
    this.autoFit = true;
    this.follow = null;
    this.fit();
  }

  /** Colours from the theme, again (after it changed). */
  theme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
    // Fainter links the more there are, so a big graph is not a solid blot.
    const m = this.scene.edges.length / 2;
    this.edgeA = Math.round(255 * (m < 1000 ? 0.5 : m < 10_000 ? 0.3 : 0.18));
    this.palette = { ring: cssColor(v('--bg-center', v('--bg', '#000'))) };
    this.accent = v('--accent', '#58f');
    this.rgb = { accent: cssColor(this.accent), faint: cssColor(v('--text-faint', '#888')), nets: new Map() };
    this.ink = v('--text', '#ddd');
    this.halo = v('--bg-center', v('--bg', '#000'));
    this.font = cs.getPropertyValue('--font').trim() || 'sans-serif';
    this.sameInk = v('--accent', '#58f');
    this.paint();
    this.dirty();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.worker?.terminate();
    this.inline = null;
    this.ro.disconnect();
    for (const f of this.off) f();
    this.r.destroy();
  }

  // ------------------------------------------------------------------ inside

  private key(g: number) {
    const np = this.ix?.graph.people.length ?? 0;
    const nq = this.ix?.graph.places.length ?? 0;
    return g < np ? `p:${this.ix!.graph.people[g].id}` : g < np + nq ? `q:${this.ix!.graph.places[g - np].id}` : 'me';
  }

  private start(pos: Float32Array) {
    this.moved(false);
    const fixed = this.vis!.me >= 0 ? this.vis!.me : undefined;
    const len = this.lengths();
    const mass = this.masses();
    const msg: ToWorker & { t: 'start' } = { t: 'start', n: this.scene.n, edges: this.scene.edges.slice(), pos: pos.slice(), fixed, len, mass };
    if (!this.inline && !this.worker)
      try {
        this.worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
          if (e.data.pos.length !== this.scene.pos.length) return;
          this.scene.pos = e.data.pos;
          this.moved(e.data.done);
          this.dirty();
        };
        this.worker.onerror = () => {
          this.worker?.terminate();
          this.worker = null;
          this.startInline(this.scene.pos, this.vis!.me >= 0 ? this.vis!.me : undefined, this.lengths(), this.masses());
        };
      } catch {
        this.worker = null;
      }
    if (this.worker) this.worker.postMessage(msg, [msg.edges.buffer, msg.pos.buffer, len.buffer, mass.buffer]);
    else this.startInline(pos, fixed, this.lengths(), this.masses());
  }

  /** Where workers are not allowed: a few steps a frame on this thread. */
  private startInline(pos: Float32Array, fixed?: number, len?: Float32Array, mass?: Float32Array) {
    this.inline = new Layout({ n: this.scene.n, edges: this.scene.edges, pos, fixed, len, mass });
    this.scene.pos = pos;
    this.dirty();
  }

  private paint() {
    const { ix, vis } = this;
    if (!ix || !vis) return;
    const np = ix.graph.people.length;
    const near = new Set<number>();
    const focus = this.selected ?? null;
    if (focus !== null) {
      near.add(focus);
      for (const g of neighbours(ix, focus)) near.add(g);
    }
    const { accent, faint, nets } = this.rgb;
    const net = (n: P.Network) => nets.get(n) ?? (nets.set(n, cssColor(NETWORK_META[n]?.color ?? '#888')), nets.get(n)!);
    for (let i = 0; i < vis.nodes.length; i++) {
      const g = vis.nodes[i];
      let c: RGBA;
      if (i === vis.me) c = accent;
      else if (g >= np) c = net(ix.graph.places[g - np].network);
      else {
        const p = ix.graph.people[g];
        c = p.bot ? faint : p.networks.length > 1 ? accent : net(p.networks[0]);
      }
      const dim = focus !== null && !near.has(g) && i !== vis.me;
      this.scene.color.set([c[0], c[1], c[2], dim ? 40 : g >= np || this.info[i]?.strong ? 255 : 150], 4 * i);
    }
    this.near = focus !== null ? near : null;
    const e = this.scene.edges;
    const sel = focus !== null ? this.local.get(focus) : undefined;
    const hov = this.hovered !== null ? this.local.get(this.hovered) : undefined;
    // Each link in its place's network's colour; yours in the accent, stronger the more that person matters. A picked
    // or hovered node's links lit, and the rest faded while something is picked.
    for (let k = 0; k < e.length / 2; k++) {
      const a = e[2 * k];
      const b = e[2 * k + 1];
      const lit = a === sel || b === sel || a === hov || b === hov;
      this.scene.edgeHi[k] = +lit;
      const mine = a === vis.me || b === vis.me;
      let c: RGBA;
      let al: number;
      if (mine) {
        c = accent;
        al = 18 + 190 * (this.scores?.[vis.nodes[a === vis.me ? b : a]] ?? 0);
      } else {
        const place = vis.nodes[a] >= np ? a : b;
        c = net(ix.graph.places[vis.nodes[place] - np].network);
        al = this.edgeA;
      }
      if (lit) al = 235;
      else if (focus !== null) al *= 0.25;
      const ec = this.scene.edgeColor;
      ec[4 * k] = c[0];
      ec[4 * k + 1] = c[1];
      ec[4 * k + 2] = c[2];
      ec[4 * k + 3] = al;
    }
  }

  private dirty() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw() {
    this.frame = 0;
    if (this.inline && !this.inline.done) {
      const until = performance.now() + 10;
      do this.inline.tick();
      while (!this.inline.done && performance.now() < until);
      this.moved(this.inline.done);
      this.frame = requestAnimationFrame(() => this.draw());
    }
    this.fitSizes();
    this.r.draw(this.scene, this.view, this.palette);
    drawLabels(this.text, this.labels(), this.dpr, this.ink, this.halo, this.font, (x) => {
      drawDiscs(x, this.discs(), this.pics, this.halo);
      if (this.same.length) this.drawSame(x);
    });
    this.pics.pump();
  }

  /** Nodes drawn big enough for a picture, in view: the biggest kept when there are too many, drawn smallest first. */
  private discs(): Disc[] {
    const { n, pos, shape } = this.scene;
    const { k, x: tx, y: ty } = this.view;
    const np = this.ix?.graph.people.length ?? 0;
    const out: Disc[] = [];
    for (let i = 0; i < n; i++) {
      const r = screenR(this.scene, i, k);
      if (r < PIC_MIN_R) continue;
      const x = pos[2 * i] * k + tx;
      const y = pos[2 * i + 1] * k + ty;
      if (x < -r || y < -r || x > this.w + r || y > this.h + r) continue;
      const inf = this.info[i];
      if (!inf) continue;
      const g = this.vis!.nodes[i];
      const me = i === this.vis!.me;
      out.push({ x, y, r, shape: shape[i] as Shape, id: inf.id, name: this.name(g), pic: inf.pic, networks: inf.networks, strong: inf.strong || g >= np, dim: !me && !!this.near && !this.near.has(g), accent: me ? this.accent : undefined });
    }
    out.sort((a, b) => b.r - a.r);
    if (out.length > PIC_MAX) out.length = PIC_MAX;
    return out.reverse();
  }

  /** Suggested same-person links, dashed, stronger the likelier; the picked person's in full. */
  private drawSame(x: CanvasRenderingContext2D) {
    x.save();
    x.strokeStyle = this.sameInk;
    x.setLineDash([5, 4]);
    for (const s of this.same) {
      const i = this.local.get(s.a);
      const j = this.local.get(s.b);
      if (i === undefined || j === undefined) continue;
      const near = this.selected === s.a || this.selected === s.b || this.hovered === s.a || this.hovered === s.b;
      x.globalAlpha = near ? 1 : this.selected !== null ? 0.15 : 0.25 + 0.6 * s.p;
      x.lineWidth = near ? 2.2 : 1.4;
      const [ax, ay] = this.screen(i);
      const [bx, by] = this.screen(j);
      x.beginPath();
      x.moveTo(ax, ay);
      x.lineTo(bx, by);
      x.stroke();
      // A ring round each end: these two may be one.
      x.setLineDash([]);
      for (const [cx, cy, at] of [[ax, ay, i], [bx, by, j]]) {
        x.beginPath();
        x.arc(cx, cy, screenR(this.scene, at, this.view.k) + 4, 0, 2 * Math.PI);
        x.stroke();
      }
      x.setLineDash([5, 4]);
    }
    x.restore();
  }

  private screen(i: number): [number, number] {
    return [this.scene.pos[2 * i] * this.view.k + this.view.x, this.scene.pos[2 * i + 1] * this.view.k + this.view.y];
  }

  private name(g: number): string {
    return this.ev.label(g);
  }

  private labels(): Label[] {
    const { ix, vis } = this;
    if (!ix || !vis) return [];
    const np = ix.graph.people.length;
    const out: Label[] = [];
    const inView = (x: number, y: number) => x > -20 && y > -20 && x < this.w + 20 && y < this.h + 20;
    const edge = (i: number) => screenR(this.scene, i, this.view.k);
    /** A place's label: on a pill in its network's colour, with how many people are in it. */
    const placeLabel = (i: number, strong = false): Label => {
      const [x, y] = this.screen(i);
      const pl = ix.graph.places[vis.nodes[i] - np];
      const n = vis.degree[i];
      return { x: x + edge(i) - 4, y, text: this.name(vis.nodes[i]), sub: (pl.total ?? n).toLocaleString(), pill: NETWORK_META[pl.network]?.color ?? '#888', big: n >= 200, strong };
    };
    const add = (g: number, strong = false) => {
      const i = this.local.get(g);
      if (i === undefined || i === vis.me) return;
      const [x, y] = this.screen(i);
      if (!inView(x, y)) return;
      out.push(g >= np ? placeLabel(i, strong) : { x: x + edge(i) - 4, y, text: this.name(g), strong });
    };
    if (vis.me >= 0) {
      const [x, y] = this.screen(vis.me);
      if (inView(x, y)) out.push({ x: x + edge(vis.me) - 4, y, text: this.name(vis.nodes[vis.me]), strong: true });
    }
    if (this.hovered !== null) add(this.hovered, true);
    if (this.selected !== null) {
      add(this.selected, true);
      for (const s of this.same) if (s.a === this.selected || s.b === this.selected) add(s.a === this.selected ? s.b : s.a, true);
      let n = 0;
      for (const g of neighbours(ix, this.selected)) if (this.local.has(g) && n++ < 80) add(g);
      return out;
    }
    // Both ends of each Same person? link, by name.
    for (const s of this.same.slice(0, 30)) {
      add(s.a);
      add(s.b);
    }
    // The busiest places in view, as pills; then the people who matter most in view (more on a bigger screen), the
    // first few in bold; and anyone drawn big enough to name.
    let n = 0;
    for (const i of this.byDegree) {
      if (n >= 20) break;
      const [x, y] = this.screen(i);
      if (!inView(x, y) || (edge(i) < 12 && n >= 8) || (this.w < 600 && n >= 14)) continue;
      out.push(placeLabel(i));
      n++;
    }
    const people: number[] = [];
    for (let i = 0; i < this.scene.n; i++) {
      if (this.scene.shape[i] || i === vis.me || edge(i) < 4) continue;
      const [x, y] = this.screen(i);
      if (inView(x, y)) people.push(i);
    }
    people.sort((a, b) => this.rank[a] - this.rank[b]);
    const room = Math.min(Math.max((this.w * this.h) / (1200 * 800), 0.35), 2.5);
    const top = Math.round(22 * room);
    const bold = Math.round(8 * room);
    let named = 0;
    for (const [j, i] of people.entries()) {
      if (named >= 80) break;
      if ((j >= top || edge(i) < 9) && edge(i) < 11) continue;
      const [x, y] = this.screen(i);
      out.push({ x: x + edge(i) - 4, y, text: this.name(vis.nodes[i]), strong: j < bold });
      named++;
    }
    return out;
  }

  /** The node under a point, nearest first. */
  private pick(x: number, y: number): number | null {
    let best = -1;
    let bd = Infinity;
    const { n, pos } = this.scene;
    const { k, x: tx, y: ty } = this.view;
    for (let i = 0; i < n; i++) {
      if (i === this.vis?.me) continue;
      const dx = pos[2 * i] * k + tx - x;
      const dy = pos[2 * i + 1] * k + ty - y;
      const d = dx * dx + dy * dy;
      const r = screenR(this.scene, i, k) + 4;
      if (d < r * r && d < bd) {
        bd = d;
        best = i;
      }
    }
    return best < 0 ? null : this.vis!.nodes[best];
  }

  private resize() {
    const b = this.host.getBoundingClientRect();
    const was = { w: this.w, h: this.h };
    this.w = Math.max(1, b.width);
    this.h = Math.max(1, b.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.r.resize(this.w, this.h, this.dpr);
    this.text.width = Math.round(this.w * this.dpr);
    this.text.height = Math.round(this.h * this.dpr);
    // The room changed: who gets pictures and names, again.
    if (Math.abs(this.w * this.h - was.w * was.h) > 0.1 * was.w * was.h || (was.w < 600) !== (this.w < 600)) {
      this.tiers();
      this.paint();
    }
    if (this.autoFit) this.fit();
    else {
      this.view.x += (this.w - was.w) / 2;
      this.view.y += (this.h - was.h) / 2;
    }
    this.dirty();
  }

  private listen() {
    const h = this.host;
    const pts = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinch = 0;
    /** The point between two fingers at the last move: the graph moves with it as well as zooming about it. */
    let mid: { x: number; y: number } | null = null;
    let hoverAt: { x: number; y: number } | null = null;
    let hoverFrame = 0;
    const local = (e: { clientX: number; clientY: number }) => {
      const b = h.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    };
    const hoverNow = () => {
      hoverFrame = 0;
      if (!hoverAt) return;
      const g = this.pick(hoverAt.x, hoverAt.y);
      if (g !== this.hovered) {
        this.hovered = g;
        this.paint();
        this.dirty();
      }
      h.style.cursor = g !== null ? 'pointer' : 'grab';
      this.ev.hover(g, hoverAt.x, hoverAt.y);
    };
    const on = <K extends keyof HTMLElementEventMap>(t: K, f: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      h.addEventListener(t, f as EventListener, o);
      this.off.push(() => h.removeEventListener(t, f as EventListener, o));
    };
    on('pointerdown', (e) => {
      h.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, local(e));
      moved = 0;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
    });
    on('pointermove', (e) => {
      const p = local(e);
      const was = pts.get(e.pointerId);
      if (!was) {
        hoverAt = p;
        if (!hoverFrame) hoverFrame = requestAnimationFrame(hoverNow);
        return;
      }
      if (pts.size === 2) {
        pts.set(e.pointerId, p);
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (mid) this.panBy(m.x - mid.x, m.y - mid.y);
        if (pinch) this.zoom(d / pinch, m.x, m.y);
        pinch = d;
        mid = m;
        moved = 99;
        return;
      }
      moved += Math.abs(p.x - was.x) + Math.abs(p.y - was.y);
      pts.set(e.pointerId, p);
      if (moved > 4) {
        this.panBy(p.x - was.x, p.y - was.y);
        h.style.cursor = 'grabbing';
        this.ev.hover(null, 0, 0);
      }
    });
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      pinch = 0;
      mid = null;
      if (moved <= 4 && e.type === 'pointerup') {
        const p = local(e);
        this.ev.pick(this.pick(p.x, p.y));
      }
      h.style.cursor = 'grab';
    };
    on('pointerup', up);
    on('pointercancel', up);
    on('pointerleave', () => {
      hoverAt = null;
      if (this.hovered !== null) {
        this.hovered = null;
        this.paint();
        this.dirty();
      }
      this.ev.hover(null, 0, 0);
    });
    on('dblclick', (e) => {
      const p = local(e);
      const g = this.pick(p.x, p.y);
      if (g !== null) this.ev.open(g);
    });
    /** Wheel events from a touchpad until then: a stream keeps its kind, momentum and all. */
    let padUntil = 0;
    on(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = local(e);
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.h : 1;
        const dx = e.deltaX * unit;
        const dy = e.deltaY * unit;
        // A touchpad pinch comes as the wheel with Ctrl held, deltaY = -100·ln(the fingers' scale) in Chrome and
        // about the same in Firefox: zoom by exactly that, so the graph stays under the fingers.
        if (e.ctrlKey) return this.zoom(Math.exp(-dy / 100), p.x, p.y);
        // Two fingers moving on a touchpad: fine steps in pixels, often sideways too. They pan, as in a map. A mouse
        // wheel's notches (whole lines, or whole and large in pixels) still zoom.
        const now = performance.now();
        if (e.deltaMode === 0 && (dx !== 0 || !Number.isInteger(dy) || Math.abs(dy) < 50)) padUntil = now + 400;
        if (now < padUntil) {
          padUntil = now + 400;
          return this.panBy(-dx, -dy);
        }
        this.zoom(Math.exp(-dy * 0.0015), p.x, p.y);
      },
      { passive: false },
    );
    // Safari's touchpad pinch: gesture events with the scale since the pinch began.
    let gestureK = 1;
    on('gesturestart' as keyof HTMLElementEventMap, (e) => {
      e.preventDefault();
      gestureK = 1;
    });
    on('gesturechange' as keyof HTMLElementEventMap, (e) => {
      e.preventDefault();
      const ge = e as Event as Event & { scale: number; clientX: number; clientY: number };
      const p = local(ge);
      this.zoom(ge.scale / gestureK, p.x, p.y);
      gestureK = ge.scale;
    });
    on('keydown', (e) => {
      if (e.key === '+' || e.key === '=') this.zoom(1.25);
      else if (e.key === '-') this.zoom(0.8);
      else if (e.key === '0') this.refit();
      else if (e.key === 'Escape' && this.selected !== null) this.ev.pick(null);
      else return;
      e.preventDefault();
    });
  }
}
