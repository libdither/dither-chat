/**
 * The search box's little language, shared by hub and PWA:
 *   rust "borrow checker" -async from:alice in:dev network:discord has:image mentions:me after:2026-01-01 before:2026-02-01 sort:relevance
 * Anything that is not a known operator is text, so "from:" alone or "http://x" still search as typed.
 */
export interface SearchQuery {
  terms: string[];
  phrases: string[];
  not: string[];
  from: string[];
  in: string[];
  network: string[];
  has: string[];
  mentionsMe: boolean;
  after: number | null;
  before: number | null;
  relevance: boolean;
}

export const SEARCH_HAS = ['attachment', 'image', 'video', 'audio', 'file', 'link', 'reaction'] as const;

function day(s: string, end: boolean): number | null {
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (end) return d ? new Date(y, m - 1, d + 1).getTime() : new Date(y, m, 1).getTime();
  return new Date(y, m - 1, d ?? 1).getTime();
}

export function parseSearch(input: string): SearchQuery {
  const q: SearchQuery = { terms: [], phrases: [], not: [], from: [], in: [], network: [], has: [], mentionsMe: false, after: null, before: null, relevance: false };
  for (const m of input.matchAll(/(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g)) {
    const [whole, neg, op, quoted, bare] = m;
    const val = quoted ?? bare ?? '';
    if (!val) continue;
    const key = op?.toLowerCase();
    if (!neg && key) {
      if (key === 'from') { q.from.push(val); continue; }
      if (key === 'in') { q.in.push(val); continue; }
      if (key === 'network' || key === 'on') { q.network.push(val.toLowerCase()); continue; }
      if (key === 'has' && (SEARCH_HAS as readonly string[]).includes(val.toLowerCase())) { q.has.push(val.toLowerCase()); continue; }
      if (key === 'mentions' && val.toLowerCase() === 'me') { q.mentionsMe = true; continue; }
      if (key === 'sort' && val.toLowerCase() === 'relevance') { q.relevance = true; continue; }
      if (key === 'after' && day(val, true) !== null) { q.after = day(val, true); continue; }
      if (key === 'before' && day(val, false) !== null) { q.before = day(val, false); continue; }
    }
    const text = op ? whole.replace(/^-/, '').replace(/"/g, '') : val;
    if (neg) q.not.push(text);
    else if (quoted !== undefined && !op) q.phrases.push(text);
    else q.terms.push(text);
  }
  return q;
}

/** The query with one operator set, cleared or toggled, for the filter buttons. */
export function setSearchOp(input: string, op: string, value: string | null): string {
  const re = new RegExp(`(^|\\s)${op}:(?:"[^"]*"|\\S+)`, 'gi');
  const rest = input.replace(re, '').replace(/\s+/g, ' ').trim();
  if (value === null || value === '') return rest;
  const v = /\s/.test(value) ? `"${value}"` : value;
  return `${rest} ${op}:${v}`.trim();
}

export function searchOp(input: string, op: string): string | null {
  const m = input.match(new RegExp(`(?:^|\\s)${op}:(?:"([^"]*)"|(\\S+))`, 'i'));
  return m ? (m[1] ?? m[2]) : null;
}
