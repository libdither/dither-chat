/**
 * Adding people to a group (docs/group-settings.md, "Adding people"), as pages of the palette (docs/palette.md): the
 * groups one of your accounts might add people to, and for one of them the people this account could add, as the
 * network allows (Discord only friends; Signal, Matrix and Telegram anyone the account knows), people you talked with
 * lately first. Pick a few, Add (Invite on Matrix); who could not be added stays listed with the network's reason.
 */
import type * as P from '@dither-chat/protocol';
import { ADD_MEMBERS_MAX } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago } from '../format.ts';
import { convTitle, identityName, netName, visibleConv } from '../model.ts';
import { matches, pickCap, rankGroups, type Entry } from '../palette.ts';
import { api, db, rev, toast } from '../state.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';
import { multiOf, PickChips, PickFooter, pickRows, usePicked, type Pickable } from './MultiPick.tsx';
import { closePalette, pushPage, setEntry } from './Palette.tsx';
import { Frame, type Row } from './PaletteFrame.tsx';

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

/** Groups one of your connected accounts might add people to: its network has `addMembers` for it. Whether it may now is the group's About's to say. */
export function addableGroups(): { conv: P.ConversationView; accountId: string; title: string; last: number }[] {
  const able = new Set([...db.accounts.values()].filter((a) => a.status === 'online' && a.capabilities.includes('addMembers')).map((a) => a.id));
  if (!able.size) return [];
  const out: { conv: P.ConversationView; accountId: string; title: string; last: number }[] = [];
  for (const c of db.conversations.values()) {
    if (c.shape !== 'group' || !visibleConv(c)) continue;
    const v = c.vantages.find((x) => able.has(x.accountId));
    if (v) out.push({ conv: c, accountId: v.accountId, title: convTitle(c), last: c.lastMessageAt ?? 0 });
  }
  return out;
}

/** Add people to a group: which group, most recent first. */
export function GroupsPage({ e }: { e: Entry }) {
  rev.value;
  const all = addableGroups().map((g) => ({ ...g, key: g.conv.id, name: g.title }));
  const shown = rankGroups(all, e.q.trim());
  const several = (n: P.Network) => [...db.accounts.values()].filter((a) => a.network === n).length > 1;
  const rows = shown.map(
    (g): Row => ({
      key: g.key,
      class: 'switcher-row add-group',
      track: 'row (group)',
      icon: <Avatar id={g.conv.id} name={g.title} url={g.conv.avatar} size={24} square network={g.conv.network} />,
      label: g.title,
      sub: `${netName(g.conv.network)}${several(g.conv.network) ? ` · ${db.accounts.get(g.accountId)?.label ?? ''}` : ''}${g.last ? ` · ${ago(g.last)}` : ''}`,
      run: () => pushPage({ kind: 'add', conversationId: g.conv.id, accountId: g.accountId }),
    }),
  );
  const empty = <div class="fwd-empty">{e.q.trim() ? `No group matches “${e.q.trim()}”.` : 'None of your accounts can add people to a group here.'}</div>;
  return <Frame e={e} class="add-groups" placeholder="Search groups" rows={rows} empty={empty} listLabel="Groups" />;
}

