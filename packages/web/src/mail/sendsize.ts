/**
 * How big a mail is as it goes (docs/mail.md "Sizes"): its text and HTML parts, the pictures inside it, its files, and
 * what the recipient's app fetches on their end (pictures linked from the web). Bytes inside the mail travel as base64,
 * a third bigger, so "sent" counts them that way.
 */
import type * as P from '@dither-chat/protocol';

export interface DraftPictures {
  /** Pasted or dropped: inside the mail whatever happens. */
  inside: { n: number; bytes: number };
  /** From the web (a forward's, a quote's, or an address you wrote): their addresses, each once. */
  web: string[];
}

const BASE64 = 4 / 3;

/** The HTML's pictures, and its bytes without the pasted ones' data. */
export function measureHtml(html: string | null | undefined): { html: number; islandText: number; pictures: DraftPictures } {
  const pictures: DraftPictures = { inside: { n: 0, bytes: 0 }, web: [] };
  if (!html) return { html: 0, islandText: 0, pictures };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // A forward's or a quote's text goes in the text part too (the hub writes it there from the original).
  let islandText = 0;
  for (const el of doc.querySelectorAll('div[data-dc-island]')) islandText += new Blob([el.textContent ?? '']).size;
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
  for (const src of inside) dataChars += src.length * html.split(src).length - src.length;
  pictures.web = [...web];
  return { html: Math.max(0, new Blob([html]).size - dataChars), islandText, pictures };
}

export interface SizeLine {
  text: number;
  html: number;
  inside: { n: number; bytes: number };
  embedded: { n: number; bytes: number; unknown: number };
  linked: { n: number; bytes: number; unknown: number; canTell: number };
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
  known: Map<string, { size: number | null; class: string }>;
  files: number;
}): SizeLine {
  const text = new Blob([o.text.replace(/^\[\[island:[\w-]+\]\]$/gm, '')]).size + (o.islandText ?? 0);
  const html = o.plainOnly ? 0 : o.html;
  const inside = o.plainOnly ? { n: 0, bytes: 0 } : o.pictures.inside;
  const embedded = { n: 0, bytes: 0, unknown: 0 };
  const linked = { n: 0, bytes: 0, unknown: 0, canTell: 0 };
  if (!o.plainOnly && o.mode !== 'drop')
    for (const u of o.pictures.web) {
      const k = o.known.get(u);
      const into = o.mode === 'embed' ? embedded : linked;
      into.n++;
      if (k?.size != null) into.bytes += k.size;
      else into.unknown++;
      if (o.mode === 'link' && k?.class === 'personal') linked.canTell++;
    }
  const sent = Math.round(text + html + (inside.bytes + embedded.bytes + o.files) * BASE64);
  return { text, html, inside, embedded, linked, files: o.files, sent, theirEnd: linked.bytes };
}
