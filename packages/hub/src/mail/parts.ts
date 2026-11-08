/**
 * Slice 3 (docs/mail-design.md §7): a message's HTML, sanitised and served under a sandbox CSP; its `cid:` parts; its
 * attachments, fetched with mail.attachment into the media cache and looked at like chat files (fileinfo.ts); remote
 * images through the proxy (images.ts) once you allow them for the message or its sender.
 *
 *   GET  /api/mail/messages/:id/html?images=0|1    the frame's document
 *   GET  /api/mail/messages/:id/cid/:cid           an inline part the HTML shows (images only)
 *   GET  /api/mail/messages/:id/attachments/:aid   a file's bytes; /info what it is (FileInfo)
 *   GET  /api/mail/img/:token                      a remote image
 *   POST /api/mail/images                          { messageId } or { sender, allow }
 *
 * It also fills a body's view (MailStore.bodyExtras): the HTML's URL and what was held back, the files, and warnings.
 * A reply's quote of the HTML is compose.ts quotedHtml (sanitize.ts quoteFragment).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import { analyze, fileSource, SNIFF_VERSION } from '../fileinfo.ts';
import { inlineType, PLAYER_CSP, SANDBOX_CSP, safeFilename, safeMime, sniffMime } from '../mediaheaders.ts';
import { MailCallError } from './backend.ts';
import type { MailHub, MailMediaOpts } from './index.ts';
import { ImageProxy, imageToken, imageType, readImageToken } from './images.ts';
import { P0 } from './queue.ts';
import type { MailRouter } from './routes.ts';
import { contentId, mailDocument, SANITIZE_VERSION, sanitizeMail, type Sanitized } from './sanitize.ts';

type Row = Record<string, any>;

const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
const hash = (...xs: string[]) => createHash('sha256').update(xs.join('\0')).digest('base64url');

/** A part's id in URLs: its extractor id hashed, so any id the extractor uses fits in a path. */
export const partId = (messageId: string, attachmentId: string) => hash('part', messageId, attachmentId).slice(0, 16);

