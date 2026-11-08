/**
 * Per-device notification rules (docs/devices.md). Triage decides once for every device whether a message is worth
 * a notification; a device's own rules then keep some of those off that device only: Signal left to the Signal app
 * on the phone while the laptop shows everything. They never change the inbox's ranking or the digest.
 *
 * A device is a page install (its id lives in the page's localStorage, the same id the activity log uses). Its push
 * registrations are linked to it when the page says hello with its push endpoint. Until then a push registration
 * counts as a device of its own, under its push id, and rules set on it move over when it is linked.
 */
import type * as P from '@dither-chat/protocol';
import type { Store } from './store.ts';
import type { Triage } from './triage.ts';

type Row = Record<string, any>;

const LEVELS: P.DeviceLevel[] = ['hub', 'mentions', 'none'];
const SCOPES: P.DeviceScope[] = ['network', 'account', 'space', 'conversation'];
const MAX_DEVICES = 200;

export class Devices {
  /** Rule keys for what is not a chat conversation (mail/triage.ts `chain`: a mail thread, its account, Email). */
  otherChain: ((id: string) => string[] | null) | null = null;

  constructor(
    private store: Store,
    private triage: Triage,
  ) {
    const db = store.db;
    db.exec(`CREATE TABLE IF NOT EXISTS device (
      id           TEXT PRIMARY KEY,
      label        TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS device_rule (
      device TEXT NOT NULL,
      scope  TEXT NOT NULL CHECK (scope IN ('network', 'account', 'space', 'conversation')),
      target TEXT NOT NULL,
      level  TEXT NOT NULL CHECK (level IN ('hub', 'mentions', 'none')),
      PRIMARY KEY (device, scope, target)
    )`);
    const cols = (db.query('PRAGMA table_info(push_subscription)').all() as Row[]).map((c) => c.name);
    if (!cols.includes('device')) db.exec('ALTER TABLE push_subscription ADD COLUMN device TEXT');
  }

  static validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{4,64}$/.test(id);

  /**
   * A page says which device it is, and which push endpoint it holds, if any. Returns true when the list changed.
   * Rules set on the push registration before it was linked move to the device.
   */
  hello(id: string, label: string, endpoint: string | null, now = Date.now()): boolean {
    const db = this.store.db;
    const name = label.trim().slice(0, 80) || 'A device';
    const before = db.query('SELECT label FROM device WHERE id = ?').get(id) as Row | null;
    db.query(`INSERT INTO device (id, label, last_seen_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET label = excluded.label, last_seen_at = excluded.last_seen_at`).run(id, name, now);
    let changed = !before || before.label !== name;
    if (endpoint) {
      const sub = db.query('SELECT id, device FROM push_subscription WHERE endpoint = ?').get(endpoint) as Row | null;
      if (sub && sub.device !== id) {
        db.transaction(() => {
          db.query('UPDATE push_subscription SET device = ? WHERE id = ?').run(id, sub.id);
          // The rules it had on its own (or on the device it belonged to before) come along, unless this device already has one there.
          for (const from of [sub.id, sub.device].filter(Boolean)) {
            db.query('INSERT OR IGNORE INTO device_rule (device, scope, target, level) SELECT ?, scope, target, level FROM device_rule WHERE device = ?').run(id, from);
            if (from === sub.id) db.query('DELETE FROM device_rule WHERE device = ?').run(from);
          }
        })();
        changed = true;
      }
    }
    if (!before) this.prune();
    if (changed) this.touch();
    return changed;
  }

  setRule(device: string, scope: P.DeviceScope, target: string, level: P.DeviceLevel | null): string | null {
    if (!SCOPES.includes(scope)) return 'unknown scope';
    if (level !== null && !LEVELS.includes(level)) return 'unknown level';
    if (!this.known(device)) return 'unknown device';
    const db = this.store.db;
    if (level === null || level === 'hub') {
      // 'hub' is kept only where it overrides a wider rule on the same device; elsewhere it is the same as no rule.
      db.query('DELETE FROM device_rule WHERE device = ? AND scope = ? AND target = ?').run(device, scope, target);
      if (level === 'hub' && scope !== 'network') db.query('INSERT INTO device_rule (device, scope, target, level) VALUES (?, ?, ?, ?)').run(device, scope, target, level);
    } else {
      db.query(`INSERT INTO device_rule (device, scope, target, level) VALUES (?, ?, ?, ?) ON CONFLICT (device, scope, target) DO UPDATE SET level = excluded.level`).run(device, scope, target, level);
    }
    this.touch();
    return null;
  }

