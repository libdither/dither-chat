/**
 * The hub's login (docs/login.md): one user, a password kept only as an argon2id hash, long-lived sessions, and one
 * token for programs on this machine.
 *
 * - The password: <data>/login.json (0600) holds `{ user, hash, setAt }`, written by `cli.ts set-password` (from stdin
 *   or a file, never argv). With none, everything behind the login stays shut and the page says how to set one.
 *   Setting it again ends every session.
 * - Sessions: an opaque random token in an HttpOnly, SameSite=Lax cookie (Secure when the page is served over https),
 *   kept here only as its sha256, with when it was made and last used, the user agent and the address. They live in
 *   <data>/auth.sqlite, apart from the hub's database, so the CLI can list and end them while the hub runs. A session
 *   slides: 90 days from its last use, never more than a year from its login.
 * - The service token: <data>/api.token (0600), made at the first start and kept, sent as `Authorization: Bearer …`
 *   by programs that read the hub without a browser (the deployer's checks, the CLI, dither-calendar).
 *   `cli.ts rotate-token` makes a new one; the hub reads the file again when it changes.
 * - Failed logins back off per address (and, far looser, overall): five free, then a doubling wait up to 15 minutes.
 */
import { Database } from 'bun:sqlite';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

export const USER = 'admin';
export const COOKIE = 'dchat_session';
const LOGIN_FILE = 'login.json';
export const TOKEN_FILE = 'api.token';
const AUTH_DB = 'auth.sqlite';
const DAY = 86_400_000;
/** A session ends this long after its last use… */
const SLIDING_MS = 90 * DAY;
/** …and never later than this after its login. */
const ABSOLUTE_MS = 365 * DAY;
/** last_used is written at most this often; the cookie's Max-Age is renewed at most once a day. */
const TOUCH_MS = 60_000;
const REFRESH_MS = DAY;
export const MIN_PASSWORD = 10;
/** How long a file ticket (a /media link a program without the cookie may fetch once it is given it) holds. */
const TICKET_MS = 5 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  -- sha256 of the cookie's token: the token itself is never stored.
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL,
  user_agent TEXT,
  ip         TEXT,
  last_ip    TEXT
);
`;

const newToken = () => randomBytes(32).toString('base64url');
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** <data>/auth.sqlite, made private to this user. */
export function openAuthDb(dataDir: string): Database {
  const file = join(dataDir, AUTH_DB);
  const db = new Database(file, { create: true });
  try {
    chmodSync(file, 0o600);
  } catch {}
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
  db.exec(SCHEMA);
  return db;
}

interface PasswordFile {
  user: string;
  hash: string;
  setAt: number;
}

export function readPassword(dataDir: string): PasswordFile | null {
  try {
    const p = JSON.parse(readFileSync(join(dataDir, LOGIN_FILE), 'utf8')) as PasswordFile;
    return p && typeof p.hash === 'string' && p.hash.startsWith('$argon2id$') && typeof p.setAt === 'number' ? p : null;
  } catch {
    return null;
  }
}

function writePrivate(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** The password's hash to <data>/login.json (0600, replaced whole), and every session ended. */
export async function setPassword(dataDir: string, password: string, now = Date.now()): Promise<void> {
  if (password.length < MIN_PASSWORD) throw new Error(`a password of at least ${MIN_PASSWORD} characters, please`);
  const hash = await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
  writePrivate(join(dataDir, LOGIN_FILE), `${JSON.stringify({ user: USER, hash, setAt: now } satisfies PasswordFile)}\n`);
  const db = openAuthDb(dataDir);
  try {
    db.query('DELETE FROM session').run();
  } finally {
    db.close();
  }
}

/** <data>/api.token, made when there is none (or `rotate`). Returns the token. */
export function ensureToken(dataDir: string, rotate = false): string {
  const file = join(dataDir, TOKEN_FILE);
  if (!rotate) {
    try {
      const t = readFileSync(file, 'utf8').trim();
      if (t.length >= 32) {
        chmodSync(file, 0o600);
        return t;
      }
    } catch {}
  }
  const t = newToken();
  writePrivate(file, `${t}\n`);
  return t;
}

/** Waits that double after a few free failures, per key. */
class Backoff {
  private m = new Map<string, { fails: number; last: number; until: number }>();
  constructor(
    private free: number,
    private maxMs = 15 * 60_000,
  ) {}
  /** How long `key` must still wait, in ms (0: it may try). */
  wait(key: string, now: number): number {
    const e = this.m.get(key);
    return e ? Math.max(0, e.until - now) : 0;
  }
  fail(key: string, now: number) {
    if (this.m.size > 10_000) for (const [k, e] of this.m) if (now - e.last > DAY) this.m.delete(k);
    const e = this.m.get(key) ?? { fails: 0, last: now, until: 0 };
    if (now - e.last > DAY) e.fails = 0;
    e.fails++;
    e.last = now;
    if (e.fails >= this.free) e.until = now + Math.min(this.maxMs, 1000 * 2 ** (e.fails - this.free));
    this.m.set(key, e);
  }
  ok(key: string) {
    this.m.delete(key);
  }
}

interface SessionInfo {
  id: string;
  createdAt: number;
  lastUsed: number;
  expiresAt: number;
  userAgent: string | null;
  ip: string | null;
  lastIp: string | null;
  current: boolean;
}

type LoginResult = { ok: true; token: string; maxAge: number } | { ok: false; status: 401 | 429 | 503; retryAfter?: number; error: string };

/** Who a request is: a browser's session (its id), the service token, or nobody. */
export type Who = { kind: 'session'; id: string; refresh: number | null } | { kind: 'token' } | { kind: 'open' };

export class Auth {
  readonly db: Database;
  private perIp = new Backoff(5);
  private overall = new Backoff(50);
  private pw: { key: string; file: PasswordFile | null } | null = null;
  private tok: { key: string; hash: Buffer | null } | null = null;

  constructor(
    private dataDir: string,
    private now: () => number = Date.now,
  ) {
    this.db = openAuthDb(dataDir);
    ensureToken(dataDir);
  }

  close() {
    this.db.close();
  }

  private static fileKey(file: string): string {
    if (!existsSync(file)) return 'none';
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  }

  /** The password file, read again when it changes. */
  password(): PasswordFile | null {
    const key = Auth.fileKey(join(this.dataDir, LOGIN_FILE));
    if (this.pw?.key !== key) this.pw = { key, file: key === 'none' ? null : readPassword(this.dataDir) };
    return this.pw.file;
  }

  /** Whether `bearer` is the service token (read again when the file changes; `rotate-token` replaces it). */
  isToken(bearer: string | null): boolean {
    if (!bearer) return false;
    const file = join(this.dataDir, TOKEN_FILE);
    const key = Auth.fileKey(file);
    if (this.tok?.key !== key) {
      let t = '';
      try {
        t = readFileSync(file, 'utf8').trim();
      } catch {}
      this.tok = { key, hash: t.length >= 32 ? Buffer.from(hashToken(t), 'hex') : null };
    }
    if (!this.tok.hash) return false;
    const h = Buffer.from(hashToken(bearer.trim()), 'hex');
    return timingSafeEqual(h, this.tok.hash);
  }

  /** A new session without a password: for a program with the service token that drives a browser (POST /api/sessions). */
  create(ip: string, userAgent: string | null): { token: string; maxAge: number } | null {
    if (!this.password()) return null;
    const now = this.now();
    const token = newToken();
    this.db
      .query('INSERT INTO session (id, token_hash, created_at, last_used, user_agent, ip, last_ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`ses_${randomBytes(9).toString('base64url')}`, hashToken(token), now, now, userAgent?.slice(0, 300) ?? null, ip || null, ip || null);
    return { token, maxAge: Math.floor(SLIDING_MS / 1000) };
  }

  async login(user: string, password: string, ip: string, userAgent: string | null): Promise<LoginResult> {
    const now = this.now();
    const wait = Math.max(this.perIp.wait(ip, now), this.overall.wait('*', now));
    if (wait > 0) return { ok: false, status: 429, retryAfter: Math.ceil(wait / 1000), error: `Too many tries. Wait ${Math.ceil(wait / 1000)} s.` };
    const pw = this.password();
    if (!pw) return { ok: false, status: 503, error: 'No password is set yet.' };
    const good = (await Bun.password.verify(String(password).slice(0, 1024), pw.hash).catch(() => false)) && String(user).trim() === pw.user;
    if (!good) {
      this.perIp.fail(ip, now);
      this.overall.fail('*', now);
      return { ok: false, status: 401, error: 'That username and password do not match.' };
    }
    this.perIp.ok(ip);
    this.sweep();
    const token = newToken();
    this.db
      .query('INSERT INTO session (id, token_hash, created_at, last_used, user_agent, ip, last_ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`ses_${randomBytes(9).toString('base64url')}`, hashToken(token), now, now, userAgent?.slice(0, 300) ?? null, ip || null, ip || null);
    return { ok: true, token, maxAge: Math.floor(SLIDING_MS / 1000) };
  }

  private expiresAt(r: { created_at: number; last_used: number }) {
    return Math.min(r.last_used + SLIDING_MS, r.created_at + ABSOLUTE_MS);
  }
  private alive(r: { created_at: number; last_used: number }, now: number) {
    const pw = this.password();
    return !!pw && r.created_at >= pw.setAt && this.expiresAt(r) > now;
  }

  /**
   * The session a cookie's token names, if it is still good: its last use is noted (at most once a minute), and
   * `refresh` gives the cookie's new Max-Age when it is due to be sent again (at most once a day).
   */
  session(token: string | null, ip: string): { id: string; refresh: number | null } | null {
    if (!token || token.length > 200) return null;
    const r = this.db.query('SELECT * FROM session WHERE token_hash = ?').get(hashToken(token)) as { id: string; created_at: number; last_used: number; last_ip: string | null } | null;
    if (!r) return null;
    const now = this.now();
    if (!this.alive(r, now)) {
      this.bookkeep(() => this.db.query('DELETE FROM session WHERE id = ?').run(r.id));
      return null;
    }
    let refresh: number | null = null;
    if (now - r.last_used >= TOUCH_MS || (ip && ip !== r.last_ip)) {
      // The answer is already known from the read above; this write only notes the use. A full disk or a busy
      // database must not turn a good session into a failed request: the note is tried again on the next request,
      // and the cookie is refreshed only once the new last use is really saved.
      const noted = this.bookkeep(() => this.db.query('UPDATE session SET last_used = ?, last_ip = ? WHERE id = ?').run(now, ip || r.last_ip, r.id));
      if (noted && now - r.last_used >= REFRESH_MS) refresh = Math.floor((this.expiresAt({ created_at: r.created_at, last_used: now }) - now) / 1000);
    }
    return { id: r.id, refresh };
  }

  private bookkeepWarned = 0;
  /** A write that only keeps the session table tidy: a failure is logged (at most once a minute) and the check goes on. */
  private bookkeep(write: () => unknown): boolean {
    try {
      write();
      return true;
    } catch (e) {
      const now = this.now();
      if (now - this.bookkeepWarned >= TOUCH_MS) {
        this.bookkeepWarned = now;
        console.warn(`auth: could not note a session's use, the request goes on: ${(e as Error)?.message ?? e}`);
      }
      return false;
    }
  }

  /** Ended sessions go. */
  sweep() {
    const now = this.now();
    const pw = this.password();
    this.db.query('DELETE FROM session WHERE last_used < ? OR created_at < ? OR created_at < ?').run(now - SLIDING_MS, now - ABSOLUTE_MS, pw?.setAt ?? Number.MAX_SAFE_INTEGER);
  }

  list(current: string | null): SessionInfo[] {
    this.sweep();
    return listSessions(this.db, current);
  }

  revoke(id: string): boolean {
    return this.db.query('DELETE FROM session WHERE id = ?').run(id).changes > 0;
  }
  revokeAll(except: string | null = null): number {
    return this.db.query('DELETE FROM session WHERE id != ?').run(except ?? '').changes;
  }
}

