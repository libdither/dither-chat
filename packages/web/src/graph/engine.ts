/**
 * The people graph's canvas: owns the renderer, the layout worker, the view (pan and zoom), picking and labels.
 * The pane (GraphView.tsx) gives it what to draw and hears what was hovered, picked or opened.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { Layout, seed, type Rings } from './layout.ts';
import type { FromWorker, ToWorker } from './layout.worker.ts';
import { neighbours, type Index, type Visible } from './model.ts';
import { drawDiscs, Pictures, type Disc, type Shape } from './pictures.ts';
import { cssColor, drawLabels, renderer, screenR, type Label, type Palette, type Renderer, type RGBA, type Scene, type View } from './render.ts';
import type { Ties } from './ties.ts';

/**
 * The rings, from the pane (docs/people-graph.md "Rings"): each person's circle, each circle's slice and name, and the
 * ties between people. The engine puts everyone at a distance from you by their rank, and each circle in its slice.
 */
interface RingsInput {
  /** Graph person index → circle, -1 for none. */
  of: Int32Array;
  /** Per circle: its slice's middle and half-width (radians), and its name. */
  at: Float32Array;
  half: Float32Array;
  names: string[];
  ties: Ties;
}

interface EngineEvents {
  hover(node: number | null, x: number, y: number): void;
  pick(node: number | null): void;
  open(node: number): void;
  /** What to call a node. */
  label(node: number): string;
  /** A Same person? group was clicked (its index in setSame's groups), or none. */
  group(index: number | null): void;
}

/** People who may be one person: global node ids, and the weakest odds holding them together. */
interface SameGroup {
  members: number[];
  /** How many accounts it joins, on the graph or not. */
  n: number;
  p: number;
}

/** World radius from its links: places above their people, and someone you have chats with above someone only seen. */
const radius = (place: boolean, deg: number, known: boolean) => (place ? 6 + 2.4 * Math.sqrt(deg) : known ? 6 + 1.2 * Math.sqrt(deg) : 2.6 + 0.8 * Math.sqrt(deg));
/** A person's world radius from how much they matter (importance.ts), 0 to 1. */
const radiusOf = (score: number) => 2.4 + 10 * Math.sqrt(score);
/** A place's world radius: a little by how many are in it, mostly by how much it matters to you (0 to 1). */
const placeRadius = (deg: number, score: number) => 3 + 1.1 * Math.log2(1 + deg) + 18 * Math.sqrt(score);
/** A place's smallest size, however far out, before its score is known: by how many are in it. */
const placeMin = (deg: number) => Math.min(3.5 + 1.6 * Math.log2(1 + deg), 22);
/**
 * How far from you someone sits, in world units, by their rank: room for everyone before them round you, each about
 * as much as a big picture needs at the overview's zoom. Past the ranks drawn big, far enough not to crowd them.
 */
const nearness = (rank: number) => 150 * Math.sqrt((Math.min(rank, 400) + 4) / Math.PI);
const LINK = 34;
/**
 * The sizes a person can be drawn at however far out: a picture with a badge, a picture, a dot. Each frame the people
 * and places that matter most get the biggest that fits where they are without covering anything already drawn
 * (fitSizes). At most so many times the screen's room (against a computer's 1200 × 800) at each, and only above a
 * score; the score asked for is lower the more room there is (divided by its square root), so a big screen shows more
 * and a phone fewer.
 */
const TIERS = [
  { rank: 14, score: 0.2, r: 15 },
  { rank: 70, score: 0.1, r: 9 },
  { rank: 260, score: 0.05, r: 5 },
];
/** The same for servers and groups: an icon with its name, an icon, a marker. */
const PLACE_TIERS = [
  { rank: 6, score: 0.25, r: 15 },
  { rank: 30, score: 0.1, r: 9 },
  { rank: 120, score: 0.03, r: 5 },
];
/** Room round each Same person? group's members, in CSS pixels. */
const BLOB_PAD = 7;

