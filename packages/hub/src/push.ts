/** Which devices get Web Push, which push servers the hub may send to, and keeping both honest. */
import type * as P from '@dither-chat/protocol';
import type { Store } from './store.ts';
import { DEFAULT_SERVERS, extraRelays, fingerprint, isBrowserRelay, pushPayload, resolvesPrivate, sendPush, serverOrigin, type PushTarget, type VapidKeys } from './webpush.ts';

type Row = Record<string, any>;

/**
 * A device that keeps failing this many times in a row, with nothing delivered for STALE_MS, is forgotten even if
 * its server never says "gone". Both, so a phone that is off for a weekend keeps its registration.
 */
const MAX_FAILURES = 20;
const STALE_MS = 7 * 86_400_000;
/** A refused registration waits this long for the owner to allow its server. */
const PENDING_MS = 60 * 60_000;
const MAX_PENDING = 20;

interface Approved {
  origin: string;
  addedAt: number;
  /** The owner confirmed it is on a private address (a tailnet ntfy, say). Without this, one is refused at send time. */
  private?: boolean;
}

/** Kept in meta as `push_servers`. `off` holds defaults the owner turned off. */
interface ServerState {
  approved: Approved[];
  off: string[];
}

type Source = 'browser' | 'default' | 'environment' | 'approved';

interface Pending {
  target: PushTarget;
  label: string;
  origin: string;
  at: number;
}

function relayName(endpoint: string): string {
  const h = new URL(endpoint).hostname;
  if (!isBrowserRelay(endpoint)) return h;
  if (h.includes('google')) return 'Google';
  if (h.includes('apple')) return 'Apple';
  if (h.includes('mozilla')) return 'Mozilla';
  if (h.includes('windows')) return 'Microsoft';
  return h;
}

const originOf = (endpoint: string) => {
  try {
    const u = new URL(endpoint);
    return u.username || u.password ? null : u.origin;
  } catch {
    return null;
  }
};

/**
 * ntfy refuses UnifiedPush messages for a topic no phone has listened on lately (507, code 50701). It happens right
 * after registering, before the ntfy app has connected, and whenever the app cannot run: never opened since install,
 * or stopped by battery optimisation.
 */
/** A phone, going by a registration's label ("Android app, Pixel", "Chrome on Android", "Safari on iOS"). */
const PHONE = /android|iphone|ipad|\bios\b/i;
/** The Android app's own registrations (Push.kt), which may take a push that shows nothing. */
const APP = /^Android app\b/;

const NO_SUBSCRIBER = /\b50701\b|without previously active subscriber/;

/** What a push server said, short enough for Settings. */
function explain(status: number, detail: string): string {
  if (status === 507 && NO_SUBSCRIBER.test(detail)) return 'ntfy has no phone listening on this topic yet. Open the ntfy app once and let it run in the background (App info → App battery usage → Unrestricted); ntfy only takes pushes while the phone is connected.';
  const why = status === 401 || status === 403 ? 'it refused the hub' : status === 413 ? 'the message was too large' : status === 429 ? 'too many pushes, it is rate limiting' : status >= 500 ? 'it had an error' : '';
  const said = detail.replace(/\s+/g, ' ').trim().slice(0, 160);
  return `The push server answered ${status}${why ? `: ${why}` : ''}${said ? ` (${said})` : ''}`;
}

export class PushService {
  private relays: string[];
  private pending = new Map<string, Pending>();
  /** Tests swap these for a local endpoint; real use never does. */
  allow: (endpoint: string) => boolean = (e) => this.source(e) !== null;
  transport: typeof fetch = fetch;
  lookup?: (host: string) => Promise<string[]>;
  /** The old plain-text ntfy topic (DITHER_NTFY_URL), still sent to when set. */
  topic: { url: string; token?: string; click?: string; lastOkAt: number | null; lastError: string | null } | null;

  constructor(private store: Store, private keys: VapidKeys, private subject: string, env = process.env) {
    const cols = (store.db.query('PRAGMA table_info(push_subscription)').all() as Row[]).map((c) => c.name);
    for (const c of ['last_error_at', 'last_test_at', 'last_arrived_at']) if (!cols.includes(c)) store.db.exec(`ALTER TABLE push_subscription ADD COLUMN ${c} INTEGER`);
    this.relays = extraRelays(env.DITHER_PUSH_RELAYS);
    this.topic = env.DITHER_NTFY_URL ? { url: env.DITHER_NTFY_URL, token: env.DITHER_NTFY_TOKEN, click: env.DITHER_PUBLIC_URL, lastOkAt: null, lastError: null } : null;
  }

  get publicKey() {
    return this.keys.publicKey;
  }

