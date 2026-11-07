/**
 * The people graph's canvas: owns the renderer, the layout worker, the view (pan and zoom), picking and labels.
 * The pane (GraphView.tsx) gives it what to draw and hears what was hovered, picked or opened.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { Layout, seed } from './layout.ts';
import type { FromWorker, ToWorker } from './layout.worker.ts';
import { neighbours, type Index, type Visible } from './model.ts';
import { cssColor, drawLabels, MIN_PX, renderer, type Label, type Palette, type Renderer, type RGBA, type Scene, type View } from './render.ts';

export interface EngineEvents {
  hover(node: number | null, x: number, y: number): void;
  pick(node: number | null): void;
  open(node: number): void;
  /** What to call a node. */
  label(node: number): string;
}

/** How far a place is drawn above its people: world radius from its links. */
const radius = (place: boolean, deg: number) => (place ? 5 + 2.2 * Math.sqrt(deg) : 3.2 + Math.sqrt(deg));

export class Engine {
  private r: Renderer;
  private view: View = { x: 0, y: 0, k: 1 };
  private w = 1;
  private h = 1;
  private dpr = 1;
  private scene: Scene = { n: 0, pos: new Float32Array(0), size: new Float32Array(0), color: new Uint8Array(0), shape: new Uint8Array(0), edges: new Uint32Array(0), edgeHi: new Uint8Array(0) };
  private ix: Index | null = null;
  private vis: Visible | null = null;
  /** Global node id → position in the scene. */
  private local = new Map<number, number>();
  private palette: Palette = { edge: [128, 128, 128, 50], edgeHi: [90, 120, 255, 220], ring: [0, 0, 0, 255] };
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
  private ro: ResizeObserver;
  private off: (() => void)[] = [];

