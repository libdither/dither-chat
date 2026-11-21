/**
 * Slice 3 (docs/mail-design.md §7): a message's HTML, sanitised and served under a sandbox CSP; its `cid:` parts; its
 * attachments, fetched with mail.attachment into the media cache and looked at like chat files (fileinfo.ts); remote
 * images through the proxy (images.ts) once you allow them for the message or its sender.
 *
 *   GET  /api/mail/messages/:id/html?images=0|1    the frame's document
 *   GET  /api/mail/messages/:id/cid/:cid           an inline part the HTML shows (images only)
 *   GET  /api/mail/messages/:id/attachments/:aid   a file's bytes; /info what it is (FileInfo)
 *   GET  /api/mail/img/:token                      a remote image
 *   POST /api/mail/images                          { messageId, pictures? } or { sender, allow | forget }
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
import { addressForms, classifyPicture, pictureAction, type PicturePolicy } from './pictures.ts';
import { P0 } from './queue.ts';
import type { MailRouter } from './routes.ts';
import { contentId, mailDocument, type PictureDecision, SANITIZE_VERSION, sanitizeMail, type Sanitized } from './sanitize.ts';
import { htmlText } from './store.ts';
import type { ComposeOriginal } from './compose.ts';
import { islandOf } from './island.ts';
import type { OutboxPictures } from './outbox.ts';

type Row = Record<string, any>;
/** Which pictures load for one message, and what decided it. */
type Policy = { pictures: PicturePolicy; trackers: boolean; source: 'message' | 'sender' | 'setting' };
const urlHash = (url: string) => createHash('sha256').update(url).digest('base64url').slice(0, 22);

const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
const hash = (...xs: string[]) => createHash('sha256').update(xs.join('\0')).digest('base64url');

/** A part's id in URLs: its extractor id hashed, so any id the extractor uses fits in a path. */
const partId = (messageId: string, attachmentId: string) => hash('part', messageId, attachmentId).slice(0, 16);

