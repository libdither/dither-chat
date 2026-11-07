/**
 * A source's identity, worked out off the hub's event loop: hashing gigabytes on it would stall every request.
 * In: { file } or { dir }. Out: { size, files, sha256 } or { error }. A folder's sha256 is that of its sorted
 * "path\tsize\tsha256" lines.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

declare const self: Worker;

export function hashFileSync(path: string): string {
  const h = new Bun.CryptoHasher('sha256');
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

self.onmessage = (e: MessageEvent<{ file?: string; dir?: string }>) => {
  try {
    if (e.data.file) {
      postMessage({ size: statSync(e.data.file).size, files: 1, sha256: hashFileSync(e.data.file) });
      return;
    }
    const dir = e.data.dir!;
    const paths = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name))
      .sort();
    let size = 0;
    const lines: string[] = [];
    for (const p of paths) {
      const s = statSync(p).size;
      size += s;
      lines.push(`${relative(dir, p)}\t${s}\t${hashFileSync(p)}`);
    }
    postMessage({ size, files: paths.length, sha256: new Bun.CryptoHasher('sha256').update(lines.join('\n')).digest('hex') });
  } catch (err: any) {
    postMessage({ error: String(err?.message ?? err) });
  }
};
