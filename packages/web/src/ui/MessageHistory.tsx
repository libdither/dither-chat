/**
 * One message's history (docs/history.md): its versions, oldest first; pins, and reactions made and taken back, by
 * whom and when (docs/reactions.md "When"); and for your own, who got, read and played it. From "(edited)", the ticks
 * on your message, or History in its menu.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { fullTime } from '../format.ts';
import { identityName, plainBody } from '../model.ts';
import { whenTitle } from '../reactions.ts';
import { api, db, isSelfIdentity, rev } from '../state.ts';
import { Avatar, Modal } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Glyph } from './Reactions.tsx';
import { Loading } from './Loader.tsx';

export const historyOf = signal<P.MessageView | null>(null);

export function MessageHistoryLayer() {
  const m = historyOf.value;
  return m ? (
    <Modal title="Message history" onClose={() => (historyOf.value = null)}>
      <MessageHistory m={m} />
    </Modal>
  ) : null;
}

/** Whether there is anything to show beyond the message itself: a reaction with a time counts. */
export const hasHistory = (m: P.MessageView) => !!(m.edits || m.events || m.receipts || m.reactions.some((r) => r.at || r.seenAt));

/** One line of "What happened to it". `seen`: the time is when the hub heard, not the network's own. */
interface Happening {
  at: number;
  seen?: boolean;
  actorId?: string;
  what: 'reacted' | 'took back' | 'cleared' | 'pinned' | 'unpinned';
  key?: string;
}

/** Pins, reactions made (those there now and those taken back), and reactions taken back, in the order they happened. */
function happenings(h: P.MessageHistoryView): Happening[] {
  const out: Happening[] = (h.reactions ?? []).map((r) => ({ at: r.at, seen: r.seen, actorId: r.identityId, what: 'reacted', key: r.key }));
  for (const e of h.events) {
    if (e.kind === 'pin' || e.kind === 'unpin') out.push({ at: e.at, actorId: e.actorId, what: e.kind === 'pin' ? 'pinned' : 'unpinned' });
    if (e.kind !== 'unreact') continue;
    const d = (e.data ?? {}) as Partial<P.UnreactData>;
    if (d.added != null) out.push({ at: d.added, seen: d.addedSeen, actorId: e.actorId, what: 'reacted', key: d.key });
    out.push({ at: e.at, seen: e.seen, actorId: e.actorId, what: d.cleared ? 'cleared' : 'took back', key: d.key });
  }
  return out.sort((a, b) => a.at - b.at);
}

const STATE: Record<P.ReceiptState, string> = { delivered: 'Delivered to', read: 'Read by', played: 'Played by' };

export function MessageHistory({ m }: { m: P.MessageView }) {
  rev.value;
  const [h, setH] = useState<P.MessageHistoryView | null>(null);
  useEffect(() => {
    api<P.MessageHistoryView>(`/api/messages/${m.id}/history`).then(
      (x) => {
        for (const i of x.identities) if (!db.identities.has(i.id)) db.identities.set(i.id, i);
        setH(x);
      },
      () => setH({ versions: [], events: [], reactions: [], receipts: [], identities: [] }),
    );
  }, [m.id, m.body, m.events, m.reactions, m.receipts?.read, m.receipts?.delivered]);
  if (!h) return <Loading label="Loading…" />;
  const name = (id?: string) => (!id ? 'Someone' : isSelfIdentity(id) ? 'You' : (db.persons.get(db.identities.get(id)?.personId ?? '')?.name ?? identityName(id)));
  // Each person once per state, the first time.
  const by = new Map<P.ReceiptState, { identityId: string; at: number }[]>();
  for (const r of h.receipts) by.set(r.state, [...(by.get(r.state) ?? []), r]);
  const happened = happenings(h);
  // A custom emoji still on the message draws as itself; one taken back from it, by its name.
  const emojiOf = (key?: string) => m.reactions.find((r) => r.key === key)?.emoji;
  return (
    <div class="msg-history">
      {h.versions.length > 1 && (
        <section>
          <h4>Versions</h4>
          {h.versions.map((v, i) => (
            <div class={`edit-version ${i === h.versions.length - 1 ? 'now' : ''}`}>
              <span class="edit-when">
                {i === h.versions.length - 1 ? 'Now' : i === 0 ? 'First' : `Edit ${i}`}
                {v.at ? ` · ${fullTime(v.at)}` : ''}
              </span>
              <span class="edit-body">{plainBody(v.body, m.network) || 'Empty'}</span>
            </div>
          ))}
        </section>
      )}
      {happened.length > 0 && (
        <section>
          <h4>What happened to it</h4>
          {happened.map((e) => {
            const glyph = <Glyph k={e.key ?? ''} emoji={emojiOf(e.key)} size={15} />;
            return (
              <div class="msg-history-event">
                <Icon name={e.what === 'pinned' || e.what === 'unpinned' ? 'pin' : 'smile'} size={13} />
                <span>
                  <b>{name(e.actorId)}</b>{' '}
                  {e.what === 'pinned' ? 'pinned it' : e.what === 'unpinned' ? 'unpinned it' : e.what === 'cleared' ? <>had {glyph} removed by a moderator</> : e.what === 'reacted' ? <>reacted {glyph}</> : <>took back {glyph}</>}
                </span>
                <time title={e.seen ? whenTitle({ at: e.at, seen: true }) : undefined}>
                  {e.seen ? '~' : ''}
                  {fullTime(e.at)}
                </time>
              </div>
            );
          })}
        </section>
      )}
      {(['played', 'read', 'delivered'] as P.ReceiptState[]).map((s) => {
        const list = by.get(s);
        return list?.length ? (
          <section>
            <h4>
              {STATE[s]} {list.length}
            </h4>
            {list.map((r) => {
              const i = db.identities.get(r.identityId);
              const p = i?.personId ? db.persons.get(i.personId) : null;
              return (
                <div class="msg-history-event">
                  <Avatar id={p?.id ?? r.identityId} name={name(r.identityId)} url={p?.avatar ?? i?.avatar} size={20} />
                  <span>{name(r.identityId)}</span>
                  <time>{fullTime(r.at)}</time>
                </div>
              );
            })}
          </section>
        ) : null;
      })}
      {h.versions.length <= 1 && !happened.length && !h.receipts.length && <p class="edit-loading">Nothing kept about this message yet.</p>}
    </div>
  );
}

/** Your message's ticks: delivered ✓, read ✓✓ (coloured), played ▶. */
export function Ticks({ m }: { m: P.MessageView }) {
  const r = m.receipts;
  if (!r || !isSelfIdentity(m.authorId)) return null;
  const top: P.ReceiptState = r.played ? 'played' : r.read ? 'read' : 'delivered';
  const n = r[top];
  const who = r.latest.state === top ? (db.persons.get(db.identities.get(r.latest.identityId)?.personId ?? '')?.name ?? identityName(r.latest.identityId)) : null;
  const title = n === 1 && who ? `${STATE[top]} ${who}, ${fullTime(r.latest.at)}` : `${STATE[top]} ${n}${r.delivered > n ? `, delivered to ${r.delivered}` : ''}`;
  return (
    <button class={`msg-ticks ${top}`} title={title} aria-label={title} onClick={() => (historyOf.value = m)}>
      {top === 'played' ? <Icon name="play" size={11} /> : <Icon name={top === 'read' ? 'checks' : 'check'} size={13} />}
      {n > 1 && <span>{n}</span>}
    </button>
  );
}
