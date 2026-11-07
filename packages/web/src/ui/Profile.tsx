/**
 * A person's profile (docs/profile.md): who they are on each network, as the networks say it (bio, pronouns, status,
 * links), what you share (servers with their nickname and roles there, group chats, friends), what they said lately,
 * and how you stand with them (accounts, notifications, your note). The actions from their menu sit in the hero.
 */
import type * as P from '@dither-chat/protocol';
import { RELATIONSHIP_LABEL } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { ago, fullTime } from '../format.ts';
import { openers } from '../direct.ts';
import { communitiesOf, convLabel, convTitle, directsOf, identityName, kindLabel, netName, plainBody, rootCommunity } from '../model.ts';
import { api, db, go, isSelfIdentity, newMessage, openMessage, openProfile, rev, setRule, toast } from '../state.ts';
import { Avatar, Empty, NetBadge, NetGlyph, Skeleton } from './bits.tsx';
import { copy, groups, type MenuEntry, type MenuSpec } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import { HistoryCard } from './HistoryCard.tsx';
import { StatusCard } from './StatusCard.tsx';
import { identityMenu, personMenu } from './menus.tsx';
import { Action, Card, Columns, Facts, Hero, monthYear, ProfilePage, Tag } from './ProfileShell.tsx';
import { openConv } from './Sidebar.tsx';

/** What a network's profile holds at most, for when it says little. */
const WHAT_NETWORKS_SHARE: Record<P.Network, string> = {
  discord: 'Bio, pronouns, status, banner, connections, mutual servers and friends, as Discord shows them on a profile.',
  signal: 'Profile name, About and avatar. Signal has no directory, and no mutual friends.',
  matrix: 'Display name and avatar, and pronouns or time zone where their server keeps them.',
  whatsapp: 'The name in your address book, their About and picture, and whether it is a business.',
  telegram: 'Name, username, bio and photo, and their phone number or last seen only where they allow it.',
  gmessages: 'The name and number in your contacts. Messages has no profiles.',
};

function externalProfile(i: P.IdentityView): string | null {
  if (i.network === 'discord') return /^\d+$/.test(i.nativeId) ? `https://discord.com/users/${i.nativeId}` : null;
  if (i.network === 'matrix') return `https://matrix.to/#/${encodeURIComponent(i.nativeId)}`;
  if (i.network === 'whatsapp') return /^\+\d{6,}$/.test(i.handle ?? '') ? `https://wa.me/${i.handle!.slice(1)}` : null;
  return null;
}

/** What a network says when someone wrote nothing. */
const STOCK_BIO = /^(available|busy|at work|hey there! i am using whatsapp\.?|urgent calls only)$/i;

/** Someone on two networks is one row. */
function onePerPerson(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((iid) => {
    const k = db.identities.get(iid)?.personId ?? iid;
    return !seen.has(k) && seen.add(k);
  });
}

/** The same line from two accounts on one network once. */
const dedupe = (rows: [string, string][]) => rows.filter((r, i) => rows.findIndex((x) => x[0] === r[0] && x[1] === r[1]) === i);

const normalized = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** A conversation's picture: its own, else its server's. */
export function PlaceIcon({ c, size = 22 }: { c: P.ConversationView; size?: number }) {
  const com = c.spaceIds.length ? rootCommunity(c.spaceIds[0]) : null;
  if (com) return <Avatar id={com.id} name={com.name} url={com.icon} size={size} square network={c.network} />;
  const person = c.peerPersonId ? db.persons.get(c.peerPersonId) : null;
  return <Avatar id={person?.id ?? c.id} name={convTitle(c)} url={person?.avatar ?? c.avatar} size={size} square={c.shape !== 'direct'} network={c.network} />;
}

