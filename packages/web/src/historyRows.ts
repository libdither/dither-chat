/**
 * A message's history as rows (docs/history.md "A message's history"), for ui/MessageHistory.tsx: what happened to
 * it, oldest first, and each edit as only what changed. Loaded with the list, not at start.
 */
import type * as P from '@dither-chat/protocol';
import type { HistoryFocus } from './messageHistory.ts';
import { space, tokens, wordDiff, type Part } from './wordDiff.ts';

/**
 * Only the changes, with up to `around` words either side and `…` where text is left out: what the history list shows
 * for one edit. A change of more than `long` words keeps only its first and last few, so a rewrite does not repeat the
 * whole of the text before it (or after it, which the top of the list shows). A `gap` part stands for the words left
 * out.
 */
export function changesInContext(a: string, b: string, around = 3, long = 12): (Part | { k: 'gap' })[] {
  const parts = wordDiff(a, b);
  const words = (ts: string[]) => ts.filter((t) => !space(t)).length;
  const take = (ts: string[], n: number, fromEnd: boolean) => {
    const seq = fromEnd ? [...ts].reverse() : ts;
    const got: string[] = [];
    let c = 0;
    for (const t of seq) {
      if (c >= n && !space(t)) break;
      got.push(t);
      if (!space(t)) c++;
    }
    return (fromEnd ? got.reverse() : got).join('');
  };
  const out: (Part | { k: 'gap' })[] = [];
  parts.forEach((p, i) => {
    if (p.k !== '=') {
      const ts = tokens(p.t);
      if (words(ts) <= long) return void out.push(p);
      return void out.push({ k: p.k, t: take(ts, 6, false).replace(/\s+$/, '') }, { k: 'gap' }, { k: p.k, t: take(ts, 3, true).replace(/^\s+/, '') });
    }
    const ts = tokens(p.t), first = i === 0, last = i === parts.length - 1, n = words(ts);
    if (first && last) return void out.push(p);
    if (first) return void (n > around ? out.push({ k: 'gap' }, { k: '=', t: take(ts, around, true).replace(/^\s+/, '') }) : out.push(p));
    if (last) return void (n > around ? out.push({ k: '=', t: take(ts, around, false).replace(/\s+$/, '') }, { k: 'gap' }) : out.push(p));
    if (n > around * 2 + 1) out.push({ k: '=', t: take(ts, around, false).replace(/\s+$/, '') }, { k: 'gap' }, { k: '=', t: take(ts, around, true).replace(/^\s+/, '') });
    else out.push(p);
  });
  return out;
}

/** One row of the list. Times are ms; `seen` means the time is when the hub heard, not the network's own. */
export type HistoryItem =
  | { kind: 'sent'; at: number }
  | { kind: 'edit'; at: number; before: string; after: string; actorId: string | null }
  | { kind: 'react'; at: number; seen?: boolean; actorId?: string; key: string }
  | { kind: 'unreact'; at: number; seen?: boolean; actorId?: string; key: string; cleared?: boolean }
  | { kind: 'pin' | 'unpin'; at: number; actorId?: string }
  /** Reactions there before the hub saw the message, with no time: at the top. `more` are counted but not named. */
  | { kind: 'before'; at: number; reactions: { actorId: string; key: string }[]; more: number }
  /** Everyone who read (or played, or got) it between two edits, as one row at the last of them. */
  | { kind: 'receipts'; at: number; from: number; state: P.ReceiptState; who: { identityId: string; at: number }[] };

/**
 * The rows for `focus`, oldest first. Reads (and plays) between two edits fold into one row each, as does every
 * delivery, so a group's receipts do not bury the edits.
 */
export function historyItems(m: P.MessageView, h: P.MessageHistoryView, focus: HistoryFocus): HistoryItem[] {
  const out: HistoryItem[] = [];
  const edits = focus !== 'reactions', reactions = focus !== 'edits', receipts = focus === 'all';
  const v = h.versions;
  const sentAt = v[0]?.at ?? m.ts;
  if (edits) {
    // Sent with no words: the first edit shows what it first said, and the top what it says now.
    out.push({ kind: 'sent', at: sentAt });
    for (let i = 1; i < v.length; i++) out.push({ kind: 'edit', at: v[i].at ?? m.editedTs ?? m.ts, before: v[i - 1].body, after: v[i].body, actorId: m.authorId });
  }
  if (reactions) {
    for (const r of h.reactions) out.push({ kind: 'react', at: r.at, ...(r.seen ? { seen: true } : {}), actorId: r.identityId, key: r.key });
    for (const e of h.events) {
      if (e.kind === 'pin' || e.kind === 'unpin') {
        if (focus === 'all') out.push({ kind: e.kind, at: e.at, actorId: e.actorId });
        continue;
      }
      if (e.kind !== 'unreact') continue;
      const d = (e.data ?? {}) as Partial<P.UnreactData>;
      const key = d.key ?? '';
      if (d.added != null) out.push({ kind: 'react', at: d.added, ...(d.addedSeen ? { seen: true } : {}), actorId: e.actorId, key });
      out.push({ kind: 'unreact', at: e.at, ...(e.seen ? { seen: true } : {}), actorId: e.actorId, key, ...(d.cleared ? { cleared: true } : {}) });
    }
    // Reactions on it now with no time: there before the hub saw it, or from someone it cannot name.
    const timed = new Set(h.reactions.map((r) => `${r.identityId}|${r.key}`));
    const before: { actorId: string; key: string }[] = [];
    let more = 0;
    for (const r of m.reactions) {
      for (const id of r.identityIds) if (!timed.has(`${id}|${r.key}`) && r.at?.[id] == null && r.seenAt?.[id] == null) before.push({ actorId: id, key: r.key });
      more += Math.max(0, r.count - r.identityIds.length);
    }
    if (before.length || more) out.push({ kind: 'before', at: sentAt, reactions: before, more });
  }
  if (receipts && h.receipts.length) {
    // Edit times split the reads: who read which version.
    const cuts = v.slice(1).map((x) => x.at ?? 0);
    const segment = (at: number) => cuts.filter((c) => c <= at).length;
    const groups = new Map<string, { state: P.ReceiptState; who: { identityId: string; at: number }[] }>();
    for (const r of h.receipts) {
      const k = r.state === 'delivered' ? 'delivered' : `${r.state}|${segment(r.at)}`;
      const g = groups.get(k) ?? groups.set(k, { state: r.state, who: [] }).get(k)!;
      g.who.push({ identityId: r.identityId, at: r.at });
    }
    for (const g of groups.values()) out.push({ kind: 'receipts', state: g.state, who: g.who, from: g.who[0].at, at: g.who[g.who.length - 1].at });
  }
  // Oldest first; at the same moment, what the message is before what was done to it.
  const rank: Record<HistoryItem['kind'], number> = { sent: 0, before: 1, edit: 2, receipts: 3, pin: 4, unpin: 4, react: 5, unreact: 6 };
  return out.sort((a, b) => a.at - b.at || rank[a.kind] - rank[b.kind]);
}
