/**
 * Picture hashes for Same person? (docs/same-person.md): the hub draws no pictures, so the page hashes the profile
 * pictures it is sent, a 64-bit difference hash each, and gives them back. Two copies of one picture, scaled or
 * recompressed by different networks, come out the same or a few bits apart.
 */
import type * as P from '@dither-chat/protocol';
import { api } from '../state.ts';
import { hashOf } from './hash.ts';

/** A picture's difference hash as 16 hex digits: each of 8×8 cells brighter than the one to its right. null: it would not load. */
async function dhash(src: string): Promise<string | null> {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const c = document.createElement('canvas');
  c.width = 9;
  c.height = 8;
  const x = c.getContext('2d', { willReadFrequently: true });
  if (!x) return null;
  x.drawImage(img, 0, 0, 9, 8);
  let d: Uint8ClampedArray;
  try {
    d = x.getImageData(0, 0, 9, 8).data;
  } catch {
    return null;
  }
  return hashOf(d);
}

/**
 * Hash what the hub asks for, a batch at a time, until it asks for nothing or `alive()` says stop. Calls `progress`
 * with how many are done. Four at a time, so the page stays quick.
 */
export async function hashPictures(alive: () => boolean, progress: (done: number) => void): Promise<number> {
  let done = 0;
  for (let round = 0; round < 100 && alive(); round++) {
    const { pictures } = await api<{ pictures: P.PictureToHash[] }>('/api/matches/pictures?limit=40');
    if (!pictures.length) break;
    const out: { identityId: string; url: string; hash: string | null }[] = [];
    for (let i = 0; i < pictures.length && alive(); i += 4) {
      const part = pictures.slice(i, i + 4);
      const hashes = await Promise.all(part.map((p) => dhash(p.src)));
      part.forEach((p, k) => out.push({ identityId: p.identityId, url: p.url, hash: hashes[k] }));
    }
    if (!out.length) break;
    await api('/api/matches/pictures', { body: { hashes: out } });
    done += out.length;
    progress(done);
  }
  return done;
}
