/**
 * dither-desk: a small server on loopback that opens links and files from the web app in the desktop's own apps
 * (docs/desktop.md). It answers one paired origin, with that origin's token, and nothing else.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { desktopFile, listApps, validAppId, validMime } from './apps.ts';

export const VERSION = '0.1.0';

export interface DeskConfig {
  /** Where paired.json and pending.json live. */
  configDir: string;
  /** Downloaded files go here. */
  downloadDir: string;
  /** Opens a URL or a file: argv, the target appended. */
  openCmd: string[];
  /** gio: `gio mime <type>` and `gio launch <desktop file> <path>`. */
  gioCmd: string[];
  /** Where .desktop files are looked up. */
  appDirs: string[];
  maxBytes: number;
  now?: () => number;
}

export interface Paired {
  origin: string;
  token: string;
  at: number;
}

interface Pending {
  hash: string;
  expires: number;
  tries: number;
  /** When given to `pair`, only this origin may use the code. */
  origin?: string;
}

const PAIR_MINUTES = 5;
const PAIR_TRIES = 5;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------- state files (0600)

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown) {
  const dir = resolve(file, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export const pairedFile = (c: Pick<DeskConfig, 'configDir'>) => join(c.configDir, 'paired.json');
const pendingFile = (c: Pick<DeskConfig, 'configDir'>) => join(c.configDir, 'pending.json');

export function readPaired(c: Pick<DeskConfig, 'configDir'>): Paired | null {
  const p = readJson<Paired>(pairedFile(c));
  return p && typeof p.origin === 'string' && typeof p.token === 'string' && p.token.length >= 32 ? p : null;
}

export function unpair(c: Pick<DeskConfig, 'configDir'>) {
  rmSync(pairedFile(c), { force: true });
  rmSync(pendingFile(c), { force: true });
}

const hashCode = (code: string) => createHash('sha256').update(normalizeCode(code)).digest('hex');
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A one-time code for the web app's Settings; it works for five minutes and five tries. */
export function startPairing(c: Pick<DeskConfig, 'configDir'>, origin?: string, now = Date.now()): string {
  const bytes = randomBytes(8);
  const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  writeJson(pendingFile(c), { hash: hashCode(code), expires: now + PAIR_MINUTES * 60_000, tries: 0, ...(origin ? { origin } : {}) } satisfies Pending);
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function pending(c: DeskConfig, now: number): Pending | null {
  const p = readJson<Pending>(pendingFile(c));
  if (!p || typeof p.hash !== 'string' || p.expires < now || p.tries >= PAIR_TRIES) return null;
  return p;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- checks

/** A browser origin as it sends it: scheme, host, port, nothing else. */
export function validOrigin(o: string | null): o is string {
  if (!o || o.length > 300) return false;
  try {
    const u = new URL(o);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o;
  } catch {
    return false;
  }
}

/** Only loopback names: a page that rebinds its own name to 127.0.0.1 still sends its own Host. */
const loopbackHost = (h: string | null) => !!h && /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(h);

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** The URL to hand to the opener, or null. */
export function safeLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (!LINK_SCHEMES.has(u.protocol)) return null;
    if (u.protocol !== 'mailto:' && !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** A hub file to fetch: a /media/ or /emoji/ path on the paired origin, nothing else. */
export function hubFileUrl(raw: unknown, origin: string): URL | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin || u.username || u.password) return null;
    if (!/^\/(media|emoji)\/[^/]/.test(u.pathname) || u.pathname.includes('/../')) return null;
    return u;
  } catch {
    return null;
  }
}

/** A name that is safe as one path segment: no separators, control or direction characters, no leading dots or dashes. */
export function safeFilename(name: unknown, fallback = 'file'): string {
  let n = typeof name === 'string' ? name : '';
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/^[.\-\s]+/, '').replace(/[.\s]+$/, '');
  const ext = extname(n).slice(0, 16);
  const stem = n.slice(0, n.length - extname(n).length);
  // 200 bytes leaves room for " (n)" under the usual 255-byte limit.
  let short = stem;
  while (Buffer.byteLength(short + ext) > 200) short = Array.from(short).slice(0, -1).join('');
  n = (short + ext).trim();
  return n && n !== '.' && n !== '..' ? n : fallback;
}

/** Kinds that run code when opened with the default handler; they are saved but not opened. */
const RUNS = new Set(['.desktop', '.sh', '.bash', '.zsh', '.fish', '.csh', '.run', '.bin', '.appimage', '.exe', '.msi', '.bat', '.cmd', '.com', '.ps1', '.vbs', '.js', '.jar', '.py', '.pl', '.rb', '.php', '.elf', '.so', '.deb', '.rpm', '.flatpakref', '.flatpakrepo', '.lnk', '.scr', '.command', '.url', '.webloc', '.x86_64', '.kdesktop']);

function looksRunnable(name: string, head: Uint8Array): boolean {
  const ext = extname(name).toLowerCase();
  if (!ext || RUNS.has(ext)) return true;
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return true; // ELF
  if (head[0] === 0x23 && head[1] === 0x21) return true; // #!
  if (head[0] === 0x4d && head[1] === 0x5a) return true; // MZ
  return /^\s*\[Desktop Entry\]/.test(new TextDecoder().decode(head.subarray(0, 64)));
}

// ---------------------------------------------------------------- running things

/** Runs argv (never a shell). Waits up to 3 s for it to exit, since an opener may stay running with the app it started. */
async function run(argv: string[]): Promise<{ ok: boolean; error?: string }> {
  let proc;
  try {
    proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  } catch (e) {
    return { ok: false, error: `could not start ${argv[0]}: ${(e as Error).message}` };
  }
  const code = await Promise.race([proc.exited, Bun.sleep(3000).then(() => null)]);
  proc.unref();
  if (code === null || code === 0) return { ok: true };
  const err = (await new Response(proc.stderr).text()).trim().slice(0, 300);
  return { ok: false, error: `${argv[0]} exited ${code}${err ? `: ${err}` : ''}` };
}

/** Writes the response into dir under a unique name (created exclusively, 0600). */
async function saveDownload(res: Response, dir: string, name: string, maxBytes: number): Promise<{ path: string; head: Uint8Array } | { error: string }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let handle;
  let path = '';
  for (let i = 1; i < 1000 && !handle; i++) {
    path = join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!resolve(path).startsWith(resolve(dir) + sep)) return { error: 'bad file name' };
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { error: (e as Error).message };
    }
  }
  if (!handle) return { error: 'too many files with that name' };
  let size = 0;
  const head = new Uint8Array(64);
  let headLen = 0;
  try {
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`bigger than ${maxBytes} bytes`);
      }
      if (headLen < head.length) {
        const take = value.subarray(0, head.length - headLen);
        head.set(take, headLen);
        headLen += take.length;
      }
      await handle.write(value);
    }
    await handle.close();
    return { path, head: head.subarray(0, headLen) };
  } catch (e) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    return { error: (e as Error).message };
  }
}