  /** Forget a device and its rules. Its push registrations stay, as devices of their own. */
  forget(device: string) {
    const db = this.store.db;
    db.query('DELETE FROM device_rule WHERE device = ?').run(device);
    db.query('DELETE FROM device WHERE id = ?').run(device);
    db.query('UPDATE push_subscription SET device = NULL WHERE device = ?').run(device);
    this.touch();
  }

  private known(id: string): boolean {
    return !!this.store.db.query('SELECT 1 FROM device WHERE id = ? UNION SELECT 1 FROM push_subscription WHERE id = ?').get(id, id);
  }

  /** Devices that have not been seen for long, with no push and no rules, are dropped past MAX_DEVICES. */
  private prune() {
    this.store.db
      .query(
        `DELETE FROM device WHERE id IN (SELECT id FROM device WHERE id NOT IN (SELECT device FROM push_subscription WHERE device IS NOT NULL)
           AND id NOT IN (SELECT device FROM device_rule) ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?)`,
      )
      .run(MAX_DEVICES);
  }

  /** The list changed: clients hold it whole. */
  touch() {
    this.store.dirty.extra.push({ t: 'devices', devices: this.list() });
  }

  list(): P.DeviceView[] {
    const db = this.store.db;
    const rules = new Map<string, P.DeviceRuleView[]>();
    for (const r of db.query('SELECT * FROM device_rule ORDER BY scope, target').all() as Row[]) {
      (rules.get(r.device) ?? rules.set(r.device, []).get(r.device)!).push({ scope: r.scope, target: r.target, level: r.level });
    }
    const subs = db.query('SELECT id, label, device, created_at FROM push_subscription ORDER BY created_at').all() as Row[];
    const out: P.DeviceView[] = (db.query('SELECT * FROM device ORDER BY last_seen_at DESC').all() as Row[]).map((d) => ({
      id: d.id,
      label: d.label,
      lastSeenAt: d.last_seen_at,
      pushIds: subs.filter((s) => s.device === d.id).map((s) => s.id),
      rules: rules.get(d.id) ?? [],
    }));
    const have = new Set(out.map((d) => d.id));
    for (const s of subs) {
      if (s.device && have.has(s.device)) continue;
      out.push({ id: s.id, label: s.label, lastSeenAt: null, pushIds: [s.id], rules: rules.get(s.id) ?? [] });
    }
    return out;
  }

  /** The device a push registration belongs to: its linked device, or itself. */
  keyOfPush(sub: { id: string; device?: string | null }): string {
    return sub.device || sub.id;
  }

  /**
   * The devices that should not show a notification about this conversation. `addressed`: it mentions you or
   * replies to you, which a device set to mentions still shows.
   */
  quietOn(conversationId: string | undefined, addressed: boolean): string[] {
    if (!conversationId) return [];
    const all = this.store.db.query('SELECT * FROM device_rule').all() as Row[];
    if (!all.length) return [];
    const byDevice = new Map<string, Map<string, P.DeviceLevel>>();
    for (const r of all) (byDevice.get(r.device) ?? byDevice.set(r.device, new Map()).get(r.device)!).set(`${r.scope}:${r.target}`, r.level);
    const chain = this.chain(conversationId);
    const out: string[] = [];
    for (const [device, rules] of byDevice) {
      const level = chain.map((k) => rules.get(k)).find((l) => l !== undefined) ?? 'hub';
      if (level === 'none' || (level === 'mentions' && !addressed)) out.push(device);
    }
    return out;
  }

  /** Rule keys for a conversation, most specific first: the triage's own order (triage.ts effectiveLevel). */
  chain(conversationId: string): string[] {
    const s = this.store;
    const c = s.one<Row>('SELECT id, network, shape, parent_id FROM conversation WHERE id = ?', conversationId);
    if (!c) return this.otherChain?.(conversationId) ?? [];
    const keys = [`conversation:${c.id}`];
    const parent = c.shape === 'thread' && c.parent_id ? c.parent_id : null;
    if (parent) keys.push(`conversation:${parent}`);
    for (const sp of this.triage.ancestors(parent ?? c.id)) keys.push(`space:${sp.id}`);
    for (const a of s.vantageAccounts('conversation', c.id)) keys.push(`account:${a}`);
    keys.push(`network:${c.network}`);
    return keys;
  }

  /** Does this message mention you or reply to you? */
  addressed(messageId: string | undefined): boolean {
    if (!messageId) return false;
    const s = this.store;
    const m = s.one<Row>('SELECT mentions_self, reply_to_id FROM message WHERE id = ?', messageId);
    if (!m) return false;
    if (m.mentions_self) return true;
    const to = m.reply_to_id ? s.one<Row>('SELECT author_id FROM message WHERE id = ?', m.reply_to_id) : null;
    return !!to && s.isSelf(to.author_id);
  }
}
