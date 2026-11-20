/**
 * Approvals (docs/approvals.md): a service asks you something, you answer on a paired device (signed) or on the page,
 * and the asker gets the answer back. This hub queues and shows them; it is not trusted for the decision: a signed
 * answer is checked here, and again by any asker that acts on it, against the device's own key.
 *
 *  - Askers: tokens in <data>/askers.json (0600, only their SHA-256), each limited to some kinds and its own requests.
 *  - Kept in <data>/approvals.sqlite, apart from the chat database (no migration of the big one for this).
 *  - The devices: dither-accounts' approver devices through the `approvals` interface on its built-in account
 *    `approver` (ApprovalLink, remote.ts); answers come back as `approvals.answer` events.
 *  - Each request is also a notice (account `approvals`, notices/index.ts `local`), so it notifies phones and browsers;
 *    an answer, a cancel or an expiry reads it.
 */
import { Database } from 'bun:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import {
  type Ask,
  askText,
  checkSigned,
  cleanTitle,
  displayHash,
  fingerprint,
  type Kind,
  KINDS,
  keysLine,
  MAX_BODY,
  MAX_MESSAGE,
  messageHash,
  NAME_RE,
  newId,
  parsePayload,
  readMerge,
  readPolicy,
  sha256hex,
  statementText,
} from '@dither-chat/approvals';

type Urgency = 'high' | 'normal' | 'low';
type Needs = 'signed' | 'any';
interface ActionDef {
  id: string;
  label: string;
  needs: Needs;
}
type ApprovalState = 'waiting' | 'answered' | 'expired' | 'cancelled' | 'sent';

/** What a device is shown (the manager's `approvals.ask` display). */
export interface Display {
  kind: Kind;
  asker: string;
  title: string;
  body: string;
  payload: string;
  urgency: Urgency;
  actions: ActionDef[];
}

export interface ApprovalDevice {
  id: string;
  name: string;
  kind: string;
  approvalKey: string | null;
  fingerprint?: string | null;
  online: boolean;
}

export type DeviceAnswer =
  | { id: string; ok: true; action: string; message: string | null; signed: number; signature?: string; statement?: string; device: string; deviceName?: string; deviceKind?: string }
  | { id: string; ok: false; reason: string; message?: string; device?: string; deviceName?: string };

/** The manager's side (remote.ts), or a test's. */
export interface ApprovalLink {
  devices(): Promise<ApprovalDevice[]>;
  ask(i: { ask: string; display: Display; expiresAt: number }): Promise<{ devices: number }>;
  cancel(id: string, reason?: string): Promise<void>;
  intent(id: string, action: string, message: string | null): Promise<{ sent: number }>;
  answers(ids: string[]): Promise<{ answers: DeviceAnswer[] }>;
}

/** What notices are told (notices/index.ts), so a request notifies like any notice. */
interface ApprovalNotices {
  raise(n: { id: string; title: string; body: string; asker: string; kind: string; urgency: Urgency; at: number }): void;
  read(id: string): void;
}

interface ApprovalView {
  id: string;
  kind: Kind;
  asker: string;
  title: string;
  body: string;
  payload: string;
  actions: ActionDef[];
  urgency: Urgency;
  topic: string | null;
  created: number;
  expires: number;
  state: ApprovalState;
  /** The answer, once there is one. */
  action: string | null;
  message: string | null;
  signed: boolean;
  device: { id: string; name: string; kind: string } | null;
  via: 'device' | 'page' | null;
  statement: string | null;
  signature: string | null;
  answeredAt: number | null;
  cancelReason: string | null;
  /** The page asked the laptop signer to sign this action; it waits for your finger. */
  signing: string | null;
  /** The asker's part of the statement: what a device signs, before its answer. */
  ask: string;
}

/** Who is asking: an asker's token, or you (your session, or the service token). */
type Caller = { asker: string; kinds: Kind[] } | { admin: true; page: boolean };

interface AskerEntry {
  name: string;
  hash: string;
  kinds: Kind[];
  createdAt: number;
}

