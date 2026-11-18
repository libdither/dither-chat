/**
 * Pictures on the people graph (docs/people-graph.md): a node drawn big enough shows its picture (a person's, a
 * server's icon, a group's), a ring in the colour of each network it is on, and a badge with the network's glyph. They
 * go on the 2D canvas under the labels; the WebGL dots stay beneath for everything too small for them.
 *
 * A picture is fetched once, cut to its node's shape on a small canvas, and drawn from there: a frame draws hundreds
 * without clipping each one again. A few load at a time, the biggest on screen first.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { GLYPH } from '../brand.ts';
import { hueOf, initials } from '../format.ts';

/** 0 a circle (a person), 1 a rounded square (a server), 2 a diamond (a group): as render.ts Scene.shape. */
export type Shape = 0 | 1 | 2;

/** Side of the cut picture, in pixels: enough for a node drawn ~48 px wide on a 2× screen. */
const SIDE = 96;
const LOADING_AT_ONCE = 6;
const KEEP = 1500;

/** The outline of a shape of radius r about (x, y). */
function outline(x: CanvasRenderingContext2D | Path2D, shape: Shape, cx: number, cy: number, r: number) {
  if (shape === 0) {
    x.moveTo(cx + r, cy);
    x.arc(cx, cy, r, 0, 2 * Math.PI);
  } else if (shape === 1) {
    x.roundRect(cx - r, cy - r, 2 * r, 2 * r, r * 0.42);
  } else {
    // A diamond with softened corners.
    const k = r * 0.18;
    x.moveTo(cx, cy - r + k);
    x.quadraticCurveTo(cx, cy - r, cx + k, cy - r + k);
    x.lineTo(cx + r - k, cy - k);
    x.quadraticCurveTo(cx + r, cy, cx + r - k, cy + k);
    x.lineTo(cx + k, cy + r - k);
    x.quadraticCurveTo(cx, cy + r, cx - k, cy + r - k);
    x.lineTo(cx - r + k, cy + k);
    x.quadraticCurveTo(cx - r, cy, cx - r + k, cy - k);
    x.closePath();
  }
}

export class Pictures {
  /** url|shape → the cut picture, null when it would not load. */
  private cut = new Map<string, HTMLCanvasElement | null>();
  private loading = new Set<string>();
  private wanted: { url: string; shape: Shape }[] = [];
  private wantedKeys = new Set<string>();
  private glyphs = new Map<string, Path2D>();

  constructor(private onLoad: () => void) {}

  /** The picture cut to its shape, or undefined while it loads (asked for now) or null when there is none. */
  get(url: string, shape: Shape): HTMLCanvasElement | null | undefined {
    const key = `${shape}|${url}`;
    const c = this.cut.get(key);
    if (c !== undefined) {
      // Most recently drawn last, so the oldest go first when there are too many.
      this.cut.delete(key);
      this.cut.set(key, c);
      return c;
    }
    if (!this.loading.has(key) && !this.wantedKeys.has(key) && this.wanted.length < 400) {
      this.wanted.push({ url, shape });
      this.wantedKeys.add(key);
    }
    return undefined;
  }

  /** Start loading what this frame asked for, in the order it asked (biggest first). */
  pump() {
    while (this.loading.size < LOADING_AT_ONCE && this.wanted.length) {
      const { url, shape } = this.wanted.shift()!;
      const key = `${shape}|${url}`;
      if (this.cut.has(key) || this.loading.has(key)) continue;
      this.loading.add(key);
      const img = new Image();
      img.decoding = 'async';
      const done = (c: HTMLCanvasElement | null) => {
        this.loading.delete(key);
        this.cut.set(key, c);
        if (this.cut.size > KEEP) this.cut.delete(this.cut.keys().next().value!);
        this.pump();
        this.onLoad();
      };
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = SIDE;
        const x = c.getContext('2d');
        if (!x || !img.naturalWidth) return done(null);
        x.beginPath();
        outline(x, shape, SIDE / 2, SIDE / 2, SIDE / 2);
        x.clip();
        // Cover: the middle of a picture that is not square.
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        x.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, SIDE, SIDE);
        done(c);
      };
      img.onerror = () => done(null);
      img.src = url;
    }
    this.wanted.length = 0;
    this.wantedKeys.clear();
  }

  /** A network's glyph as a path in a 24-unit box. */
  glyph(n: P.Network): Path2D | null {
    const d = (GLYPH as Record<string, string | undefined>)[n];
    if (!d) return null;
    let p = this.glyphs.get(n);
    if (!p) this.glyphs.set(n, (p = new Path2D(d)));
    return p;
  }
}

