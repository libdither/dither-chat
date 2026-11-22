/**
 * Status dots (docs/profile.md, "Status dots"): how each person is on their network right now (online, idle, do not
 * disturb, offline), as its own app shows it. Only the latest state is kept, always: in memory, and in `presence_now`
 * so a hub restart does not lose it (adapters tell a state once, when it changes, so a restarted hub would not hear it
 * again). Presence over time is another thing: the change log keeps it only with the adversarial `presence` switch
 * (Store.setPresence, docs/history.md).
 *
 * Presence is chatty on a big Discord server, so changes are coalesced: each identity is sent at most once a frame of
 * FRAME_MS, with only its newest state, and written after the frame's commit (`save`, outside the flush's transaction,
 * so a commit that fails cannot leave the table behind what was sent).
 *
 * What is not known is not shown. A state is hidden (sent as unknown) while no account that heard it is online
 * (offline, connecting, needing attention, error, disabled, or the hub cut off from dither-accounts), and shown again
 * once one is back: adapters tell only changes, so what one told is still its word then, and anything newer comes as a
 * change. A removed account's states go, and so does one not heard for longer than the network's own apps would trust
 * it (STALE_MS; offline ones after OFFLINE_STALE_MS).
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';

/** Changes are sent at most this often, each identity's newest only. */
export const FRAME_MS = 2_000;
/**
 * Online, idle or busy not heard again or changed for this long: unknown. Adapters tell changes, and a person is seldom
 * on for days with none; an account that stops telling is hidden by its status before this.
 */
export const STALE_MS = 3 * 24 * 3600_000;
/** Offline not heard again for this long: unknown. */
export const OFFLINE_STALE_MS = 7 * 24 * 3600_000;
const STATES = new Set<string>(['online', 'idle', 'dnd', 'offline']);
const DEVICES = new Set<string>(['desktop', 'mobile', 'web']);

interface Entry {
  view: P.PresenceNowView;
  /** The accounts that heard this state. One that heard another state since is not among them. */
  accounts: Set<string>;
  /** When it was last heard, changed or not. Saved with a change only, so a start may count it from a little earlier. */
  heard: number;
}

export class PresenceNow {
  private map = new Map<string, Entry>();
  /** Changed or shown or hidden since the last frame: sent then (a hidden or missing entry is sent as removed). */
  private pending = new Set<string>();
  /** Changed since the last write. */
  private unsaved = new Set<string>();
  private sentAt = 0;
  private expiredAt = 0;
  /** Accounts not online now: what only they heard is hidden. */
  private down: Set<string>;

  constructor(
    private db: Database,
    down: Iterable<string> = [],
    private now: () => number = Date.now,
  ) {
    this.down = new Set(down);
    // An identity that went (a mail identity dropped) takes its row with it.
    db.query('DELETE FROM presence_now WHERE identity_id NOT IN (SELECT id FROM identity)').run();
    const rows = db.query('SELECT identity_id, state, devices, at, heard, accounts FROM presence_now').all() as {
      identity_id: string;
      state: string;
      devices: string | null;
      at: number;
      heard: number;
      accounts: string | null;
    }[];
    for (const r of rows) {
      if (!STATES.has(r.state)) continue;
      const devices = r.devices ? (r.devices.split(',').filter((d) => DEVICES.has(d)) as P.PresenceNowView['devices']) : undefined;
      const view: P.PresenceNowView = { identityId: r.identity_id, state: r.state as P.PresenceNowView['state'], at: r.at, ...(devices?.length ? { devices } : {}) };
      this.map.set(r.identity_id, { view, accounts: new Set(r.accounts ? r.accounts.split(',') : []), heard: r.heard });
    }
    this.expire();
  }