  // ---------------------------------------------------------------- servers

  private state(): ServerState {
    const r = this.store.db.query(`SELECT value FROM meta WHERE key = 'push_servers'`).get() as Row | null;
    const s = r ? (JSON.parse(r.value) as Partial<ServerState>) : {};
    return { approved: s.approved ?? [], off: s.off ?? [] };
  }

  private save(s: ServerState) {
    this.store.db.query(`INSERT INTO meta (key, value) VALUES ('push_servers', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(s));
  }

  /** Why the hub may send to this endpoint, or null if it may not. */
  source(endpoint: string): Source | null {
    if (isBrowserRelay(endpoint)) return 'browser';
    const origin = originOf(endpoint);
    if (!origin) return null;
    if (this.relays.includes(origin)) return 'environment';
    const s = this.state();
    if (s.approved.some((a) => a.origin === origin)) return 'approved';
    if (DEFAULT_SERVERS.includes(origin) && !s.off.includes(origin)) return 'default';
    return null;
  }

  servers(): P.PushServerView[] {
    const s = this.state();
    const count = new Map<string, number>();
    for (const r of this.store.db.query('SELECT endpoint FROM push_subscription').all() as Row[]) {
      const o = originOf(r.endpoint);
      if (o) count.set(o, (count.get(o) ?? 0) + 1);
    }
    const view = (origin: string, source: P.PushServerView['source'], extra: Partial<P.PushServerView> = {}): P.PushServerView => ({ origin, source, private: false, addedAt: null, off: false, devices: count.get(origin) ?? 0, ...extra });
    return [
      ...DEFAULT_SERVERS.map((o) => view(o, 'default', { off: s.off.includes(o) })),
      ...this.relays.filter((o) => !DEFAULT_SERVERS.includes(o)).map((o) => view(o, 'environment')),
      ...s.approved.filter((a) => !DEFAULT_SERVERS.includes(a.origin) && !this.relays.includes(a.origin)).map((a) => view(a.origin, 'approved', { private: !!a.private, addedAt: a.addedAt })),
    ];
  }

  /**
   * The owner allows a push server, from the app. `typed` says the address was typed out in Settings, which is the
   * only way to allow plain http. An address that is not on the public internet needs `allowPrivate`, so the first
   * answer for one is a question.
   */
  async approve(input: string, opts: { typed?: boolean; allowPrivate?: boolean } = {}): Promise<{ ok: true; origin: string; registered: number } | { ok: false; error: string; confirm?: 'private'; origin?: string; addresses?: string[] }> {
    const parsed = serverOrigin(input, opts.typed);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    const { origin } = parsed;
    const u = new URL(origin);
    if (u.protocol === 'http:' && !opts.typed) return { ok: false, origin, error: `${origin} is plain http. If it is on your own network, type it under Push servers to allow it.` };
    if (isBrowserRelay(`${origin}/`)) return { ok: true, origin, registered: this.finish(origin) };
    const where = await resolvesPrivate(u.hostname, this.lookup);
    if (where.private && !opts.allowPrivate) {
      const at = where.addresses.length ? `is at ${where.addresses.join(', ')}, a private address` : 'does not resolve from the hub';
      return { ok: false, confirm: 'private', origin, addresses: where.addresses, error: `${u.host} ${at}. Allow it only if it is your own push server.` };
    }
    const s = this.state();
    s.off = s.off.filter((o) => o !== origin);
    if (!DEFAULT_SERVERS.includes(origin) || where.private) {
      s.approved = s.approved.filter((a) => a.origin !== origin);
      s.approved.push({ origin, addedAt: Date.now(), ...(where.private ? { private: true } : {}) });
    }
    this.save(s);
    return { ok: true, origin, registered: this.finish(origin) };
  }

  /** Stops sending to a server, and forgets the devices on it. Servers from the environment stay. */
  revoke(input: string): { ok: boolean; removed: number; error?: string } {
    const origin = originOf(input);
    if (!origin) return { ok: false, removed: 0, error: 'not a push server address' };
    if (this.relays.includes(origin)) return { ok: false, removed: 0, error: `${origin} is listed in DITHER_PUSH_RELAYS on the hub; remove it there` };
    const s = this.state();
    s.approved = s.approved.filter((a) => a.origin !== origin);
    if (DEFAULT_SERVERS.includes(origin) && !s.off.includes(origin)) s.off.push(origin);
    this.save(s);
    this.dismiss(origin);
    let removed = 0;
    for (const r of this.store.db.query('SELECT id, endpoint FROM push_subscription').all() as Row[]) {
      if (originOf(r.endpoint) === origin) {
        this.store.db.query('DELETE FROM push_subscription WHERE id = ?').run(r.id);
        removed++;
      }
    }
    return { ok: true, removed };
  }

  // ---------------------------------------------------------------- registrations waiting for a server

  private prune() {
    const now = Date.now();
    for (const [k, p] of this.pending) if (now - p.at > PENDING_MS) this.pending.delete(k);
  }

  /** Registers what was waiting on this origin. */
  private finish(origin: string): number {
    let n = 0;
    for (const [k, p] of this.pending) {
      if (p.origin !== origin) continue;
      this.pending.delete(k);
      if (this.subscribe(p.target, p.label)) n++;
    }
    return n;
  }

  dismiss(origin: string) {
    for (const [k, p] of this.pending) if (p.origin === origin) this.pending.delete(k);
  }

  pendingList(): P.PushPendingView[] {
    this.prune();
    const by = new Map<string, P.PushPendingView>();
    for (const p of this.pending.values()) {
      const v = by.get(p.origin);
      if (v) v.labels.push(p.label), (v.at = Math.max(v.at, p.at));
      else by.set(p.origin, { origin: p.origin, labels: [p.label], at: p.at, http: p.origin.startsWith('http:') });
    }
    return [...by.values()];
  }

  pendingFor(endpoint: string): P.PushPendingView | null {
    const o = originOf(endpoint);
    return (o && this.pendingList().find((p) => p.origin === o)) || null;
  }

  // ---------------------------------------------------------------- devices

  subscribe(t: PushTarget, label?: string): string | null {
    const name = label?.trim().slice(0, 80) ?? '';
    if (!this.allow(t.endpoint)) {
      const origin = originOf(t.endpoint);
      if (origin && /^https?:$/.test(new URL(origin).protocol)) {
        this.prune();
        this.pending.delete(t.endpoint);
        this.pending.set(t.endpoint, { target: t, label: name || 'A device', origin, at: Date.now() });
        while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
      }
      return null;
    }
    this.pending.delete(t.endpoint);
    const id = fingerprint(t.endpoint);
    this.store.db
      .query(
        `INSERT INTO push_subscription (id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = COALESCE(NULLIF(excluded.label, ''), label), failures = 0, last_error = NULL, last_error_at = NULL`,
      )
      .run(id, t.endpoint, t.p256dh, t.auth, name, Date.now());
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
      server: isBrowserRelay(r.endpoint) ? null : originOf(r.endpoint),
      createdAt: r.created_at,
      lastOkAt: r.last_ok_at,
      lastError: r.last_error,
      lastErrorAt: r.last_error_at ?? null,
      lastTestAt: r.last_test_at ?? null,
      lastArrivedAt: r.last_arrived_at ?? null,
    }));
  }

  /** The device says a test push reached it. Only tests ask for this, so the hub learns nothing about reading. */
  arrived(id: string) {
    this.store.db.query('UPDATE push_subscription SET last_arrived_at = ? WHERE id = ?').run(Date.now(), id);
  }

  private async deliver(r: Row, payload: unknown): Promise<{ ok: boolean; error?: string; code?: string }> {
    const db = this.store.db;
    try {
      const refusal = await this.guard(r.endpoint);
      if (refusal) return this.failed(r, refusal);
      const { outcome, status, detail } = await sendPush({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, payload, this.keys, this.subject, { fetch: this.transport });
      if (outcome === 'ok') {
        db.query('UPDATE push_subscription SET last_ok_at = ?, last_error = NULL, last_error_at = NULL, failures = 0 WHERE id = ?').run(Date.now(), r.id);
        return { ok: true };
      }
      if (outcome === 'gone') {
        db.query('DELETE FROM push_subscription WHERE id = ?').run(r.id);
        return { ok: false, error: 'The push server says this device unsubscribed, so it was removed. Turn push on again on that device.' };
      }
      const failure = this.failed(r, explain(status, detail ?? ''));
      return status === 507 && NO_SUBSCRIBER.test(detail ?? '') ? { ...failure, code: 'no-subscriber' } : failure;
    } catch (e: any) {
      const host = originOf(r.endpoint) ?? 'the push server';
      return this.failed(r, e?.name === 'TimeoutError' ? `${host} did not answer in time` : `Could not reach ${host}: ${String(e?.message ?? e)}`);
    }
  }

  /**
   * Sending is where a name could point somewhere new. An allowed server that now resolves to a private address is
   * refused unless the owner allowed it as one; browser relays and DITHER_PUSH_RELAYS are trusted as they are.
   */
  private async guard(endpoint: string): Promise<string | null> {
    const src = this.source(endpoint);
    if (src !== 'approved' && src !== 'default') return null;
    const u = new URL(endpoint);
    if (this.state().approved.find((a) => a.origin === u.origin)?.private) return null;
    const where = await resolvesPrivate(u.hostname, this.lookup);
    return where.private ? `${u.host} now ${where.addresses.length ? `resolves to ${where.addresses.join(', ')}, a private address` : 'does not resolve'}. Allow it again in Settings → Notifications if that is expected.` : null;
  }

  private failed(r: Row, error: string) {
    this.store.db.query('UPDATE push_subscription SET last_error = ?, last_error_at = ?, failures = failures + 1 WHERE id = ?').run(error, Date.now(), r.id);
    this.store.db.query('DELETE FROM push_subscription WHERE id = ? AND failures >= ? AND COALESCE(last_ok_at, created_at) < ?').run(r.id, MAX_FAILURES, Date.now() - STALE_MS);
    return { ok: false, error };
  }

  /**
   * Each device's payload names the device, so what it reports back about the push (activity.ts) says where it happened.
   * `quiet`: devices whose own rules keep this off them (devices.ts), by device id or, unlinked, by push id.
   */
  async notify(title: string, body: string, conversationId: string | undefined, extra: Record<string, unknown>, quiet: string[] = [], level: 'push' | 'quiet' = 'push'): Promise<{ devices: number; accepted: number }> {
    const skip = new Set(quiet);
    const rows = (this.store.db.query('SELECT * FROM push_subscription').all() as Row[]).filter((r) => !skip.has(r.device || r.id));
    const [results] = await Promise.all([Promise.all(rows.map((r) => this.deliver(r, pushPayload(title, body, conversationId, { ...extra, device: r.id })))), this.toTopic(title, body, conversationId, level)]);
    return { devices: rows.length, accepted: results.filter((r) => r.ok).length };
  }

  /**
   * A conversation was read: its notification goes from the Android app (docs/notifications.md). Only there, since a
   * browser must show something for every push, and a push that shows nothing counts against the site.
   */
  async clear(conversationId: string): Promise<void> {
    const rows = (this.store.db.query('SELECT * FROM push_subscription').all() as Row[]).filter((r) => APP.test(r.label ?? ''));
    await Promise.all(rows.map((r) => this.deliver(r, { clear: conversationId, device: r.id })));
  }

  /** Registrations that are not phones (by the label the page gave): Active, a silent phone notification, skips them. */
  desktops(): string[] {
    return (this.store.db.query('SELECT id, device, label FROM push_subscription').all() as Row[]).filter((r) => !PHONE.test(r.label ?? '')).map((r) => r.device || r.id);
  }

  async test(ref: { id?: string; endpoint?: string }) {
    if (ref.id === 'ntfy-topic') return this.topic ? this.toTopic('dither-chat test', 'Push works through the ntfy topic.') : { ok: false, error: 'No ntfy topic is set on the hub.' };
    const r = this.store.db.query('SELECT * FROM push_subscription WHERE id = ? OR endpoint = ?').get(ref.id ?? '', ref.endpoint ?? '') as Row | null;
    if (!r) return { ok: false, error: 'This device is not registered with the hub. Turn push off and on again on it.' };
    this.store.db.query('UPDATE push_subscription SET last_test_at = ? WHERE id = ?').run(Date.now(), r.id);
    return this.deliver(r, pushPayload('dither-chat test', `Push works on ${r.label}.`, undefined, { test: true, device: r.id }));
  }

  /** The older route: plain ntfy messages to one topic, readable by that server. Off unless DITHER_NTFY_URL is set. */
  private async toTopic(title: string, body: string, conversationId?: string, level: 'push' | 'quiet' = 'push'): Promise<{ ok: boolean; error?: string }> {
    const t = this.topic;
    if (!t) return { ok: true };
    const headers: Record<string, string> = { Title: title, Tags: 'speech_balloon', ...(level === 'quiet' ? { Priority: 'low' } : {}) };
    if (t.token) headers.Authorization = `Bearer ${t.token}`;
    if (t.click) headers.Click = `${t.click}/#/inbox${conversationId ? `/c/${conversationId}` : ''}`;
    try {
      const res = await this.transport(t.url, { method: 'POST', body, headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(explain(res.status, await res.text().catch(() => '')));
      t.lastOkAt = Date.now();
      t.lastError = null;
      return { ok: true };
    } catch (e: any) {
      t.lastError = String(e?.message ?? e);
      return { ok: false, error: t.lastError };
    }
  }

  topicView(): P.PushTopicView | null {
    if (!this.topic) return null;
    return { server: originOf(this.topic.url) ?? this.topic.url, lastOkAt: this.topic.lastOkAt, lastError: this.topic.lastError };
  }
}
