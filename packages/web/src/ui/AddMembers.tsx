/**
 * Adding people to a group (docs/group-settings.md, "Adding people"): the people this account could add, as the
 * network allows (Discord only friends; Signal, Matrix and Telegram anyone the account knows), people you talked with
 * lately first. Pick a few, Add (Invite on Matrix); who could not be added stays listed with the network's reason.
 */
import type * as P from '@dither-chat/protocol';
import { ADD_MEMBERS_MAX } from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ago } from '../format.ts';
import { identityName, netName } from '../model.ts';
import { phone } from '../phone.ts';
import { api, db, toast } from '../state.ts';
import { Avatar, Modal } from './bits.tsx';
import { Icon } from './icons.tsx';

const REL: Partial<Record<P.PersonRelationship, string>> = { friend: 'Friend', contact: 'Contact' };

/** "Ann", "Ann and Bo", "Ann, Bo and 2 more". */
function names(ids: string[]): string {
  const n = ids.map((id) => personName(id));
  if (n.length <= 2) return n.join(' and ');
  return `${n.slice(0, 2).join(', ')} and ${n.length - 2} more`;
}

function personName(identityId: string): string {
  const i = db.identities.get(identityId);
  const p = i?.personId ? db.persons.get(i.personId) : null;
  return p?.name ?? identityName(identityId);
}

/** Whom the network lets this account add, in a line. */
function whoLine(network: P.Network, v: P.MemberCandidatesView): string {
  const net = netName(network);
  const whom = v.who === 'friends' ? `Only your ${net} friends can be added.` : v.who === 'contacts' ? `Your ${net} contacts and people you have a chat with.` : `People this ${net} account knows.`;
  const how = v.mode === 'invite' ? ' They get an invite and are in once they accept.' : v.who === 'friends' ? '' : ' Their privacy settings may still refuse.';
  const room = v.room !== undefined ? ` ${v.room === 1 ? 'One more fits' : `${v.room} more fit`}.` : '';
  return whom + how + room;
}