/** The frame's CSP: no script, nothing loaded but this hub's mail images and data: images, and only in our frames. */
function htmlCsp(origin: string, messageId: string): string {
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
    return this.store.one('SELECT id, account_id, from_addr, from_name, images_allowed, size FROM mail_message WHERE id = ?', id);
  }

  /**
   * Which of this message's pictures load (docs/mail.md "Pictures and trackers"): all when you loaded them for it;
   * else the sender's rule (Always or Never from them); else the setting. Trackers: the setting.
   */
  policy(m: Row): Policy {
    const setting = (k: string) => this.store.one<{ value: string }>('SELECT value FROM mail_setting WHERE key = ?', k)?.value;
    const trackers = setting('trackers') === 'keep';
    // For this message: 1 all, 2 shared only, 3 none (POST /api/mail/images { messageId, pictures }).
    const own = ({ 1: 'all', 2: 'shared', 3: 'none' } as const)[Number(m.images_allowed) as 1 | 2 | 3];
    if (own) return { pictures: own, trackers, source: 'message' };
    const from = String(m.from_addr ?? '').toLowerCase();
    const rule = from ? this.store.one<{ allow: number }>('SELECT allow FROM mail_sender_images WHERE address = ?', from) : null;
    if (rule) return { pictures: rule.allow ? 'all' : 'none', trackers, source: 'sender' };
    const p = setting('pictures');
    return { pictures: p === 'none' || p === 'all' ? p : 'shared', trackers, source: 'setting' };
  }

  /** The forms your addresses take in a URL (pictures.ts addressForms), per account. */
  private yours = new Map<string, string[]>();
  you(accountId: string): string[] {
    let f = this.yours.get(accountId);
    if (!f) {
      const a = this.store.one<{ address: string | null; addresses: string | null }>('SELECT address, addresses FROM mail_account WHERE id = ?', accountId);
      const list = [a?.address ?? '', ...json<{ email: string }[]>(a?.addresses, []).map((x) => x.email)].filter(Boolean);
      f = addressForms(list);
      this.yours.set(accountId, f);
    }
    return f;
  }

  /** Each picture's fate for this message under `pol`. */
  decider(m: Row, pol: Policy): (url: string, shaped: boolean) => PictureDecision {
    const from = String(m.from_addr ?? '').toLowerCase();
    const seenElsewhere = (url: string) => !!this.store.one('SELECT 1 FROM mail_picture_seen WHERE url_hash = ? AND sender != ? LIMIT 1', urlHash(url), from);
    const you = this.you(m.account_id);
    return (url, shaped) => {
      const v = classifyPicture(url, { you, seenElsewhere }, shaped);
      return { ...v, action: pictureAction(v.class, pol.pictures, pol.trackers, this.images.cachedSize(url) !== null) };
    };
  }

  /** The HTML made safe under `pol`, from the cache when it is there. */
  sanitized(m: Row, html: string, pol: Policy): Sanitized {
    const key = `${m.id}:${SANITIZE_VERSION}:${pol.pictures}:${pol.trackers ? 1 : 0}`;
    const have = this.cache.get(key);
    if (have) {
      this.cache.delete(key);
      this.cache.set(key, have);
      return have;
    }
    const s = sanitizeMail(html, {
      images: 'block',
      decide: this.decider(m, pol),
      proxy: (url) => `/api/mail/img/${imageToken(this.media.key, m.id, url)}`,
      cid: (cid) => `/api/mail/messages/${m.id}/cid/${encodeURIComponent(cid)}`,
    });
    // Remembered by sender, so the next sender's mail with the same address knows it is shared.
    const from = String(m.from_addr ?? '').toLowerCase();
    if (from) {
      const q = this.store.db.query('INSERT OR IGNORE INTO mail_picture_seen (url_hash, sender) VALUES (?, ?)');
      for (const p of s.pictures ?? []) if (p.class !== 'tracker') q.run(urlHash(p.url), from);
    }
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
      const pol = this.policy(m);
      const san = this.sanitized(m, b.html, pol);
      cids = new Set(san.cids);
      out.html = {
        url: `/api/mail/messages/${messageId}/html?p=${pol.pictures}&t=${pol.trackers ? 1 : 0}&v=${SANITIZE_VERSION}`,
        remoteImages: san.remoteImages,
        trackers: san.trackers,
        imagesShown: pol.pictures === 'all',
        plain: san.plain && hasTextPart(b),
        ...(san.formatted ? { formatted: true } : {}),
        pictures: this.picturesView(san, pol),
      };
      for (const x of dedupe(san.mismatched).slice(0, 3)) warnings.push(`A link that shows ${x.shown} goes to ${x.goes}.`);
    }
    out.attachments = parts
      .filter((a) => !(a.inline && a.contentId && cids.has(contentId(a.contentId))))
      .map((a) => {
        const id = partId(messageId, a.id);
        const base = `/api/mail/messages/${messageId}/attachments/${id}`;
        const info = this.infoOf(this.partFile(m, a));
        return { id, name: a.filename ?? null, mime: a.mime || 'application/octet-stream', size: a.size, inline: a.inline, url: base, infoUrl: `${base}/info`, ...(info ? { info } : {}) };
      });
    out.sizes = {
      raw: Number(m.size) > 0 ? Number(m.size) : null,
      text: b.text ? Buffer.byteLength(b.text) : 0,
      html: b.html ? Buffer.byteLength(b.html) : 0,
      files: parts.reduce((n, a) => n + (a.size || 0), 0),
    };
    warnings.push(...senderWarnings(m, json<M.MailAddress[]>(b.reply_to, [])));
    if (warnings.length) out.warnings = warnings;
    return out;
  }

  /**
   * A forward's or a quote's island for the editor (island.ts): the original's HTML with its sheets and every picture's
   * address kept; pictures shown as your setting shows them in the reader, trackers always gone (a forwarded tracker
   * would tell the original sender each time your recipient opens it).
   */
  island(messageId: string, kind: 'forward' | 'quote', o: ComposeOriginal, tz?: string): P.MailIsland | null {
    const m = this.message(messageId);
    const b = m ? this.store.body(messageId) : null;
    if (!m || !b) return null;
    const pol = { ...this.policy(m), trackers: false };
    const content = b.html
      ? sanitizeMail(b.html, {
          images: 'block',
          keepSource: true,
          decide: this.decider(m, pol),
          proxy: (url) => `/api/mail/img/${imageToken(this.media.key, m.id, url)}`,
          cid: (cid) => `/api/mail/messages/${m.id}/cid/${encodeURIComponent(cid)}`,
        })
      : null;
    return islandOf(kind, o, content, Math.random().toString(36).slice(2, 8), tz);
  }

  /** What the outbox needs of pictures (island.ts OutgoingCtx): this hub's addresses resolved, bytes fetched. */
  outboxPictures(): OutboxPictures {
    return {
      island: (id, kind, o, tz) => this.island(id, kind, o, tz),
      resolve: (src) => {
        const img = /^(?:https?:\/\/[^/]+)?\/api\/mail\/img\/([\w.-]+)$/.exec(src);
        if (img) {
          const t = readImageToken(this.media.key, img[1]);
          return t ? { url: t.url } : null;
        }
        const cid = /^(?:https?:\/\/[^/]+)?\/api\/mail\/messages\/([\w-]+)\/cid\/([^/?#]+)$/.exec(src);
        if (cid) return { cid: { messageId: cid[1], contentId: decodeURIComponent(cid[2]) } };
        return null;
      },
      fetchPicture: async (url) => {
        const r = await this.images.bytes(url);
        return 'bytes' in r ? r : null;
      },
      cidPart: async (messageId, cid) => {
        const m = this.message(messageId);
        if (!m) return null;
        const want = contentId(cid);
        const b = await this.bodyOf(m);
        const a = json<M.MailAttachment[]>(b?.parts, []).find((x) => x.contentId && contentId(x.contentId) === want);
        if (!a) return null;
        const { file } = await this.fetchPart(m, a);
        const bytes = readFileSync(file);
        const mime = imageType(new Uint8Array(bytes.subarray(0, 32)));
        return mime ? { bytes, mime } : null;
      },
      sizes: (urls, accountId) => {
        const you = this.you(accountId);
        return {
          sizes: urls.map((u) => this.images.cachedSize(u)),
          classes: urls.map((u) => classifyPicture(u, { you }, false).class),
        };
      },
    };
  }

  /** What the reader's banner and details say of the pictures: counts, the hosts, and bytes the hub already has. */
  picturesView(san: Sanitized, pol: Policy): P.MailPicturesView {
    const list = san.pictures ?? [];
    let bytes = 0;
    let unknown = 0;
    const items = list.map((p) => {
      let host = '';
      try {
        host = new URL(p.url).hostname;
      } catch {}
      const size = this.images.cachedSize(p.url);
      if (p.action === 'load') {
        if (size === null) unknown++;
        else bytes += size;
      }
      return { host, class: p.class, why: p.why, action: p.action, ...(size !== null ? { size } : {}) };
    });
    return {
      policy: pol.pictures,
      source: pol.source,
      keepTrackers: pol.trackers,
      loaded: items.filter((x) => x.action === 'load').length,
      held: items.filter((x) => x.action === 'hold').length,
      removed: items.filter((x) => x.action === 'drop').length,
      hosts: new Set(items.map((x) => x.host).filter(Boolean)).size,
      bytes,
      unknown,
      items: items.slice(0, 200),
    };
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

/**
 * The body has a text part of its own that says what its HTML says: not the text putBody made from the HTML when the
 * mail had none (store.ts htmlText, so the same text again), and not a stub ("view this mail in a browser") much
 * shorter than the HTML's own text.
 */
export function hasTextPart(b: { text?: string | null; html?: string | null }): boolean {
  const text = b.text ?? '';
  if (!text.trim() || !b.html) return false;
  const made = htmlText(b.html).replace(/\r\n?/g, '\n');
  return text !== made && text.length * 2 >= made.length;
}

const dedupe = (xs: { shown: string; goes: string }[]) => [...new Map(xs.map((x) => [`${x.shown} ${x.goes}`, x])).values()];

const domain = (e: string) => e.toLowerCase().split('@').pop() ?? '';

/** A name that is itself another address, and replies that go to another domain than the sender's. */
function senderWarnings(m: { from_addr?: string | null; from_name?: string | null }, replyTo: M.MailAddress[]): string[] {
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
  hub.outbox.pictures = parts.outboxPictures();
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
        const doc = mailDocument(parts.sanitized(m, b.html, parts.policy(m)));
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
        // Loaded when the page was made; still loaded now.
        const b = m ? hub.store.body(m.id) : null;
        const p = m && b?.html ? parts.sanitized(m, b.html, parts.policy(m)).pictures?.find((x) => x.url === t.url) : null;
        if (!p || p.action !== 'load') return new Response('this picture is not loaded for this message', { status: 403 });
        return parts.images.serve(t.url);
      },
    },
    {
      // The composer's size meter: what the hub knows of pictures from the web (fetches nothing).
      method: 'POST',
      path: /^\/api\/mail\/pictures\/sizes$/,
      handle: async ({ body }) => {
        const b = await body<{ urls?: unknown; accountId?: unknown }>();
        const urls = (Array.isArray(b.urls) ? b.urls : []).filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 500);
        return Response.json(parts.outboxPictures().sizes(urls, String(b.accountId ?? '')) satisfies P.MailPictureSizes);
      },
    },
    {
      // Load this message's images, or always (or never again) a sender's.
      method: 'POST',
      path: /^\/api\/mail\/images$/,
      handle: async ({ body }) => {
        const b = await body<{ messageId?: string; pictures?: 'all' | 'shared' | 'none' | null; sender?: string; allow?: boolean; forget?: boolean }>();
        if (typeof b.messageId === 'string') {
          need(b.messageId);
          // { messageId } alone loads all, as before; pictures: null goes back to the sender's rule or the setting.
          const v = b.pictures === null ? 0 : b.pictures === undefined || b.pictures === 'all' ? 1 : b.pictures === 'shared' ? 2 : b.pictures === 'none' ? 3 : -1;
          if (v < 0) throw new MailCallError('pictures: all, shared, none or null', 400);
          hub.store.db.query('UPDATE mail_message SET images_allowed = ? WHERE id = ?').run(v, b.messageId);
          return Response.json({ ok: true, body: hub.store.bodyView(b.messageId) });
        }
        const sender = typeof b.sender === 'string' ? b.sender.trim().toLowerCase() : '';
        if (!/^[^\s@]+@[^\s@]+$/.test(sender)) throw new MailCallError('give a messageId, or a sender address', 400);
        // A sender's rule: Always (allow), Never (allow false), or none (forget: the setting decides again).
        if (b.forget) hub.store.db.query('DELETE FROM mail_sender_images WHERE address = ?').run(sender);
        else
          hub.store.db
            .query('INSERT INTO mail_sender_images (address, allow, at) VALUES (?, ?, ?) ON CONFLICT (address) DO UPDATE SET allow = excluded.allow, at = excluded.at')
            .run(sender, b.allow === false ? 0 : 1, Date.now());
        return Response.json({ ok: true });
      },
    },
  ];
};
