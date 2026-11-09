/**
 * Requests waiting on you (docs/add.md "Requests"): the inbox's Requests row, the Requests view with a card per
 * request and the buttons it offers, the bar that stands in for the composer in a held message request, the buttons
 * on a profile (Add friend, Follow, Add contact, Accept, Decline), and how your accounts stand with someone
 * ("Relationships"): a DM's banner for a friend request either way, and Remove friend, Cancel request, Unblock,
 * Remove contact and Unfollow on a profile and in People.
 */
import type * as P from '@dither-chat/protocol';
import { RELATIONSHIP_LABEL, REMOVE_LABEL } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ACTION_LABEL } from '../add.ts';
import { identityPeer } from '../direct.ts';
import { ago } from '../format.ts';
import { identityName, netName } from '../model.ts';
import { accountLine, ANSWER_LABEL, canRemove, groupRequests, linkRows, messageRequestNote, profileLinks, relation, removeNote, removeQuestion, requestLine, requestsRow, sentence, targetMembers } from '../requests.ts';
import { api, applyEvents, db, go, openDirect, openProfile, rev, toast } from '../state.ts';
import { LiveView } from './Accounts.tsx';
import { Avatar, Empty, Menu, Modal, NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';
import { CheckFirst, ConfirmFirst } from './NewMessage.tsx';
import { Action } from './ProfileShell.tsx';
import { homeRoute } from './Sidebar.tsx';

/**
 * Answer one: the hub asks the network. Answered, it is gone here at once; the hub's requests event says the same.
 * `confirm`: the owner pressed "Accept anyway" after the network's words. A check or a confirm leaves it waiting.
 */
export async function answerRequest(r: P.RequestView, answer: P.RequestAnswer, confirm = false): Promise<P.AddResultView> {
  const res = await api<P.AddResultView>(`/api/requests/${encodeURIComponent(r.id)}`, { body: { answer, ...(confirm ? { confirm: true } : {}) } });
  const events: P.ClientEvent[] = res.conversation ? [{ t: 'conversation', conversation: res.conversation }] : [];
  if (!res.check && !res.confirm) events.push({ t: 'requests', requests: db.requests.filter((x) => x.id !== r.id) });
  if (events.length) applyEvents(events);
  return res;
}

/** This account can open a DM with them now. */
function canMessage(accountId: string, identityId: string | null): boolean {
  const a = db.accounts.get(accountId);
  const i = identityId ? db.identities.get(identityId) : undefined;
  return !!a && !!i && a.status === 'online' && a.capabilities.includes('openDirect') && !!identityPeer(i);
}

/**
 * The DM with someone on one account: the one there is, else one opened through the hub (POST /api/directs, as the
 * New box does). A network that will not open it throws its own words.
 */
export async function messageOn(accountId: string, identityId: string): Promise<string> {
  const i = db.identities.get(identityId);
  if (!i) throw new Error('Nobody by that id here');
  const have = [...db.conversations.values()].find((c) => c.shape === 'direct' && c.network === i.network && c.participantIds.includes(identityId) && c.vantages.some((v) => v.accountId === accountId));
  if (have) return have.id;
  const peer = identityPeer(i);
  if (!peer) throw new Error(`${netName(i.network)} did not say how to reach them.`);
  const r = await openDirect(accountId, peer);
  if (!r.conversation) throw new Error('The network did not say which conversation it opened.');
  return r.conversation.id;
}

/** Where an accepted request lands: the conversation, else the space. */
function landOn(res: P.AddResultView): boolean {
  const c = res.conversation ? db.conversations.get(res.conversation.id) : undefined;
  if (c) go(c.shape === 'direct' || c.shape === 'group' ? { view: 'inbox', conv: c.id } : homeRoute(c));
  else if (res.spaceId) go({ view: 'space', space: res.spaceId });
  else return false;
  return true;
}

/**
 * The inbox's row for what waits on you: how many, and from whom. Silent: it counts on no badge. Not one of the
 * ranked rows (`data-row`): it stays at the top.
 */
export function RequestsRow() {
  const row = requestsRow(db.requests, (id) => (id ? identityName(id) : 'Someone'));
  if (!row) return null;
  return (
    <button class="row requests-row" data-track="requests row" onClick={() => go({ view: 'requests' })} title="Friend requests, invites and message requests waiting on you">
      <span class="row-avatar">
        <span class="requests-icon">
          <Icon name="userPlus" size={18} />
        </span>
      </span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            Requests <span class="requests-count">{row.count}</span>
          </span>
          <span class="row-time">{ago(row.lastAt)}</span>
        </span>
        <span class="row-bottom">
          <span class="row-preview">
            {row.names.join(', ')}
            {row.count > row.names.length ? '…' : ''}
          </span>
        </span>
      </span>
    </button>
  );
}

export function RequestsPane({ focus, onBack }: { focus?: string; onBack?: () => void }) {
  rev.value;
  const groups = groupRequests(db.requests);
  const count = db.requests.length;
  useEffect(() => {
    if (focus) document.querySelector(`[data-request="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focus, count > 0]);
  return (
    <section class="pane requests-pane" aria-label="Requests">
      <header class="conv-head">
        {onBack && (
          <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
            <Icon name="back" />
          </button>
        )}
        <span class="conv-head-icon requests-icon">
          <Icon name="userPlus" size={18} />
        </span>
        <div class="conv-head-text">
          <h2>Requests</h2>
          <div class="conv-head-sub">
            <span class="muted-label">{count ? `${count} waiting on you` : 'Nothing waiting on you'}</span>
          </div>
        </div>
      </header>
      <div class="requests-scroll">
        {!groups.length && (
          <Empty icon="check" title="Nothing waiting on you">
            When someone asks to be friends, invites you somewhere or writes to you without being a contact, it waits here.
          </Empty>
        )}
        {groups.map((g) => (
          <section class="requests-group" data-kind={g.kind}>
            <h3>
              {g.title} <span class="section-count">{g.requests.length}</span>
            </h3>
            {g.requests.map((r) => (
              <RequestCard key={r.id} r={r} focused={r.id === focus} />
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}

function RequestCard({ r, focused }: { r: P.RequestView; focused: boolean }) {
  const who = r.from ? db.identities.get(r.from) : undefined;
  const name = r.from ? identityName(r.from) : 'Someone';
  const account = db.accounts.get(r.accountId);
  const conv = r.kind === 'message' && r.target?.kind === 'conversation' && r.target.id ? db.conversations.get(r.target.id) : undefined;
  const members = targetMembers(r);
  const said = conv?.lastMessage?.text?.trim();
  return (
    <article class={`request-card ${focused ? 'focused' : ''} ${r.warning ? 'warned' : ''}`} data-request={r.id} data-kind={r.kind} data-network={r.network}>
      <div class="request-head">
        <button class="request-avatar" onClick={() => openProfile(r.from)} disabled={!r.from} aria-label={`${name}'s profile`} title={`${name}'s profile`}>
          <Avatar id={who?.id ?? r.id} name={name} url={who?.avatar} size={44} network={r.network} />
        </button>
        <div class="request-text">
          <div class="request-title">
            <button class="link-btn request-name" onClick={() => openProfile(r.from)} disabled={!r.from}>
              {name}
            </button>{' '}
            {requestLine(r)}
          </div>
          <small class="request-meta">
            {members && <span>{members} · </span>}
            <span class="request-to">
              {account && <span class="acc-dot" style={{ background: account.color }} />}
              {accountLine(r.network, account?.label)}
            </span>{' '}
            · <time>{ago(r.ts)}</time>
          </small>
          {who?.handle && <small class="request-handle">{who.handle}</small>}
        </div>
      </div>
      {r.kind === 'message' && (
        <>
          {said && <p class="request-said">“{said.length > 280 ? `${said.slice(0, 280)}…` : said}”</p>}
          <p class="set-help request-note">
            <Icon name="eyeOff" size={13} />
            <span>{messageRequestNote(r.network, name)}</span>
          </p>
          {conv && (
            <button class="btn ghost small request-read" onClick={() => go({ view: 'inbox', conv: conv.id })}>
              <Icon name="eye" size={13} /> Read what they wrote
            </button>
          )}
        </>
      )}
      <Answers r={r} name={name} message={r.kind === 'friend' || r.kind === 'follow'} />
    </article>
  );
}

/**
 * The buttons a request offers, and what answering did: an error on the spot, the check screen, or where it landed.
 * Block asks once more first. A request the network flagged shows its words above the buttons, and Accept takes a
 * second click ("Accept anyway"), which confirms; so does an answer that came back asking for a confirm.
 * `message`: a Message button that opens or starts the DM on the account it came to. `after`: what to do once it is
 * answered, besides landing somewhere.
 */
function Answers({ r, name, after, message }: { r: P.RequestView; name: string; after?: (answer: P.RequestAnswer, res: P.AddResultView) => void; message?: boolean }) {
  const [busy, setBusy] = useState<P.RequestAnswer | 'message' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<P.AddResultView | null>(null);
  const [blocking, setBlocking] = useState(false);
  // The network's words to confirm: its warning once Accept is pressed, or what an answer came back with.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const account = db.accounts.get(r.accountId);
  const messageable = !!message && canMessage(r.accountId, r.from);
  const answer = async (a: P.RequestAnswer, confirm = false) => {
    if (a === 'block' && !blocking) return setBlocking(true);
    if (a === 'accept' && r.warning && !confirm) return setConfirming(r.warning);
    setBusy(a);
    setError(null);
    try {
      const res = await answerRequest(r, a, confirm);
      if (res.check) return setCheck(res);
      if (res.confirm) return setConfirming(res.confirm);
      setConfirming(null);
      if (res.notes.length) toast({ kind: 'info', title: name, body: res.notes.join(' ') });
      if (a === 'accept' && landOn(res)) return;
      if (a === 'accept' && res.relationship) toast({ kind: 'info', title: name, body: r.kind === 'follow' ? 'They follow you now.' : 'You are friends now.' });
      after?.(a, res);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
      setBlocking(false);
    }
  };
  // Opens or starts the DM on the account it came to; a network that will not deliver to them says so here.
  const write = async () => {
    setBusy('message');
    setError(null);
    try {
      go({ view: 'inbox', conv: await messageOn(r.accountId, r.from!) });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  };
  const back = (
    <button class="btn ghost small" onClick={() => setCheck(null)}>
      Back
    </button>
  );
  const messageBtn = messageable && (
    <button class="btn ghost small request-message" data-answer="message" disabled={!!busy} onClick={write} title={`Open your DM with ${name} on ${netName(r.network)} ${account?.label ?? ''}, without answering`}>
      <Icon name="send" size={13} /> {busy === 'message' ? 'Opening…' : 'Message'}
    </button>
  );
  return (
    <div class="request-answers">
      {error && (
        <p class="new-message-error request-error" role="alert">
          <Icon name="alert" size={13} /> {error}
        </p>
      )}
      {r.warning && !confirming && !check && (
        <p class="request-warning">
          <Icon name="alert" size={13} /> <span>{sentence(r.warning)}</span>
        </p>
      )}
      {check ? (
        <CheckFirst network={r.network} result={check} setLive={setLive} onLeave={() => {}} back={back} />
      ) : confirming ? (
        <ConfirmFirst words={confirming} verb="accept" busy={busy === 'accept'} onConfirm={() => answer('accept', true)} canMessage={messageable}>
          {messageBtn}
          <button class="btn ghost small" disabled={!!busy} onClick={() => setConfirming(null)}>
            Back
          </button>
        </ConfirmFirst>
      ) : blocking ? (
        <div class="btn-row request-actions">
          <span class="set-help">
            Block {name} on {netName(r.network)}?
          </span>
          <button class="btn small danger" data-answer="block" disabled={!!busy} onClick={() => answer('block')}>
            {busy === 'block' ? 'Blocking…' : 'Block'}
          </button>
          <button class="btn ghost small" onClick={() => setBlocking(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div class="btn-row request-actions">
          {r.answers.map((a) => (
            <button class={`btn small ${a === 'accept' && !r.warning ? 'primary' : 'ghost'}`} data-answer={a} disabled={!!busy} onClick={() => answer(a)}>
              {busy === a ? `${ANSWER_LABEL[a]}…` : ANSWER_LABEL[a]}
            </button>
          ))}
          {messageBtn}
          {!r.answers.length && <span class="set-help">This one can only be answered on {netName(r.network)} itself.</span>}
        </div>
      )}
      {live && account && <LiveView account={account} onClose={() => setLive(false)} />}
    </div>
  );
}

/**
 * Stands in for the composer while a conversation is an open message request: what they wrote can be read here,
 * and the network hears nothing until Accept. Accepted, the composer comes back; declined or blocked, it goes.
 */
export function RequestBar({ r }: { r: P.RequestView }) {
  const name = r.from ? identityName(r.from) : 'They';
  return (
    <div class="request-bar" role="region" aria-label="Message request">
      <p class="set-help request-note">
        <Icon name="eyeOff" size={13} />
        <span>
          <b>{name} is not in your contacts.</b> {messageRequestNote(r.network, name)}
        </span>
      </p>
      <Answers r={r} name={name} after={(a) => a !== 'accept' && go(db.requests.length ? { view: 'requests' } : { view: 'inbox' })} />
    </div>
  );
}

const CONNECT_ICON = { friend: 'userPlus', follow: 'plus', contact: 'userPlus' } as const;

/**
 * A profile's buttons for how you stand with them on each network (requests.ts `relation`): Add friend, Follow or Add
 * contact for a stranger; Accept and Decline for someone who asked; "Request sent" and "Following" to say so.
 * Nothing where no account can. `onChanged`: the network's new word on how you stand, for the page to show.
 */
export function ConnectActions({ identities, abouts, onChanged }: { identities: P.IdentityView[]; abouts: Record<string, P.PersonAboutView | undefined>; onChanged: (about: P.PersonAboutView) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<{ network: P.Network; res: P.AddResultView } | null>(null);
  // The network's words before "Accept anyway" or "Add anyway", and what sends it again with confirm.
  const [confirming, setConfirming] = useState<{ key: string; about: P.PersonAboutView; words: string; verb: 'accept' | 'add'; again: () => Promise<P.AddResultView>; fallback?: P.PersonRelationship } | null>(null);
  const [live, setLive] = useState(false);
  const accounts = [...db.accounts.values()];
  const several = new Set(identities.map((i) => i.network)).size > 1;
  const on = (n: P.Network) => (several ? ` on ${netName(n)}` : '');
  const done = (about: P.PersonAboutView, res: P.AddResultView, ask?: Omit<NonNullable<typeof confirming>, 'about' | 'words'>) => {
    if (res.check) return setCheck({ network: about.network, res });
    if (res.confirm && ask) return setConfirming({ ...ask, about, words: res.confirm });
    if (res.relationship) onChanged({ ...about, relationship: res.relationship });
    if (res.notes.length) toast({ kind: 'info', title: netName(about.network), body: res.notes.join(' ') });
  };
  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    try {
      await f();
    } catch (e: any) {
      toast({ kind: 'error', title: 'That did not go through', body: String(e?.message ?? e) });
    } finally {
      setBusy(null);
    }
  };
  const buttons = identities.flatMap((i) => {
    const about = abouts[i.id];
    const rel = about ? relation(about, i, accounts, db.requests) : null;
    if (!about || !rel) return [];
    if (rel.kind === 'state') return [<Action icon="check" label={`${rel.label}${on(i.network)}`} kind="relationship" disabled />];
    if (rel.kind === 'connect') {
      const key = `${i.id}:${rel.action}`;
      return [
        <Action
          icon={CONNECT_ICON[rel.action]}
          label={`${busy === key ? `${ACTION_LABEL[rel.action]}…` : ACTION_LABEL[rel.action]}${on(i.network)}`}
          kind={rel.action}
          disabled={!!busy}
          title={`${ACTION_LABEL[rel.action]} on ${netName(i.network)}, as ${db.accounts.get(rel.accountId)?.label ?? 'your account'}`}
          onClick={() => {
            const send = (confirm: boolean) => api<P.AddResultView>('/api/add', { body: { accountId: rel.accountId, ref: rel.ref, action: rel.action, ...(confirm ? { confirm: true } : {}) } });
            run(key, async () => done(about, await send(false), { key, verb: 'add', again: () => send(true) }));
          }}
        />,
      ];
    }
    const r = rel.request;
    return r.answers
      .filter((a) => a !== 'block')
      .map((a) => (
        <Action
          icon={a === 'accept' ? 'check' : 'x'}
          label={`${busy === `${r.id}:${a}` ? `${ANSWER_LABEL[a]}…` : ANSWER_LABEL[a]}${on(i.network)}`}
          kind={a}
          primary={a === 'accept'}
          disabled={!!busy}
          title={`${ANSWER_LABEL[a]} their ${r.kind} request on ${netName(r.network)}`}
          onClick={() => {
            const key = `${r.id}:${a}`;
            const fallback: P.PersonRelationship = a === 'accept' ? (r.kind === 'follow' ? 'stranger' : 'friend') : 'stranger';
            const ask = { key, verb: 'accept' as const, again: () => answerRequest(r, a, true), fallback };
            // Flagged by the network: its words first, and Accept anyway confirms.
            if (a === 'accept' && r.warning) return setConfirming({ ...ask, about, words: r.warning });
            run(key, async () => {
              const res = await answerRequest(r, a);
              done(about, res.relationship || res.check || res.confirm ? res : { ...res, relationship: fallback }, ask);
            });
          }}
        />
      ));
  });
  const account = check ? accounts.find((a) => a.id === check.res.accountId) : undefined;
  const c = confirming;
  return (
    <>
      {buttons}
      {c && (
        <Modal title={netName(c.about.network)} onClose={() => setConfirming(null)}>
          <ConfirmFirst
            words={c.words}
            verb={c.verb}
            busy={busy === c.key}
            canMessage={false}
            onConfirm={() =>
              run(c.key, async () => {
                const res = await c.again();
                setConfirming(null);
                done(c.about, res.relationship || res.check || res.confirm || !c.fallback ? res : { ...res, relationship: c.fallback });
              })
            }
          >
            <button class="btn ghost small" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </ConfirmFirst>
        </Modal>
      )}
      {check && (
        <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setCheck(null)}>
          <div class="modal new-message" role="dialog" aria-label="A check first">
            <header class="modal-head">
              <h2>{netName(check.network)}</h2>
              <button class="icon-btn small" onClick={() => setCheck(null)} aria-label="Close">
                <Icon name="x" size={15} />
              </button>
            </header>
            <div class="modal-body">
              <CheckFirst
                network={check.network}
                result={check.res}
                setLive={setLive}
                onLeave={() => setCheck(null)}
                back={
                  <button class="btn ghost small" onClick={() => setCheck(null)}>
                    Close
                  </button>
                }
              />
              {live && account && <LiveView account={account} onClose={() => setLive(false)} />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ relationships

/**
 * Ends how one account stands with someone, after asking (POST /api/people/:id/remove): Remove friend, Cancel request,
 * Unblock, Remove contact, Unfollow. `onDone`: the hub's answer, once it went through.
 */
export function RemoveDialog({ identityId, accountId, relationship, onClose, onDone }: { identityId: string; accountId: string; relationship: P.LinkRelationship; onClose: () => void; onDone: (res: P.AddResultView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const i = db.identities.get(identityId);
  const network = i?.network ?? db.accounts.get(accountId)?.network ?? 'discord';
  const name = identityName(identityId);
  const label = REMOVE_LABEL[relationship];
  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<P.AddResultView>(`/api/people/${encodeURIComponent(identityId)}/remove`, { body: { relationship, accountId } });
      onDone(res);
      onClose();
      toast({ kind: 'info', title: name, body: `${label}: done.` });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`${label}?`} onClose={onClose}>
      <div class="remove-link" data-remove-dialog={relationship}>
        <p>{removeQuestion(relationship, name, network, db.accounts.get(accountId)?.label)}</p>
        <p class="set-help">{removeNote(relationship, network)}</p>
        {error && (
          <p class="new-message-error" role="alert">
            <Icon name="alert" size={13} /> {error}
          </p>
        )}
        <div class="btn-row">
          <button class={`btn small ${relationship === 'blocked' ? '' : 'danger'}`} data-confirm-remove={relationship} disabled={busy} onClick={end}>
            {busy ? `${label}…` : label}
          </button>
          <button class="btn ghost small" onClick={onClose}>
            Keep
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A DM shows a friend request it is about, either way: theirs with Accept, Decline and Block; yours with Cancel. */
export function LinkBanner({ c }: { c: P.ConversationView }) {
  const [cancel, setCancel] = useState(false);
  const p = c.pending;
  if (!p) return null;
  const name = identityName(p.identityId);
  const account = db.accounts.get(p.accountId);
  const who = db.identities.get(p.identityId);
  const several = c.vantages.length > 1 || [...db.accounts.values()].filter((a) => a.network === c.network).length > 1;
  const line = (incoming: boolean) => accountLine(c.network, account?.label).replace(/^to /, incoming ? 'to ' : 'from ');
  const via = (incoming: boolean) => (several && account ? <small class="link-banner-acc">{line(incoming)}</small> : null);
  if (p.incoming) {
    const r = p.requestId ? db.requests.find((x) => x.id === p.requestId) : undefined;
    if (!r) return null;
    return (
      <div class="link-banner incoming" role="region" aria-label="Friend request" data-request={r.id}>
        <div class="link-banner-head">
          <Avatar id={p.identityId} name={name} url={who?.avatar} size={28} />
          <span class="link-banner-text">
            <span>
              <b>{name}</b> {requestLine(r)}
            </span>
            {via(true)}
          </span>
        </div>
        <Answers r={r} name={name} />
      </div>
    );
  }
  return (
    <div class="link-banner outgoing" role="region" aria-label="Friend request sent">
      <div class="link-banner-head">
        <Icon name="userPlus" size={16} />
        <span class="link-banner-text">
          <span>Friend request sent</span>
          {via(false)}
        </span>
        {canRemove(account) && (
          <button class="btn ghost small" data-remove="requested" onClick={() => setCancel(true)}>
            Cancel
          </button>
        )}
      </div>
      {cancel && (
        <RemoveDialog
          identityId={p.identityId}
          accountId={p.accountId}
          relationship="requested"
          onClose={() => setCancel(false)}
          onDone={() => applyEvents([{ t: 'conversation', conversation: { ...c, pending: undefined } }])}
        />
      )}
    </div>
  );
}

/**
 * A profile's list of how each of your accounts stands with them (requests.ts profileLinks), with the button that
 * ends each where the account can. `onEnded`: one ended, for the page to show.
 */
export function ProfileLinks({ identities, links, abouts, onEnded }: { identities: P.IdentityView[]; links: P.PersonLinkView[]; abouts: Record<string, P.PersonAboutView | undefined>; onEnded: (identityId: string, accountId: string) => void }) {
  const [ending, setEnding] = useState<{ identityId: string; accountId: string; relationship: P.LinkRelationship } | null>(null);
  const rows = profileLinks(identities, links, abouts);
  if (!rows.length) return null;
  return (
    <div class="pf-links-list">
      {rows.map((x) => {
        const account = db.accounts.get(x.accountId);
        return (
          <div class="pf-link-row" data-rel={x.relationship} data-account={x.accountId}>
            <span class="pf-link-what">
              <b>{RELATIONSHIP_LABEL[x.relationship]}</b>
              <small>
                {account && <span class="acc-dot" style={{ background: account.color }} />}
                {account ? `${netName(x.network)} ${account.label}` : 'an account no longer here'}
              </small>
            </span>
            {canRemove(account) && (
              <button class="btn ghost small" data-remove={x.relationship} onClick={() => setEnding(x)}>
                {REMOVE_LABEL[x.relationship]}
              </button>
            )}
          </div>
        );
      })}
      {ending && <RemoveDialog {...ending} onClose={() => setEnding(null)} onDone={() => onEnded(ending.identityId, ending.accountId)} />}
    </div>
  );
}

/**
 * The People list filtered to one kind of list across your accounts (GET /api/people): friends, contacts or follows,
 * by account when you have several. A row opens their profile; its button ends it.
 */
export function PeopleLinks({ relationship, active }: { relationship: P.LinkRelationship; active?: string }) {
  rev.value;
  const [view, setView] = useState<P.PeopleLinksView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ending, setEnding] = useState<{ identityId: string; accountId: string } | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    api<P.PeopleLinksView>(`/api/people?relationship=${relationship}`)
      .then((v) => {
        if (!live) return;
        v.identities.forEach((i) => db.identities.set(i.id, i));
        setView(v);
      })
      .catch((e) => live && setError(String(e?.message ?? e)));
    return () => void (live = false);
  }, [relationship, n]);
  const listing = [...db.accounts.values()].filter((a) => a.capabilities.includes('relationships'));
  if (error) return <p class="inbox-empty">{error}</p>;
  if (!view) return <p class="inbox-empty">Asking the hub…</p>;
  const mine = new Set(view.links.map((l) => l.accountId));
  const accounts = listing.filter((a) => mine.has(a.id));
  const shown = accountId && mine.has(accountId) ? view.links.filter((l) => l.accountId === accountId) : view.links;
  const rows = linkRows(shown);
  const what = RELATIONSHIP_LABEL[relationship].toLowerCase();
  return (
    <div class="people-links" data-relationship={relationship}>
      {accounts.length > 1 && (
        <div class="inbox-chips people-accounts" role="radiogroup" aria-label="Which account">
          <button class={`chip-btn ${!accountId ? 'on' : ''}`} role="radio" aria-checked={!accountId} data-track="account chip (all)" onClick={() => setAccountId(null)}>
            All
          </button>
          {accounts.map((a) => (
            <button class={`chip-btn ${accountId === a.id ? 'on' : ''}`} role="radio" aria-checked={accountId === a.id} data-account={a.id} data-track="account chip" title={`${netName(a.network)} ${a.label}`} onClick={() => setAccountId(a.id)}>
              <NetGlyph network={a.network} size={11} /> <span class="acc-dot" style={{ background: a.color }} /> {a.label}
            </button>
          ))}
        </div>
      )}
      {!rows.length && (
        <p class="inbox-empty">
          {listing.length
            ? `Nobody here: none of your accounts lists anyone as ${relationship === 'following' ? 'followed' : what}.`
            : 'None of your accounts keeps a list the hub can read yet.'}
        </p>
      )}
      {rows.map((row) => {
        const person = row.personId ? db.persons.get(row.personId) : undefined;
        const i = db.identities.get(row.identityId);
        const name = person?.name ?? identityName(row.identityId);
        const ends = row.links.filter((l) => canRemove(db.accounts.get(l.accountId)));
        const since = Math.min(...row.links.map((l) => l.since ?? Infinity));
        return (
          <div class={`row conv-row plink-row ${active && (active === row.personId || active === row.identityId) ? 'active' : ''}`} data-plink={row.identityId}>
            <button class="plink-main" data-track={`row (${relationship})`} onClick={() => openProfile(row.identityId)} title={`${name}'s profile`}>
              <span class="row-avatar">
                <Avatar id={row.personId ?? row.identityId} name={name} url={person?.avatar ?? i?.avatar} size={36} network={i?.network} />
              </span>
              <span class="row-main">
                <span class="row-top">
                  <span class="row-title">{name}</span>
                </span>
                <span class="row-bottom">
                  <span class="row-preview">
                    {row.links.map((l) => db.accounts.get(l.accountId)).filter((a): a is P.AccountView => !!a).map((a) => (
                      <span class="plink-acc" title={`${netName(a.network)} ${a.label}`}>
                        <NetGlyph network={a.network} size={10} />
                        <span class="acc-dot" style={{ background: a.color }} />
                        {a.label}
                      </span>
                    ))}
                    {Number.isFinite(since) && <span class="plink-since">since {new Date(since).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>}
                  </span>
                </span>
              </span>
            </button>
            {ends.length > 0 && (
              <LinkEnd links={ends} label={REMOVE_LABEL[relationship]} name={name} onPick={(l) => setEnding({ identityId: l.identityId, accountId: l.accountId })} />
            )}
          </div>
        );
      })}
      {ending && <RemoveDialog {...ending} relationship={relationship} onClose={() => setEnding(null)} onDone={() => setN((x) => x + 1)} />}
    </div>
  );
}

/** A row's button that ends it: straight to the question for one account, a choice of account for several. */
function LinkEnd({ links, label, name, onPick }: { links: P.PersonLinkView[]; label: string; name: string; onPick: (l: P.PersonLinkView) => void }) {
  const button = (onClick: () => void) => (
    <button class="icon-btn small plink-end" data-remove={links[0].relationship} data-track={`remove (${links[0].relationship})`} title={`${label}: ${name}`} aria-label={`${label}: ${name}`} onClick={onClick}>
      <Icon name="x" size={14} />
    </button>
  );
  if (links.length === 1) return button(() => onPick(links[0]));
  return (
    <Menu align="right" trigger={(toggle) => button(toggle)}>
      {(close) => (
        <div class="level-menu plink-menu">
          {links.map((l) => {
            const a = db.accounts.get(l.accountId);
            return (
              <button class="menu-item" data-track={`remove (${l.relationship}, one account)`} onClick={() => (close(), onPick(l))}>
                {label} on {a ? `${netName(a.network)} ${a.label}` : 'that account'}
              </button>
            );
          })}
        </div>
      )}
    </Menu>
  );
}