export function AddMembersDialog({
  conversationId,
  accountId,
  network,
  title,
  onClose,
  onDone,
}: {
  conversationId: string;
  accountId: string | null;
  network: P.Network;
  title: string;
  onClose: () => void;
  /** The About as it now stands, when the network said. */
  onDone: (about: P.AboutView) => void;
}) {
  const [view, setView] = useState<P.MemberCandidatesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Who the network refused last time, with its reason, shown on their row until they are picked again.
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Set<string>>(new Set());
  const search = useRef<HTMLInputElement>(null);
  const base = `/api/conversations/${conversationId}/members`;

  useEffect(() => {
    let live = true;
    api<P.MemberCandidatesView>(`${base}/candidates${accountId ? `?account=${encodeURIComponent(accountId)}` : ''}`)
      .then((v) => {
        if (!live) return;
        for (const i of v.identities) if (!db.identities.has(i.id)) db.identities.set(i.id, i);
        setView(v);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => void (live = false);
  }, [base, accountId]);
  // On a phone, no keyboard unasked.
  useEffect(() => void (view && !phone.value && search.current?.focus()), [!!view]);

  const room = view?.room;
  const max = Math.min(ADD_MEMBERS_MAX, room ?? ADD_MEMBERS_MAX);
  const verb = view?.mode === 'invite' ? 'Invite' : 'Add';
  const needle = q.trim().toLowerCase();
  const all = (view?.candidates ?? []).filter((c) => !done.has(c.identityId));
  const shown = (needle
    ? all.filter((c) => {
        const i = db.identities.get(c.identityId);
        return `${personName(c.identityId)} ${i?.displayName ?? ''} ${i?.handle ?? ''}`.toLowerCase().includes(needle);
      })
    : all
  ).slice(0, 150);
  const toggle = (id: string) => {
    setRefused((r) => {
      if (!(id in r)) return r;
      const { [id]: _, ...rest } = r;
      return rest;
    });
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= max ? p : [...p, id]));
  };

  const add = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<P.AddMembersView>(base, { body: { identities: picked, ...(view?.accountId ? { accountId: view.accountId } : {}) } });
      if (r.about) onDone(r.about);
      const went = [...r.added, ...r.invited];
      setDone((d) => new Set([...d, ...went]));
      setPicked([]);
      setRefused(Object.fromEntries(r.failed.map((f) => [f.identityId, f.reason])));
      if (went.length) {
        const title = [r.added.length && `Added ${names(r.added)}`, r.invited.length && `Invited ${names(r.invited)}`].filter(Boolean).join('; ');
        toast({ kind: 'info', title, body: r.invited.length ? 'They are in once they accept.' : '' }, 3000);
      }
      if (!r.failed.length) onClose();
      else if (!went.length) setError(r.failed.length === 1 ? `Could not add ${names([r.failed[0].identityId])}.` : 'Nobody could be added.');
      // Room left after this, as the network now says.
      if (r.about?.adding && view) setView({ ...view, ...(r.about.adding.room !== undefined ? { room: r.about.adding.room } : {}) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${verb} people to ${title}`} onClose={onClose}>
      <div class="fwd add-mem">
        {view && <p class="fwd-sub">{whoLine(network, view)}</p>}
        {error && (
          <p class="add-mem-error" role="alert">
            <Icon name="alert" size={13} /> {error}
          </p>
        )}
        {!view && !error && <p class="det-note">Loading…</p>}
        {view && (
          <>
            <label class="search fwd-search">
              <Icon name="search" size={15} />
              <input ref={search} placeholder="Search people" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            </label>
            {picked.length > 0 && (
              <div class="fwd-chips">
                {picked.map((id) => (
                  <button class="fwd-chip" onClick={() => toggle(id)} aria-label={`Remove ${personName(id)}`}>
                    {personName(id)}
                    <Icon name="x" size={11} />
                  </button>
                ))}
              </div>
            )}
            <div class="fwd-list" role="listbox" aria-multiselectable="true" aria-label="People">
              {shown.map((c) => {
                const on = picked.includes(c.identityId);
                const i = db.identities.get(c.identityId);
                const p = i?.personId ? db.persons.get(i.personId) : null;
                const name = personName(c.identityId);
                const why = refused[c.identityId];
                const sub = why ?? [i?.handle && i.handle !== name ? i.handle : null, c.relationship && REL[c.relationship], c.lastTalked ? `talked ${ago(c.lastTalked)}` : null].filter(Boolean).join(' · ');
                return (
                  <button class={`fwd-row ${on ? 'on' : ''} ${why ? 'refused' : ''}`} role="option" aria-selected={on} disabled={!on && picked.length >= max} onClick={() => toggle(c.identityId)}>
                    <Avatar id={p?.id ?? c.identityId} name={name} url={p?.avatar ?? i?.avatar} size={32} />
                    <span class="fwd-row-text">
                      <b>{name}</b>
                      <small>{sub}</small>
                    </span>
                    <span class={`fwd-check ${on ? 'on' : ''}`} aria-hidden="true">
                      {on && <Icon name="check" size={13} />}
                    </span>
                  </button>
                );
              })}
              {!shown.length && (
                <div class="fwd-empty">
                  {needle ? `Nobody matches “${q}”.` : view.who === 'friends' ? `None of your ${netName(network)} friends is left to add.` : `Nobody this account knows is left to add.`}
                </div>
              )}
            </div>
            <div class="fwd-send add-mem-send">
              <span class="add-mem-count">{picked.length ? `${picked.length} picked${picked.length >= max ? ', the most at once' : ''}` : max > 0 ? `Pick up to ${max}` : 'There is no room for anyone else'}</span>
              <button class="btn primary" disabled={!picked.length || busy} onClick={() => void add()}>
                <Icon name="userPlus" size={14} /> {busy ? (verb === 'Invite' ? 'Inviting…' : 'Adding…') : picked.length > 1 ? `${verb} (${picked.length})` : verb}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
