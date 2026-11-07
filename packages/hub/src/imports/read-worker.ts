/**
 * Reads a source into facts off the hub's event loop (docs/import.md, stage 2). Writes NDJSON, one conversation
 * header then its messages, and puts every file the facts point at into the media store,
 * <data>/imports/media/<sha256[0:2]>/<sha256><ext>: hardlinked from the source when it can be (no extra space),
 * copied otherwise. The facts' file:// URLs point at the store, so deleting a source never breaks an attachment.
 *
 * In: { kind, rawDir, selfId, mediaDir, out }. Out: { progress }, then { done, stats } or { error }.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, openSync, closeSync, readSync, renameSync, writeSync } from 'node:fs';
import { extname, join } from 'node:path';
import { authorIndex, readFile } from './discord-html.ts';
import { readdirSync } from 'node:fs';

declare const self: Worker;

export interface ReadStats {
  conversations: number;
  messages: number;
  duplicates: number;
  /** Messages the importing account wrote: none means the export belongs to someone else. */
  selfMessages: number;
  files: { linked: number; missing: number };
}

function hashFile(path: string): string {
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

self.onmessage = (e: MessageEvent<{ kind: string; rawDir: string; selfId: string; mediaDir: string; out: string }>) => {
  const { kind, rawDir, selfId, mediaDir, out } = e.data;
  try {
    if (kind !== 'dce-html') throw new Error(`no reader for ${kind} yet`);
    const stats: ReadStats = { conversations: 0, messages: 0, duplicates: 0, selfMessages: 0, files: { linked: 0, missing: 0 } };
    const stored = new Map<string, string>();
    const mediaUrl = (p: string): string => {
      const have = stored.get(p);
      if (have) return have;
      let url = `file://${p}`;
      if (existsSync(p)) {
        const sha = hashFile(p);
        const ext = extname(p).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
        const dir = join(mediaDir, sha.slice(0, 2));
        const dest = join(dir, sha + ext);
        if (!existsSync(dest)) {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          try {
            linkSync(p, dest);
          } catch {
            copyFileSync(p, dest + '.tmp');
            renameSync(dest + '.tmp', dest);
          }
        }
        url = `file://${dest}`;
        stats.files.linked++;
      } else stats.files.missing++;
      stored.set(p, url);
      return url;
    };

    const files = readdirSync(rawDir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && /\[\d+\]\.html$/.test(d.name))
      .map((d) => join(d.parentPath, d.name).slice(rawDir.length + 1))
      .sort();
    const names = authorIndex(rawDir);
    const seen = new Set<string>();
    const tmp = out + '.tmp';
    const fd = openSync(tmp, 'w', 0o600);
    const line = (x: unknown) => writeSync(fd, JSON.stringify(x) + '\n');
    files.forEach((f, i) => {
      const b = readFile({ rawDir, selfId, mediaUrl }, f, names);
      const messages = b.messages.filter((m) => {
        if (seen.has(m.nativeId)) return (stats.duplicates++, false);
        seen.add(m.nativeId);
        return true;
      });
      stats.conversations++;
      stats.messages += messages.length;
      stats.selfMessages += messages.filter((m) => m.author === selfId).length;
      line({ t: 'conversation', file: b.file, guild: b.guild, conversation: b.conversation, identities: b.identities, messages: messages.length });
      for (const m of messages) line({ t: 'message', m });
      postMessage({ progress: (i + 1) / files.length });
    });
    closeSync(fd);
    renameSync(tmp, out);
    postMessage({ done: true, stats });
  } catch (err: any) {
    postMessage({ error: String(err?.message ?? err) });
  }
};
