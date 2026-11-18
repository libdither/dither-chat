/**
 * How the Feed page is spaced (docs/feed.md "Looks"), kept on this device: roomy (large pictures, the composer open),
 * snug (the default: smaller pictures and faces, the composer one line until used) or dense (a list to skim: small
 * faces, pictures as a strip, the bar under a post faint until pointed at).
 */
import { signal } from '@preact/signals';

export type Density = 'roomy' | 'snug' | 'dense';
const DENSITIES: readonly Density[] = ['roomy', 'snug', 'dense'];
const KEY = 'dither.feed.density';

function readDensity(): Density {
  try {
    const v = localStorage.getItem(KEY);
    return (DENSITIES as readonly string[]).includes(v ?? '') ? (v as Density) : 'snug';
  } catch {
    return 'snug';
  }
}

export const density = signal<Density>(readDensity());

export function setDensity(d: Density) {
  density.value = d;
  try {
    localStorage.setItem(KEY, d);
  } catch {
    /* a private window: the choice lasts while the page is open */
  }
}