const ASKERS_FILE = 'askers.json';
const DEFAULT_KINDS: Kind[] = KINDS.filter((k) => k !== 'policy');
/** Waiting requests one asker may have at once. */
const MAX_WAITING = 50;
const MAX_WAIT_S = 60;
const DAY = 86_400_000;
/** Answered, expired and cancelled requests are kept this long. */
const KEEP_MS = 30 * DAY;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS request (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, asker TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, payload TEXT NOT NULL,
  actions TEXT NOT NULL, urgency TEXT NOT NULL, topic TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, ask TEXT NOT NULL,
  state TEXT NOT NULL, action TEXT, message TEXT, signed INTEGER NOT NULL DEFAULT 0, device TEXT, device_name TEXT, device_kind TEXT,
  via TEXT, statement TEXT, signature TEXT, answered_at INTEGER, cancel_reason TEXT, signing TEXT
);
CREATE INDEX IF NOT EXISTS request_state ON request (state, expires);
CREATE INDEX IF NOT EXISTS request_topic ON request (topic, created);
`;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** The askers' file: add, list, remove (the CLI), and checking a token (the hub, read again when the file changes). */
export class Askers {
  private file: string;
  private cache: { mtime: number; list: AskerEntry[] } | null = null;
  constructor(dataDir: string) {
    this.file = join(dataDir, ASKERS_FILE);
  }
  list(): AskerEntry[] {
    const mtime = existsSync(this.file) ? statSync(this.file).mtimeMs : 0;
    if (this.cache?.mtime === mtime) return this.cache.list;
    const raw = mtime ? readSecretFile<{ askers?: AskerEntry[] }>(this.file, (m) => console.error(`[approvals] ${m}`)) : {};
    const list = Array.isArray(raw.askers) ? raw.askers.filter((a) => a && NAME_RE.test(a.name) && /^[0-9a-f]{64}$/.test(a.hash)) : [];
    this.cache = { mtime, list };
    return list;
  }
  /** A new token for `name` (replacing its old one); only its hash is kept. */
  add(name: string, kinds: Kind[] = DEFAULT_KINDS): string {
    if (!NAME_RE.test(name)) throw new Error('an asker name is a-z, 0-9 and -, at most 32');
    const token = `dask_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')}`;
    const list = this.list().filter((a) => a.name !== name);
    list.push({ name, hash: hashToken(token), kinds, createdAt: Date.now() });
    writeSecretFile(this.file, { askers: list });
    this.cache = null;
    return token;
  }
  remove(name: string): boolean {
    const list = this.list();
    const rest = list.filter((a) => a.name !== name);
    if (rest.length === list.length) return false;
    writeSecretFile(this.file, { askers: rest });
    this.cache = null;
    return true;
  }
  /** The asker a bearer token is, or null. Every entry is compared, each in constant time. */
  of(token: string | null | undefined): { asker: string; kinds: Kind[] } | null {
    if (!token || !token.startsWith('dask_') || token.length > 100) return null;
    const h = Buffer.from(hashToken(token), 'hex');
    let hit: AskerEntry | null = null;
    for (const a of this.list()) if (timingSafeEqual(Buffer.from(a.hash, 'hex'), h)) hit = a;
    return hit ? { asker: hit.name, kinds: hit.kinds.filter((k) => KINDS.includes(k)) } : null;
  }
}

type Row = Record<string, any>;
const json = <T>(s: string | null, fb: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fb;
  } catch {
    return fb;
  }
};

class ApprovalError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

interface Opts {
  dataDir: string;
  /** null: no manager (a hub without dither-accounts): the page can still deny and answer `any` actions. */
  link?: ApprovalLink | null;
  notices?: ApprovalNotices | null;
  now?: () => number;
  /** Tests: the expiry sweep's period. */
  sweepMs?: number;
}

export class Approvals {
  readonly db: Database;
  readonly askers: Askers;
  link: ApprovalLink | null;
  notices: ApprovalNotices | null;
  private now: () => number;
  private waiters = new Map<string, Set<() => void>>();
  private sweeper: Timer;
  private deviceCache: { at: number; list: ApprovalDevice[] } | null = null;

