/**
 * Links in plain text (a bio, a post): web addresses with or without their scheme, Markdown links, and on X an @handle,
 * as parts to draw. Pure, so tests can import it.
 */
import type * as P from '@dither-chat/protocol';

export type LinkPart = string | { href: string; label: string };

// Common endings of a bare address ("nachotype.com", "dither.link/talk"): a word with a dot is not a link without one,
// so "e.g." or "node.js" stay words.
const TLDS =
  'com|org|net|io|dev|app|co|me|ai|gg|xyz|link|sh|so|to|tv|fm|is|it|de|uk|us|ca|au|fr|nl|eu|jp|ch|se|no|fi|be|at|es|pl|in|info|blog|page|site|tech|art|lol|wtf|cafe|social|space|studio|works|zone|world|club|online|codes|tools|land|moe|ink|im|ly|cc|ws|lgbt|gay|garden|pub|wiki|cv|nz|br|mx|ru|kr|cn|tw|hk|sg';
const BARE = `(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS})(?![a-z0-9-])(?::\\d{2,5})?(?:/[^\\s<>]*)?`;
// A Markdown link; a link with its scheme; www.; a bare address; an @handle (X only, checked below).
const LINK = new RegExp(`\\[([^\\]\\n]+)\\]\\((https?://[^)\\s]+)\\)|(https?://[^\\s<>]+)|(?<![\\w@.])(www\\.[^\\s<>]+|${BARE})|(?<![\\w@])@(\\w{1,30})\\b`, 'gi');
// What usually ends a sentence, not an address.
const TRAIL = /[.,;:!?'"”’)\]]+$/;

/** Text cut into plain runs and links. `network` x: an @handle links to its profile on x.com. */
export function linkParts(text: string, network?: P.Network): LinkPart[] {
  const out: LinkPart[] = [];
  let at = 0;
  const push = (s: string) => {
    if (!s) return;
    if (typeof out[out.length - 1] === 'string') out[out.length - 1] += s;
    else out.push(s);
  };
  for (const m of text.matchAll(LINK)) {
    const start = m.index!;
    let whole = m[0];
    let part: LinkPart | null = null;
    if (m[1]) part = { href: m[2], label: m[1] };
    else if (m[5]) {
      if (network !== 'x') continue;
      part = { href: `https://x.com/${m[5]}`, label: `@${m[5]}` };
    } else {
      const raw = (m[3] ?? m[4])!;
      const trail = raw.match(TRAIL)?.[0] ?? '';
      // A closing bracket is the address's own when it opened one ("wiki/Foo_(bar)").
      const keep = trail.startsWith(')') && raw.slice(0, -trail.length).includes('(') ? ')' : '';
      const url = raw.slice(0, raw.length - trail.length) + keep;
      whole = url;
      if (!/[a-z0-9/]$/i.test(url) && !keep) continue;
      part = { href: m[3] ? url : `https://${url}`, label: url };
    }
    push(text.slice(at, start));
    out.push(part);
    at = start + whole.length;
  }
  push(text.slice(at));
  return out;
}