/** The frame's CSP: no script, nothing loaded but this hub's mail images and data: images, and only in our frames. */
export function htmlCsp(origin: string, messageId: string): string {
  return [
    'sandbox allow-same-origin',
    "default-src 'none'",
    `img-src ${origin}/api/mail/img/ ${origin}/api/mail/messages/${messageId}/cid/ data:`,
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** Everything slice 3 keeps per hub. */
class Parts {
  readonly media: MailMediaOpts;
  readonly images: ImageProxy;
  /** Sanitised HTML by (message, version, images), the most recently used last. */
  private cache = new Map<string, Sanitized>();

  constructor(private hub: MailHub) {
    // Without the hub's own (a test): a directory made when first needed, and a key for this process.
    this.media = hub.media ?? { dir: join(tmpdir(), `dither-mail-${process.pid}`), key: crypto.randomUUID() };
    this.images = new ImageProxy({ dir: this.media.dir, fetch: this.media.fetch, lookup: this.media.lookup });
  }

  get store() {
    return this.hub.store;
  }

  message(id: string): Row | null {
    return this.store.one('SELECT id, account_id, from_addr, from_name, images_allowed FROM mail_message WHERE id = ?', id);
  }

  /** Remote images show for this message: allowed for it, or always for its sender. */
  imagesAllowed(m: Row): boolean {
    if (m.images_allowed) return true;
    const from = String(m.from_addr ?? '').toLowerCase();
    return !!from && !!this.store.one('SELECT 1 FROM mail_sender_images WHERE address = ? AND allow = 1', from);
  }

  /** The HTML made safe, from the cache when it is there. */
  sanitized(messageId: string, html: string, images: boolean): Sanitized {
    const key = `${messageId}:${SANITIZE_VERSION}:${images ? 1 : 0}`;
    const have = this.cache.get(key);
    if (have) {
      this.cache.delete(key);
      this.cache.set(key, have);
      return have;
    }
    const s = sanitizeMail(html, {
      images: images ? 'proxy' : 'block',
      proxy: (url) => `/api/mail/img/${imageToken(this.media.key, messageId, url)}`,
      cid: (cid) => `/api/mail/messages/${messageId}/cid/${encodeURIComponent(cid)}`,
    });
    this.cache.set(key, s);
    while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return s;
  }

  /** Messages the server no longer has, or a whole account: their HTML and files go too. */
  forget(accountId: string, messageIds: string[] | null) {
    if (!messageIds) {
      this.cache.clear();
      return this.removeFiles(`mailpart-${hash('a', accountId).slice(0, 10)}-`);
    }
    const gone = new Set(messageIds);
    for (const k of [...this.cache.keys()]) if (gone.has(k.split(':')[0])) this.cache.delete(k);
    for (const id of messageIds) this.removeFiles(`mailpart-${hash('a', accountId).slice(0, 10)}-${hash('m', id).slice(0, 12)}-`);
  }

  removeFiles(prefix: string) {
    if (!existsSync(this.media.dir)) return;
    for (const f of readdirSync(this.media.dir)) if (f.startsWith(prefix)) rmSync(join(this.media.dir, f), { force: true });
    this.store.db.query('DELETE FROM mail_file_info WHERE key LIKE ?').run(`${prefix}%`);
  }

  // ---------------------------------------------------------------- the body's view

  /** What slice 3 adds to a body's view. */
  extras(messageId: string, b: Row): Partial<P.MailBodyView> {
    const m = this.message(messageId);
    if (!m) return {};
    const parts = json<M.MailAttachment[]>(b.parts, []);
    const out: Partial<P.MailBodyView> = {};
    let cids = new Set<string>();
    const warnings: string[] = [];
    if (b.html) {
      const shown = this.imagesAllowed(m);
      // The counts are those of the blocked pass: what the banner offers to load.
      const held = this.sanitized(messageId, b.html, false);
      cids = new Set(held.cids);
      out.html = { url: `/api/mail/messages/${messageId}/html?images=${shown ? 1 : 0}&v=${SANITIZE_VERSION}`, remoteImages: held.remoteImages, trackers: held.trackers, imagesShown: shown };
      for (const x of dedupe(held.mismatched).slice(0, 3)) warnings.push(`A link that shows ${x.shown} goes to ${x.goes}.`);
    }
    out.attachments = parts
      .filter((a) => !(a.inline && a.contentId && cids.has(contentId(a.contentId))))
      .map((a) => {
        const id = partId(messageId, a.id);
        const base = `/api/mail/messages/${messageId}/attachments/${id}`;
        const info = this.infoOf(this.partFile(m, a));
        return { id, name: a.filename ?? null, mime: a.mime || 'application/octet-stream', size: a.size, inline: a.inline, url: base, infoUrl: `${base}/info`, ...(info ? { info } : {}) };
      });
    warnings.push(...senderWarnings(m, json<M.MailAddress[]>(b.reply_to, [])));
    if (warnings.length) out.warnings = warnings;
    return out;
  }

  // ---------------------------------------------------------------- parts

  /** Where a part's bytes are kept: named by account, message and part, so a deleted message's files can go. */
  partFile(m: Row, a: M.MailAttachment): string {
    return join(this.media.dir, `mailpart-${hash('a', m.account_id).slice(0, 10)}-${hash('m', m.id).slice(0, 12)}-${hash('p', m.account_id, m.id, a.id).slice(0, 32)}`);
  }

  /** A message's body row; one the body cache let go (cache.ts, slice 2) comes back from the server first. */
  async bodyOf(m: Row): Promise<Row | null> {
    if (!this.store.body(m.id)) await this.hub.body(m.id);
    return this.store.body(m.id);
  }

  async part(m: Row, pid: string): Promise<M.MailAttachment | null> {
    const b = await this.bodyOf(m);
    return json<M.MailAttachment[]>(b?.parts, []).find((a) => partId(m.id, a.id) === pid) ?? null;
  }

  /** A part's bytes on disk, fetched with mail.attachment when they are not here yet. */
  async fetchPart(m: Row, a: M.MailAttachment): Promise<{ file: string; mime: string }> {
    const file = this.partFile(m, a);
    if (existsSync(file) && existsSync(file + '.mime')) return { file, mime: readFileSync(file + '.mime', 'utf8') };
    const sync = this.usable(m.account_id);
    const r = await sync.queue.run(P0, `part:${m.id}:${a.id}`, async () => {
      const at = this.store.nativeOf(m.id);
      if (!at) throw new MailCallError('the server no longer has this message', 404);
      return this.hub.backend!.call<{ filename: string | null; mime: string; base64: string }>(m.account_id, 'mail.attachment', { id: at.id, attachmentId: a.id }, 125_000);
    });
    if (!existsSync(this.media.dir)) mkdirSync(this.media.dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, Buffer.from(r.base64 ?? '', 'base64'), { mode: 0o600 });
    const mime = r.mime || a.mime || 'application/octet-stream';
    writeFileSync(file + '.mime', mime, { mode: 0o600 });
    return { file, mime };
  }

  /** The account's sync, when its server can be asked now; else the reason, as body() gives it. */
  private usable(accountId: string) {
    const acc = this.store.account(accountId);
    const s = this.hub.sync(accountId);
    if (!acc || acc.gone_at) throw new MailCallError('this account is no longer shared with the hub, and this file was not kept here', 410);
    if (!this.hub.backend?.connected || !s) throw new MailCallError('dither-accounts is not reachable', 503);
    if (!acc.online) throw new MailCallError(JSON.parse(acc.problem ?? 'null')?.message ?? 'the account is offline', 503);
    return s;
  }

  infoOf(file: string): P.FileInfo | null {
    const key = file.slice(this.media.dir.length + 1);
    const r = this.store.one<{ info: string }>('SELECT info FROM mail_file_info WHERE key = ? AND version = ?', key, SNIFF_VERSION);
    return r ? json<P.FileInfo | null>(r.info, null) : null;
  }

  async lookAt(file: string, a: M.MailAttachment): Promise<P.FileInfo> {
    const have = this.infoOf(file);
    if (have) return have;
    const info = await analyze(fileSource(file), { name: a.filename, mime: a.mime });
    this.store.db
      .query('INSERT INTO mail_file_info (key, info, version, at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET info = excluded.info, version = excluded.version, at = excluded.at')
      .run(file.slice(this.media.dir.length + 1), JSON.stringify(info), SNIFF_VERSION, Date.now());
    return info;
  }
}

const dedupe = (xs: { shown: string; goes: string }[]) => [...new Map(xs.map((x) => [`${x.shown} ${x.goes}`, x])).values()];

const domain = (e: string) => e.toLowerCase().split('@').pop() ?? '';

/** A name that is itself another address, and replies that go to another domain than the sender's. */
export function senderWarnings(m: { from_addr?: string | null; from_name?: string | null }, replyTo: M.MailAddress[]): string[] {
  const out: string[] = [];
  const from = String(m.from_addr ?? '').toLowerCase();
  const named = String(m.from_name ?? '').match(/[^\s<>"'()]+@[^\s<>"'()]+\.[a-z]{2,}/i)?.[0].toLowerCase();
  if (from && named && named !== from) out.push(`The name says ${named}, but it came from ${from}.`);
  const away = replyTo.filter((r) => r.email && domain(r.email) !== domain(from));
  if (from && away.length) out.push(`Replies go to ${away.map((r) => r.email).join(', ')}, not to ${from}.`);
  return out;
}

/** The headers of a part's bytes: shown in place only for the types a browser shows harmlessly, else a download. */
function partHeaders(mime: string, name: string | null, key: string): Record<string, string> {
  const type = safeMime(mime);
  const inline = inlineType(type);
  const n = safeFilename(name ?? '') || `attachment-${key.slice(0, 8)}`;
  const ascii = n.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(n).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return {
    'content-type': type,
    'cache-control': 'private, max-age=604800',
    'x-content-type-options': 'nosniff',
    'content-security-policy': inline && /^(video|audio)\//i.test(type) ? PLAYER_CSP : SANDBOX_CSP,
    'referrer-policy': 'no-referrer',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
  };
}

/** Generic types say nothing: the bytes do. */
const GENERIC = /^(application\/(octet-stream|binary|unknown|x-download|force-download)|binary\/octet-stream)?$/;

export const partRoutes: MailRouter = (hub) => {
  const parts = new Parts(hub);
  hub.store.bodyExtras.push((id, b) => parts.extras(id, b));
  hub.on('deleted', (e) => parts.forget(e.accountId, e.messageIds));
  hub.on('account', (e) => e.state === 'deleted' && parts.forget(e.accountId, null));
  const need = (id: string) => {
    const m = parts.message(id);
    if (!m) throw new MailCallError('no such message', 404);
    return m;
  };

  return [
    {
      method: 'GET',
      path: /^\/api\/mail\/messages\/([\w-]+)\/html$/,
      handle: async ({ params, url }) => {
        const m = need(params[0]);
        let b = hub.store.body(m.id);
        if (!b) {
          await hub.body(m.id);
          b = hub.store.body(m.id);
        }
        if (!b?.html) throw new MailCallError('this message has no HTML', 404);
        const images = url.searchParams.get('images') === '1' && parts.imagesAllowed(m);
        const doc = mailDocument(parts.sanitized(m.id, b.html, images));
        return new Response(doc, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': htmlCsp(url.origin, m.id),
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'cache-control': 'private, max-age=300',
            'cross-origin-resource-policy': 'same-origin',
          },
        });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/mail\/messages\/([\w-]+)\/cid\/([^/]+)$/,
      handle: async ({ params }) => {
        const m = need(params[0]);
        const want = contentId(params[1]);
        const b = await parts.bodyOf(m);
        const a = json<M.MailAttachment[]>(b?.parts, []).find((x) => x.contentId && contentId(x.contentId) === want);
        if (!a) throw new MailCallError('no such part', 404);
        const { file } = await parts.fetchPart(m, a);
        const type = imageType(new Uint8Array(readFileSync(file).subarray(0, 32)));
        if (!type) throw new MailCallError('that part is not an image', 415);
        return new Response(Bun.file(file), { headers: { ...partHeaders(type, a.filename, partId(m.id, a.id)), 'content-disposition': 'inline' } });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/mail\/messages\/([\w-]+)\/attachments\/([\w-]+)(\/info)?$/,
      handle: async ({ params }) => {
        const m = need(params[0]);
        const a = await parts.part(m, params[1]);
        if (!a) throw new MailCallError('no such attachment', 404);
        const { file, mime } = await parts.fetchPart(m, a);
        if (params[2] === '/info') return Response.json((await parts.lookAt(file, a)) satisfies P.FileInfo);
        // The type it says it is, unless that says nothing and the bytes do.
        const essence = mime.split(';')[0].trim().toLowerCase();
        const type = GENERIC.test(essence) ? (parts.infoOf(file)?.mime ?? sniffMime(new Uint8Array(readFileSync(file).subarray(0, 16))) ?? mime) : mime;
        return new Response(Bun.file(file), { headers: partHeaders(type, a.filename, params[1]) });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/mail\/img\/([\w.-]+)$/,
      handle: async ({ params }) => {
        const t = readImageToken(parts.media.key, params[0]);
        if (!t) return new Response('bad token', { status: 403 });
        const m = parts.message(t.messageId);
        // Allowed when the page was made; still allowed now.
        if (!m || !parts.imagesAllowed(m)) return new Response('images are not allowed for this message', { status: 403 });
        return parts.images.serve(t.url);
      },
    },
    {
      // Load this message's images, or always (or never again) a sender's.
      method: 'POST',
      path: /^\/api\/mail\/images$/,
      handle: async ({ body }) => {
        const b = await body<{ messageId?: string; sender?: string; allow?: boolean }>();
        if (typeof b.messageId === 'string') {
          need(b.messageId);
          hub.store.db.query('UPDATE mail_message SET images_allowed = 1 WHERE id = ?').run(b.messageId);
          return Response.json({ ok: true, body: hub.store.bodyView(b.messageId) });
        }
        const sender = typeof b.sender === 'string' ? b.sender.trim().toLowerCase() : '';
        if (!/^[^\s@]+@[^\s@]+$/.test(sender)) throw new MailCallError('give a messageId, or a sender address', 400);
        hub.store.db
          .query('INSERT INTO mail_sender_images (address, allow, at) VALUES (?, ?, ?) ON CONFLICT (address) DO UPDATE SET allow = excluded.allow, at = excluded.at')
          .run(sender, b.allow === false ? 0 : 1, Date.now());
        return Response.json({ ok: true });
      },
    },
  ];
};