export interface Disc {
  x: number;
  y: number;
  /** Radius on screen, CSS pixels. */
  r: number;
  shape: Shape;
  id: string;
  name: string;
  pic?: string;
  networks: P.Network[];
  /** Drawn full; otherwise softer (someone only seen in a place). */
  strong: boolean;
  /** Dimmed: something else is picked. */
  dim: boolean;
  /** A ring in this colour instead of the networks' (you). */
  accent?: string;
}

const netColor = (n: P.Network) => NETWORK_META[n]?.color ?? '#888';

/** Draw each disc: its picture (or a tint and initials), its networks' ring, and a badge once it is big enough. */
export function drawDiscs(x: CanvasRenderingContext2D, discs: Disc[], pics: Pictures, ring: string) {
  // Ask for the biggest first: they load first.
  for (let i = discs.length - 1; i >= 0; i--) if (discs[i].pic) pics.get(discs[i].pic!, discs[i].shape);
  for (const d of discs) {
    const { r, shape } = d;
    x.globalAlpha = d.dim ? 0.18 : d.strong ? 1 : 0.72;
    const img = d.pic ? pics.get(d.pic, shape) : null;
    // The ring: each network a share of it, so someone on two networks wears both colours.
    const rw = Math.min(Math.max(1.5, r * 0.14), 3.5);
    const nets = d.networks.length ? d.networks : [];
    x.lineWidth = rw;
    if (d.accent) {
      x.lineWidth = rw + 1;
      x.beginPath();
      outline(x, shape, d.x, d.y, r + rw / 2 + 0.5);
      x.strokeStyle = d.accent;
      x.stroke();
    } else if (shape === 0 && nets.length > 1) {
      const step = (2 * Math.PI) / nets.length;
      nets.forEach((n, i) => {
        x.beginPath();
        x.arc(d.x, d.y, r + rw / 2, -Math.PI / 2 + i * step + 0.12, -Math.PI / 2 + (i + 1) * step - 0.12);
        x.strokeStyle = netColor(n);
        x.stroke();
      });
    } else if (nets.length) {
      x.beginPath();
      outline(x, shape, d.x, d.y, r + rw / 2);
      x.strokeStyle = netColor(nets[0]);
      x.stroke();
    }
    // The picture, or its stand-in.
    if (img) x.drawImage(img, d.x - r, d.y - r, 2 * r, 2 * r);
    else {
      x.beginPath();
      outline(x, shape, d.x, d.y, r);
      x.fillStyle = shape === 0 ? hueOf(d.id) : netColor(nets[0] ?? 'discord');
      x.fill();
      if (r >= 11) {
        x.fillStyle = '#fff';
        x.font = `600 ${Math.round(r * (shape === 0 ? 0.78 : 0.7))}px system-ui, sans-serif`;
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        x.fillText(initials(d.name).slice(0, shape === 0 ? 2 : 3), d.x, d.y + 0.5);
        x.textAlign = 'start';
      }
    }
    // The network's badge, bottom right, once there is room for it.
    if (r >= (shape === 0 ? 11 : 19) && nets[0]) {
      const br = Math.min(Math.max(6, r * 0.34), 11);
      const off = shape === 0 ? r * 0.72 : r * 0.82;
      nets.slice(0, 3).forEach((n, i) => {
        const bx = d.x + off - i * br * 1.55;
        const by = d.y + off;
        x.beginPath();
        x.arc(bx, by, br + 1.5, 0, 2 * Math.PI);
        x.fillStyle = ring;
        x.fill();
        x.beginPath();
        x.arc(bx, by, br, 0, 2 * Math.PI);
        x.fillStyle = netColor(n);
        x.fill();
        const g = pics.glyph(n);
        if (g) {
          const s = (br * 1.25) / 24;
          x.save();
          x.translate(bx - 12 * s, by - 12 * s);
          x.scale(s, s);
          x.fillStyle = '#fff';
          x.fill(g);
          x.restore();
        }
      });
    }
  }
  x.globalAlpha = 1;
}
