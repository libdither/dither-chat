/**
 * Random drafts for the writing tests: every kind of block, style and thing in the text, nested at random, with the
 * characters a network could take for its own markers typed among the words. A seed makes a run the same every time.
 */
import type { Mark, Node } from '../src/writing/doc.ts';

const MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'spoiler', 'color', 'sub', 'sup'];
/** Typed characters that are markers somewhere. */
const TYPED = ['*', '_', '~', '`', '**', '__', '~~', '||', '# ', '> ', '- ', '1. ', '+ ', '---', '|', '[x]', '(y)', '<b>', '&amp;', '&', '\\', '  ', '!', '.', ',', '"', '^', '>!', '@everyone', 'https://example.org/a_b_c*d', '-# ', '=', '```', '``'];
const IDS = { signal: 'uuid-1', discord: '8001', telegram: '7001', matrix: '@w:example.org', slack: 'U8W', zulip: '17', whatsapp: '15550100', bluesky: 'did:plc:w', mastodon: 'w@example.social', github: 'wgh', reddit: 'wrd', x: 'wx' };

export function drafts(seed: number, typed = true) {
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  let wid = 0;
  const word = () => 'W' + wid++ + 'W';
  const run = () => {
    let s = word();
    if (typed && rnd() < 0.35) s = pick(TYPED) + s;
    if (typed && rnd() < 0.25) s = s + pick(TYPED);
    if (rnd() < 0.3) s = ' ' + s;
    if (rnd() < 0.3) s = s + ' ';
    if (rnd() < 0.2) s = s + ' ' + word();
    return s;
  };
  const inl = (): Node[] => {
    const out: Node[] = [];
    for (let i = 1 + Math.floor(rnd() * 4); i > 0; i--) {
      const r = rnd();
      const marks: Mark[] = MARKS.filter(() => rnd() < 0.13).map((m) => (m === 'color' ? { type: m, attrs: { color: '#f00' } } : { type: m }));
      if (rnd() < 0.12) marks.push({ type: 'link', attrs: { href: 'https://example.org/' + wid } });
      const on = marks.length ? { marks } : {};
      if (r < 0.07) out.push({ type: 'mention', attrs: { kind: pick(['user', 'user', 'role', 'channel', 'everyone']), label: word(), ids: rnd() < 0.7 ? IDS : {} }, ...on });
      else if (r < 0.1) out.push({ type: 'hardBreak' });
      else if (r < 0.13) out.push({ type: 'emoji', attrs: { name: word(), id: '9' }, ...on });
      else if (r < 0.16) out.push({ type: 'time', attrs: { at: 1700000000 } });
      else if (r < 0.18) out.push({ type: 'footnote', attrs: { n: 1 } });
      else out.push({ type: 'text', text: run(), ...on });
    }
    return out;
  };
  const blk = (depth: number): Node => {
    const r = rnd();
    const kids = () => Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => blk(depth + 1));
    if (depth > 3 || r < 0.4) return { type: 'paragraph', content: rnd() < 0.08 ? [] : inl() };
    if (r < 0.47) return { type: 'heading', attrs: { level: 1 + Math.floor(rnd() * 6) }, content: inl() };
    if (r < 0.57) return { type: 'blockquote', content: kids() };
    if (r < 0.7) return { type: pick(['bulletList', 'orderedList']), ...(rnd() < 0.2 ? { attrs: { start: 3 } } : {}), content: Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => ({ type: 'listItem', content: [{ type: 'paragraph', content: inl() }, ...(rnd() < 0.5 ? kids() : [])] })) };
    if (r < 0.78) return { type: 'codeBlock', ...(rnd() < 0.5 ? { attrs: { language: 'js' } } : {}), content: [{ type: 'text', text: word() + (typed && rnd() < 0.3 ? '\n```\n' : '\n') + '  ' + word() + '\n\n' + word() }] };
    if (r < 0.81) return { type: 'horizontalRule' };
    if (r < 0.88) return { type: 'table', content: [0, 1].map((i) => ({ type: 'tableRow', content: [0, 1].map(() => ({ type: i ? 'tableCell' : 'tableHeader', content: rnd() < 0.7 ? [{ type: 'paragraph', content: inl() }] : kids() })) })) };
    if (r < 0.94) return { type: 'fold', attrs: { title: word(), ...(rnd() < 0.3 ? { why: 'long' } : {}) }, content: kids() };
    if (r < 0.96) return { type: 'image', attrs: { src: 'https://example.org/p.png', alt: 'a picture' } };
    if (r < 0.98) return { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: inl() }] }] };
    const [a, b] = [word(), word()];
    return { type: 'raw', attrs: { format: 'html', source: `<div><b>${a}</b>\n\n<i>${b}</i></div>`, text: `${a} ${b}` } };
  };
  return (): Node => {
    wid = 0;
    return { type: 'doc', content: Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => blk(0)) };
  };
}