  constructor(o: Opts) {
    this.db = new Database(join(o.dataDir, 'approvals.sqlite'), { create: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.askers = new Askers(o.dataDir);
    this.link = o.link ?? null;
    this.notices = o.notices ?? null;
    this.now = o.now ?? Date.now;
    this.sweeper = setInterval(() => this.sweep(), o.sweepMs ?? 15_000);
  }

  stop() {
    clearInterval(this.sweeper);
    for (const w of this.waiters.values()) for (const f of w) f();
    this.db.close();
  }

  private row(id: string): Row | null {
    return (this.db.query('SELECT * FROM request WHERE id = ?').get(id) as Row | null) ?? null;
  }

  view(r: Row): ApprovalView {
    return {
      id: r.id,
      kind: r.kind,
      asker: r.asker,
      title: r.title,
      body: r.body,
      payload: r.payload,
      actions: json<ActionDef[]>(r.actions, []),
      urgency: r.urgency,
      topic: r.topic ?? null,
      created: r.created,
      expires: r.expires,
      state: r.state,
      action: r.action ?? null,
      message: r.message ?? null,
      signed: !!r.signed,
      device: r.device ? { id: r.device, name: r.device_name ?? r.device, kind: r.device_kind ?? 'phone' } : null,
      via: r.via ?? null,
      statement: r.statement ?? null,
      signature: r.signature ?? null,
      answeredAt: r.answered_at ?? null,
      cancelReason: r.cancel_reason ?? null,
      signing: r.signing ?? null,
      ask: r.ask,
    };
  }

  get(id: string): ApprovalView | null {
    this.sweep();
    const r = this.row(id);
    return r ? this.view(r) : null;
  }

  list(o: { state?: string; asker?: string; topic?: string; limit?: number } = {}): ApprovalView[] {
    this.sweep();
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.state) where.push('state = ?'), args.push(o.state);
    if (o.asker) where.push('asker = ?'), args.push(o.asker);
    if (o.topic) where.push('topic = ?'), args.push(o.topic);
    const sql = `SELECT * FROM request ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created DESC LIMIT ?`;
    return (this.db.query(sql).all(...args, Math.min(o.limit ?? 100, 500)) as Row[]).map((r) => this.view(r));
  }

  // ---------------------------------------------------------------- asking

  /** A new request (POST /api/approvals), checked, kept, shown and sent to the devices. */
  create(caller: Caller, b: Record<string, unknown>): ApprovalView {
    const kind = b.kind as Kind;
    if (!KINDS.includes(kind)) throw new ApprovalError(`kind is one of ${KINDS.join(', ')}`);
    let asker: string;
    if ('asker' in caller) {
      if (!caller.kinds.includes(kind)) throw new ApprovalError(`this token may not ask a ${kind}`, 403);
      asker = caller.asker;
    } else asker = typeof b.asker === 'string' && NAME_RE.test(b.asker) ? b.asker : 'you';
    const title = cleanTitle(typeof b.title === 'string' ? b.title : '');
    if (!title) throw new ApprovalError('a title, one line');
    const body = typeof b.body === 'string' ? b.body.replace(/\r\n/g, '\n') : '';
    if (Buffer.byteLength(body) > MAX_BODY) throw new ApprovalError('the body is at most 32 KiB');
    const payload = typeof b.payload === 'string' ? b.payload : '';
    if (payload) {
      const p = parsePayload(payload);
      if (typeof p === 'string') throw new ApprovalError(p);
      if (kind === 'merge' && typeof readMerge(p) === 'string') throw new ApprovalError(readMerge(p) as string);
      if (kind === 'policy' && typeof readPolicy(p) === 'string') throw new ApprovalError(readPolicy(p) as string);
    } else if (kind === 'merge' || kind === 'policy') throw new ApprovalError(`a ${kind} needs its payload`);
    const actions = kind === 'alert' ? [] : actionsOf(b.actions);
    const urgency: Urgency = b.urgency === 'high' || b.urgency === 'normal' || b.urgency === 'low' ? b.urgency : kind === 'alert' ? 'normal' : 'high';
    const expiresIn = typeof b.expiresIn === 'number' && Number.isFinite(b.expiresIn) ? Math.min(Math.max(b.expiresIn, 60), 7 * 86_400) : 3600;
    const topic = typeof b.topic === 'string' && b.topic.trim() ? b.topic.trim().slice(0, 200) : null;
    const waiting = (this.db.query(`SELECT COUNT(*) AS n FROM request WHERE asker = ? AND state = 'waiting'`).get(asker) as Row).n as number;
    if (kind !== 'alert' && waiting >= MAX_WAITING) throw new ApprovalError(`${asker} has ${MAX_WAITING} requests waiting already`, 429);
    const now = this.now();
    const ask: Ask = { id: newId(), kind, asker, created: now, expires: now + expiresIn * 1000, payloadSha256: sha256hex(payload), displaySha256: displayHash(title, body) };
    const state: ApprovalState = kind === 'alert' ? 'sent' : 'waiting';
    this.db
      .query(`INSERT INTO request (id, kind, asker, title, body, payload, actions, urgency, topic, created, expires, ask, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ask.id, kind, asker, title, body, payload, JSON.stringify(actions), urgency, topic, ask.created, ask.expires, askText(ask), state);
    this.notices?.raise({ id: ask.id, title, body, asker, kind, urgency, at: now });
    if (state === 'waiting') this.send(ask.id);
    return this.get(ask.id)!;
  }

  /** To the devices, through the manager (again after the manager came back). */
  private send(id: string) {
    const r = this.row(id);
    if (!r || r.state !== 'waiting' || !this.link) return;
    const display: Display = { kind: r.kind, asker: r.asker, title: r.title, body: r.body, payload: r.payload, urgency: r.urgency, actions: json(r.actions, []) };
    this.link.ask({ ask: r.ask, display, expiresAt: r.expires }).catch((e) => console.warn(`[approvals] sending ${id} to the devices failed: ${(e as Error)?.message ?? e}`));
  }

  /** The manager is reachable again: send what waits, and ask for answers that came meanwhile. */
  async connected() {
    if (!this.link) return;
    this.deviceCache = null;
    const ids = (this.db.query(`SELECT id FROM request WHERE state = 'waiting'`).all() as Row[]).map((r) => r.id as string);
    if (!ids.length) return;
    try {
      const { answers } = await this.link.answers(ids);
      for (const a of answers) await this.answered(a);
    } catch (e) {
      console.warn(`[approvals] catching up answers failed: ${(e as Error)?.message ?? e}`);
    }
    for (const id of ids) this.send(id);
  }

  cancel(caller: Caller, id: string, reason: string | null): ApprovalView {
    const r = this.mine(caller, id);
    if (r.state === 'waiting') this.close(id, { state: 'cancelled', cancel_reason: reason?.slice(0, 200) ?? null }, 'cancelled');
    return this.get(id)!;
  }

  private mine(caller: Caller, id: string): Row {
    const r = this.row(id);
    if (!r || ('asker' in caller && r.asker !== caller.asker)) throw new ApprovalError('no such request', 404);
    return r;
  }

  /** Ends a waiting request: kept, its notice read, the devices told, its waiters woken. */
  private close(id: string, set: Record<string, string | number | null>, tell: string | null) {
    const cols = Object.keys(set);
    const res = this.db.query(`UPDATE request SET ${cols.map((c) => `${c} = ?`).join(', ')}, signing = NULL WHERE id = ? AND state = 'waiting'`).run(...cols.map((c) => set[c]!), id);
    if (!res.changes) return false;
    this.notices?.read(id);
    if (tell && this.link) this.link.cancel(id, tell).catch(() => {});
    this.wake(id);
    return true;
  }

  private sweep() {
    const now = this.now();
    for (const r of this.db.query(`SELECT id FROM request WHERE state = 'waiting' AND expires <= ?`).all(now) as Row[]) this.close(r.id, { state: 'expired' }, null);
    this.db.query('DELETE FROM request WHERE created < ? AND state != ?').run(now - KEEP_MS, 'waiting');
  }

  // ---------------------------------------------------------------- answers

  /** The devices' approval keys, fresh within a minute (the fingerprint is computed here, not taken from the manager). */
  async devices(fresh = false): Promise<ApprovalDevice[]> {
    if (!this.link) return [];
    if (!fresh && this.deviceCache && this.now() - this.deviceCache.at < 60_000) return this.deviceCache.list;
    const list = (await this.link.devices()).map((d) => ({ ...d, fingerprint: d.approvalKey ? fingerprint(d.approvalKey) : null }));
    this.deviceCache = { at: this.now(), list };
    return list;
  }

  async keysFile(): Promise<string> {
    const list = await this.devices(true);
    const lines = list.filter((d) => d.approvalKey).map((d) => keysLine({ id: d.id, kind: d.kind, key: d.approvalKey!, fingerprint: fingerprint(d.approvalKey!), name: d.name.replace(/\s+/g, ' ') }));
    return `# device-id  kind  approval-key (SPKI, base64)  fingerprint  name\n# Compare each fingerprint with the one the device shows before trusting a line.\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
  }

  /** A device's answer (the manager's approvals.answer event): checked, then the request's, if it still waits. */
  async answered(a: DeviceAnswer): Promise<boolean> {
    const r = this.row(a.id);
    if (!r || r.state !== 'waiting') return false;
    if (!a.ok) {
      console.log(`[approvals] ${a.id}: ${a.deviceName ?? a.device ?? 'a device'} answered ${a.reason}`);
      if (r.signing && a.device) this.db.query('UPDATE request SET signing = NULL WHERE id = ?').run(a.id), this.wake(a.id);
      return false;
    }
    const actions = json<ActionDef[]>(r.actions, []);
    const def = actions.find((x) => x.id === a.action);
    if (!def) return void console.warn(`[approvals] ${a.id}: ${a.device} answered an action it was not offered`), false;
    const message = typeof a.message === 'string' && a.message ? a.message.slice(0, MAX_MESSAGE) : null;
    let statement: string | null = null;
    let signature: string | null = null;
    if (a.signature) {
      const dev = (await this.devices()).find((d) => d.id === a.device) ?? (await this.devices(true)).find((d) => d.id === a.device);
      statement = statementText({ ...askOf(r), action: a.action, messageSha256: messageHash(message), device: a.device, signed: a.signed });
      const c = dev?.approvalKey ? await checkSigned(statement, a.signature, [{ id: dev.id, kind: dev.kind, key: dev.approvalKey, fingerprint: '', name: dev.name }], { ask: askOf(r) }) : { ok: false, reason: 'the device has no approval key here' };
      if (!c.ok) return void console.warn(`[approvals] ${a.id}: a signature from ${a.device} does not check out (${c.reason}): ignored`), false;
      signature = a.signature;
    } else if (def.needs === 'signed') return void console.warn(`[approvals] ${a.id}: ${a.device} answered ${a.action} without a signature: ignored`), false;
    return this.close(
      a.id,
      { state: 'answered', action: a.action, message, signed: signature ? 1 : 0, device: a.device, device_name: a.deviceName ?? a.device, device_kind: a.deviceKind ?? 'phone', via: 'device', statement, signature, answered_at: this.now() },
      'answered',
    );
  }

  /**
   * The page's answer (your session). An action that needs no signature is answered here; one that does goes to the
   * laptop signer as an intent, when one holds it, and waits for your finger.
   */
  async pageAnswer(id: string, action: string, message: string | null): Promise<{ answered: boolean; signing: boolean }> {
    const r = this.row(id);
    if (!r) throw new ApprovalError('no such request', 404);
    if (r.state !== 'waiting') throw new ApprovalError(`it is ${r.state} already`, 409);
    const def = json<ActionDef[]>(r.actions, []).find((x) => x.id === action);
    if (!def) throw new ApprovalError('not one of its actions');
    const msg = message?.trim() ? message.trim().slice(0, MAX_MESSAGE) : null;
    if (def.needs === 'any') {
      this.close(id, { state: 'answered', action, message: msg, signed: 0, via: 'page', answered_at: this.now() }, 'answered');
      return { answered: true, signing: false };
    }
    const sent = this.link ? await this.link.intent(id, action, msg).catch(() => ({ sent: 0 })) : { sent: 0 };
    if (!sent.sent) throw new ApprovalError(`${def.label} needs a device's signature, and no laptop signer is online to sign it: answer on your phone`, 409);
    this.db.query('UPDATE request SET signing = ? WHERE id = ?').run(action, id);
    this.wake(id);
    return { answered: false, signing: true };
  }

  // ---------------------------------------------------------------- waiting for an answer

  private wake(id: string) {
    const w = this.waiters.get(id);
    if (!w) return;
    this.waiters.delete(id);
    for (const f of w) f();
  }

  /** Resolves when the request changes, or after `ms`. */
  waitFor(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? this.waiters.set(id, new Set()).get(id)!;
      const done = () => {
        clearTimeout(t);
        set.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      set.add(done);
    });
  }

  // ---------------------------------------------------------------- routes

  /** /api/approvals… for a caller already known (an asker's token, your session or the service token). */
  async route(req: Request, url: URL, caller: Caller): Promise<Response> {
    const path = url.pathname;
    try {
      if (path === '/api/approvals' && req.method === 'POST') return Response.json(this.create(caller, await body(req)), { status: 201 });
      if (path === '/api/approvals' && req.method === 'GET') {
        const state = url.searchParams.get('state') ?? undefined;
        const topic = url.searchParams.get('topic') ?? undefined;
        // By topic (a review branch's latest request), any asker may read: an agent reads the answer the bot's request got.
        return Response.json({ items: this.list({ state, topic, asker: 'asker' in caller && !topic ? caller.asker : undefined }) });
      }
      if (path === '/api/approvals/keys' && req.method === 'GET') {
        if (!this.link) throw new ApprovalError('no devices: this hub has no manager', 503);
        return new Response(await this.keysFile(), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      }
      if (path === '/api/approvals/devices' && req.method === 'GET' && !('asker' in caller)) return Response.json({ devices: await this.devices(true) });
      const m = /^\/api\/approvals\/(apv_[A-Za-z0-9_-]{22})(?:\/(cancel|answer))?$/.exec(path);
      if (!m) throw new ApprovalError('no such approvals route', 404);
      const id = m[1]!;
      if (!m[2] && req.method === 'GET') {
        this.mine(caller, id);
        const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) || 0, 0), MAX_WAIT_S);
        if (wait > 0 && this.get(id)?.state === 'waiting') await this.waitFor(id, wait * 1000);
        return Response.json(this.get(id));
      }
      if (m[2] === 'cancel' && req.method === 'POST') {
        const b = await body(req);
        return Response.json(this.cancel(caller, id, typeof b.reason === 'string' ? b.reason : null));
      }
      if (m[2] === 'answer' && req.method === 'POST') {
        if ('asker' in caller || !caller.page) throw new ApprovalError('answers come from a device or from the page', 403);
        const b = await body(req);
        const res = await this.pageAnswer(id, typeof b.action === 'string' ? b.action : '', typeof b.message === 'string' ? b.message : null);
        return Response.json({ ...res, request: this.get(id) });
      }
      throw new ApprovalError('no such approvals route', 404);
    } catch (e) {
      if (e instanceof ApprovalError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  }
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApprovalError('send a JSON object');
  return b as Record<string, unknown>;
}

function askOf(r: Row): Ask {
  return { id: r.id, kind: r.kind, asker: r.asker, created: r.created, expires: r.expires, payloadSha256: sha256hex(r.payload), displaySha256: displayHash(r.title, r.body) };
}

/** The asker's actions, checked; `deny` always among them, needing no signature. Default: approve (signed) and deny. */
function actionsOf(raw: unknown): ActionDef[] {
  const label = (id: string) => id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  let list: ActionDef[] = [];
  if (Array.isArray(raw) && raw.length) {
    if (raw.length > 8) throw new ApprovalError('at most 8 actions');
    for (const a of raw as Record<string, unknown>[]) {
      if (!a || typeof a.id !== 'string' || !NAME_RE.test(a.id)) throw new ApprovalError('an action id is a-z, 0-9 and -, at most 32');
      if (list.some((x) => x.id === a.id)) throw new ApprovalError(`action ${a.id} twice`);
      const needs: Needs = a.needs === 'any' ? 'any' : 'signed';
      list.push({ id: a.id, label: typeof a.label === 'string' && a.label.trim() ? cleanTitle(a.label).slice(0, 40) : label(a.id), needs: a.id === 'deny' ? 'any' : needs });
    }
  } else list = [{ id: 'approve', label: 'Approve', needs: 'signed' }];
  if (!list.some((a) => a.id === 'deny')) list.push({ id: 'deny', label: 'Deny', needs: 'any' });
  return list;
}
