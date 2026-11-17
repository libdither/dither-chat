/** A picture's difference hash, apart from drawing it (pictures.ts), so it can be tested. */

/** The hash of a 9×8 RGBA image: brightness of each cell against the next one along. */
export function hashOf(d: ArrayLike<number>): string {
  const grey = (i: number) => 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  let out = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (grey(y * 9 + x) > grey(y * 9 + x + 1) ? 1 : 0);
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}
