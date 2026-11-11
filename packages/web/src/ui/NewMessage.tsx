/**
 * New: start a conversation, join a server or group, or add someone (docs/add.md). Someone known, or anything typed
 * or pasted: an invite link, an address, an @username, a phone number.
 */
import type * as P from '@dither-chat/protocol';
import { directTarget, RELATIONSHIP_LABEL } from '@dither-chat/protocol';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ACTION_LABEL, addRows, CHECK_LINE, expiresIn, isLink, messagePeer, offlineNetworks, partialLine, previewCounts, previewKind, type AddRow } from '../add.ts';
import { directNote, openers } from '../direct.ts';
import { directsOf, identityName, netName } from '../model.ts';
import { confirmNext, sentence } from '../requests.ts';
import { api, applyEvents, db, go, newMessage, openDirect, rev, toast } from '../state.ts';
import { LiveView } from './Accounts.tsx';
import { MyCodes, ScanCode } from './QrCodes.tsx';
import { AccountChip, Avatar, NetBadge, useDialog } from './bits.tsx';
import { Icon } from './icons.tsx';
import { homeRoute } from './Sidebar.tsx';
import { fuzzyScore } from './Switcher.tsx';
import { Loading } from './Loader.tsx';

interface Target {
  network: P.Network;
  /** The address: an identity's native id, or what was typed. */
  peer: string;
  name: string;
}

interface Row {
  key: string;
  name: string;
  avatar: string | null;
  identities: P.IdentityView[];
}

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

const identityTarget = (i: P.IdentityView): Target => ({ network: i.network, peer: i.nativeId, name: identityName(i.id) });
const isMine = (i: P.IdentityView) => [...db.accounts.values()].some((a) => a.selfIdentityId === i.id);

function knownPeople(): Row[] {
  const rows: Row[] = [];
  for (const p of db.persons.values()) {
    if (p.isSelf) continue;
    const identities = p.identityIds.map((id) => db.identities.get(id)).filter((i): i is P.IdentityView => !!i && !isMine(i));
    if (identities.length) rows.push({ key: p.id, name: p.name, avatar: p.avatar, identities });
  }
  for (const i of db.identities.values()) if (!i.personId && !isMine(i)) rows.push({ key: i.id, name: identityName(i.id), avatar: i.avatar, identities: [i] });
  return rows;
}

const TITLE = { join: 'Join a server or group', add: 'Add someone' } as const;
const QR_TITLE = { scan: 'Scan a code', mine: 'My code' } as const;

export function NewMessage() {
  rev.value;
  const v = newMessage.value;
  return v ? <NewMessageBox identityId={v.identityId} q={v.q} mode={v.mode} /> : null;
}