/** The profile and what each network says, the kept answers first and fresh ones as they come. */
function useProfile(personId?: string, identityId?: string) {
  const person = personId ? db.persons.get(personId) : undefined;
  const signature = person ? `${person.identityIds.join()}|${person.name}` : identityId;
  const [profile, setProfile] = useState<P.ProfileView | null | 'none'>(null);
  const [abouts, setAbouts] = useState<Record<string, P.PersonAboutView>>({});
  const [asking, setAsking] = useState(0);
  const learn = (a: P.PersonAboutView) => {
    a.identities.forEach((i) => db.identities.set(i.id, i));
    setAbouts((x) => ({ ...x, [a.identityId]: a }));
  };
  const ask = (ids: string[], fresh = false) => {
    setAsking((n) => n + ids.length);
    for (const id of ids)
      api<P.PersonAboutView>(`/api/identities/${id}/about${fresh ? '?fresh=1' : ''}`)
        .then(learn, () => {})
        .finally(() => setAsking((n) => n - 1));
  };
  useEffect(() => {
    let live = true;
    setAbouts({});
    api<P.ProfileView>(personId ? `/api/persons/${personId}/profile` : `/api/identities/${identityId}/profile`)
      .then((p) => {
        if (!live) return;
        [...p.identities, ...p.mentioned].forEach((i) => db.identities.set(i.id, i));
        p.abouts.forEach(learn);
        setProfile(p);
        ask(p.identityIds);
      })
      .catch(() => live && setProfile('none'));
    return () => void (live = false);
  }, [personId, identityId, signature]);
  return { profile, abouts, asking: asking > 0, refresh: () => profile && profile !== 'none' && ask(profile.identityIds, true) };
}

