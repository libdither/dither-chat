/**
 * A mail thread as a tree (docs/places.md "A thread as a chat or a tree"), pure: each mail under the one it answers
 * (In-Reply-To to Message-ID), by the rule a post's replies follow (ui/feed/tree.ts `runOf`): a mail with one answer
 * goes on in the same column, and only a mail with two answers or more steps in. So a thread where nobody branched is
 * in the order of its chat, and `branched` says whether the tree is worth offering.
 */
import type * as P from '@dither-chat/protocol';

export interface MailTreeRow {
  /** How far in it steps: one for each branching above it. */
  depth: number;
  /** The first mail of the branch it is in (the one that stepped in), or null at the top: what its rail folds. */
  branch: string | null;
  /** Mails under it in its branch, when it starts one. */
  size: number;
}

export interface MailTree {
  /** The mails in the tree's order: each after the one it answers, answers to the same mail oldest first. */
  order: P.MessageView[];
  rows: Map<string, MailTreeRow>;
  /** Some mail has two answers or more. */
  branched: boolean;
}

/** A thread held whole, as a tree. Mails whose parent is not here (or not mail) start at the top, by time. */
export function mailTree(msgs: readonly P.MessageView[]): MailTree {
  const byMid = new Map<string, P.MessageView>();
  for (const m of msgs) if (m.mail?.messageId) byMid.set(m.mail.messageId, m);
  const parentOf = (m: P.MessageView) => {
    const p = m.mail?.inReplyTo ? byMid.get(m.mail.inReplyTo) : undefined;
    return p && p !== m ? p : undefined;
  };
  const kids = new Map<string, P.MessageView[]>();
  const roots: P.MessageView[] = [];
  const byTime = [...msgs].sort((a, b) => a.ts - b.ts);
  for (const m of byTime) {
    const p = parentOf(m);
    if (p) (kids.get(p.id) ?? kids.set(p.id, []).get(p.id)!).push(m);
    else roots.push(m);
  }
  const order: P.MessageView[] = [];
  const rows = new Map<string, MailTreeRow>();
  let branched = false;
  const seen = new Set<string>();
  // Returns how many mails it put (itself and all under it).
  const visit = (m: P.MessageView, depth: number, branch: string | null): number => {
    // A loop of In-Reply-To (a broken client) is cut where it comes back.
    if (seen.has(m.id)) return 0;
    seen.add(m.id);
    order.push(m);
    const row: MailTreeRow = { depth, branch, size: 0 };
    rows.set(m.id, row);
    const ks = kids.get(m.id) ?? [];
    if (ks.length > 1) branched = true;
    let n = 0;
    for (const k of ks) n += ks.length === 1 ? visit(k, depth, branch) : visit(k, depth + 1, k.id);
    if (branch === m.id) row.size = n;
    return 1 + n;
  };
  for (const r of roots) visit(r, 0, null);
  // What a loop left out goes at the end, by time.
  for (const m of byTime) if (!seen.has(m.id)) visit(m, 0, null);
  return { order, rows, branched };
}
