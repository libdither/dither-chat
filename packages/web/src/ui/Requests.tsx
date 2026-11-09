/**
 * Requests waiting on you (docs/add.md "Requests"): the inbox's Requests row, the Requests view with a card per
 * request and the buttons it offers, the bar that stands in for the composer in a held message request, and the
 * buttons on a profile (Add friend, Follow, Add contact, Accept, Decline).
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ACTION_LABEL } from '../add.ts';
import { ago } from '../format.ts';
import { identityName, netName } from '../model.ts';
import { ANSWER_LABEL, groupRequests, messageRequestNote, relation, requestLine, requestsRow, targetMembers } from '../requests.ts';
import { api, applyEvents, db, go, openProfile, rev, toast } from '../state.ts';
import { LiveView } from './Accounts.tsx';
import { AccountChip, Avatar, Empty } from './bits.tsx';
import { Icon } from './icons.tsx';
import { CheckFirst } from './NewMessage.tsx';
import { Action } from './ProfileShell.tsx';
import { homeRoute } from './Sidebar.tsx';

/** Answer one: the hub asks the network. Answered, it is gone here at once; the hub's requests event says the same. */
export async function answerRequest(r: P.RequestView, answer: P.RequestAnswer): Promise<P.AddResultView> {
  const res = await api<P.AddResultView>(`/api/requests/${encodeURIComponent(r.id)}`, { body: { answer } });
  const events: P.ClientEvent[] = res.conversation ? [{ t: 'conversation', conversation: res.conversation }] : [];
  if (!res.check) events.push({ t: 'requests', requests: db.requests.filter((x) => x.id !== r.id) });
  if (events.length) applyEvents(events);
  return res;
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
    <button class="row requests-row" onClick={() => go({ view: 'requests' })} title="Friend requests, invites and message requests waiting on you">
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
          <button class="icon-btn back" onClick={onBack} aria-label="Back">
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
    <article class={`request-card ${focused ? 'focused' : ''}`} data-request={r.id} data-kind={r.kind} data-network={r.network}>
      <div class="request-head">
        <Avatar id={who?.id ?? r.id} name={name} url={who?.avatar} size={44} network={r.network} />
        <div class="request-text">
          <div class="request-title">
            <button class="link-btn request-name" onClick={() => openProfile(r.from)} disabled={!r.from}>
              {name}
            </button>{' '}
            {requestLine(r)}
          </div>
          <small class="request-meta">
            {members && <span>{members} · </span>}
            {netName(r.network)} {account ? <AccountChip account={account} small /> : null} · <time>{ago(r.ts)}</time>
          </small>
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
      <Answers r={r} name={name} />
    </article>
  );
}

/**
 * The buttons a request offers, and what answering did: an error on the spot, the check screen, or where it landed.
 * Block asks once more first. `after`: what to do once it is answered, besides landing somewhere.
 */
function Answers({ r, name, after }: { r: P.RequestView; name: string; after?: (answer: P.RequestAnswer, res: P.AddResultView) => void }) {
  const [busy, setBusy] = useState<P.RequestAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<P.AddResultView | null>(null);
  const [blocking, setBlocking] = useState(false);
  const [live, setLive] = useState(false);
  const account = db.accounts.get(r.accountId);
  const answer = async (a: P.RequestAnswer) => {
    if (a === 'block' && !blocking) return setBlocking(true);
    setBusy(a);
    setError(null);
    try {
      const res = await answerRequest(r, a);
      if (res.check) return setCheck(res);
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
  const back = (
    <button class="btn ghost small" onClick={() => setCheck(null)}>
      Back
    </button>
  );
  return (
    <div class="request-answers">
      {error && (
        <p class="new-message-error request-error" role="alert">
          <Icon name="alert" size={13} /> {error}
        </p>
      )}
      {check ? (
        <CheckFirst network={r.network} result={check} setLive={setLive} onLeave={() => {}} back={back} />
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
            <button class={`btn small ${a === 'accept' ? 'primary' : 'ghost'}`} data-answer={a} disabled={!!busy} onClick={() => answer(a)}>
              {busy === a ? `${ANSWER_LABEL[a]}…` : ANSWER_LABEL[a]}
            </button>
          ))}
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
  const [live, setLive] = useState(false);
  const accounts = [...db.accounts.values()];
  const several = new Set(identities.map((i) => i.network)).size > 1;
  const on = (n: P.Network) => (several ? ` on ${netName(n)}` : '');
  const done = (about: P.PersonAboutView, res: P.AddResultView) => {
    if (res.check) return setCheck({ network: about.network, res });
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
          onClick={() => run(key, async () => done(about, await api<P.AddResultView>('/api/add', { body: { accountId: rel.accountId, ref: rel.ref, action: rel.action } })))}
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
          onClick={() =>
            run(`${r.id}:${a}`, async () => {
              const res = await answerRequest(r, a);
              done(about, res.relationship || res.check ? res : { ...res, relationship: a === 'accept' ? (r.kind === 'follow' ? 'stranger' : 'friend') : 'stranger' });
            })
          }
        />
      ));
  });
  const account = check ? accounts.find((a) => a.id === check.res.accountId) : undefined;
  return (
    <>
      {buttons}
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
