/**
 * How big a mail is as it goes (docs/mail.md "Sizes"): its text and HTML parts, the pictures inside it, its files, and
 * what the recipient's app fetches on their end (pictures linked from the web). Bytes inside the mail travel as base64,
 * a third bigger, so "sent" counts them that way.
 */
import type * as P from '@dither-chat/protocol';

interface DraftPictures {
  /** Pasted or dropped: inside the mail whatever happens. */
  inside: { n: number; bytes: number };
  /** From the web (a forward's, a quote's, or an address you wrote): their addresses, each once. */
  web: string[];
}

const BASE64 = 4 / 3;

/** A picture's address from a background (an attribute, a style, a sheet): the web's, or this hub's for one. */
const BG_URL = /url\(\s*(['"]?)((?:https?:\/\/|\/api\/mail\/img\/)[^'")\s]+)\1\s*\)/gi;
const fetched = (u: string) => /^(https?:\/\/|\/api\/mail\/img\/)/i.test(u);

/**
 * The HTML's pictures, and its bytes without the pasted ones' data. `island`: the forward or quote as the hub made it,
 * with the bytes it adds to the text part; while it is unchanged that is its share of the text part, not its HTML's text.
 */
export function measureHtml(html: string | null | undefined, island?: { html: string; textBytes?: number } | null): { html: number; islandText: number; pictures: DraftPictures } {
  const pictures: DraftPictures = { inside: { n: 0, bytes: 0 }, web: [] };
  if (!html) return { html: 0, islandText: 0, pictures };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // A forward's or a quote's text goes in the text part too (the hub writes it there from the original).
  let islandText = 0;
  let asMade = island?.textBytes !== undefined && html.includes(island.html);
  for (const el of doc.querySelectorAll('div[data-dc-island]')) {
    if (asMade && (el.getAttribute('data-dc-island') === 'forward' || el.getAttribute('data-dc-island') === 'quote')) {
      islandText += island!.textBytes!;
      asMade = false;
    } else islandText += new Blob([el.textContent ?? '']).size;
  }
  const web = new Set<string>();
  const inside = new Set<string>();
  let dataChars = 0;
  for (const img of doc.querySelectorAll('img')) {
    const orig = img.getAttribute('data-dc-src');
    const src = img.getAttribute('src') ?? '';
    if (orig && /^https?:\/\//i.test(orig)) web.add(orig);
    else if (/^https?:\/\//i.test(src)) web.add(src);
    else if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src) && !inside.has(src)) {
      inside.add(src);
      const b64 = src.slice(src.indexOf(',') + 1);
      pictures.inside.n++;
      pictures.inside.bytes += Math.floor((b64.length * 3) / 4);
    }
  }
  // Backgrounds go as pictures do (embedded, linked or left out).
  for (const el of doc.querySelectorAll('[background]')) {
    const u = el.getAttribute('background') ?? '';
    if (fetched(u)) web.add(u);
  }
  for (const el of doc.querySelectorAll('[style], style')) {
    const css = el.tagName === 'STYLE' ? (el.textContent ?? '') : (el.getAttribute('style') ?? '');
    for (const m of css.matchAll(BG_URL)) web.add(m[2]);
  }
  for (const src of inside) dataChars += src.length * html.split(src).length - src.length;
  pictures.web = [...web];
  return { html: Math.max(0, new Blob([html]).size - dataChars), islandText, pictures };
}

export interface SizeLine {
  text: number;
  html: number;
  inside: { n: number; bytes: number };
  /** `leftOut`: ones Embed leaves out because fetching them now would tell the original sender (the hub has not got them). */
  embedded: { n: number; bytes: number; unknown: number; leftOut: number };
  /** `leftOut`: ones Link leaves out because they can tell (unless linkCanTell). */
  linked: { n: number; bytes: number; unknown: number; canTell: number; leftOut: number };
  files: number;
  /** About what goes over the wire: the parts, the pictures and files as base64. */
  sent: number;
  /** What the recipient's app fetches when they open it (linked pictures it knows the size of). */
  theirEnd: number;
}

/** The sizes as the chosen pictures mode makes them; `known` from POST /api/mail/pictures/sizes. */
export function sizeLine(o: {
  text: string;
  /** Bytes of text the hub adds to the text part (a forward's, a quote's). */
  islandText?: number;
  html: number;
  plainOnly: boolean;
  pictures: DraftPictures;
  mode: P.MailOutgoingPictures;
  /** With Link, the ones that can tell are linked too (MailDraft.linkCanTell). */
  linkCanTell?: boolean;
  known: Map<string, { size: number | null; class: string; cached?: boolean }>;
  files: number;
}): SizeLine {
  const text = new Blob([o.text.replace(/^\[\[island:[\w-]+\]\]$/gm, '')]).size + (o.islandText ?? 0);
  const html = o.plainOnly ? 0 : o.html;
  const inside = o.plainOnly ? { n: 0, bytes: 0 } : o.pictures.inside;
  const embedded = { n: 0, bytes: 0, unknown: 0, leftOut: 0 };
  const linked = { n: 0, bytes: 0, unknown: 0, canTell: 0, leftOut: 0 };
  if (!o.plainOnly && o.mode !== 'drop')
    for (const u of o.pictures.web) {
      const k = o.known.get(u);
      // Embed fetches no picture that can tell: one the hub has not got already is left out (docs/mail.md "Writing").
      if (o.mode === 'embed' && k && k.class !== 'shared' && k.cached === false) {
        embedded.leftOut++;
        continue;
      }
      // Link leaves out the ones that can tell, unless asked to link them too.
      if (o.mode === 'link' && !o.linkCanTell && k && k.class !== 'shared') {
        linked.leftOut++;
        continue;
      }
      const into = o.mode === 'embed' ? embedded : linked;
      into.n++;
      if (k?.size != null) into.bytes += k.size;
      else into.unknown++;
      if (o.mode === 'link' && k?.class === 'personal') linked.canTell++;
    }
  const sent = Math.round(text + html + (inside.bytes + embedded.bytes + o.files) * BASE64);
  return { text, html, inside, embedded, linked, files: o.files, sent, theirEnd: linked.bytes };
}