  constructor(
    private host: HTMLElement,
    private gl: HTMLCanvasElement,
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
    const isPlace = (i: number) => vis.nodes[i] >= np;
    const pos = seed(n, isPlace, vis.degree, vis.edges, this.kept, (i) => this.key(vis.nodes[i]));
    const size = new Float32Array(n);
    const shape = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const g = vis.nodes[i];
      const place = g >= np;
      size[i] = radius(place, vis.degree[i]);
      shape[i] = place ? (ix.graph.places[g - np].kind === 'group' ? 2 : 1) : 0;
    }
    this.scene = { n, pos, size, shape, color: new Uint8Array(n * 4), edges: vis.edges, edgeHi: new Uint8Array(vis.edges.length / 2) };
    this.byDegree = [...Array(n).keys()].filter(isPlace).sort((a, b) => vis.degree[b] - vis.degree[a]);
    if (this.selected !== null && !this.local.has(this.selected)) this.selected = null;
    this.theme();
    this.start(pos);
    if (this.autoFit) this.fit();
    this.dirty();
  }

  select(node: number | null) {
    this.selected = node;
    if (node === null) this.follow = null;
    this.paint();
    this.dirty();
  }

  /** Bring a node to the middle, near enough to read, and keep it there while the layout settles. */
  center(node: number) {
    const i = this.local.get(node);
    if (i === undefined) return;
    this.autoFit = false;
    this.follow = node;
    const k = Math.max(this.view.k, 1.4);
    this.view = { k, x: this.w / 2 - this.scene.pos[2 * i] * k, y: this.h / 2 - this.scene.pos[2 * i + 1] * k };
    this.dirty();
  }

  /** The layout moved things: keep what is followed in the middle, or everything in view. */
  private moved(done: boolean) {
    this.settled = done;
    this.host.dataset.settled = done ? '1' : '';
    const i = this.follow !== null ? this.local.get(this.follow) : undefined;
    if (i !== undefined) this.view = { k: this.view.k, x: this.w / 2 - this.scene.pos[2 * i] * this.view.k, y: this.h / 2 - this.scene.pos[2 * i + 1] * this.view.k };
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
    const a = m < 1000 ? 0.55 : m < 10_000 ? 0.32 : 0.2;
    this.palette = { edge: cssColor(v('--text-dim', '#999'), a), edgeHi: cssColor(v('--accent', '#58f'), 0.9), ring: cssColor(v('--bg-center', v('--bg', '#000'))) };
    this.ink = v('--text', '#ddd');
    this.halo = v('--bg-center', v('--bg', '#000'));
    this.font = cs.getPropertyValue('--font').trim() || 'sans-serif';
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
    return g < np ? `p:${this.ix!.graph.people[g].id}` : `q:${this.ix!.graph.places[g - np].id}`;
  }

  private start(pos: Float32Array) {
    this.moved(false);
    const msg: ToWorker = { t: 'start', n: this.scene.n, edges: this.scene.edges.slice(), pos: pos.slice() };
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
          this.startInline(this.scene.pos);
        };
      } catch {
        this.worker = null;
      }
    if (this.worker) this.worker.postMessage(msg, [msg.edges.buffer, msg.pos.buffer]);
    else this.startInline(pos);
  }

  /** Where workers are not allowed: a few steps a frame on this thread. */
  private startInline(pos: Float32Array) {
    this.inline = new Layout({ n: this.scene.n, edges: this.scene.edges, pos });
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
    const cs = getComputedStyle(document.documentElement);
    const accent = cssColor(cs.getPropertyValue('--accent').trim() || '#58f');
    const faint = cssColor(cs.getPropertyValue('--text-faint').trim() || '#888');
    const nets = new Map<string, RGBA>();
    const net = (n: P.Network) => nets.get(n) ?? (nets.set(n, cssColor(NETWORK_META[n]?.color ?? '#888')), nets.get(n)!);
    for (let i = 0; i < vis.nodes.length; i++) {
      const g = vis.nodes[i];
      let c: RGBA;
      if (g >= np) c = net(ix.graph.places[g - np].network);
      else {
        const p = ix.graph.people[g];
        c = p.bot ? faint : p.networks.length > 1 ? accent : net(p.networks[0]);
      }
      const dim = focus !== null && !near.has(g);
      this.scene.color.set([c[0], c[1], c[2], dim ? 40 : g >= np ? 255 : 225], 4 * i);
    }
    const e = this.scene.edges;
    const sel = focus !== null ? this.local.get(focus) : undefined;
    const hov = this.hovered !== null ? this.local.get(this.hovered) : undefined;
    for (let k = 0; k < e.length / 2; k++) {
      const a = e[2 * k];
      const b = e[2 * k + 1];
      this.scene.edgeHi[k] = +(a === sel || b === sel || a === hov || b === hov);
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
    this.r.draw(this.scene, this.view, this.palette);
    drawLabels(this.text, this.labels(), this.dpr, this.ink, this.halo, this.font);
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
    const out: Label[] = [];
    const inView = (x: number, y: number) => x > -20 && y > -20 && x < this.w + 20 && y < this.h + 20;
    const add = (g: number, strong = false) => {
      const i = this.local.get(g);
      if (i === undefined) return;
      const [x, y] = this.screen(i);
      if (inView(x, y)) out.push({ x: x + Math.min(this.scene.size[i] * this.view.k, 30) - 6, y, text: this.name(g), strong });
    };
    if (this.hovered !== null) add(this.hovered, true);
    if (this.selected !== null) {
      add(this.selected, true);
      let n = 0;
      for (const g of neighbours(ix, this.selected)) if (this.local.has(g) && n++ < 80) add(g);
      return out;
    }
    // The busiest places in view; people too once close enough to tell them apart.
    let n = 0;
    for (const i of this.byDegree) {
      if (n >= 40) break;
      const [x, y] = this.screen(i);
      if (!inView(x, y) || this.scene.size[i] * this.view.k < 4) continue;
      out.push({ x: x + Math.min(this.scene.size[i] * this.view.k, 30) - 6, y, text: this.name(vis.nodes[i]) });
      n++;
    }
    if (this.view.k > 2.2) {
      let m = 0;
      for (let i = 0; i < this.scene.n && m < 60; i++) {
        if (this.scene.shape[i]) continue;
        const [x, y] = this.screen(i);
        if (!inView(x, y)) continue;
        out.push({ x: x + 4, y, text: this.name(vis.nodes[i]) });
        m++;
      }
    }
    return out;
  }

  /** The node under a point, nearest first. */
  private pick(x: number, y: number): number | null {
    let best = -1;
    let bd = Infinity;
    const { n, pos, size, shape } = this.scene;
    const { k, x: tx, y: ty } = this.view;
    for (let i = 0; i < n; i++) {
      const dx = pos[2 * i] * k + tx - x;
      const dy = pos[2 * i + 1] * k + ty - y;
      const d = dx * dx + dy * dy;
      const r = Math.max(size[i] * k, (shape[i] ? MIN_PX.place : MIN_PX.person) / 2) + 4;
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
        if (pinch) this.zoom(d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = d;
        moved = 99;
        return;
      }
      moved += Math.abs(p.x - was.x) + Math.abs(p.y - was.y);
      pts.set(e.pointerId, p);
      if (moved > 4) {
        this.autoFit = false;
        this.follow = null;
        this.view.x += p.x - was.x;
        this.view.y += p.y - was.y;
        h.style.cursor = 'grabbing';
        this.ev.hover(null, 0, 0);
        this.dirty();
      }
    });
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      pinch = 0;
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
    on(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = local(e);
        const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoom(Math.exp(-d * 0.0015), p.x, p.y);
      },
      { passive: false },
    );
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
