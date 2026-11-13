/**
 * Links in plain text (a bio, a post): web addresses with or without their scheme, Markdown links (bios only: a post
 * shows its text as written), and on X an @handle, as parts to draw. Only http(s) links are made. Pure, so tests can
 * import it.
 */
import type * as P from '@dither-chat/protocol';

export type LinkPart = string | { href: string; label: string };

// Endings of a bare address ("nachotype.com", "dither.link/talk"). Lowercase only, and none that is also a common
// word or file ending ("do.it", "build.sh", "lib.so", "Nice.It"): a word with a dot is not a link without one.
const TLDS =
  'com|org|net|io|dev|app|co|ai|gg|xyz|link|tv|fm|uk|de|fr|nl|eu|jp|ch|se|fi|ca|au|es|pl|info|blog|page|site|tech|art|cafe|social|space|studio|works|zone|world|club|online|codes|tools|moe|ink|ly|cc|garden|wiki|cv|nz|br|mx|ru|kr|cn|tw|hk|sg';
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
// Not inside a word, an address or an email (any script's letters count as a word: "bücher.de" is not "cher.de").
const BEFORE = '(?<![\\p{L}\\p{N}_@.\\-/:])';
const BARE = `(?:${LABEL}\\.)+(?:${TLDS})(?![\\p{L}\\p{N}_\\-@])(?::\\d{2,5})?(?:/[^\\s<>]*)?`;
const URL_CHARS = '[^\\s<>]+';
// What usually ends a sentence, not an address.
const TRAIL = /[.,;:!?'"”’)\]]+$/u;

function pattern(markdown: boolean): RegExp {
  return new RegExp(
    [
      markdown ? `\\[([^\\]\\n]+)\\]\\((https?://[^)\\s]+)\\)` : '(?!)()()',
      `${BEFORE}(https?://${URL_CHARS})`,
      `${BEFORE}(www\\.${URL_CHARS}|${BARE})`,
      `(?<![\\p{L}\\p{N}_@])@(\\w{1,30})(?![\\w@.])`,
    ].join('|'),
    'gu',
  );
}
const WITH_MD = pattern(true);
const PLAIN = pattern(false);

/**
 * Text cut into plain runs and links. `network` x: an @handle links to its profile on x.com. `markdown`: a Markdown
 * link `[words](https://…)` shows its words (a bio); off, it stays text as written (a post, where X shows it so).
 */
export function linkParts(text: string, network?: P.Network, markdown = true): LinkPart[] {
  const out: LinkPart[] = [];
  let at = 0;
  const push = (s: string) => {
    if (!s) return;
    if (typeof out[out.length - 1] === 'string') out[out.length - 1] += s;
    else out.push(s);
  };
  for (const m of text.matchAll(markdown ? WITH_MD : PLAIN)) {
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
      if (!url || /^https?:\/\/$/i.test(url)) continue;
      part = { href: m[3] ? url : `https://${url}`, label: url };
    }
    push(text.slice(at, start));
    out.push(part);
    at = start + whole.length;
  }
  push(text.slice(at));
  return out;
}
