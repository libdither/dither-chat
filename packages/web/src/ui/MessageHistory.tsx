/**
 * One message's history (docs/history.md): its versions, oldest first; pins and reactions taken back, by whom; and for
 * your own, who got, read and played it. From "(edited)", the ticks on your message, or History in its menu.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { fullTime } from '../format.ts';
import { identityName, plainBody } from '../model.ts';
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

/** Whether there is anything to show beyond the message itself. */
export const hasHistory = (m: P.MessageView) => !!(m.edits || m.events || m.receipts);

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
      () => setH({ versions: [], events: [], receipts: [], identities: [] }),
    );
  }, [m.id, m.body, m.events, m.receipts?.read, m.receipts?.delivered]);
  if (!h) return <Loading label="Loading…" />;
  const name = (id?: string) => (!id ? 'Someone' : isSelfIdentity(id) ? 'You' : (db.persons.get(db.identities.get(id)?.personId ?? '')?.name ?? identityName(id)));
  // Each person once per state, the first time.
  const by = new Map<P.ReceiptState, { identityId: string; at: number }[]>();
  for (const r of h.receipts) by.set(r.state, [...(by.get(r.state) ?? []), r]);
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
      {h.events.length > 0 && (
        <section>
          <h4>What happened to it</h4>
          {h.events.map((e) => {
            const d = (e.data ?? {}) as { key?: string; cleared?: boolean };
            return (
              <div class="msg-history-event">
                <Icon name={e.kind === 'unreact' ? 'smile' : 'pin'} size={13} />
                <span>
                  <b>{name(e.actorId)}</b>{' '}
                  {e.kind === 'pin' ? 'pinned it' : e.kind === 'unpin' ? 'unpinned it' : d.cleared ? <>had <Glyph k={d.key ?? ''} size={15} /> removed by a moderator</> : <>took back <Glyph k={d.key ?? ''} size={15} /></>}
                </span>
                <time>{fullTime(e.at)}</time>
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
      {h.versions.length <= 1 && !h.events.length && !h.receipts.length && <p class="edit-loading">Nothing kept about this message yet.</p>}
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
