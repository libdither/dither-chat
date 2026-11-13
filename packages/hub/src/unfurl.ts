/**
 * A link preview for a message you send (protocol LinkPreviewOut, docs/messages.md): the first link in the text, its
 * page's title, description and picture, the way Signal's own apps make one on the sender's device. Only for an
 * account whose adapter offers 'linkPreviews', which Signal's does only while your phone's link-preview setting is on.
 *
 * It goes through the media proxy's rules (fetchsafe.ts): the public internet only (every redirect checked again), no
 * credentials in the URL, at most PAGE_MAX of the page and IMAGE_MAX of the picture, a few seconds each. Anything that
 * goes wrong is no preview, never a failed send.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { fetchPublicToFile, type Lookup } from './fetchsafe.ts';

export const PAGE_MAX = 512 * 1024;
export const IMAGE_MAX = 1024 * 1024;
const TIMEOUT_MS = 5_000;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 300;

/** The first http(s) link in a message body, outside code. */
export function firstLink(body: string): string | null {
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const m = /https?:\/\/[^\s<>"'`)\]]+/i.exec(text);
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?*_~|]+$/, '');
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
const clean = (s: string | undefined, max: number) => {
  const t = s ? decode(s).replace(/\s+/g, ' ').trim() : '';
  return t ? (t.length > max ? t.slice(0, max - 1) + '…' : t) : undefined;
};

/** Title, description and picture from a page's HTML: Open Graph first, then Twitter's tags, then <title> and the description. */
export function parsePreview(html: string, base: string): { title?: string; description?: string; image?: string } {
  const head = html.slice(0, PAGE_MAX);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
    const key = attr('property') ?? attr('name');
    const content = attr('content');
    if (!key || !content) continue;
    const k = (key[1] ?? key[2] ?? key[3]).toLowerCase();
    if (!meta.has(k)) meta.set(k, content[1] ?? content[2] ?? content[3]);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, TITLE_MAX);
  const description = clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), DESCRIPTION_MAX);
  let image: string | undefined;
  const raw = meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image');
  if (raw) {
    try {
      const u = new URL(decode(raw), base);
      if (u.protocol === 'https:' || u.protocol === 'http:') image = u.toString();
    } catch {}
  }
  return { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(image ? { image } : {}) };
}

/**
 * Fetch `url` and make its preview, with its picture in `dir` as `<stem>.img` (the caller deletes it after the send).
 * Null when the page is not public, not HTML, too big, slow, or has no title.
 */
export async function unfurl(url: string, dir: string, stem: string, opts: { lookup?: Lookup; fetch?: typeof fetch; allowPrivate?: boolean } = {}): Promise<P.LinkPreviewOut | null> {
  const page = join(dir, `${stem}.html`);
  const img = join(dir, `${stem}.img`);
  try {
    const got = await fetchPublicToFile(url, page, { maxBytes: PAGE_MAX, timeoutMs: TIMEOUT_MS, ...opts });
    if (!got.ok || !/^text\/html|^application\/xhtml\+xml/i.test(got.mime)) return null;
    const p = parsePreview(readFileSync(page, 'utf8'), url);
    if (!p.title) return null;
    const out: P.LinkPreviewOut = { url, title: p.title, ...(p.description ? { description: p.description } : {}) };
    if (p.image) {
      const pic = await fetchPublicToFile(p.image, img, { maxBytes: IMAGE_MAX, timeoutMs: TIMEOUT_MS, ...opts }).catch(() => null);
      if (pic?.ok && /^image\/(jpeg|png|webp|gif)\b/i.test(pic.mime)) out.image = img;
      else rmSync(img, { force: true });
    }
    return out;
  } catch {
    rmSync(img, { force: true });
    return null;
  } finally {
    rmSync(page, { force: true });
  }
}
