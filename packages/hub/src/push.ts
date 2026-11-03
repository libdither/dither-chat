/** Which devices get Web Push, and keeping that list honest. */
import type * as P from '@dither-chat/protocol';
import type { Store } from './store.ts';
import { extraRelays, fingerprint, isPushRelay, pushPayload, sendPush, type PushTarget, type VapidKeys } from './webpush.ts';

type Row = Record<string, any>;

/** A device that keeps failing this many times in a row is forgotten, even if its relay never says "gone". */
const MAX_FAILURES = 20;

function relayName(endpoint: string): string {
  const h = new URL(endpoint).hostname;
  if (h.includes('google')) return 'Google';
  if (h.includes('apple')) return 'Apple';
  if (h.includes('mozilla')) return 'Mozilla';
  if (h.includes('windows')) return 'Microsoft';
  return h;
}

export class PushService {
  private relays = extraRelays();
  /** Tests swap these for a local endpoint; real use never does. */
  allow: (endpoint: string) => boolean = (e) => isPushRelay(e, this.relays);
  transport: typeof fetch = fetch;

  constructor(private store: Store, private keys: VapidKeys, private subject: string) {}

  get publicKey() {
    return this.keys.publicKey;
  }

  subscribe(t: PushTarget, label?: string): string | null {
    if (!this.allow(t.endpoint)) return null;
    const id = fingerprint(t.endpoint);
    this.store.db
      .query(
        `INSERT INTO push_subscription (id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = COALESCE(NULLIF(excluded.label, ''), label), failures = 0, last_error = NULL`,
      )
      .run(id, t.endpoint, t.p256dh, t.auth, label?.trim().slice(0, 80) ?? '', Date.now());
    this.store.db.query(`UPDATE push_subscription SET label = 'A device' WHERE id = ? AND label = ''`).run(id);
    return id;
  }

  remove(ref: { id?: string; endpoint?: string }) {
    this.store.db.query('DELETE FROM push_subscription WHERE id = ? OR endpoint = ?').run(ref.id ?? '', ref.endpoint ?? '');
  }

  devices(): P.PushDeviceView[] {
    return (this.store.db.query('SELECT * FROM push_subscription ORDER BY created_at').all() as Row[]).map((r) => ({
      id: r.id,
      label: r.label,
      relay: relayName(r.endpoint),
      createdAt: r.created_at,
      lastOkAt: r.last_ok_at,
      lastError: r.last_error,
    }));
  }

  private async deliver(r: Row, payload: unknown): Promise<{ ok: boolean; error?: string }> {
    const db = this.store.db;
    try {
      const { outcome, status } = await sendPush({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, payload, this.keys, this.subject, { fetch: this.transport });
      if (outcome === 'ok') {
        db.query('UPDATE push_subscription SET last_ok_at = ?, last_error = NULL, failures = 0 WHERE id = ?').run(Date.now(), r.id);
        return { ok: true };
      }
      if (outcome === 'gone') {
        db.query('DELETE FROM push_subscription WHERE id = ?').run(r.id);
        return { ok: false, error: 'The browser dropped this subscription, so it was removed.' };
      }
      return this.failed(r, `The relay answered ${status}`);
    } catch (e: any) {
      return this.failed(r, String(e?.message ?? e));
    }
  }

  private failed(r: Row, error: string) {
    this.store.db.query('UPDATE push_subscription SET last_error = ?, failures = failures + 1 WHERE id = ?').run(error, r.id);
    this.store.db.query('DELETE FROM push_subscription WHERE id = ? AND failures >= ?').run(r.id, MAX_FAILURES);
    return { ok: false, error };
  }

  async notify(title: string, body: string, conversationId: string | undefined, extra: Record<string, unknown>) {
    const rows = this.store.db.query('SELECT * FROM push_subscription').all() as Row[];
    await Promise.all(rows.map((r) => this.deliver(r, pushPayload(title, body, conversationId, extra))));
  }

  async test(ref: { id?: string; endpoint?: string }) {
    const r = this.store.db.query('SELECT * FROM push_subscription WHERE id = ? OR endpoint = ?').get(ref.id ?? '', ref.endpoint ?? '') as Row | null;
    if (!r) return { ok: false, error: 'This device is not subscribed.' };
    return this.deliver(r, pushPayload('dither-chat test', `Push works on ${r.label}.`, undefined, { test: true }));
  }
}
