/**
 * Adapter state that signal-cli does not keep for us, in <accountDir>/state.json:
 *
 *   dms       peers we have a 1:1 with (Signal has no conversation list)
 *   index     recent message ids -> conversation, text, quoted message, files:
 *             read syncs carry no conversation, quotes and edits want the
 *             original, deletions remove the downloaded files
 *   unread    incoming messages not yet acknowledged with a read receipt
 *   expiring  disappearing messages and when their timer started
 *   groups    last seen group details, to describe group updates
 *
 * Writes are debounced and atomic (tmp + rename).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { SigGroup } from './types.ts';

export interface Expiring {
  id: string;
  conversation: string;
  ts: number;
  ttl: number; // seconds
  started?: number; // ms epoch; unset until read
  files?: string[];
}

interface StateFile {
  v: 1;
  dms: string[];
  index: [id: string, entry: IndexEntry][];
  unread: Record<string, [author: string, ts: number][]>;
  expiring: Expiring[];
  groups: Record<string, SigGroup>;
}

interface IndexEntry {
  c: string; // conversation
  t: string; // plain text (truncated)
  r?: string; // quoted message id
  f?: string[]; // downloaded attachment files
}

const INDEX_MAX = 5000;
const TEXT_MAX = 280;
const UNREAD_MAX = 500;

export class AdapterState {
  dms = new Set<string>();
  /** insertion-ordered; oldest first */
  private index = new Map<string, IndexEntry>();
  unread = new Map<string, [string, number][]>();
  expiring: Expiring[] = [];
  groups = new Map<string, SigGroup>();
  private timer?: Timer;

  constructor(private path: string) {
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) return;
    try {
      const s = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StateFile>;
      for (const d of s.dms ?? []) this.dms.add(d);
      for (const [id, e] of s.index ?? []) if (e && typeof e === 'object') this.index.set(id, e);
      for (const [c, list] of Object.entries(s.unread ?? {})) this.unread.set(c, list);
      this.expiring = s.expiring ?? [];
      for (const [id, g] of Object.entries(s.groups ?? {})) this.groups.set(id, g);
    } catch (e) {
      console.error('[signal] state.json unreadable, starting fresh', e);
    }
  }

  clear() {
    this.dms.clear();
    this.index.clear();
    this.unread.clear();
    this.expiring = [];
    this.groups.clear();
    this.save();
  }

  remember(id: string, conversation: string, text: string, replyTo?: string, files?: string[]) {
    const prev = this.index.get(id);
    this.index.delete(id);
    const r = replyTo ?? prev?.r;
    const f = files?.length ? files : prev?.f;
    this.index.set(id, { c: conversation, t: text.length > TEXT_MAX ? text.slice(0, TEXT_MAX - 1) + '…' : text, ...(r ? { r } : {}), ...(f ? { f } : {}) });
    while (this.index.size > INDEX_MAX) this.index.delete(this.index.keys().next().value!);
    this.save();
  }

  /** Drop a deleted message; returns its downloaded files. */
  forget(id: string): string[] {
    const e = this.index.get(id);
    if (!e) return [];
    this.index.delete(id);
    this.save();
    return e.f ?? [];
  }

  conversationOf(id: string) {
    return this.index.get(id)?.c;
  }

  textOf(id: string) {
    return this.index.get(id)?.t;
  }

  replyOf(id: string) {
    return this.index.get(id)?.r;
  }

  addUnread(conversation: string, author: string, ts: number) {
    const list = this.unread.get(conversation) ?? [];
    if (!list.some(([a, t]) => a === author && t === ts)) list.push([author, ts]);
    if (list.length > UNREAD_MAX) list.splice(0, list.length - UNREAD_MAX);
    this.unread.set(conversation, list);
    this.save();
  }

  /** Remove and return unread entries up to `upToTs`. */
  takeUnread(conversation: string, upToTs: number): [string, number][] {
    const list = this.unread.get(conversation) ?? [];
    const taken = list.filter(([, t]) => t <= upToTs);
    const left = list.filter(([, t]) => t > upToTs);
    if (left.length) this.unread.set(conversation, left);
    else this.unread.delete(conversation);
    if (taken.length) this.save();
    return taken;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const data: StateFile = {
      v: 1,
      dms: [...this.dms],
      index: [...this.index],
      unread: Object.fromEntries(this.unread),
      expiring: this.expiring,
      groups: Object.fromEntries(this.groups),
    };
    try {
      const tmp = this.path + '.tmp';
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (e) {
      console.error('[signal] could not write state.json', e);
    }
  }
}
