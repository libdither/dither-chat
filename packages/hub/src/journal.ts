/**
 * The change journal: every frame the hub broadcasts gets a position, and the journal remembers which objects
 * changed at which position, so a client that comes back after a while asks for what changed since its last
 * position instead of downloading everything again (docs/sync.md).
 *
 * Compacted: one row per object, at the position of its latest change. A client resuming from `since` gets every
 * object whose row is newer, read as it is now. Rows past an age or count are dropped; the oldest kept position is
 * the floor, and a client from before it starts over with /api/bootstrap.
 *
 * The epoch is the journal's identity. It changes when the journal cannot vouch for what happened, which voids
 * every position handed out before:
 *   - the hub stopped without closing it (a crash, a kill): changes made in the last moment may not be in it;
 *   - the demo world was reset;
 *   - the database is a fresh one.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { SYNC_VERSION } from '@dither-chat/protocol';

/** Positions older than this, or behind this many changed objects, start over. */
const KEEP_MS = 14 * 86_400_000;
const KEEP_ROWS = 250_000;

interface Change {
  kind: string;
  id: string;
  /** A message's conversation. */
  conv?: string | null;
  removed?: boolean;
}

export interface ChangeRow {
  kind: string;
  id: string;
  seq: number;
  conv: string | null;
  removed: number;
}

/** Lists the client holds whole. Their journal id is '*'. */
const LISTS: Partial<Record<P.ClientEvent['t'], string>> = { folders: 'folders', placePrefs: 'placePrefs', categories: 'categories', rules: 'rules', devices: 'devices', arrange: 'arrange', 'mail.access': 'mailAccess', requests: 'requests' };

/** What a broadcast changed, in journal terms. Typing, notifications and progress are of the moment and not kept. */
export function changesOf(events: P.ClientEvent[]): Change[] {
  const out: Change[] = [];
  for (const e of events) {
    switch (e.t) {
      case 'account':
        out.push({ kind: 'account', id: e.account.id });
        break;
      case 'identity':
        out.push({ kind: 'identity', id: e.identity.id });
        break;
      case 'person':
        out.push({ kind: 'person', id: e.person.id });
        break;
      case 'space':
        out.push({ kind: 'space', id: e.space.id });
        break;
      case 'conversation':
        out.push({ kind: 'conversation', id: e.conversation.id });
        break;
      case 'account.removed':
      case 'person.removed':
      case 'space.removed':
      case 'conversation.removed':
        out.push({ kind: e.t.slice(0, -'.removed'.length), id: e.id, removed: true });
        break;
      case 'message':
        out.push({ kind: 'message', id: e.message.id, conv: e.message.conversationId });
        break;
      case 'message.deleted':
        out.push({ kind: 'message', id: e.id, conv: e.conversationId });
        break;
      case 'attention':
        if (e.replace) out.push({ kind: 'attention', id: '*' });
        for (const a of e.items) out.push({ kind: 'attention', id: a.id });
        for (const id of e.removed) out.push({ kind: 'attention', id, removed: true });
        break;
      // Mail (docs/mail.md): accounts, each account's mailboxes, and threads. Progress and outbox are not kept here.
      case 'mail.account':
        out.push({ kind: 'mailAccount', id: e.account.id });
        break;
      case 'mail.account.removed':
        out.push({ kind: 'mailAccount', id: e.id, removed: true });
        break;
      case 'mail.mailboxes':
        out.push({ kind: 'mailboxes', id: e.accountId });
        break;
      case 'mail.threads':
        for (const t of e.threads) out.push({ kind: 'mailThread', id: t.id });
        for (const id of e.removed) out.push({ kind: 'mailThread', id, removed: true });
        break;
      // Lists the hub changed without sending their threads (mail/backfill.ts).
      case 'mail.lists':
        for (const k of e.stale) out.push({ kind: 'mailList', id: k });
        break;
      case 'presence':
        if (e.replace) out.push({ kind: 'presence', id: '*' });
        for (const v of e.items) out.push({ kind: 'presence', id: v.identityId });
        for (const id of e.removed) out.push({ kind: 'presence', id, removed: true });
        break;
      case 'usage':
        if (e.replace) out.push({ kind: 'usage', id: '*' });
        for (const u of e.places) out.push({ kind: 'usage', id: `${u.kind}:${u.id}` });
        for (const u of e.removed) out.push({ kind: 'usage', id: `${u.kind}:${u.id}`, removed: true });
        break;
      default: {
        const list = LISTS[e.t];
        if (list) out.push({ kind: list, id: '*' });
      }
    }
  }
  return out;
}

export class Journal {
  epoch!: string;
  /** The latest position handed out. Never goes back, not even across epochs. */
  seq: number;
  /** Positions before this are no longer covered. */
  floor: number;
  /** Why the epoch changed at startup, if it did. */
  readonly started: 'continued' | 'new' | 'unclean';

  constructor(private db: Database) {
    this.seq = Number(this.meta('sync_seq') ?? 0);
    this.floor = Number(this.meta('sync_floor') ?? 0);
    const epoch = this.meta('sync_epoch');
    this.started = !epoch ? 'new' : this.meta('sync_open') === '1' ? 'unclean' : 'continued';
    if (this.started === 'continued') this.epoch = epoch!;
    else this.restart();
    this.setMeta('sync_open', '1');
  }