// ---------------------------------------------------------------- the server

export function createDesk(c: DeskConfig) {
  const now = () => (c.now ?? Date.now)();

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    if (!loopbackHost(req.headers.get('host'))) return new Response('not a loopback host', { status: 403 });

    const origin = req.headers.get('origin');
    const paired = readPaired(c);
    const pend = path === '/pair' ? pending(c, now()) : null;
    // Who may read the answer: the paired origin always; before pairing, any page may see /hello; while a code is
    // waiting, the page it was made for (or any page, if none was named) may send /pair.
    const allowed =
      validOrigin(origin) &&
      ((paired && origin === paired.origin) || (path === '/hello' && !paired) || (path === '/pair' && pend && (!pend.origin || pend.origin === origin)));
    const cors: Record<string, string> = allowed ? { 'access-control-allow-origin': origin!, vary: 'Origin' } : {};
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...cors, 'cache-control': 'no-store' } });

    if (method === 'OPTIONS') {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET, POST',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-private-network': 'true',
          'access-control-max-age': '600',
        },
      });
    }

    // Without an Origin it is not a browser: a local check like curl may see that the helper is up, nothing more.
    if (path === '/hello' && method === 'GET' && (allowed || !origin)) return json({ app: 'dither-desk', version: VERSION, paired: !!paired && (!origin || origin === paired.origin) });
    if (!allowed) return json({ error: 'not allowed' }, 403);

    const body = async <T>(): Promise<Partial<T>> => {
      if (method !== 'POST') return {};
      const text = await req.text();
      if (text.length > 16_384) return {};
      try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' ? v : {};
      } catch {
        return {};
      }
    };

    if (path === '/pair' && method === 'POST') {
      const p = pend!;
      const b = await body<{ code: string }>();
      if (typeof b.code !== 'string' || !same(hashCode(b.code), p.hash)) {
        writeJson(pendingFile(c), { ...p, tries: p.tries + 1 });
        return json({ error: 'wrong code', triesLeft: Math.max(0, PAIR_TRIES - p.tries - 1) }, 403);
      }
      const token = randomBytes(32).toString('base64url');
      writeJson(pairedFile(c), { origin: origin!, token, at: now() } satisfies Paired);
      rmSync(pendingFile(c), { force: true });
      return json({ ok: true, token });
    }

    // Everything else: the paired origin with its token.
    const auth = req.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!paired || origin !== paired.origin || !same(token, paired.token)) return json({ error: 'not paired with this page' }, 401);

    if (path === '/unpair' && method === 'POST') {
      unpair(c);
      return json({ ok: true });
    }

    if (path === '/open' && method === 'POST') {
      const link = safeLink((await body<{ url: string }>()).url);
      if (!link) return json({ error: 'only http, https and mailto links' }, 400);
      const r = await run([...c.openCmd, link]);
      return json(r, r.ok ? 200 : 502);
    }

    if (path === '/apps' && method === 'GET') {
      const mime = url.searchParams.get('mime');
      if (!validMime(mime)) return json({ error: 'not a MIME type' }, 400);
      return json({ apps: await listApps(mime, c.gioCmd, c.appDirs) });
    }

    if (path === '/open-file' && method === 'POST') {
      const b = await body<{ url: string; name: string; mime: string; app: string }>();
      const src = hubFileUrl(b.url, paired.origin);
      if (!src) return json({ error: "only the hub's own files" }, 400);
      let launcher: string | null = null;
      if (b.app != null) {
        if (!validAppId(b.app) || !validMime(b.mime)) return json({ error: 'which app?' }, 400);
        const apps = await listApps(b.mime, c.gioCmd, c.appDirs);
        if (!apps.some((a) => a.id === b.app)) return json({ error: `${b.app} does not open ${b.mime}` }, 403);
        launcher = desktopFile(b.app, c.appDirs);
        if (!launcher) return json({ error: 'app not found' }, 404);
      }
      let res: Response;
      try {
        res = await fetch(src, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        return json({ error: `could not fetch it: ${(e as Error).message}` }, 502);
      }
      if (res.status !== 200 || !res.body) return json({ error: `the hub answered ${res.status}` }, 502);
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > c.maxBytes) {
        await res.body.cancel();
        return json({ error: `bigger than ${c.maxBytes} bytes` }, 413);
      }
      const saved = await saveDownload(res, c.downloadDir, safeFilename(b.name, src.pathname.startsWith('/emoji/') ? 'emoji' : 'file'), c.maxBytes);
      if ('error' in saved) return json({ error: saved.error }, saved.error.startsWith('bigger') ? 413 : 500);
      const name = saved.path.slice(saved.path.lastIndexOf(sep) + 1);
      if (!launcher && looksRunnable(name, saved.head)) return json({ ok: false, saved: name, error: 'saved, not opened: this kind of file can run code. Use Open with to pick an app.' }, 422);
      const r = await run(launcher ? [...c.gioCmd, 'launch', launcher, saved.path] : [...c.openCmd, saved.path]);
      return json({ ...r, saved: name }, r.ok ? 200 : 502);
    }

    return json({ error: 'no such endpoint' }, 404);
  };
}

/** The XDG download directory, from the environment or user-dirs.dirs, else ~/Downloads. */
export function downloadDir(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME ?? '';
  if (env.XDG_DOWNLOAD_DIR) return env.XDG_DOWNLOAD_DIR;
  const dirs = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'user-dirs.dirs');
  if (existsSync(dirs)) {
    const m = readFileSync(dirs, 'utf8').match(/^XDG_DOWNLOAD_DIR="([^"]+)"/m);
    if (m) return m[1].replace(/^\$HOME/, home);
  }
  return join(home, 'Downloads');
}