  /** How they are as heard now, on this account. True when it is news (a change, or the first heard). */
  set(identityId: string, state: string, devices: readonly string[] | undefined, accountId: string, ts?: number): boolean {
    if (!STATES.has(state)) return false;
    const now = this.now();
    const on = state === 'offline' ? [] : [...new Set((devices ?? []).filter((d) => DEVICES.has(d)))].sort();
    const was = this.map.get(identityId);
    if (was && was.view.state === state && (was.view.devices ?? []).join() === on.join()) {
      was.heard = now;
      if (!was.accounts.has(accountId)) {
        const hidden = !this.shown(was);
        was.accounts.add(accountId);
        this.unsaved.add(identityId);
        if (hidden && this.shown(was)) this.pending.add(identityId);
      }
      return false;
    }
    // A network's own time, but never in the future, and never before what was heard last.
    const at = Math.max(Math.min(ts ?? now, now), was?.view.at ?? 0);
    const view: P.PresenceNowView = { identityId, state: state as P.PresenceNowView['state'], at, ...(on.length ? { devices: on as P.PresenceNowView['devices'] } : {}) };
    this.map.set(identityId, { view, accounts: new Set([accountId]), heard: now });
    this.touch(identityId);
    return true;
  }

  private shown(e: Entry): boolean {
    for (const a of e.accounts) if (!this.down.has(a)) return true;
    return false;
  }

  /** How they are, while an account that heard it is online. */
  get(identityId: string): P.PresenceNowView | null {
    const e = this.map.get(identityId);
    return e && this.shown(e) ? e.view : null;
  }

  list(): P.PresenceNowView[] {
    return [...this.map.values()].filter((e) => this.shown(e)).map((e) => e.view);
  }

  /** An account came online, or stopped being: what it heard shows again, or hides. */
  accountUp(accountId: string, up: boolean) {
    if (up !== this.down.has(accountId)) return;
    if (up) this.down.delete(accountId);
    else this.down.add(accountId);
    for (const [id, e] of this.map) if (e.accounts.has(accountId)) this.pending.add(id);
  }

  /** Forget what was heard on this account: it went. What another account heard too stays. */
  forgetAccount(accountId: string) {
    this.down.delete(accountId);
    for (const [id, e] of this.map) {
      if (!e.accounts.delete(accountId)) continue;
      if (!e.accounts.size) this.map.delete(id);
      this.touch(id);
    }
  }

  /** Never a dot: your own identity. */
  forget(identityId: string) {
    if (this.map.delete(identityId)) this.touch(identityId);
  }

  /** States heard too long ago to trust: unknown now. */
  expire() {
    const now = this.now();
    for (const [id, e] of this.map) {
      const limit = e.view.state === 'offline' ? OFFLINE_STALE_MS : STALE_MS;
      if (now - e.heard > limit) {
        this.map.delete(id);
        this.touch(id);
      }
    }
  }

  private touch(id: string) {
    this.pending.add(id);
    this.unsaved.add(id);
  }

  /** Whether a frame is due: something changed, and the last one went out FRAME_MS ago or more. Expires stale states once a minute. */
  due(): boolean {
    const now = this.now();
    if (now - this.expiredAt >= 60_000) {
      this.expiredAt = now;
      this.expire();
    }
    return this.pending.size > 0 && now - this.sentAt >= FRAME_MS;
  }

  /** The frame's event; null when none is due (`force`: send what is pending now). Writes nothing: `save` does. */
  take(force = false): P.ClientEvent | null {
    if (!this.pending.size || (!force && !this.due())) return null;
    this.sentAt = this.now();
    const items: P.PresenceNowView[] = [];
    const removed: string[] = [];
    for (const id of this.pending) {
      const v = this.get(id);
      if (v) items.push(v);
      else removed.push(id);
    }
    this.pending.clear();
    return { t: 'presence', items, removed };
  }

  /**
   * Write what changed, one transaction for the lot, after the frame's own commit. What a failed write left stays to
   * write next time.
   */
  save() {
    if (!this.unsaved.size) return;
    const ids = [...this.unsaved];
    const put = this.db.query(
      `INSERT INTO presence_now (identity_id, state, devices, at, heard, accounts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (identity_id) DO UPDATE SET state = excluded.state, devices = excluded.devices, at = excluded.at, heard = excluded.heard, accounts = excluded.accounts`,
    );
    const del = this.db.query('DELETE FROM presence_now WHERE identity_id = ?');
    this.db.transaction(() => {
      for (const id of ids) {
        const e = this.map.get(id);
        if (e) put.run(id, e.view.state, e.view.devices?.join(',') ?? null, e.view.at, e.heard, [...e.accounts].join(','));
        else del.run(id);
      }
    })();
    for (const id of ids) this.unsaved.delete(id);
  }
}