function NewMessageBox({ identityId, q: given, mode }: { identityId?: string; q?: string; mode?: 'join' | 'add' }) {
  const known = identityId ? db.identities.get(identityId) : undefined;
  const [q, setQ] = useState(given ?? '');
  const [target, setTarget] = useState<Target | null>(known ? identityTarget(known) : null);
  const [card, setCard] = useState<Card | null>(null);
  const [live, setLive] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Scanning a code, or showing your own (docs/add.md, "QR codes"). */
  const [qr, setQr] = useState<'scan' | 'mine' | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const pasted = useRef(false);
  const asked = useRef(0);
  const close = () => (newMessage.value = null);
  const dialog = useDialog(close);
  useEffect(() => box.current?.focus(), [target, card, qr]);

  const needle = q.trim();
  const accounts = [...db.accounts.values()];
  const canStart = (n: P.Network) => openers(accounts, n).length > 0;
  const readings = addRows(needle, accounts);
  const offline = readings.length ? [] : offlineNetworks(needle, accounts);
  const people = knownPeople()
    .filter((r) => r.identities.some((i) => canStart(i.network)))
    .map((r) => ({ r, s: fuzzyScore(`${r.name} ${r.identities.map((i) => i.handle ?? '').join(' ')}`, needle) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s! - a.s! || a.r.name.localeCompare(b.r.name))
    .slice(0, 8)
    .map((x) => x.r);

  /** Ask an account what a reading is. Only from a click, a paste or Enter: never per keystroke. */
  const resolve = async (row: AddRow, via?: string) => {
    if (row.state.kind !== 'resolve') return;
    const acc = row.state.accounts.find((a) => a.id === via) ?? row.state.accounts[0];
    const n = ++asked.current;
    setCard({ row, accountId: acc.id, loading: true });
    try {
      const v = await api<P.AddPreviewView>('/api/add/resolve', { body: { accountId: acc.id, ref: row.ref } });
      if (v.identities.length) applyEvents(v.identities.map((identity) => ({ t: 'identity', identity }) as P.ClientEvent));
      if (n === asked.current) setCard({ row, accountId: acc.id, loading: false, view: v });
    } catch (e: any) {
      if (n === asked.current) setCard({ row, accountId: acc.id, loading: false, error: String(e?.message ?? e) });
    }
  };
  /** A link resolves at once; anything else waits for its row to be clicked. */
  const resolveLink = (text: string) => {
    if (!isLink(text)) return;
    const row = addRows(text.trim(), accounts).find((r) => r.state.kind === 'resolve');
    if (row) void resolve(row);
  };
  useEffect(() => {
    if (given) resolveLink(given);
  }, []);
  /** A scanned code fills the box as a paste would: a link is looked up, nothing is acted on. */
  const scanned = (text: string) => {
    setQr(null);
    setQ(text);
    resolveLink(text);
  };

  /** Someone you already have a DM with on this network: go there, nothing to create. */
  const choose = (i: P.IdentityView) => {
    const dm = i.personId ? directsOf(i.personId).find((d) => d.network === i.network) : undefined;
    if (dm) {
      close();
      return go({ view: 'inbox', conv: dm.id });
    }
    setError(null);
    setTarget(identityTarget(i));
  };

  const start = async () => {
    if (!target) return;
    const from = openers(accounts, target.network);
    const account = from.find((a) => a.id === accountId) ?? from[0];
    if (!account) return setError(`No connected ${netName(target.network)} account can start this.`);
    const address = directTarget(target.network, target.peer);
    if ('error' in address) return setError(address.error);
    setBusy(true);
    setError(null);
    try {
      const r = await openDirect(account.id, address.peer);
      if (!r.conversation) throw new Error('The network did not say which conversation it opened.');
      close();
      go({ view: 'inbox', conv: r.conversation.id });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const open = (conversationId?: string | null, spaceId?: string | null) => (close(), openAdded(conversationId, spaceId));
  const act = (c: Card, action: P.AddAction, confirm?: boolean) => void actOn(c, action, setCard, close, confirm);

  const from = target ? openers(accounts, target.network) : [];
  const title = target ? `Message ${target.name} on ${netName(target.network)}` : card ? card.row.label : qr ? QR_TITLE[qr] : mode ? TITLE[mode] : 'New';
  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && dialog.dismiss()}>
      <div class="modal new-message" role="dialog" aria-label={mode ? TITLE[mode] : 'New'} ref={dialog.box}>
        <div class="sheet-grip" aria-hidden="true" />
        <header class="modal-head">
          <h2>{title}</h2>
          <button class="icon-btn small" onClick={close} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </header>
        <div class="modal-body">
          {target ? (
            <>
              {from.length > 1 && (
                <div class="new-message-from">
                  <span>Send as</span>
                  <div class="level-picker">
                    {from.map((a) => (
                      <button class={`chip-btn ${(accountId ?? from[0].id) === a.id ? 'on' : ''}`} onClick={() => setAccountId(a.id)}>
                        <AccountChip account={a} small />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <p class="set-help">{directNote(target.network, target.name)}</p>
              {!from.length && <p class="set-help"><Icon name="alert" size={13} /> No connected {netName(target.network)} account can start this.</p>}
              {error && <p class="new-message-error" role="alert"><Icon name="alert" size={13} /> {error}</p>}
              <div class="btn-row">
                <button class="btn small" disabled={busy || !from.length} onClick={start}>
                  <Icon name="send" size={13} /> {busy ? 'Opening…' : 'Open conversation'}
                </button>
                {!known && (
                  <button class="btn ghost small" onClick={() => setTarget(null)}>
                    Back
                  </button>
                )}
              </div>
            </>
          ) : card ? (
            <AddCard card={card} live={live} setLive={setLive} onAccount={(id) => resolve(card.row, id)} onAct={(a, confirm) => act(card, a, confirm)} onOpen={open} onBack={() => (++asked.current, setCard(null), setLive(false))} onClose={close} />
          ) : qr ? (
            <>
              {qr === 'scan' ? <ScanCode onLink={scanned} /> : <MyCodes />}
              <div class="btn-row">
                <button class="btn ghost small qr-back" onClick={() => setQr(null)}>
                  Back
                </button>
              </div>
            </>
          ) : (
            <>
              <input
                ref={box}
                class="input"
                placeholder="Name, invite link, @username or phone"
                value={q}
                onPaste={() => (pasted.current = true)}
                onInput={(e) => {
                  const value = (e.target as HTMLInputElement).value;
                  setQ(value);
                  if (pasted.current) {
                    pasted.current = false;
                    resolveLink(value);
                  }
                }}
                onKeyDown={(e) => e.key === 'Enter' && resolveLink(q)}
              />
              <div class="new-message-qr">
                <button class="btn ghost small qr-scan-btn" onClick={() => setQr('scan')}>
                  <Icon name="scan" size={13} /> Scan a code
                </button>
                <button class="btn ghost small qr-mine-btn" onClick={() => setQr('mine')}>
                  <Icon name="qr" size={13} /> My code
                </button>
              </div>
              <div class="new-message-list">
                {readings.map((r) =>
                  r.state.kind === 'resolve' ? (
                    <button class="link-row add-reading" data-network={r.ref.network} data-kind={r.ref.kind} onClick={() => resolve(r)}>
                      <NetBadge network={r.ref.network} size={20} /> <span class="add-reading-label">{r.label}</span> <small>Look it up</small>
                    </button>
                  ) : r.state.kind === 'direct' ? (
                    <button class="link-row add-reading" data-network={r.ref.network} data-kind={r.ref.kind} onClick={() => setTarget({ network: r.ref.network, peer: (r.state as { peer: string }).peer, name: needle })}>
                      <NetBadge network={r.ref.network} size={20} /> Message <b>{needle}</b> <small>on {netName(r.ref.network)}</small>
                    </button>
                  ) : (
                    <p class="set-help add-unbuilt" data-network={r.ref.network}>
                      <NetBadge network={r.ref.network} size={16} /> {r.state.line}
                    </p>
                  ),
                )}
                {offline.length > 0 && <p class="set-help">No connected {netName(offline[0])} account here can do this.</p>}
                {people.map((r) => (
                  <div class="new-message-row">
                    <Avatar id={r.key} name={r.name} url={r.avatar} size={28} />
                    <span class="new-message-name">{r.name}</span>
                    {r.identities.filter((i) => canStart(i.network)).map((i) => (
                      <button class="chip-btn" title={`${netName(i.network)}: ${i.handle ?? i.nativeId}`} onClick={() => choose(i)}>
                        <NetBadge network={i.network} size={14} /> {netName(i.network)}
                      </button>
                    ))}
                  </div>
                ))}
                {!readings.length && !offline.length && !people.length && (
                  <p class="set-help">Nobody by that name. Paste an invite link to join a server or group, or type an @username, a Matrix ID, or a phone number with its country code. On Discord, someone your account has seen, or their username.</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
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