export function ProfilePane({ personId, identityId, onBack }: { personId?: string; identityId?: string; onBack: () => void }) {
  rev.value;
  const { profile, abouts, asking, refresh } = useProfile(personId, identityId);
  const [merging, setMerging] = useState(false);
  const [filter, setFilter] = useState('');
  const person = personId ? db.persons.get(personId) : undefined;

  if (profile === 'none')
    return (
      <ProfilePage title="Profile" label="Profile" onBack={onBack}>
        <Empty icon="user" title="Nobody by that id" />
      </ProfilePage>
    );
  if (!profile)
    return (
      <ProfilePage title="Profile" label="Profile" onBack={onBack}>
        <Skeleton rows={4} />
      </ProfilePage>
    );

  const ids = (person ? person.identityIds : profile.identityIds).map((id) => db.identities.get(id)).filter((i): i is P.IdentityView => !!i);
  const first = ids[0];
  const name = person?.name ?? identityName(first?.id);
  const isSelf = !!person?.isSelf || ids.some((i) => isSelfIdentity(i.id));
  const directs = person ? directsOf(person.id) : [];
  const nets = [...new Set(ids.map((i) => i.network))];
  const accounts = [...db.accounts.values()];
  // One way in per network they are on and you have no DM on. A network whose adapter cannot do it shows nothing.
  const startable = isSelf ? [] : nets.filter((n) => !directs.some((d) => d.network === n)).map((n) => ids.find((i) => i.network === n)!).filter((i) => openers(accounts, i.network).length > 0);
  const rule = person ? db.rules.find((x) => x.scope === 'person' && x.target === person.id) : undefined;
  const said = ids.map((i) => abouts[i.id]).filter((a): a is P.PersonAboutView => !!a);
  const discord = said.find((a) => a.network === 'discord');

  /** Person actions need a Person; someone seen only in a channel gets one the first time you act. */
  const ensure = async () => {
    if (person) return person.id;
    const { personId: pid } = await api<{ personId: string }>(`/api/identities/${first.id}/person`, { body: {} });
    go({ view: 'profile', person: pid }, true);
    return pid;
  };
  const patch = async (body: Record<string, unknown>) => {
    const pid = await ensure();
    await api(`/api/persons/${pid}`, { method: 'PATCH', body }).catch((e) => toast({ kind: 'error', title: 'Could not save that', body: e.message }));
  };

  // ---- what you share
  const convs = profile.conversations.map((x) => ({ ...x, c: db.conversations.get(x.id) })).filter((x): x is typeof x & { c: P.ConversationView } => !!x.c);
  const spaces = new Map<string, { s: P.SpaceView; messages: number; nick?: string; roles?: { name: string; color?: string }[] }>();
  for (const a of said)
    for (const m of a.mutualSpaces ?? []) {
      const s = m.spaceId ? db.spaces.get(m.spaceId) : null;
      if (s) spaces.set(s.id, { s, messages: 0, nick: m.nick, roles: m.roles });
    }
  for (const x of convs) {
    for (const com of communitiesOf(x.c)) {
      const root = rootCommunity(com.id) ?? com;
      const cur = spaces.get(root.id) ?? { s: root, messages: 0 };
      cur.messages += x.messages;
      spaces.set(root.id, cur);
    }
  }
  const sharedSpaces = [...spaces.values()].sort((a, b) => b.messages - a.messages || a.s.name.localeCompare(b.s.name));
  const groupChats = convs.filter((x) => x.c.shape === 'group' || (x.c.shape === 'channel' && !x.c.spaceIds.length));
  const mutualFriends = onePerPerson([...new Set(said.flatMap((a) => a.mutualFriends ?? []))]);
  const friends = onePerPerson([...new Set(said.flatMap((a) => a.friends ?? []))]).filter((iid) => !isSelfIdentity(iid));

  // ---- who they are
  // The richest first; a network's stock line ("Available") says nothing.
  const bios = said
    .map((a) => {
      // A newer About heard since the profile was asked replaces its bio.
      const st = (a.network === 'signal' || a.network === 'whatsapp') && db.identities.get(a.identityId)?.status;
      return st && st.at > a.fetchedAt ? { ...a, bio: st.text ?? '' } : a;
    })
    .filter((a) => a.bio?.trim() && !STOCK_BIO.test(a.bio.trim()))
    .sort((a, b) => b.bio!.length - a.bio!.length);
  const pronouns = said.find((a) => a.pronouns)?.pronouns;
  // The newest heard: an adapter's live status on an identity, else what a profile said. On Signal and WhatsApp the
  // live status is their About, which shows as the bio instead.
  const live = ids
    .filter((i) => i.network !== 'signal' && i.network !== 'whatsapp')
    .map((i) => i.status)
    .filter((x): x is NonNullable<P.IdentityView['status']> => !!(x?.text || x?.emoji))
    .sort((a, b) => b.at - a.at)[0];
  const status = live ?? (said.find((a) => a.status?.text) ?? said.find((a) => a.status?.emoji))?.status;
  const changesPath = person ? `/api/persons/${person.id}/changes` : `/api/identities/${first.id}/changes`;
  // One number written two ways is one link.
  const seen = new Set<string>();
  const links = said
    .flatMap((a) => (a.links ?? []).map((l) => ({ ...l, network: a.network })))
    .filter((l) => {
      const k = `${l.label}|${l.label === 'Phone' ? l.value.replace(/\D/g, '') : l.value}`;
      return !seen.has(k) && seen.add(k);
    });
  const facts = said.flatMap((a) => (a.facts ?? []).map((f) => ({ ...f, network: a.network })));
  const relations = said.filter((a) => a.relationship && a.relationship !== 'stranger');

  // ---- merging
  const candidates = [...db.persons.values()].filter((x) => x.id !== person?.id && !x.isSelf);
  const myNames = new Set(ids.flatMap((i) => [normalized(i.displayName), normalized(i.handle)]).concat(normalized(name)).filter(Boolean));
  const similar = candidates.filter((x) => myNames.has(normalized(x.name)) || x.identityIds.some((id) => myNames.has(normalized(db.identities.get(id)?.displayName)) || myNames.has(normalized(db.identities.get(id)?.handle))));
  const needle = filter.trim().toLowerCase();
  const matches = needle ? candidates.filter((x) => x.name.toLowerCase().includes(needle)).slice(0, 12) : similar;
  const merge = async (from: string) => {
    const into = await ensure();
    await api('/api/persons/merge', { body: { into, from } });
    setMerging(false);
    setFilter('');
    toast({ kind: 'info', title: 'Merged', body: 'They now count as one person, on this hub only.' });
  };

  // ---- actions
  const messageMenu = (): MenuSpec => ({
    label: 'Message',
    items: groups(
      directs.length > 1 && person ? [{ label: 'All Chats Together', icon: 'merge', run: () => go({ view: 'people', person: person.id }) }] : [],
      directs.map((d): MenuEntry => ({ label: `On ${netName(d.network)}`, icon: 'send', run: () => go({ view: 'inbox', conv: d.id }) })),
      startable.map((i): MenuEntry => ({ label: `Start on ${netName(i.network)}`, icon: 'plus', run: () => (newMessage.value = { identityId: i.id }) })),
    ),
  });
  const messageOptions = (directs.length > 1 ? 1 : 0) + directs.length + startable.length;
  const message = () => {
    if (directs.length === 1) go({ view: 'inbox', conv: directs[0].id });
    else if (startable.length === 1) newMessage.value = { identityId: startable[0].id };
  };
  const moreMenu = (): MenuSpec | null => {
    const base = person ? personMenu(person) : identityMenu(first?.id);
    const extra: MenuEntry[] = groups(
      ids.map((i) => externalProfile(i) && ({ label: `Open on ${netName(i.network)}`, icon: 'external', run: () => window.open(externalProfile(i)!, '_blank', 'noreferrer') })),
      [!isSelf && { label: 'Merge Another Identity In', icon: 'merge', run: () => setMerging(true) }, { label: 'Ask the Networks Again', icon: 'refresh', run: refresh }],
    );
    // What the page already shows as a button is not repeated.
    const shown = new Set(['Profile', 'Message', 'Star', 'Unstar']);
    const items = (base?.items ?? [])
      .filter((e) => !('label' in e && shown.has(e.label as string)))
      .filter((e, i, xs) => e.kind !== 'sep' || (i > 0 && i < xs.length - 1 && xs[i - 1].kind !== 'sep'));
    return { label: `${name} actions`, items: groups(items, extra) };
  };

  const accent = discord?.accent ?? null;
  const banner = discord?.banner ?? null;
  const picture = person?.avatar ?? first?.avatar ?? said.find((a) => a.avatar)?.avatar;

  const hero = (
    <Hero
      id={person?.id ?? first?.id ?? ''}
      name={name}
      picture={picture}
      network={nets.length === 1 ? nets[0] : undefined}
      banner={banner}
      accent={accent}
      title={
        <h1>
          {name}
          {person?.starred && <Icon name="star" size={17} class="row-star" />}
        </h1>
      }
      sub={
        <span class="pf-handles">
          {ids.map((i) => (
            <button class="pf-handle" title={`Copy ${netName(i.network)} ${i.handle ? 'username' : 'id'}`} onClick={() => copy(i.handle ?? i.nativeId, 'Copied')}>
              <NetGlyph network={i.network} size={12} />
              {i.handle ?? i.displayName ?? i.nativeId}
            </button>
          ))}
        </span>
      }
      tags={
        <>
          {isSelf && <Tag tone="accent">You</Tag>}
          {first?.isBot && <Tag tone="muted">Bot</Tag>}
          {pronouns && <Tag>{pronouns}</Tag>}
          {[...new Set(relations.map((a) => a.relationship!))].map((rel) => {
            const where = relations.filter((a) => a.relationship === rel).map((a) => a.network);
            return (
              <Tag icon={rel === 'friend' ? 'users' : rel === 'blocked' ? 'x' : 'user'} tone={rel === 'friend' ? 'accent' : rel === 'blocked' ? 'warn' : undefined} title={`${RELATIONSHIP_LABEL[rel]} on ${where.map(netName).join(' and ')}`}>
                {RELATIONSHIP_LABEL[rel]}
                {nets.length > 1 && where.map((n) => <NetGlyph network={n} size={11} />)}
              </Tag>
            );
          })}
        </>
      }
      status={
        status && (
          <>
            {status.emoji && <span class="pf-status-emoji">{status.emoji}</span>}
            {status.text}
          </>
        )
      }
      actions={
        <>
          {!isSelf && messageOptions > 0 && (messageOptions === 1 && directs.length + startable.length === 1 ? <Action primary icon="send" label="Message" onClick={message} /> : <Action primary icon="send" label="Message" menu={messageMenu} />)}
          {!isSelf && <Action icon="star" label={person?.starred ? 'Starred' : 'Star'} on={person?.starred} title={person?.starred ? 'Starred: their messages always notify. Click to unstar' : 'Star: always notify for them, everywhere'} onClick={() => patch({ starred: !person?.starred })} />}
          {directs.length > 1 && person && <Action icon="merge" label="All chats" onClick={() => go({ view: 'people', person: person.id })} />}
          <Action icon="more" label="More" menu={moreMenu} />
        </>
      }
    />
  );

  const main = (
    <>
      <Card title="About" icon="info" extra={asking ? <span class="pf-asking">Asking…</span> : undefined}>
        {bios.length ? (
          bios.map((a) => (
            <div class="pf-bio">
              {(bios.length > 1 || nets.length > 1) && (
                <span class="pf-bio-net">
                  <NetGlyph network={a.network} size={11} /> {netName(a.network)}
                </span>
              )}
              <p>{plainBody(a.bio!, a.network)}</p>
            </div>
          ))
        ) : (
          <p class="pf-empty" title={nets.map((n) => `${netName(n)}: ${WHAT_NETWORKS_SHARE[n]}`).join('\n')}>
            {asking ? 'Asking the networks…' : `No bio on ${nets.length > 1 ? 'any of their networks' : netName(nets[0])}.`}
          </p>
        )}
        {links.length > 0 && (
          <div class="pf-links">
            {links.map((l) =>
              l.url ? (
                <a class="pf-link" href={l.url} target="_blank" rel="noreferrer" title={`${l.label}: ${l.value}`}>
                  <NetGlyph network={l.network} size={11} />
                  <b>{l.label}</b> {l.value}
                  {l.verified && <Icon name="check" size={11} />}
                </a>
              ) : (
                <span class="pf-link">
                  <b>{l.label}</b> {l.value}
                </span>
              ),
            )}
          </div>
        )}
        <Facts
          rows={[
            ...dedupe([
              ...said.filter((a) => a.createdAt).map((a): [string, string] => [`On ${netName(a.network)} since`, monthYear(a.createdAt!)]),
              ...facts.map((f): [string, string] => [f.label, f.value]),
            ]),
            profile.totalMessages > 0 && [
              'Messages stored',
              `${profile.totalMessages.toLocaleString()}${profile.firstSeenTs ? ` since ${new Date(profile.firstSeenTs).toLocaleDateString()}` : ''}`,
            ],
          ]}
        />
        {said.filter((a) => a.stale).map((a) => (
          <p class="pf-stale">
            <NetGlyph network={a.network} size={11} /> {a.stale}
          </p>
        ))}
      </Card>

      <StatusCard path={changesPath} status={status} at={live && status === live ? live.at : undefined} />

      {(sharedSpaces.length > 0 || groupChats.length > 0) && (
        <Card title={isSelf ? 'Your places' : 'In common'} icon="layers" count={sharedSpaces.length + groupChats.length}>
          {sharedSpaces.length > 0 && (
            <div class="pf-spaces">
              {sharedSpaces.map(({ s, messages, nick, roles }) => (
                <button class="pf-space" onClick={() => go({ view: 'space', space: s.id })} title={s.name}>
                  <Avatar id={s.id} name={s.name} url={s.icon} size={40} square network={s.network} />
                  <span class="pf-space-text">
                    <b>{s.name}</b>
                    <small>{nick ? `as ${nick}` : messages ? `${messages.toLocaleString()} message${messages === 1 ? '' : 's'}` : 'member'}</small>
                    {roles && roles.length > 0 && (
                      <span class="pf-roles">
                        {roles.slice(0, 3).map((r) => (
                          <span class="pf-role" style={r.color ? { '--role': r.color } : undefined}>
                            {r.name}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
          {groupChats.length > 0 && (
            <div class="pf-rows">
              {groupChats.map(({ c, messages, lastTs }) => (
                <button class="pf-row" onClick={() => openConv(c)}>
                  <PlaceIcon c={c} size={28} />
                  <span class="pf-row-text">
                    <b>{convTitle(c)}</b>
                    <small>
                      {kindLabel(c)}
                      {messages ? ` · ${messages.toLocaleString()} from ${isSelf ? 'you' : 'them'}` : ''}
                    </small>
                  </span>
                  {lastTs && <span class="pf-row-time">{ago(lastTs)}</span>}
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card title="Recent messages" icon="send" count={profile.recent.length || undefined}>
        {!profile.recent.length && <p class="pf-empty">None stored. The hub only has what your accounts have fetched.</p>}
        <div class="pf-rows">
          {profile.recent.map((m) => {
            const c = db.conversations.get(m.conversationId);
            return (
              <button class="pf-row pf-msg" onClick={() => openMessage(m.conversationId, m.id)} title={fullTime(m.ts)}>
                {c ? <PlaceIcon c={c} size={28} /> : <NetBadge network={m.network} size={28} />}
                <span class="pf-row-text">
                  <small class="pf-msg-where">{c ? (c.shape === 'direct' ? `Direct message · ${netName(c.network)}` : convLabel(c)) : 'Unknown'}</small>
                  <span class="pf-msg-body">{plainBody(m.body, m.network) || (m.attachments.length ? 'Attachment' : m.kind === 'encrypted' ? 'Encrypted message' : '')}</span>
                </span>
                <span class="pf-row-time">{ago(m.ts)}</span>
              </button>
            );
          })}
        </div>
      </Card>
      <HistoryCard path={`${changesPath}?except=status,presence`} />
    </>
  );

  const people = (list: string[]) => (
    <div class="pf-people">
      {list.slice(0, 60).map((iid) => {
        const i = db.identities.get(iid);
        const p = i?.personId ? db.persons.get(i.personId) : null;
        const n = p?.name ?? identityName(iid);
        return (
          <button class="pf-person" onClick={() => openProfile(iid)} title={n}>
            <Avatar id={p?.id ?? iid} name={n} url={p?.avatar ?? i?.avatar} size={30} />
            <span>{n}</span>
          </button>
        );
      })}
      {list.length > 60 && <p class="pf-empty">and {list.length - 60} more</p>}
    </div>
  );

  const side = (
    <>
      {isSelf
        ? friends.length > 0 && (
            <Card title="Friends" icon="users" count={friends.length}>
              {people(friends)}
            </Card>
          )
        : mutualFriends.length > 0 && (
            <Card title="Mutual friends" icon="users" count={mutualFriends.length}>
              {people(mutualFriends)}
            </Card>
          )}

      <Card title="Accounts" icon="idBadge" count={ids.length > 1 ? ids.length : undefined}>
        {ids.map((i) => {
          const link = externalProfile(i);
          return (
            <div class="pf-identity">
              <NetBadge network={i.network} size={24} />
              <span class="pf-row-text">
                <b>{i.displayName ?? i.handle ?? i.nativeId}</b>
                <small>
                  {netName(i.network)} · {i.handle ?? i.nativeId}
                </small>
              </span>
              {link && (
                <a class="icon-btn small" href={link} target="_blank" rel="noreferrer" title={`Open on ${netName(i.network)}`}>
                  <Icon name="external" size={14} />
                </a>
              )}
              {ids.length > 1 && !isSelf && (
                <button
                  class="icon-btn small"
                  title="Unmerge: split this identity into its own person"
                  onClick={() => api(`/api/identities/${i.id}/split`, { body: {} }).then(() => toast({ kind: 'info', title: 'Split', body: `${i.displayName ?? i.handle ?? 'That identity'} is its own person again.` }))}
                >
                  <Icon name="unlink" size={14} />
                </button>
              )}
            </div>
          );
        })}
        {!isSelf && similar.length > 0 && !merging && (
          <p class="pf-hint">
            Same name elsewhere: {similar.slice(0, 3).map((x) => x.name).join(', ')}.{' '}
            <button class="link-btn" onClick={() => setMerging(true)}>
              Merge?
            </button>
          </p>
        )}
        {!isSelf && merging && (
          <div class="merge-box">
            <input class="input" placeholder="Search people to merge in" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} ref={(el) => void (el && document.activeElement !== el && !filter && el.focus())} />
            {matches.map((o) => (
              <button class="link-row" onClick={() => merge(o.id)}>
                <Avatar id={o.id} name={o.name} url={o.avatar} size={22} /> {o.name}
                <span class="row-nets">
                  {[...new Set(o.identityIds.map((x) => db.identities.get(x)?.network).filter(Boolean))].map((n) => (
                    <NetBadge network={n as P.Network} size={13} />
                  ))}
                </span>
              </button>
            ))}
            {needle && !matches.length && <p class="pf-hint">Nobody by that name.</p>}
            <button class="btn ghost small" onClick={() => setMerging(false)}>
              Done
            </button>
          </div>
        )}
      </Card>

      {!isSelf && (
        <Card title="Notifications" icon="bell">
          <label class="toggle-row">
            <input type="checkbox" checked={!!person?.starred} onChange={(e) => patch({ starred: (e.target as HTMLInputElement).checked })} />
            <span>
              <b>Star</b>
              <small>Always notify for them, on every network, even in busy groups.</small>
            </span>
          </label>
          <label class="toggle-row">
            <input
              type="checkbox"
              checked={rule?.level === 'all'}
              onChange={async (e) => {
                const on = (e.target as HTMLInputElement).checked;
                setRule('person', await ensure(), on ? 'all' : null);
              }}
            />
            <span>
              <b>Always notify, without starring</b>
              <small>The same, for someone you would rather not list as starred. A place set to Off still stays silent.</small>
            </span>
          </label>
        </Card>
      )}

      <Card title="Note" icon="pencil">
        <textarea class="input pf-note" rows={3} placeholder="Only you see this. It stays on the hub." value={profile.note ?? ''} onChange={(e) => patch({ note: (e.target as HTMLTextAreaElement).value })} />
      </Card>
    </>
  );

  return (
    <ProfilePage title={name} label={`${name}'s profile`} onBack={onBack}>
      {hero}
      {!isSelf && !directs.length && !startable.length && (
        <p class="pf-hint pf-banner-note">
          No direct chat yet, and no connected account can start one on {nets.map(netName).join(' or ')}. Start it in the network's own app; it appears here once it exists.
        </p>
      )}
      <Columns main={main} side={side} />
    </ProfilePage>
  );
}
