/** Start a direct conversation: with someone known, or an address typed in. */
import type * as P from '@dither-chat/protocol';
import { directTarget, guessDirectNetwork } from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { directNote, openers } from '../direct.ts';
import { directsOf, identityName, netName } from '../model.ts';
import { db, go, newMessage, openDirect } from '../state.ts';
import { AccountChip, Avatar, NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';
import { fuzzyScore } from './Switcher.tsx';

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

export function NewMessage() {
  return newMessage.value ? <NewMessageBox identityId={newMessage.value.identityId} /> : null;
}

function NewMessageBox({ identityId }: { identityId?: string }) {
  const given = identityId ? db.identities.get(identityId) : undefined;
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<Target | null>(given ? identityTarget(given) : null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const close = () => (newMessage.value = null);
  useEffect(() => box.current?.focus(), [target]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const needle = q.trim();
  const accounts = [...db.accounts.values()];
  const canStart = (n: P.Network) => openers(accounts, n).length > 0;
  const typed = guessDirectNetwork(needle);
  const rows = knownPeople()
    .filter((r) => r.identities.some((i) => canStart(i.network)))
    .map((r) => ({ r, s: fuzzyScore(`${r.name} ${r.identities.map((i) => i.handle ?? '').join(' ')}`, needle) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s! - a.s! || a.r.name.localeCompare(b.r.name))
    .slice(0, 8)
    .map((x) => x.r);

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

  const from = target ? openers(accounts, target.network) : [];
  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="modal new-message" role="dialog" aria-label="New message">
        <header class="modal-head">
          <h2>{target ? `Message ${target.name} on ${netName(target.network)}` : 'New message'}</h2>
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
                {!given && (
                  <button class="btn ghost small" onClick={() => setTarget(null)}>
                    Back
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <input ref={box} class="input" placeholder="A name, @name:server.org, or +15551234567" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
              <div class="new-message-list">
                {typed && (
                  canStart(typed) ? (
                    <button class="link-row" onClick={() => setTarget({ network: typed, peer: needle, name: needle })}>
                      <NetBadge network={typed} size={20} /> Message <b>{needle}</b> <small>on {netName(typed)}</small>
                    </button>
                  ) : (
                    <p class="set-help">No connected {netName(typed)} account here can start a conversation.</p>
                  )
                )}
                {rows.map((r) => (
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
                {!typed && !rows.length && <p class="set-help">Nobody by that name. On Matrix, type their ID. On Signal, their phone number with its country code. On Discord, they have to be someone your account has seen.</p>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
