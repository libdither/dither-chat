/**
 * New, as pages of the palette (docs/palette.md, docs/add.md): start a conversation, join a server or group, add
 * someone, scan a code. Someone known, or anything typed or pasted: an invite link, an address, an @username, a phone
 * number. The preview card itself is NewMessage.tsx's, which a card under a message uses too.
 */
import type * as P from '@dither-chat/protocol';
import { directTarget } from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { addRows, isLink, offlineNetworks } from '../add.ts';
import { directNote, openers } from '../direct.ts';
import { directsOf, identityName, netName } from '../model.ts';
import { newMenu, paletteStack, rankPeople, type Entry, type Reachable } from '../palette.ts';
import { api, applyEvents, db, go, openDirect, rev, route } from '../state.ts';
import { addableGroups } from './AddMembers.tsx';
import { AccountChip, Avatar, NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';
import { actOn, AddCard, openAdded, type Card } from './NewMessage.tsx';
import { backPage, closePalette, lookUp, pushPage, scanned } from './Palette.tsx';
import { Frame, type Row } from './PaletteFrame.tsx';
import { MyCodes, ScanCode } from './QrCodes.tsx';
import { NEW_GROUP } from './Switcher.tsx';

interface Person extends Reachable {
  avatar: string | null;
  identities: P.IdentityView[];
}


const isMine = (i: P.IdentityView) => [...db.accounts.values()].some((a) => a.selfIdentityId === i.id);
const bestScore = (convs: P.ConversationView[]) => {
  const s = convs.map((c) => db.attention.get(c.id)?.score).filter((x): x is number => x !== undefined);
  return s.length ? Math.max(...s) : null;
};

/** Everyone New could message: people, and identities not merged into one. */
function knownPeople(): Person[] {
  const rows: Person[] = [];
  for (const p of db.persons.values()) {
    if (p.isSelf) continue;
    const identities = p.identityIds.map((id) => db.identities.get(id)).filter((i): i is P.IdentityView => !!i && !isMine(i));
    const dms = directsOf(p.id);
    if (identities.length) rows.push({ key: p.id, name: p.name, avatar: p.avatar, identities, handles: identities.map((i) => i.handle ?? '').join(' '), score: bestScore(dms), last: Math.max(0, ...dms.map((d) => d.lastMessageAt ?? 0)) });
  }
  for (const i of db.identities.values()) if (!i.personId && !isMine(i)) rows.push({ key: i.id, name: identityName(i.id), avatar: i.avatar, identities: [i], handles: i.handle ?? '', score: null, last: 0 });
  return rows;
}

const canStart = (n: P.Network) => openers(db.accounts.values(), n).length > 0;

/** Someone you already have a DM with on this network: go there, nothing to create. Else "Message X on Network". */
function choose(i: P.IdentityView) {
  const dm = i.personId ? directsOf(i.personId).find((d) => d.network === i.network) : undefined;
  if (dm) {
    closePalette();
    return go({ view: 'inbox', conv: dm.id });
  }
  pushPage({ kind: 'message', network: i.network, peer: i.nativeId, name: identityName(i.id) });
}

/** The group on screen, when one of your accounts could add people to it. */
function groupHere() {
  const r = route.value as { conv?: string };
  return r.conv ? addableGroups().find((g) => g.conv.id === r.conv) : undefined;
}

const PLACEHOLDER = { message: 'Name, @username or phone', join: 'Invite link or address', add: 'Username, @handle or phone' } as const;
const MENU_ICON: Record<string, string> = { 'n:add-here': 'userPlus', 'n:add': 'userPlus', 'n:group': 'groups', 'n:scan': 'scan', 'n:mine': 'qr' };

/** New: its menu and the people you would most likely message; typed or pasted, everything the box reads. */
export function NewPage({ e }: { e: Entry & { kind: 'new' } }) {
  rev.value;
  const needle = e.q.trim();
  const accounts = [...db.accounts.values()];
  const readings = needle ? addRows(needle, accounts) : [];
  const offline = needle && !readings.length ? offlineNetworks(needle, accounts) : [];
  // With nothing typed, Join and Add someone offer their menu only: the people are New's and New message's.
  const people = needle || !e.mode || e.mode === 'message' ? rankPeople(knownPeople().filter((r) => r.identities.some((i) => canStart(i.network))), needle) : [];

  const here = needle ? undefined : groupHere();
  const menu = needle ? [] : newMenu({ mode: e.mode, newGroup: !!NEW_GROUP, canAdd: addableGroups().length > 0, here: here ? here.title : null });
  const menuRows = menu.map(
    (m): Row => ({
      key: m.key,
      label: m.label,
      icon: <Icon name={MENU_ICON[m.key] as any} size={18} />,
      class: `switcher-row ${m.key === 'n:scan' ? 'qr-scan-btn' : m.key === 'n:mine' ? 'qr-mine-btn' : ''}`,
      track: `menu (${m.key.slice(2)})`,
      run: () =>
        m.key === 'n:scan'
          ? pushPage({ kind: 'scan', into: e.id })
          : m.key === 'n:mine'
            ? pushPage({ kind: 'mine' })
            : m.key === 'n:add-here'
              ? pushPage({ kind: 'add', conversationId: here!.conv.id, accountId: here!.accountId })
              : m.key === 'n:add'
                ? pushPage({ kind: 'groups' })
                : pushPage(NEW_GROUP!),
    }),
  );

  const readingRows = readings.map((r): Row => {
    const data = { network: r.ref.network, kind: r.ref.kind };
    if (r.state.kind === 'resolve')
      // Asked only from a click or Enter on its row (a link also on a paste): never per keystroke.
      return { key: `r:${r.key}`, class: 'switcher-row add-reading', data, track: 'reading', icon: <NetBadge network={r.ref.network} size={20} />, label: <span class="add-reading-label">{r.label}</span>, sub: 'Look it up', run: () => pushPage({ kind: 'card', row: r }) };
    if (r.state.kind === 'direct') {
      const peer = r.state.peer;
      return {
        key: `r:${r.key}`,
        class: 'switcher-row add-reading',
        data,
        track: 'reading (message)',
        icon: <NetBadge network={r.ref.network} size={20} />,
        label: (
          <>
            Message <b>{needle}</b>
          </>
        ),
        sub: `on ${netName(r.ref.network)}`,
        run: () => pushPage({ kind: 'message', network: r.ref.network, peer, name: needle }),
      };
    }
    return {
      key: `r:${r.key}`,
      class: 'set-help add-unbuilt',
      data: { network: r.ref.network },
      inner: (
        <>
          <NetBadge network={r.ref.network} size={16} /> {r.state.line}
        </>
      ),
    };
  });
  const offlineRows: Row[] = offline.length ? [{ key: 'offline', class: 'set-help', label: `No connected ${netName(offline[0])} account here can do this.` }] : [];

  const personRows = people.map((r): Row => {
    const reach = r.identities.filter((i) => canStart(i.network));
    return {
      key: r.key,
      class: 'switcher-row new-message-row',
      holder: true,
      track: 'row (person)',
      run: () => (reach.length === 1 ? choose(reach[0]) : pushPage({ kind: 'reach', key: r.key })),
      inner: (
        <>
          <Avatar id={r.key} name={r.name} url={r.avatar} size={28} />
          <span class="new-message-name">{r.name}</span>
          {reach.map((i) => (
            <button
              class="chip-btn"
              tabIndex={-1}
              title={`${netName(i.network)}: ${i.handle ?? i.nativeId}`}
              onClick={(ev) => {
                ev.stopPropagation();
                choose(i);
              }}
            >
              <NetBadge network={i.network} size={14} /> {netName(i.network)}
            </button>
          ))}
        </>
      ),
    };
  });

  const link = isLink(needle);
  const rows = [...menuRows, ...(link ? [...readingRows, ...offlineRows, ...personRows] : [...personRows, ...readingRows, ...offlineRows])];
  const nobody = needle && !rows.length && (
    <p class="set-help palette-help">
      Nobody by that name. Paste an invite link to join a server or group, or type an @username, a Matrix ID, or a phone number with its country code. On Discord, someone your account has seen, or their username.
    </p>
  );
  return (
    <Frame
      e={e}
      class="new-message"
      placeholder={e.mode ? PLACEHOLDER[e.mode] : 'Name, invite link, @username or phone'}
      typing
      rows={rows}
      empty={nobody || undefined}
      listClass="new-message-list"
      onEnter={() => lookUp(e.q)}
      onPasted={(text) => void lookUp(text)}
    />
  );
}

/** Someone known on several networks: which one to message them on. */
export function ReachPage({ e }: { e: Entry & { kind: 'reach' } }) {
  rev.value;
  const p = db.persons.get(e.key);
  const ids = p ? p.identityIds.map((id) => db.identities.get(id)).filter((i): i is P.IdentityView => !!i && !isMine(i)) : [db.identities.get(e.key)].filter((i): i is P.IdentityView => !!i);
  const rows = ids
    .filter((i) => canStart(i.network))
    .map((i): Row => ({ key: i.id, class: 'switcher-row', data: { network: i.network }, track: 'row (network)', icon: <NetBadge network={i.network} size={20} />, label: `On ${netName(i.network)}`, sub: i.handle ?? i.nativeId, run: () => choose(i) }));
  return <Frame e={e} class="new-message" rows={rows} empty={<p class="set-help palette-help">No connected account can message them now.</p>} />;
}

/** "Message X on Network": which account sends, what opening does there, and Open conversation. */
export function MessagePage({ e }: { e: Entry & { kind: 'message' } }) {
  rev.value;
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = isBottom(e);
  const from = openers(db.accounts.values(), e.network);

  const start = async () => {
    if (busy) return;
    const account = from.find((a) => a.id === accountId) ?? from[0];
    if (!account) return setError(`No connected ${netName(e.network)} account can start this.`);
    const address = directTarget(e.network, e.peer);
    if ('error' in address) return setError(address.error);
    setBusy(true);
    setError(null);
    try {
      const r = await openDirect(account.id, address.peer);
      if (!r.conversation) throw new Error('The network did not say which conversation it opened.');
      closePalette();
      go({ view: 'inbox', conv: r.conversation.id });
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame
      e={e}
      class="new-message"
      onEnter={() => void start()}
      body={
        <div class="new-message-target">
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
          <p class="set-help">{directNote(e.network, e.name)}</p>
          {!from.length && (
            <p class="set-help">
              <Icon name="alert" size={13} /> No connected {netName(e.network)} account can start this.
            </p>
          )}
          {error && (
            <p class="new-message-error" role="alert">
              <Icon name="alert" size={13} /> {error}
            </p>
          )}
          <div class="btn-row">
            <button class="btn small new-message-open" data-track="open conversation" disabled={busy || !from.length} onClick={start}>
              <Icon name="send" size={13} /> {busy ? 'Opening…' : 'Open conversation'}
            </button>
            {!bottom && (
              <button class="btn ghost small" onClick={backPage}>
                Back
              </button>
            )}
          </div>
        </div>
      }
    />
  );
}

/** A page opened straight (the palette's bottom page) has no Back: backing out of it closes. */
const isBottom = (e: Entry) => paletteStack.value?.[0]?.id === e.id;

/** A reading looked up: the account asked, its preview, and what can be done with it. */
export function CardPage({ e }: { e: Entry & { kind: 'card' } }) {
  const [card, setCard] = useState<Card>(() => ({ row: e.row, accountId: e.via ?? (e.row.state.kind === 'resolve' ? e.row.state.accounts[0].id : ''), loading: true }));
  const [live, setLive] = useState(false);
  const asked = useRef(0);

  /** Ask an account what a reading is. Only from a click, a paste or Enter: never per keystroke. */
  const resolve = async (via?: string) => {
    const row = e.row;
    if (row.state.kind !== 'resolve') return;
    const acc = row.state.accounts.find((a) => a.id === via) ?? row.state.accounts[0];
    const n = ++asked.current;
    setCard({ row, accountId: acc.id, loading: true });
    try {
      const v = await api<P.AddPreviewView>('/api/add/resolve', { body: { accountId: acc.id, ref: row.ref } });
      if (v.identities.length) applyEvents(v.identities.map((identity) => ({ t: 'identity', identity }) as P.ClientEvent));
      if (n === asked.current) setCard({ row, accountId: acc.id, loading: false, view: v });
    } catch (err: any) {
      if (n === asked.current) setCard({ row, accountId: acc.id, loading: false, error: String(err?.message ?? err) });
    }
  };
  useEffect(() => {
    void resolve(e.via);
    return () => void ++asked.current;
  }, []);

  const open = (conversationId?: string | null, spaceId?: string | null) => (closePalette(), openAdded(conversationId, spaceId));
  return (
    <Frame
      e={e}
      class="new-message"
      body={<AddCard card={card} live={live} setLive={setLive} onAccount={(id) => void resolve(id)} onAct={(a, confirm) => void actOn(card, a, setCard, closePalette, confirm)} onOpen={open} onBack={backPage} onClose={closePalette} />}
    />
  );
}

const qrBack = (e: Entry) =>
  !isBottom(e) && (
    <div class="btn-row">
      <button class="btn ghost small qr-back" onClick={backPage}>
        Back
      </button>
    </div>
  );

/** Scan a code: what it holds fills New as a paste would. A scan never acts. */
export function ScanPage({ e }: { e: Entry & { kind: 'scan' } }) {
  return (
    <Frame
      e={e}
      class="new-message"
      body={
        <>
          <ScanCode onLink={scanned} />
          {qrBack(e)}
        </>
      }
    />
  );
}

/** Your own codes, one per account. */
export function MinePage({ e }: { e: Entry & { kind: 'mine' } }) {
  return (
    <Frame
      e={e}
      class="new-message"
      body={
        <>
          <MyCodes />
          {qrBack(e)}
        </>
      }
    />
  );
}