/** Pictures show once a node is drawn at least this wide, in CSS pixels; at most this many a frame, biggest first. */
const PIC_MIN_R = 6.5;
const PIC_MAX = 700;
/** Rings: the innermost ring's distance from you, and how much farther out each node adds (by its square root). */
const RING_IN = 70;
const RING_STEP = 24;
/** The ranks marked by a ring, with what each says. */
const RING_MARKS = [10, 50, 250, 1000];
/** Ties pulled together in the layout: each person's strongest few. */
const RING_TIES = 5;

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
  /** How much each place matters (graph place index → 0 to 1), from setScores; null until then. */
  private placeScores: Float32Array | null = null;
  /** Each shown person's place among the people shown, and each place's among the places, by how much they matter (scene index → rank). */
  private rank = new Uint32Array(0);
  /** The people and places that may be drawn bigger than a speck, most important first (scene indexes). */
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
  /** Places, the ones that matter most first, for labels when nothing is picked. */
  private byDegree: number[] = [];
  private kept = new Map<string, [number, number]>();
  /** Same person? suggestions, as pairs of global node ids and their odds: dashed lines (drawSame). */
  private same: { a: number; b: number; p: number }[] = [];
  /** The same, joined into groups: drawn as one shaded shape each, with a badge to click. */
  private groups: SameGroup[] = [];
  /** This frame's group shapes and badges, on screen, for clicks. */
  private blobs: { gi: number; pts: { x: number; y: number; r: number }[]; hull: [number, number][] }[] = [];
  private badges: { gi: number; x: number; y: number; w: number; h: number }[] = [];
  private pickedGroup: number | null = null;
  private hoveredGroup: number | null = null;
  private sameInk = '#58f';
  /** What is picked and its neighbours (paint), for dimming the rest. */
  private near: Set<number> | null = null;
  /** Per shown node, what its disc needs: names, pictures, networks, and whether you have chats with them. */
  private info: { id: string; pic?: string; networks: P.Network[]; strong: boolean }[] = [];
  private pics = new Pictures(() => this.dirty());
  /** Each node's smallest size when nothing is picked; a picked node and its neighbours are drawn bigger. */
  private baseMinR = new Uint8Array(0);
  /** The rings, or null for the free layout; and where they put each rank this time (radius by rank). */
  private ringsIn: RingsInput | null = null;
  private ringOut = 0;
  private ringPeople = 0;

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
    const places: number[] = [];
    const ps = this.placeScores;
    for (let i = 0; i < n; i++) {
      const g = vis.nodes[i];
      if (i === vis.me) min[i] = Math.round(30 * f);
      else if (g >= np) {
        places.push(i);
        min[i] = ps ? 3 : Math.max(2, Math.round(placeMin(vis.degree[i]) * f));
      } else people.push(i);
    }
    const sc = this.scores;
    const s = (i: number) => this.score(i);
    people.sort((a, b) => s(b) - s(a) || a - b);
    places.sort((a, b) => s(b) - s(a) || vis.degree[b] - vis.degree[a] || a - b);
    this.byDegree = places;
    this.rank = new Uint32Array(n).fill(n);
    const bar = (t: { score: number }) => t.score / Math.sqrt(room);
    people.forEach((i, r) => {
      this.rank[i] = r;
      const pe = ix.graph.people[vis.nodes[i]];
      const t = sc ? TIERS.find((t) => r < t.rank * room && s(i) >= bar(t)) : null;
      min[i] = !sc && (pe.dm.length || pe.networks.length > 1) ? 4 : 2;
      this.info[i].strong = !!pe.dm.length || (t?.r ?? 0) >= 9;
    });
    places.forEach((i, r) => (this.rank[i] = r));
    const last = TIERS[TIERS.length - 1];
    const lastP = PLACE_TIERS[PLACE_TIERS.length - 1];
    this.byRank = [
      ...(sc ? people.filter((i, r) => r < last.rank * room && s(i) >= bar(last)) : []),
      ...(ps ? places.filter((i, r) => r < lastP.rank * room && s(i) >= bar(lastP)) : []),
    ].sort((a, b) => s(b) - s(a) || a - b);
    this.baseMinR = min;
  }

  /** A shown node's score, 0 to 1: a person's or a place's. */
  private score(i: number): number {
    const g = this.vis!.nodes[i];
    const np = this.ix!.graph.people.length;
    return (g < np ? this.scores?.[g] : this.placeScores?.[g - np]) ?? 0;
  }

  /**
   * How much each person and place matters (importance.ts), per graph person and place: sizes, who gets pictures and
   * names, and how near you.
   */
  setScores(score: Float32Array, place: Float32Array) {
    this.scores = score;
    this.placeScores = place;
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
    if (this.ringsIn) this.sendRings();
    this.dirty();
  }

  /** Rings on (with circles and ties), or off for the free layout. */
  setRings(r: RingsInput | null) {
    if (!r && !this.ringsIn) return;
    this.ringsIn = r;
    // For scripts: how many circles the rings show.
    this.host.dataset.circles = r ? String(r.names.length) : '';
    this.sendRings();
    if (this.autoFit) this.fit();
    this.dirty();
  }

  private sendRings() {
    const rings = this.rings();
    if (this.worker) this.worker.postMessage({ t: 'rings', rings } satisfies ToWorker);
    else if (this.inline) {
      this.inline.setRings(rings);
      this.inline.heat(0.6);
    }
  }

  /**
   * A rank's distance from you on the rings, on a log scale: the 10, 50, 250 and 1,000 nearest each get a band about as
   * wide, so the few who matter most have room, and the thousands only seen in a server share the outside.
   */
  private ringAt(rank: number, of: number) {
    return RING_IN + (this.ringOut - RING_IN) * (Math.log1p((rank + 0.5) / 4) / Math.log1p(Math.max(of, 1) / 4));
  }

  /**
   * Where the rings put each node: people at a distance by their rank (the most important nearest), places by theirs;
   * a person in a circle within its slice; and each person's strongest ties as springs. Null with rings off, or with
   * you not shown (nothing to be round).
   */
  private rings(): Rings | null {
    const { ix, vis, ringsIn: ri } = this;
    if (!ri || !ix || !vis || vis.me < 0) return null;
    const np = ix.graph.people.length;
    const n = this.scene.n;
    const radius = new Float32Array(n).fill(-1);
    const angle = new Float32Array(n).fill(NaN);
    const spread = new Float32Array(n);
    let people = 0;
    let places = 0;
    for (let i = 0; i < n; i++) if (i !== vis.me) vis.nodes[i] < np ? people++ : places++;
    this.ringPeople = people;
    this.ringOut = RING_IN + RING_STEP * Math.sqrt(people + places);
    const springs: number[] = [];
    const pull: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i === vis.me) continue;
      const g = vis.nodes[i];
      if (g >= np) {
        // A place a little outside its people of the same rank: it is drawn bigger, and they gather round it.
        radius[i] = this.ringAt(this.rank[i] ?? places, places) * 1.04;
        continue;
      }
      radius[i] = this.ringAt(this.rank[i] ?? people, people);
      const c = ri.of[g];
      if (c >= 0) {
        angle[i] = ri.at[c];
        spread[i] = ri.half[c];
      }
      const t = ri.ties;
      const mine: [number, number][] = [];
      for (let k = t.start[g]; k < t.start[g + 1]; k++) {
        const j = this.local.get(t.to[k]);
        if (j !== undefined) mine.push([j, t.w[k]]);
      }
      mine.sort((a, b) => b[1] - a[1]);
      for (const [j, w] of mine.slice(0, RING_TIES)) {
        springs.push(i, j);
        pull.push(Math.min(1, w * 2));
      }
    }
    return { radius, angle, spread, springs: Uint32Array.from(springs), pull: Float32Array.from(pull) };
  }

  /** The rings' guides: a ring at a few ranks, each circle's name at the end of its slice, faint lines between slices. */
  private drawRings(x: CanvasRenderingContext2D) {
    const { ringsIn: ri, vis } = this;
    if (!ri || !vis || vis.me < 0 || !this.ringOut) return;
    const k = this.view.k;
    const [cx, cy] = this.screen(vis.me);
    x.save();
    x.strokeStyle = this.ink;
    x.fillStyle = this.ink;
    x.lineWidth = 1;
    x.font = `500 11px ${this.font}`;
    x.textAlign = 'center';
    x.textBaseline = 'bottom';
    for (const mark of RING_MARKS) {
      if (mark >= this.ringPeople) break;
      const r = this.ringAt(mark, this.ringPeople) * k;
      if (r < 40) continue;
      x.globalAlpha = 0.12;
      x.setLineDash([3, 5]);
      x.beginPath();
      x.arc(cx, cy, r, 0, 2 * Math.PI);
      x.stroke();
      x.setLineDash([]);
      x.globalAlpha = 0.45;
      x.fillText(`${mark} nearest`, cx, cy - r - 2);
    }
    const out = this.ringOut * k;
    x.font = `600 12px ${this.font}`;
    x.textBaseline = 'middle';
    ri.names.forEach((name, c) => {
      const a = ri.at[c];
      const h = ri.half[c];
      // A line at the slice's start, from the inner ring out.
      x.globalAlpha = 0.07;
      x.beginPath();
      x.moveTo(cx + Math.cos(a - h) * RING_IN * k, cy + Math.sin(a - h) * RING_IN * k);
      x.lineTo(cx + Math.cos(a - h) * (out + 12), cy + Math.sin(a - h) * (out + 12));
      x.stroke();
      // Its name past the outer ring, if the slice is wide enough on screen to hold it.
      if (2 * h * out < 50) return;
      const tx = cx + Math.cos(a) * (out + 18);
      const ty = cy + Math.sin(a) * (out + 18);
      if (tx < -100 || ty < -20 || tx > this.w + 100 || ty > this.h + 20) return;
      x.globalAlpha = 0.75;
      x.textAlign = Math.cos(a) > 0.3 ? 'left' : Math.cos(a) < -0.3 ? 'right' : 'center';
      const max = Math.max(60, Math.min(200, 2 * h * out));
      let t = name;
      while (t.length > 4 && x.measureText(t).width > max) t = t.slice(0, -2);
      x.fillText(t === name ? t : `${t.trimEnd()}…`, tx, ty);
    });
    x.restore();
  }

  private sizes() {
    const { ix, vis } = this;
    if (!ix || !vis) return;
    const np = ix.graph.people.length;
    for (let i = 0; i < vis.nodes.length; i++) {
      const g = vis.nodes[i];
      if (i === vis.me) this.scene.size[i] = 24;
      else if (g >= np) this.scene.size[i] = this.placeScores ? placeRadius(vis.degree[i], this.placeScores[g - np]) : radius(true, vis.degree[i], false);
      else this.scene.size[i] = this.scores ? radiusOf(this.scores[g]) : radius(false, vis.degree[i], !!ix.graph.people[g].dm.length);
    }
  }

  /** Each link's length for the layout: yours by how much the other end matters, the rest as usual. */
  private lengths(): Float32Array {
    const vis = this.vis!;
    const e = vis.edges;
    const len = new Float32Array(e.length / 2).fill(1);
    if (vis.me < 0) return len;
    // People who may be one person sit as near you as the nearer of them, so their tie can bring them side by side.
    const near = new Map<number, number>();
    const t = this.ties();
    for (let k = 0; k < t.length; k += 2) {
      const r = Math.min(this.rank[t[k]] ?? 999, this.rank[t[k + 1]] ?? 999);
      for (const i of [t[k], t[k + 1]]) near.set(i, Math.min(near.get(i) ?? r, r));
    }
    for (let k = 0; k < len.length; k++) {
      const a = e[2 * k];
      const b = e[2 * k + 1];
      if (a !== vis.me && b !== vis.me) continue;
      const o = a === vis.me ? b : a;
      // The layout makes a link to someone with no other links shorter (layout.ts): undo that here.
      const usual = Math.min(vis.degree[a], vis.degree[b]) <= 1 ? 0.45 : 1;
      len[k] = nearness(near.get(o) ?? this.rank[o] ?? 999) / LINK / usual;
    }
    return len;
  }

  /** The people who may be drawn big push harder, so their pictures do not pile up. */
  private masses(): Float32Array {
    const mass = new Float32Array(this.scene.n);
    for (const i of this.byRank) if (!this.scene.shape[i]) mass[i] = this.rank[i] < TIERS[0].rank * this.room ? 12 : this.rank[i] < TIERS[1].rank * this.room ? 4 : 0;
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
    // You, and big places that do not matter much, are in the way; a small place's marker may be drawn over.
    const ranked = new Uint8Array(this.scene.n);
    for (const i of this.byRank) ranked[i] = 1;
    for (let i = 0; i < this.scene.n; i++) {
      if ((!shape[i] || ranked[i]) && i !== vis.me) continue;
      const r = screenR(this.scene, i, k);
      if (r < 10 && i !== vis.me) continue;
      const [x, y] = this.screen(i);
      if (inView(x, y)) put(x, y, r);
    }
    const lower = Math.sqrt(this.room);
    for (const i of this.byRank) {
      const [x, y] = this.screen(i);
      if (!inView(x, y)) continue;
      const s = this.score(i);
      const own = Math.min(size[i] * k, 48);
      for (const t of shape[i] ? PLACE_TIERS : TIERS) {
        if (this.rank[i] >= t.rank * this.room || s < t.score / lower) continue;
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
    this.sizes();
    this.tiers();
    if (this.selected !== null && !this.local.has(this.selected)) this.selected = null;
    this.theme();
    this.start(pos);
    if (this.autoFit) this.fit();
    this.dirty();
  }

  /** Show these suggested same-person links and their groups (none: hide them); the layout holds each group close. */
  setSame(pairs: { a: number; b: number; p: number }[], groups: SameGroup[]) {
    this.same = pairs;
    this.groups = groups;
    if (this.pickedGroup !== null && this.pickedGroup >= groups.length) this.pickedGroup = null;
    const ties = this.ties();
    const len = this.lengths();
    const mass = this.masses();
    if (this.worker) {
      this.worker.postMessage({ t: 'ties', ties } satisfies ToWorker, [ties.buffer]);
      this.worker.postMessage({ t: 'tune', len, mass } satisfies ToWorker, [len.buffer, mass.buffer]);
    } else if (this.inline) {
      this.inline.setTies(ties);
      this.inline.tune(len, mass);
      this.inline.heat(0.3);
    }
    this.dirty();
  }

  /** Mark a Same person? group as picked (its index), and bring it into view. */
  selectGroup(gi: number | null) {
    this.pickedGroup = gi;
    const first = gi === null ? undefined : this.groups[gi]?.members.find((g) => this.local.has(g));
    if (first !== undefined) this.center(first);
    this.dirty();
  }

  /** The scene pairs the layout holds close: both ends of each suggestion on the graph. */
  private ties(): Uint32Array {
    const out: number[] = [];
    for (const s of this.same) {
      const i = this.local.get(s.a);
      const j = this.local.get(s.b);
      if (i !== undefined && j !== undefined) out.push(i, j);
    }
    return Uint32Array.from(out);
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
    const f = this.follow!;
    const grp = this.groups.find((x) => x.members.includes(f));
    const others = grp ? grp.members.filter((g) => g !== f) : this.same.flatMap((s) => (s.a === f ? [s.b] : s.b === f ? [s.a] : []));
    const pts = [i, ...others.map((g) => this.local.get(g)).filter((j): j is number => j !== undefined)];
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
    // With you shown, the view is centred on you (held at 0, 0) and wide enough for the farthest node each way.
    const me = (this.vis?.me ?? -1) >= 0;
    const cx = me ? 0 : (x0 + x1) / 2;
    const cy = me ? 0 : (y0 + y1) / 2;
    const sx = me ? 2 * Math.max(-x0, x1) : x1 - x0;
    const sy = me ? 2 * Math.max(-y0, y1) : y1 - y0;
    const k = Math.min((this.w - 2 * pad) / Math.max(sx, 1), (this.h - 2 * pad) / Math.max(sy, 1), 3);
    this.view = { k, x: this.w / 2 - cx * k, y: this.h / 2 - cy * k };
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
    const ties = this.ties();
    const msg: ToWorker & { t: 'start' } = { t: 'start', n: this.scene.n, edges: this.scene.edges.slice(), pos: pos.slice(), fixed, len, mass, ties, rings: this.rings() };
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
    if (this.worker) this.worker.postMessage(msg, [msg.edges.buffer, msg.pos.buffer, len.buffer, mass.buffer, ties.buffer]);
    else this.startInline(pos, fixed, this.lengths(), this.masses());
  }

  /** Where workers are not allowed: a few steps a frame on this thread. */
  private startInline(pos: Float32Array, fixed?: number, len?: Float32Array, mass?: Float32Array) {
    this.inline = new Layout({ n: this.scene.n, edges: this.scene.edges, pos, fixed, len, mass, ties: this.ties(), rings: this.rings() });
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
      this.blobs = [];
      this.badges = [];
      if (this.ringsIn) this.drawRings(x);
      if (this.groups.length) this.drawBlobs(x);
      drawDiscs(x, this.discs(), this.pics, this.halo);
      if (this.same.length) this.drawSame(x);
      if (this.groups.length) this.drawBadges(x);
      else if (this.host.dataset.badge) this.host.dataset.badge = '';
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
    // You last of all, so no one is drawn over you; then the biggest kept, drawn smallest first.
    const meAt = out.findIndex((d) => d.accent);
    const me = meAt >= 0 ? out.splice(meAt, 1) : [];
    out.sort((a, b) => b.r - a.r);
    if (out.length > PIC_MAX) out.length = PIC_MAX;
    return [...out.reverse(), ...me];
  }

  /** Whether a group is the one picked or hovered, or holds the picked or hovered person. */
  private groupOn(gi: number): boolean {
    const m = this.groups[gi].members;
    return this.pickedGroup === gi || this.hoveredGroup === gi || (this.selected !== null && m.includes(this.selected)) || (this.hovered !== null && m.includes(this.hovered));
  }

  /**
   * Each Same person? group as one shaded shape round its members on the graph: circles round each, joined along the
   * outline they make (the convex hull), filled once.
   */
  private drawBlobs(x: CanvasRenderingContext2D) {
    const k = this.view.k;
    x.save();
    x.fillStyle = this.sameInk;
    this.groups.forEach((grp, gi) => {
      const pts: { x: number; y: number; r: number }[] = [];
      for (const g of grp.members) {
        const i = this.local.get(g);
        if (i === undefined) continue;
        const [sx, sy] = this.screen(i);
        pts.push({ x: sx, y: sy, r: screenR(this.scene, i, k) + BLOB_PAD });
      }
      if (!pts.length || pts.every((p) => p.x < -p.r || p.y < -p.r || p.x > this.w + p.r || p.y > this.h + p.r)) return;
      // Members far apart on screen are ringed each, the dashed links joining them; near ones as one shape.
      const all = convexHull(pts.map((p) => [p.x, p.y]));
      const rOf = (q: [number, number]) => pts.find((p) => p.x === q[0] && p.y === q[1])?.r ?? BLOB_PAD;
      const far = all.some((a, k) => {
        const b = all[(k + 1) % all.length];
        return Math.hypot(a[0] - b[0], a[1] - b[1]) > 3 * (rOf(a) + rOf(b)) + 60;
      });
      const hull = far ? [] : all;
      this.blobs.push({ gi, pts, hull });
      const on = this.groupOn(gi);
      x.globalAlpha = on ? 0.26 : this.selected !== null || this.pickedGroup !== null ? 0.05 : 0.08 + 0.12 * grp.p;
      x.fill(blobPath(pts, hull), 'nonzero');
    });
    x.restore();
  }

  /**
   * A badge over each group on screen: how many and how likely, to click for the merge card. The likeliest first when
   * there are many; a picked or hovered one always.
   */
  private drawBadges(x: CanvasRenderingContext2D) {
    const order = [...this.blobs].sort((a, b) => +this.groupOn(b.gi) - +this.groupOn(a.gi) || this.groups[b.gi].p - this.groups[a.gi].p);
    x.save();
    x.font = `600 10.5px ${this.font}`;
    x.textBaseline = 'middle';
    x.textAlign = 'center';
    const taken: [number, number, number, number][] = [];
    for (const [n, bl] of order.entries()) {
      const on = this.groupOn(bl.gi);
      if (n >= Math.round(10 * this.room) && !on) break;
      const grp = this.groups[bl.gi];
      const top = bl.pts.reduce((a, p) => (p.y - p.r < a.y - a.r ? p : a));
      const cx = bl.pts.reduce((a, p) => a + p.x, 0) / bl.pts.length;
      const text = `${grp.n} · ${Math.round(grp.p * 100)}%`;
      const w = x.measureText(text).width + 22;
      const h = 17;
      const bx = cx - w / 2;
      const by = top.y - top.r - h - 1;
      if (!on && taken.some(([x0, y0, x1, y1]) => bx < x1 && bx + w > x0 && by < y1 && by + h > y0)) continue;
      taken.push([bx, by, bx + w, by + h]);
      this.badges.push({ gi: bl.gi, x: bx, y: by, w, h });
      x.globalAlpha = on || (this.selected === null && this.pickedGroup === null) ? 1 : 0.35;
      x.fillStyle = this.sameInk;
      x.beginPath();
      x.roundRect(bx, by, w, h, h / 2);
      x.fill();
      x.fillStyle = '#fff';
      // Two lines becoming one: these may be one.
      x.strokeStyle = '#fff';
      x.lineWidth = 1.5;
      x.lineCap = 'round';
      x.lineJoin = 'round';
      x.beginPath();
      x.moveTo(bx + 6, by + 4.5);
      x.lineTo(bx + 10, by + h / 2);
      x.lineTo(bx + 6, by + h - 4.5);
      x.moveTo(bx + 10, by + h / 2);
      x.lineTo(bx + 15, by + h / 2);
      x.stroke();
      x.fillText(text, bx + w / 2 + 6, by + h / 2 + 0.5);
    }
    x.restore();
    // Where the first badge is, for headless checks (scripts/verify-graph.ts) to click.
    const b = this.badges[0];
    this.host.dataset.badge = b ? `${Math.round(b.x + b.w / 2)},${Math.round(b.y + b.h / 2)}` : '';
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
      x.globalAlpha = near ? 1 : this.selected !== null || this.pickedGroup !== null ? 0.15 : 0.25 + 0.6 * s.p;
      x.lineWidth = near ? 2 : 1.2;
      const [ax, ay] = this.screen(i);
      const [bx, by] = this.screen(j);
      x.beginPath();
      x.moveTo(ax, ay);
      x.lineTo(bx, by);
      x.stroke();
    }
    x.restore();
  }

  /** The Same person? group under a point: its badge, or its shape away from any node. */
  private groupAt(px: number, py: number): number | null {
    for (const b of this.badges) if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b.gi;
    for (const bl of this.blobs) {
      if (bl.pts.some((p) => (p.x - px) ** 2 + (p.y - py) ** 2 <= p.r * p.r)) return bl.gi;
      if (bl.hull.length >= 3 && insideConvex(bl.hull, px, py)) return bl.gi;
    }
    return null;
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
    // The places that matter most in view, as pills (more on a bigger screen, and any drawn big); then the people who
    // matter most in view, the first few in bold; and anyone drawn big enough to name.
    const room = Math.min(Math.max((this.w * this.h) / (1200 * 800), 0.35), 2.5);
    const topPlaces = Math.round(8 * room);
    let n = 0;
    for (const i of this.byDegree) {
      if (n >= (this.w < 600 ? 12 : 20)) break;
      const [x, y] = this.screen(i);
      if (!inView(x, y) || (edge(i) < 14 && (n >= topPlaces || edge(i) < 9))) continue;
      out.push(placeLabel(i, n < Math.round(3 * room)));
      n++;
    }
    const people: number[] = [];
    for (let i = 0; i < this.scene.n; i++) {
      if (this.scene.shape[i] || i === vis.me || edge(i) < 4) continue;
      const [x, y] = this.screen(i);
      if (inView(x, y)) people.push(i);
    }
    people.sort((a, b) => this.rank[a] - this.rank[b]);
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
      const onBadge = this.badges.some((b) => hoverAt!.x >= b.x && hoverAt!.x <= b.x + b.w && hoverAt!.y >= b.y && hoverAt!.y <= b.y + b.h);
      const g = onBadge ? null : this.pick(hoverAt.x, hoverAt.y);
      const gi = g === null ? this.groupAt(hoverAt.x, hoverAt.y) : null;
      if (g !== this.hovered || gi !== this.hoveredGroup) {
        this.hovered = g;
        this.hoveredGroup = gi;
        this.paint();
        this.dirty();
      }
      h.style.cursor = g !== null || gi !== null ? 'pointer' : 'grab';
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
        // A group's badge first; then a node; then a group's shape round its members; else nothing.
        const badge = this.badges.find((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
        const node = badge ? null : this.pick(p.x, p.y);
        const gi = badge ? badge.gi : node === null ? this.groupAt(p.x, p.y) : null;
        if (gi !== null) this.ev.group(gi);
        else this.ev.pick(node);
      }
      h.style.cursor = 'grab';
    };
    on('pointerup', up);
    on('pointercancel', up);
    on('pointerleave', () => {
      hoverAt = null;
      if (this.hovered !== null || this.hoveredGroup !== null) {
        this.hovered = null;
        this.hoveredGroup = null;
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
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.h : 1;
        const dy = e.deltaY * unit;
        // A touchpad pinch comes as the wheel with Ctrl held, deltaY = -100·ln(the fingers' scale) in Chrome and
        // about the same in Firefox: zoom by exactly that, so the graph stays under the fingers.
        if (e.ctrlKey) return this.zoom(Math.exp(-dy / 100), p.x, p.y);
        // Any other wheel zooms too, a mouse's notches and two fingers on a touchpad alike, about the pointer;
        // sideways scrolling does nothing. Dragging pans.
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
      else if (e.key === 'Escape' && this.pickedGroup !== null) this.ev.group(null);
      else return;
      e.preventDefault();
    });
  }
}

/** The convex hull of points, as screen points going the way canvas arcs do (clockwise on screen). */
function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const hi: [number, number][] = [];
  for (const q of [...p].reverse()) {
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

/** Twice the signed area of a polygon: positive when it goes the way canvas arcs do. */
const area2 = (poly: [number, number][]) => poly.reduce((a, p, i) => a + p[0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * p[1], 0);

function addPoly(path: Path2D, poly: [number, number][]) {
  const pts = area2(poly) < 0 ? [...poly].reverse() : poly;
  path.moveTo(pts[0][0], pts[0][1]);
  for (const q of pts.slice(1)) path.lineTo(q[0], q[1]);
  path.closePath();
}

/** Circles round each point, a band along each side of the hull, and the hull itself: one shape when filled nonzero. */
function blobPath(pts: { x: number; y: number; r: number }[], hull: [number, number][]): Path2D {
  const path = new Path2D();
  for (const p of pts) {
    path.moveTo(p.x + p.r, p.y);
    path.arc(p.x, p.y, p.r, 0, 2 * Math.PI);
  }
  const rOf = (q: [number, number]) => pts.find((p) => p.x === q[0] && p.y === q[1])?.r ?? BLOB_PAD;
  for (let k = 0; k < hull.length; k++) {
    const a = hull[k];
    const b = hull[(k + 1) % hull.length];
    if (hull.length === 2 && k === 1) break;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    const ra = rOf(a);
    const rb = rOf(b);
    addPoly(path, [
      [a[0] + nx * ra, a[1] + ny * ra],
      [b[0] + nx * rb, b[1] + ny * rb],
      [b[0] - nx * rb, b[1] - ny * rb],
      [a[0] - nx * ra, a[1] - ny * ra],
    ]);
  }
  if (hull.length >= 3) addPoly(path, hull);
  return path;
}

/** Whether a point is inside a convex polygon. */
function insideConvex(poly: [number, number][], x: number, y: number): boolean {
  let sign = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const c = Math.sign((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]));
    if (!c) continue;
    if (sign && c !== sign) return false;
    sign = c;
  }
  return true;
}
