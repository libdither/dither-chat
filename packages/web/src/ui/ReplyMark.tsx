/**
 * Reply marks made on an inbox row (docs/inbox.md, "Marks"), by gesture instead of a menu:
 *
 * - On a computer, a row's ↩ is a button: hovered it shows ✕ and says "No reply needed", and a click takes the ↩ off
 *   without opening the chat. A row with no ↩ shows a faint one in the same place while the pointer is on the row,
 *   "Reply needed". The button sits beside the row's own button, not in it, so Tab reaches it and a screen reader
 *   names it.
 * - On a phone, the same button lies unseen over the ↩, so a tap on the ↩ is "No reply needed". There is no "Reply
 *   needed" there: rows are not swiped, since a left swipe on the list is the pager's (Pager.ts), bringing back the
 *   page peeking at the edge.
 *
 * Both go through markRow, with its Undo toast.
 */
import type { ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { since } from '../format.ts';
import { markRow, needsReplyLabel, REPLY_MARK_LABEL } from '../replymarks.ts';
import { readMinute } from '../state.ts';

/** The ↩ and how long, as the row draws it: the button over it has the same, so it covers it exactly. */
function Age({ at }: { at: number }) {
  readMinute();
  return <>{since(at)}</>;
}

/**
 * Around one inbox row. `owedSince`: the row's ↩ (a reply you owe, or one held by "Reply needed"); `latest`: the
 * newest message from someone else, when "Reply needed" can go on the row at all (not notes to self, not where you
 * wrote last, not mail without a reply owed).
 */
export function MarkableRow({
  rowKey,
  kind,
  ids,
  owedSince,
  needsP,
  canNeed,
  latest,
  fold,
  below,
  children,
}: {
  rowKey: string;
  kind: 'conversation' | 'mail';
  ids: string[];
  owedSince: number | null | undefined;
  /** The chance the reply owed is needed (docs/inbox.md, "Needs a reply"), for the ↩ button's tooltip. */
  needsP?: number | null;
  canNeed: boolean;
  latest?: string;
  /** A control beside the row's own button, as the ↩ is: a channel row's fold (Sidebar.tsx). */
  fold?: ComponentChildren;
  /** What moves with the row, under it: the threads an open channel row lists. */
  below?: ComponentChildren;
  children: ComponentChildren;
}) {
  const owes = owedSince != null;
  const mark: P.ReplyMark | null = owes ? 'none' : canNeed ? 'needs' : null;
  // Nothing to mark and nothing beside it: the row as it is, with no wrapper.
  if (!mark && !fold && !below) return <>{children}</>;
  const label = mark && REPLY_MARK_LABEL[mark];
  const run = () => mark && void markRow(kind, ids, mark, latest);
  const row = (key?: string) => (
    <div class={`inbox-row ${mark ? `markable ${owes ? 'owes' : 'can-need'} mark-${mark}` : ''}`} data-row-key={key}>
      {children}
      {/* Its ↩ and ✕ are drawn by styles.css: one element per row, as the perf budget counts them. */}
      {mark && (
        <button type="button" class="row-mark" aria-label={label!} title={needsP != null ? `${needsReplyLabel(needsP)}. Click: ${label}` : label!} data-track={mark === 'none' ? 'mark no reply needed' : 'mark reply needed'} onClick={run}>
          {owes ? <Age at={owedSince!} /> : null}
        </button>
      )}
      {fold}
    </div>
  );
  if (!below) return row(rowKey);
  // The row and what it opens on move as one: the key goes on both.
  return (
    <div class="inbox-group" data-row-key={rowKey}>
      {row()}
      {below}
    </div>
  );
}
