/**
 * A second opinion for the writing tests. The model checks its own wire with its own reader (read.ts, check.ts); a test
 * that asked the same code whether it was right would prove nothing. This reads each wire by the network's own
 * documented syntax, with none of the model's code: which words are in it at all, and which can be read without
 * tapping anything. GitHub's is read by a real CommonMark parser (Bun's).
 */
import type { Node } from '../src/writing/doc.ts';

/** The words of a draft (the generator's W1W, W2W…) and which of them it hides. A mention's name is not on a wire. */
export function tokens(d: Node): { all: string[]; hidden: string[] } {
  const out = { all: [] as string[], hidden: [] as string[] };
  const of = (s: unknown) => String(s ?? '').match(/W\d+W/g) ?? [];
  const walk = (n: Node, hidden: boolean) => {
    const hid = hidden || !!n.marks?.some((m) => m.type === 'spoiler');
    const add = (s: unknown, h: boolean) => (out.all.push(...of(s)), h && out.hidden.push(...of(s)));
    if (n.type === 'text') add(n.text, hid);
    if (n.type === 'fold') add(n.attrs?.title, hid);
    if (n.type === 'raw') add(n.attrs?.text, hid);
    for (const c of n.content ?? []) walk(c, hid || (n.type === 'fold' && n.attrs?.why !== 'long'));
  };
  walk(d, false);
  return out;
}

const blank = (s: string, ranges: [number, number][]) => {
  const units = s.split('');
  for (const [at, n] of ranges) for (let i = at; i < at + n; i++) units[i] = ' ';
  return units.join('');
};

/** HTML as text, without what sits in an element that hides (a spoiler span, a <details> but for its summary). */
function shownHtml(html: string): string {
  let out = '';
  const stack: boolean[] = [];
  let depth = 0;
  let summary = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      if (!depth || (summary && depth === 1)) out += m[4];
      continue;
    }
    out += ' ';
    if (/^(br|hr|img)$/i.test(m[2])) continue;
    if (!m[1]) {
      const hides = (m[2] === 'span' && /data-mx-spoiler/.test(m[3])) || m[2] === 'details';
      stack.push(hides);
      if (hides) depth++;
      if (m[2] === 'summary') summary++;
    } else {
      if (stack.pop()) depth--;
      if (m[2] === 'summary') summary--;
    }
  }
  return out;
}

const markdown = (Bun as unknown as { markdown?: { html(s: string, o: object): string } }).markdown;

/** What a wire holds (`all`) and what of it is read without a tap (`seen`); null where this file has no way to say. */
export function reading(id: string, wire: any): { all: string; seen: string } | null {
  const all = typeof wire === 'string' ? wire : JSON.stringify(wire);
  switch (id) {
    case 'signal':
      return { all, seen: blank(wire.message, wire.textStyle.filter((x: string) => x.endsWith(':SPOILER')).map((x: string) => x.split(':').slice(0, 2).map(Number))) };
    case 'telegram':
      return { all, seen: blank(wire.message, wire.entities.filter((e: any) => e._ === 'messageEntitySpoiler').map((e: any) => [e.offset, e.length])) };
    case 'discord':
      return { all, seen: String(wire.content).replace(/\\[\s\S]/g, '§').replace(/```[\s\S]*?```/g, (m) => m.replace(/\|/g, '§')).replace(/\|\|[\s\S]*?\|\|/g, ' ') };
    case 'reddit':
      return { all, seen: String(wire.text).replace(/\\[\s\S]/g, '§').replace(/>![\s\S]*?!</g, ' ') };
    case 'github': {
      if (!markdown) return null;
      const html = markdown.html(String(wire), { tables: true, strikethrough: true, autolinks: true, tasklists: true });
      return { all: html.replace(/<[^>]*>/g, ' '), seen: shownHtml(html) };
    }
    case 'zulip': {
      const lines = String(wire).split('\n');
      const seen: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:> ?)*\s*(`{3,})spoiler( .*)?$/.exec(lines[i]);
        if (!m) {
          seen.push(lines[i]);
          continue;
        }
        seen.push(m[2] ?? '');
        while (++i < lines.length && !new RegExp('^\\s*(?:> ?)*\\s*`{' + m[1].length + ',}\\s*$').test(lines[i]));
      }
      return { all, seen: seen.join('\n') };
    }
    case 'matrix':
      // The plain copy is read by notifications: what it holds is seen.
      return { all, seen: shownHtml(wire.formatted_body) + ' ' + wire.body };
    default:
      // Nothing can be hidden there: all of it is seen.
      return { all, seen: all };
  }
}
