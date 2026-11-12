/**
 * A preview card and what can be done with it (docs/add.md): the card New's card page shows (NewPages.tsx), and the
 * one under a message (InviteCard.tsx), with the same actions; and the check-first and confirm-first lines, which
 * request cards use too (Requests.tsx). Small and loaded with the app: the pages of New load with the palette's.
 */
import type * as P from '@dither-chat/protocol';
import { RELATIONSHIP_LABEL } from '@dither-chat/protocol';
import type { JSX } from 'preact';
import { ACTION_LABEL, CHECK_LINE, expiresIn, messagePeer, partialLine, previewCounts, previewKind, type AddRow } from '../add.ts';
import { identityName, netName } from '../model.ts';
import { confirmNext, sentence } from '../requests.ts';
import { api, applyEvents, db, go, openDirect, toast } from '../state.ts';
import { LiveView } from './Accounts.tsx';
import { AccountChip, Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import { homeRoute } from './Sidebar.tsx';
import { Loading } from './Loader.tsx';

/** A reading being looked up, its preview, and what acting on it did. */
export interface Card {
  row: AddRow;
  accountId: string;
  loading: boolean;
  view?: P.AddPreviewView;
  error?: string;
  acting?: P.AddAction;
  actError?: string;
  done?: P.AddResultView;
  /** The action `done` answers: what "Add anyway" sends again. */
  doneAction?: P.AddAction;
}


/** Where something joined or found lives. */
export function openAdded(conversationId?: string | null, spaceId?: string | null) {
  const c = conversationId ? db.conversations.get(conversationId) : undefined;
  if (c) go(homeRoute(c));
  else if (spaceId) go({ view: 'space', space: spaceId });
}

/**
 * Act on a preview, from the New box or a card under a message (InviteCard.tsx): the same steps either way. `set` shows
 * the card's progress; `leave` closes what it is in before going where it landed. `confirm`: the owner pressed "Add
 * anyway" after the network asked. What was done, or null.
 */
export async function actOn(c: Card, action: P.AddAction, set: (c: Card) => void, leave: () => void, confirm = false): Promise<P.AddResultView | null> {
  const v = c.view!;
  set({ ...c, acting: action, actError: undefined });
  try {
    if (action === 'message') {
      const peer = messagePeer(v);
      if (!peer) throw new Error(`${netName(v.ref.network)} did not say how to reach them.`);
      const r = await openDirect(c.accountId, peer);
      if (!r.conversation) throw new Error('The network did not say which conversation it opened.');
      leave();
      go({ view: 'inbox', conv: r.conversation.id });
      return null;
    }
    const r = await api<P.AddResultView>('/api/add', { body: { accountId: c.accountId, ref: v.ref, action, ...(confirm ? { confirm: true } : {}) } });
    if (r.conversation) applyEvents([{ t: 'conversation', conversation: r.conversation }]);
    if (!r.check && !r.confirm && !r.pending && (r.conversation || r.spaceId)) {
      leave();
      openAdded(r.conversation?.id, r.spaceId);
      if (r.notes.length) toast({ kind: 'info', title: v.name, body: r.notes.join(' ') });
      return r;
    }
    set({ ...c, acting: undefined, done: r, doneAction: action });
    return r;
  } catch (e: any) {
    set({ ...c, acting: undefined, done: undefined, actError: String(e?.message ?? e) });
    return null;
  }
}

/** A preview and what can be done with it. `inline`: a card under a message, which has no Back to the box. */
export function AddCard({ card, live, setLive, onAccount, onAct, onOpen, onBack, onClose, inline }: { card: Card; live: boolean; setLive: (on: boolean) => void; onAccount: (id: string) => void; onAct: (a: P.AddAction, confirm?: boolean) => void; onOpen: (conversationId?: string | null, spaceId?: string | null) => void; onBack: () => void; onClose: () => void; inline?: boolean }) {
  const { row, view: v, done } = card;
  const net = row.ref.network;
  const accounts = row.state.kind === 'resolve' ? row.state.accounts : [];
  const account = db.accounts.get(card.accountId);
  const counts = v ? previewCounts(v) : null;
  const back = (
    <button class="btn ghost small" onClick={onBack}>
      Back
    </button>
  );
  return (
    <div class="add-card-wrap">
      {accounts.length > 1 && (
        <div class="new-message-from">
          <span>As</span>
          <div class="level-picker">
            {accounts.map((a) => (
              <button class={`chip-btn ${card.accountId === a.id ? 'on' : ''}`} disabled={card.loading || !!card.acting} onClick={() => card.accountId !== a.id && onAccount(a.id)}>
                <AccountChip account={a} small />
              </button>
            ))}
          </div>
        </div>
      )}
      {card.loading && <Loading inline label={`Asking ${netName(net)}…`} />}
      {card.error && (
        <>
          <p class="new-message-error add-error" role="alert">
            <Icon name="alert" size={13} /> {card.error}
          </p>
          <div class="btn-row">{back}</div>
        </>
      )}
      {v && (
        <div class="add-card">
          <div class="add-card-head">
            <Avatar id={v.nativeId ?? row.key} name={v.name} url={v.avatar} size={48} square={v.what !== 'person'} network={net} />
            <div class="add-card-title">
              <b class="add-card-name">{v.name}</b>
              <small>
                {previewKind(v, net)}
                {counts ? ` · ${counts}` : ''}
              </small>
            </div>
          </div>
          {v.partial && (
            <p class="set-help add-partial">
              <Icon name="info" size={13} /> {partialLine(v.actions)}
            </p>
          )}
          {v.description && <p class="add-card-desc">{v.description}</p>}
          {v.inviter && <p class="set-help">Invited by {identityName(v.inviter)}</p>}
          {v.expires !== null && <p class="set-help">{expiresIn(v.expires)}</p>}
          {v.relationship && v.relationship !== 'stranger' && <p class="set-help">{RELATIONSHIP_LABEL[v.relationship]}</p>}
          {v.notes.map((n) => (
            <p class="set-help add-note">{n}</p>
          ))}
        </div>
      )}
      {v && !done && (
        <>
          {!v.actions.length && !v.joined && <p class="set-help add-none">There is nothing {account?.label ?? 'this account'} can do with this yet.</p>}
          {card.actError && (
            <p class="new-message-error add-error" role="alert">
              <Icon name="alert" size={13} /> {card.actError}
            </p>
          )}
          <div class="btn-row add-actions">
            {v.joined && (
              <button class="btn small" onClick={() => onOpen(v.joined!.conversation, v.joined!.space)}>
                Open
              </button>
            )}
            {v.actions.map((a, i) => (
              <button class={`btn small ${i ? 'ghost' : 'primary'}`} data-action={a} disabled={!!card.acting} onClick={() => onAct(a)}>
                {card.acting === a ? `${ACTION_LABEL[a]}…` : ACTION_LABEL[a]}
              </button>
            ))}
            {!inline && back}
          </div>
        </>
      )}
      {done && <AddDone card={card} result={done} setLive={setLive} onClose={onClose} onConfirm={() => card.doneAction && onAct(card.doneAction, true)} back={inline ? null : back} />}
      {live && account && <LiveView account={account} onClose={() => setLive(false)} />}
    </div>
  );
}

/**
 * The network wants a check only you can do (a captcha, proving it is you, Discord's rules): where to do it, and that
 * nothing was done. Also on request cards (Requests.tsx). `onLeave`: before going to the account's page.
 */
export function CheckFirst({ network, result: r, setLive, onLeave, back }: { network: P.Network; result: P.AddResultView; setLive: (on: boolean) => void; onLeave: () => void; back: JSX.Element | null }) {
  if (!r.check) return null;
  return (
    <div class="add-done add-check">
      <p class="set-help">
        <Icon name="alert" size={13} /> {netName(network)} wants a check first: {CHECK_LINE[r.check]}, in the account's live view. Nothing was done.
      </p>
      <div class="btn-row">
        {r.liveView ? (
          <button class="btn small add-live" onClick={() => setLive(true)}>
            <Icon name="monitor" size={13} /> Open live view
          </button>
        ) : r.managerUrl ? (
          <a class="btn small add-live" href={r.managerUrl} target="_blank" rel="noopener">
            <Icon name="external" size={13} /> Open it on dither-accounts
          </a>
        ) : (
          <button class="btn small add-live" onClick={() => (onLeave(), go({ view: 'accounts', account: r.accountId }))}>
            <Icon name="monitor" size={13} /> Open the account
          </button>
        )}
        {back}
      </div>
    </div>
  );
}

/**
 * The network wants you to confirm first, or flagged what you are about to accept: its words, that nothing is done
 * yet, and the button that sends it with confirm (`data-confirm`). Also on request cards and DM banners (Requests.tsx).
 */
export function ConfirmFirst({ words, verb, busy, onConfirm, canMessage, children }: { words: string; verb: 'accept' | 'add'; busy: boolean; onConfirm: () => void; canMessage: boolean; children?: JSX.Element | (JSX.Element | null | false)[] | null }) {
  const label = verb === 'accept' ? 'Accept anyway' : 'Add anyway';
  return (
    <div class="add-done add-confirm">
      <p class="request-warning" role="alert">
        <Icon name="alert" size={13} /> <span>{sentence(words)}</span>
      </p>
      <p class="set-help">{confirmNext(verb, canMessage)}</p>
      <div class="btn-row">
        <button class="btn small" data-confirm={verb} disabled={busy} onClick={onConfirm}>
          {busy ? `${label}…` : label}
        </button>
        {children}
      </div>
    </div>
  );
}

/** After an action that did not land somewhere to open: asked, a check first, a confirm first, or someone added. */
function AddDone({ card, result: r, setLive, onClose, onConfirm, back }: { card: Card; result: P.AddResultView; setLive: (on: boolean) => void; onClose: () => void; onConfirm: () => void; back: JSX.Element | null }) {
  if (r.check) return <CheckFirst network={card.row.ref.network} result={r} setLive={setLive} onLeave={onClose} back={back} />;
  if (r.confirm) return <ConfirmFirst words={r.confirm} verb="add" busy={!!card.acting} onConfirm={onConfirm} canMessage={false}>{back}</ConfirmFirst>;
  return (
    <div class="add-done">
      <p class="set-help add-done-line">
        <Icon name="check" size={13} /> {r.pending ? 'Asked; waiting on them.' : r.relationship ? `Done: ${RELATIONSHIP_LABEL[r.relationship].toLowerCase()}.` : 'Done.'}
      </p>
      {r.notes.map((n) => (
        <p class="set-help add-note">{n}</p>
      ))}
      <div class="btn-row">
        <button class="btn small" onClick={onClose}>
          Close
        </button>
        {back}
      </div>
    </div>
  );
}
