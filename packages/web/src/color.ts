/**
 * Just enough colour maths for themes: WCAG contrast, and the same OKLab mixing CSS's color-mix() does,
 * so a theme can pick its own readable colours and the tests can check them the way the browser draws them.
 */

export type RGB = [number, number, number];

export function hex(c: string): RGB {
  let h = c.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((x) => x + x).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const toHex = ([r, g, b]: RGB) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

const lin = (v: number) => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const gam = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function luminance(c: string | RGB): number {
  const [r, g, b] = typeof c === 'string' ? hex(c) : c;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio, 1 to 21. AA wants 4.5 for body text, 3 for large text and UI parts. */
export function contrast(a: string | RGB, b: string | RGB): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function toOklab([r, g, b]: RGB): RGB {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

/** color-mix(in oklab, a p%, b). */
export function mix(a: string, b: string, p: number): string {
  const [x, y] = [toOklab(hex(a)), toOklab(hex(b))];
  return toHex(fromOklab([0, 1, 2].map((i) => x[i] * p + y[i] * (1 - p)) as RGB));
}

/** oklch(L C h), as the avatars use it. */
export function oklch(L: number, C: number, h: number): string {
  const r = (h * Math.PI) / 180;
  return toHex(fromOklab([L, C * Math.cos(r), C * Math.sin(r)]));
}

/** Of a few candidates, the one that reads best on `bg`. */
export function readableOn(bg: string, candidates = ['#ffffff', '#111318']): string {
  return candidates.reduce((best, c) => (contrast(c, bg) > contrast(best, bg) ? c : best));
}