/** The people this account could add to one group: pick a few, then Add (or Invite). */
export function AddPage({ e }: { e: Entry & { kind: 'add' } }) {
  rev.value;
  const conv = db.conversations.get(e.conversationId);
  const network = conv?.network ?? 'signal';
  const title = convTitle(conv);
  const [view, setView] = useState<P.MemberCandidatesView | null>(null);
  // What the group's About says about adding here: given by the page that opened this, else asked. null: it says nothing.
  const [adding, setAdding] = useState<P.AboutAdding | null | undefined>(e.adding);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Who the network refused last time, with its reason, shown on their row until they are picked again.
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Set<string>>(new Set());
  const base = `/api/conversations/${e.conversationId}/members`;
  const as = e.accountId ? `?account=${encodeURIComponent(e.accountId)}` : '';

  useEffect(() => {
    let live = true;
    api<P.MemberCandidatesView>(`${base}/candidates${as}`)
      .then((v) => {
        if (!live) return;
        for (const i of v.identities) if (!db.identities.has(i.id)) db.identities.set(i.id, i);
        setView(v);
      })
      .catch((err: Error) => live && setError(err.message));
    if (e.adding === undefined)
      api<P.AboutView>(`/api/conversations/${e.conversationId}/about${as}`)
        .then((a) => live && setAdding(a.adding ?? null))
        .catch((err: Error) => live && setError(err.message));
    return () => void (live = false);
  }, []);

  const mode = view?.mode ?? adding?.mode;
  const verb = mode === 'invite' ? 'Invite' : 'Add';
  const heading = `${verb} people to ${title}`;
  useEffect(() => {
    if (heading !== e.title) setEntry(e.id, { title: heading });
  }, [heading]);
  const max = pickCap(ADD_MEMBERS_MAX, view?.room);
  const pick = usePicked(e, max);
  const toggle = (id: string) => {
    setRefused((r) => {
      if (!(id in r)) return r;
      const { [id]: _, ...rest } = r;
      return rest;
    });
    pick.toggle(id);
  };

  const add = async () => {
    const picked = pick.picked;
    if (!picked.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<P.AddMembersView>(base, { body: { identities: picked, ...(view?.accountId ? { accountId: view.accountId } : {}) } });
      if (r.about) e.onDone?.(r.about);
      const went = [...r.added, ...r.invited];
      setDone((d) => new Set([...d, ...went]));
      pick.clear();
      setRefused(Object.fromEntries(r.failed.map((f) => [f.identityId, f.reason])));
      if (went.length) {
        const t = [r.added.length && `Added ${names(r.added)}`, r.invited.length && `Invited ${names(r.invited)}`].filter(Boolean).join('; ');
        toast({ kind: 'info', title: t, body: r.invited.length ? 'They are in once they accept.' : '' }, 3000);
      }
      if (!r.failed.length) return closePalette();
      if (!went.length) setError(r.failed.length === 1 ? `Could not add ${names([r.failed[0].identityId])}.` : 'Nobody could be added.');
      // Room left after this, as the network now says.
      if (r.about?.adding && view) setView({ ...view, ...(r.about.adding.room !== undefined ? { room: r.about.adding.room } : {}) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const errorLine = error && (
    <p class="add-mem-error" role="alert">
      <Icon name="alert" size={13} /> {error}
    </p>
  );
  // The About says this account may not add people here: why, and nothing to do.
  if (adding === null || adding?.can === false)
    return (
      <Frame
        e={e}
        title={heading}
        class="add-mem"
        body={
          <>
            <p class="set-help add-mem-reason">
              <Icon name="info" size={13} /> {adding?.reason ?? `This account can't add people to ${title}.`}
            </p>
            {errorLine}
          </>
        }
      />
    );

  const needle = e.q.trim();
  const items: Pickable[] = (view?.candidates ?? [])
    .filter((c) => !done.has(c.identityId))
    .filter((c) => {
      if (!needle) return true;
      const i = db.identities.get(c.identityId);
      return matches(`${personName(c.identityId)} ${i?.displayName ?? ''} ${i?.handle ?? ''}`, needle);
    })
    .slice(0, 150)
    .map((c) => {
      const i = db.identities.get(c.identityId);
      const p = i?.personId ? db.persons.get(i.personId) : null;
      const name = personName(c.identityId);
      return {
        key: c.identityId,
        name,
        avatarId: p?.id ?? c.identityId,
        avatar: p?.avatar ?? i?.avatar,
        refused: refused[c.identityId],
        sub: [i?.handle && i.handle !== name ? i.handle : null, c.relationship && REL[c.relationship], c.lastTalked ? `talked ${ago(c.lastTalked)}` : null].filter(Boolean).join(' · '),
      };
    });
  const empty = view && (
    <div class="fwd-empty">{needle ? `Nobody matches “${e.q}”.` : view.who === 'friends' ? `None of your ${netName(network)} friends is left to add.` : `Nobody this account knows is left to add.`}</div>
  );
  const n = pick.picked.length;
  return (
    <Frame
      e={e}
      title={heading}
      class="add-mem"
      placeholder="Search people"
      rows={view ? pickRows(items, pick.picked, max, toggle) : []}
      empty={view ? empty : undefined}
      listClass="fwd-list"
      listLabel="People"
      multi={multiOf(pick, () => void add())}
      before={
        <>
          {view && <p class="fwd-sub">{whoLine(network, view)}</p>}
          {errorLine}
          {!view && !error && <Loading inline label="Loading…" />}
          <PickChips picked={pick.picked} nameOf={personName} onRemove={toggle} />
        </>
      }
      after={view && <PickFooter class="add-mem-send" n={n} max={max} busy={busy} track={verb === 'Invite' ? 'invite' : 'add'} label={busy ? (verb === 'Invite' ? 'Inviting…' : 'Adding…') : n > 1 ? `${verb} (${n})` : verb} onGo={() => void add()} />}
    />
  );
}