export function listSessions(db: Database, current: string | null = null): SessionInfo[] {
  return (db.query('SELECT * FROM session ORDER BY last_used DESC').all() as any[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    lastUsed: r.last_used,
    expiresAt: Math.min(r.last_used + SLIDING_MS, r.created_at + ABSOLUTE_MS),
    userAgent: r.user_agent,
    ip: r.ip,
    lastIp: r.last_ip,
    current: r.id === current,
  }));
}

// ---------------------------------------------------------------- file tickets

/**
 * A /media or /emoji path a program without the cookie may fetch for a few minutes (the desktop helper opening a file
 * in another app, docs/desktop.md): `?ticket=<expiry>.<hmac>`, signed with the hub's secret over the path.
 */
export function fileTicket(secret: string, pathname: string, now = Date.now()): string {
  const exp = now + TICKET_MS;
  return `${exp}.${createHmac('sha256', secret).update(`ticket|${pathname}|${exp}`).digest('base64url').slice(0, 32)}`;
}

export function ticketGood(secret: string, pathname: string, ticket: string | null, now = Date.now()): boolean {
  const m = ticket?.match(/^(\d{10,16})\.([\w-]{32})$/);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > now) || exp > now + TICKET_MS) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(`ticket|${pathname}|${exp}`).digest('base64url').slice(0, 32));
  const got = Buffer.from(m[2]);
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---------------------------------------------------------------- the HTTP side's helpers

