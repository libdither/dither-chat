/**
 * Files on their way out: uploaded from a client, handed to an adapter by path, deleted once sent.
 * Kept briefly so a failed send can be retried, and never across a restart.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { attachmentKind, MAX_UPLOAD } from '@dither-chat/protocol';

const KEEP = 60 * 60_000;

/** A name for humans and for the network. Never part of a path here. */
export function cleanFileName(raw: string | null): string {
  let name = raw ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {}
  name = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..') return 'file';
  return name.length > 200 ? name.slice(name.length - 200) : name;
}

export class Uploads {
  private items = new Map<string, P.OutgoingAttachment & { at: number }>();

  constructor(private dir: string) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  put(bytes: Uint8Array, name: string, mime: string, now = Date.now()): P.UploadView {
    if (bytes.length > MAX_UPLOAD) throw new Error('file too large');
    this.sweep(now);
    const id = randomBytes(12).toString('hex');
    const path = join(this.dir, id);
    writeFileSync(path, bytes, { mode: 0o600 });
    const clean = /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream';
    this.items.set(id, { path, name, mime: clean, size: bytes.length, kind: attachmentKind(clean), at: now });
    return { id, name, mime: clean, size: bytes.length };
  }

  /** The files behind these ids, or null if any of them is gone. */
  get(ids: string[]): P.OutgoingAttachment[] | null {
    const out: P.OutgoingAttachment[] = [];
    for (const id of ids) {
      const it = this.items.get(id);
      if (!it) return null;
      const { at: _at, ...file } = it;
      out.push(file);
    }
    return out;
  }

  remove(ids: string[]) {
    for (const id of ids) {
      const it = this.items.get(id);
      if (!it) continue;
      rmSync(it.path, { force: true });
      this.items.delete(id);
    }
  }

  sweep(now = Date.now()) {
    for (const [id, it] of this.items) if (now - it.at > KEEP) this.remove([id]);
  }
}