  private meta(key: string): string | null {
    return (this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null)?.value ?? null;
  }
  private setMeta(key: string, value: string | number) {
    this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  position(): P.SyncPosition {
    return { v: SYNC_VERSION, epoch: this.epoch, seq: this.seq };
  }

  /** Every position handed out so far is void. */
  restart() {
    this.epoch = Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString('base64url');
    this.floor = this.seq;
    this.db.transaction(() => {
      this.db.query('DELETE FROM sync_change').run();
      this.setMeta('sync_epoch', this.epoch);
      this.setMeta('sync_floor', this.floor);
      this.setMeta('sync_seq', this.seq);
    })();
  }

  /**
   * Changes a write could not keep (a full disk, a file that would not open), by `kind:id`. They go in with the next
   * frame that is written, at its position; until then a client resuming from before them has not missed them, because
   * the position they would have had was never handed out.
   */
  private held = new Map<string, Change>();

  /**
   * One frame's changes at the next position. Returns it, or null when nothing here is kept, or when the write failed:
   * the changes are then held for the next frame, and the frame goes out with no position. Never throws for a failed
   * write, because the frame still has to reach the devices that are connected (server.ts flush).
   */
  record(changes: Change[], now = Date.now()): number | null {
    if (!changes.length) return null;
    const all = this.held.size ? [...this.held.values(), ...changes] : changes;
    const seq = this.seq + 1;
    const put = this.db.query(
      `INSERT INTO sync_change (kind, id, seq, conv, removed, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET seq = excluded.seq, conv = COALESCE(excluded.conv, conv), removed = excluded.removed, at = excluded.at`,
    );
    try {
      this.db.transaction(() => {
        for (const c of all) put.run(c.kind, c.id, seq, c.conv ?? null, c.removed ? 1 : 0, now);
        this.setMeta('sync_seq', seq);
      })();
    } catch (e) {
      // Only the newest change of an object matters (the journal is compacted), so what is held stays one per object.
      for (const c of changes) this.held.set(`${c.kind}:${c.id}`, c);
      if (now - this.heldLogged >= 60_000) {
        this.heldLogged = now;
        console.error(`journal: ${this.held.size} changes not written; held for the next frame`, e);
      }
      return null;
    }
    this.held.clear();
    this.seq = seq;
    return seq;
  }
  private heldLogged = -Infinity;

  /**
   * Where the journal stands, for a caller that records inside a transaction of its own: when that transaction is rolled
   * back, `undo` puts back what it believed written (the position and what was held), since the rows went with it.
   */
  mark(): { seq: number; held: Change[] } {
    return { seq: this.seq, held: [...this.held.values()] };
  }
  undo(m: { seq: number; held: Change[] }) {
    this.seq = m.seq;
    for (const c of m.held) if (!this.held.has(`${c.kind}:${c.id}`)) this.held.set(`${c.kind}:${c.id}`, c);
  }

  /** Why a client at this position cannot resume, or null when it can. */
  refuse(v: unknown, epoch: unknown, seq: unknown): string | null {
    if (v !== SYNC_VERSION) return 'another sync version';
    if (epoch !== this.epoch) return 'the journal started over';
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return 'no position';
    if (seq < this.floor) return 'older than the journal';
    if (seq > this.seq) return 'ahead of the journal';
    return null;
  }

  /** Objects changed after `seq`, messages and what left a conversation aside. */
  since(seq: number): ChangeRow[] {
    return this.db.query(`SELECT kind, id, seq, conv, removed FROM sync_change WHERE seq > ? AND kind NOT IN ('message', 'movedOut') ORDER BY seq`).all(seq) as ChangeRow[];
  }

  /**
   * A message moved out of `conv` (MessageFact.moved): a client's copy of it from before now holds one that is not there,
   * which a delta of what changed in it cannot say (sync.ts timeline answers such a copy with a fresh page).
   */
  movedOut(conv: string, now = Date.now()) {
    this.record([{ kind: 'movedOut', id: conv, conv }], now);
  }

  /** Drop what is too old or too much. Everything before the newest dropped row is then out of reach. */
  prune(now = Date.now(), keepMs = KEEP_MS, keepRows = KEEP_ROWS) {
    const byAge = (this.db.query('SELECT MAX(seq) AS s FROM sync_change WHERE at < ?').get(now - keepMs) as { s: number | null }).s;
    const n = (this.db.query('SELECT COUNT(*) AS n FROM sync_change').get() as { n: number }).n;
    const byCount = n > keepRows ? (this.db.query('SELECT seq AS s FROM sync_change ORDER BY seq LIMIT 1 OFFSET ?').get(n - keepRows - 1) as { s: number }).s : null;
    const cut = Math.max(byAge ?? 0, byCount ?? 0);
    if (cut <= 0 || cut < this.floor) return;
    this.db.transaction(() => {
      this.db.query('DELETE FROM sync_change WHERE seq <= ?').run(cut);
      this.floor = Math.max(this.floor, cut);
      this.setMeta('sync_floor', this.floor);
    })();
  }

  /** At a clean shutdown, after the last flush: the next start can trust what is here. */
  close() {
    // Held changes that still cannot be written: the journal cannot vouch for them, so it stays open and the next start
    // begins a new epoch.
    if (this.held.size) this.record([...this.held.values()]);
    if (this.held.size) return;
    this.setMeta('sync_open', '0');
  }
}