export function cookieOf(req: Request, name = COOKIE): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function bearerOf(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h?.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

export function sessionCookie(token: string, maxAge: number, secure: boolean): string {
  return `${COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, maxAge)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * A browser's write comes from this hub's own page: its Origin (or, without one, its Referer) names the host it was
 * sent to. A write with neither is refused: programs without a browser use the service token, not a cookie.
 */
export function fromOwnPage(req: Request): boolean {
  const host = req.headers.get('host');
  const from = req.headers.get('origin') ?? req.headers.get('referer');
  if (!host || !from || from === 'null') return false;
  try {
    return new URL(from).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

const v4 = (ip: string) => ip.replace(/^::ffff:/, '');
let own: { at: number; ips: Set<string> } | null = null;
/** An address of this machine: loopback, or one of its interfaces' (the proxy here may reach us from the tailnet address). */
function isThisMachine(ip: string): boolean {
  if (ip === '::1' || v4(ip).startsWith('127.')) return true;
  if (!own || Date.now() - own.at > 60_000) own = { at: Date.now(), ips: new Set(Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((a) => a.address.toLowerCase()))) };
  return own.ips.has(v4(ip).toLowerCase());
}

/** Who sent a request: the peer, or, from the proxy on this machine (Caddy), the address it forwarded for. */
export function clientIp(req: Request, peer: string): string {
  const fwd = isThisMachine(peer) ? req.headers.get('x-forwarded-for') : null;
  return fwd?.split(',').pop()?.trim() || peer;
}

/** Served over https: directly, or through the proxy on this machine. */
export const overHttps = (req: Request, peer: string) => new URL(req.url).protocol === 'https:' || (isThisMachine(peer) && req.headers.get('x-forwarded-proto') === 'https');
