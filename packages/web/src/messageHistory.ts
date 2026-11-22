/**
 * One message's history as one list (docs/history.md "A message's history"): its edits, reactions made and taken
 * back, pins, and for your own who got and read it, oldest first so the latest is at the bottom, as in a chat. Opened
 * on all of it, or on only its edits (from "(edited)" and the words an edit put in) or only its reactions (a long
 * press on one, on a phone), with a way from either to all of it. On its own, not in ui/MessageHistory.tsx, so the
 * chat and the reaction pills can open it without importing the list (docs/testing.md "Import cycles").
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';

export type HistoryFocus = 'all' | 'edits' | 'reactions';

/** The history open now: whose, on what, and on a computer what it hangs from (none: the middle of the window). */
export const historyOf = signal<{ m: P.MessageView; focus: HistoryFocus; anchor?: DOMRect } | null>(null);

export function openHistory(m: P.MessageView, focus: HistoryFocus = 'all', anchor?: DOMRect) {
  historyOf.value = { m, focus, anchor };
}

/** Whether there is anything to show beyond the message itself: a reaction with a time counts. */
export const hasHistory = (m: P.MessageView) => !!(m.edits || m.events || m.receipts || m.reactions.some((r) => r.at || r.seenAt));

/** One row of the list. Times are ms; `seen` means the time is when the hub heard, not the network's own. */
export type HistoryItem =
  | { kind: 'sent'; at: number; body?: string }
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
    out.push({ kind: 'sent', at: sentAt, ...(v.length > 1 ? { body: v[0].body } : {}) });
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
