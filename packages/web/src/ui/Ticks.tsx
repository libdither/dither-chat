/**
 * Your message's ticks (docs/history.md "A message's history"): delivered ✓, read ✓✓ (coloured), played ▶. A click
 * opens its history. Not in ui/MessageHistory.tsx, which loads only when a history opens.
 */
import type * as P from '@dither-chat/protocol';
import { fullTime } from '../format.ts';
import { historyOf } from '../messageHistory.ts';
import { identityName } from '../model.ts';
import { db, isSelfIdentity } from '../state.ts';
import { Icon } from './icons.tsx';

export const STATE: Record<P.ReceiptState, string> = { delivered: 'Delivered to', read: 'Read by', played: 'Played by' };

export function Ticks({ m }: { m: P.MessageView }) {
  const r = m.receipts;
  if (!r || !isSelfIdentity(m.authorId)) return null;
  const top: P.ReceiptState = r.played ? 'played' : r.read ? 'read' : 'delivered';
  const n = r[top];
  const who = r.latest.state === top ? (db.persons.get(db.identities.get(r.latest.identityId)?.personId ?? '')?.name ?? identityName(r.latest.identityId)) : null;
  const title = n === 1 && who ? `${STATE[top]} ${who}, ${fullTime(r.latest.at)}` : `${STATE[top]} ${n}${r.delivered > n ? `, delivered to ${r.delivered}` : ''}`;
  return (
    <button class={`msg-ticks ${top}`} title={title} aria-label={title} onClick={(e) => (historyOf.value = { m, focus: 'all', anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
      {top === 'played' ? <Icon name="play" size={11} /> : <Icon name={top === 'read' ? 'checks' : 'check'} size={13} />}
      {n > 1 && <span>{n}</span>}
    </button>
  );
}
