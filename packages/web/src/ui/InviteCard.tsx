/**
 * Invite links in a message (docs/add.md, "Invites in messages"): a card under the message for each, the way Discord
 * shows invites. It says what kind of link it is at once and asks the network only when Preview is clicked: each look
 * is a request from your account, and paced. Then it shows what New's card shows, with the same actions
 * (NewMessage.tsx). A preview any page looked up within the hour comes from the hub without asking again.
 */
import type * as P from '@dither-chat/protocol';
import { addRefKey, notBuiltLine } from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { addRows } from '../add.ts';
import { findInvites, inviteKind, shortLink, type FoundInvite } from '../invites.ts';
import { netName } from '../model.ts';
import { api, applyEvents, db, metaRev } from '../state.ts';
import { cardOpen } from '../palette.ts';
import { NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';
import { actOn, AddCard, openAdded, type Card } from './NewMessage.tsx';

/** Previews by reading, then by account: what the hub kept and what this page looked up. */
const known = new Map<string, Map<string, P.AddPreviewView>>();
const knownRev = signal(0);
/** Readings this page has asked the hub about already. */
const asked = new Set<string>();
let queue: P.AddRef[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function remember(views: P.AddPreviewView[]) {
  if (!views.length) return;
  const people = views.flatMap((v) => v.identities);
  if (people.length) applyEvents(people.map((identity) => ({ t: 'identity', identity }) as P.ClientEvent));
  for (const v of views) {
    const k = addRefKey(v.ref);
    if (!known.has(k)) known.set(k, new Map());
    known.get(k)!.set(v.accountId, v);
  }
  knownRev.value++;
}

/** What the hub kept of these readings: never a request to a network, and free of the pace. */
async function kept(refs: P.AddRef[]) {
  try {
    remember((await api<{ previews: P.AddPreviewView[] }>('/api/add/cached', { body: { refs } })).previews);
  } catch {
    // Asked again when the card is next drawn.
    for (const r of refs) asked.delete(addRefKey(r));
  }
}

/** Once per page and reading (`again`: once more), batched over the cards drawn in the same moment. */
function wantKept(ref: P.AddRef, again = false) {
  const k = addRefKey(ref);
  if (asked.has(k) && !again) return;
  asked.add(k);
  queue.push(ref);
  timer ??= setTimeout(function send() {
    const refs = queue.splice(0, 50);
    timer = queue.length ? setTimeout(send, 0) : null;
    void kept(refs);
  }, 30);
}

/** The cards for a message's text: `body` is what is shown, a forward's text included. */
export function InviteCards({ m, body }: { m: P.MessageView; body: string }) {
  const found = useMemo(() => findInvites(body), [body]);
  if (!found.length || m.deleted || m.kind === 'encrypted') return null;
  return (
    <div class="invite-cards">
      {found.map((f) => (
        <InviteCard key={f.key} f={f} seenVia={m.seenVia} />
      ))}
    </div>
  );
}

/** A Matrix room by its id that the hub holds already: joined, without asking anyone. */
function heldRoom(ref: P.AddRef): { space?: string; conversation?: string } | null {
  if (ref.kind !== 'place' || !ref.address.startsWith('!')) return null;
  for (const s of db.spaces.values()) if (s.network === ref.network && s.nativeId === ref.address) return { space: s.id };
  for (const c of db.conversations.values()) if (c.network === ref.network && c.nativeId === ref.address) return { conversation: c.id };
  return null;
}

function InviteCard({ f, seenVia }: { f: FoundInvite; seenVia: string[] }) {
  // Accounts, spaces and conversations are names-and-settings changes: a message arriving does not draw this again.
  metaRev.value;
  knownRev.value;
  const [card, setCard] = useState<Card | null>(null);
  const [live, setLive] = useState(false);
  const seq = useRef(0);
  // Asked once; and again after the palette's card goes, which may have looked it up (a click on the link opens it).
  const boxOpen = cardOpen.value;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (boxOpen) return void (wasOpen.current = true);
    wantKept(f.ref, wasOpen.current);
    wasOpen.current = false;
  }, [f.key, boxOpen]);

  const net = f.ref.network;
  const row = addRows(f.url, db.accounts.values()).find((r) => addRefKey(r.ref) === f.key);
  const resolvers = row?.state.kind === 'resolve' ? row.state.accounts : [];
  // The account the message came through, when it can look this up.
  const mine = resolvers.find((a) => seenVia.includes(a.id)) ?? resolvers[0];
  const views = known.get(f.key);
  const view = views && ((mine && views.get(mine.id)) ?? [...views.values()].find((v) => resolvers.some((a) => a.id === v.accountId)));
  const shown: Card | null = card ?? (row && view ? { row, accountId: view.accountId, loading: false, view } : null);
  const joined = shown?.view?.joined ?? (shown ? null : heldRoom(f.ref));

  const resolve = async (accountId: string) => {
    if (!row) return;
    const n = ++seq.current;
    setCard({ row, accountId, loading: true });
    try {
      const v = await api<P.AddPreviewView>('/api/add/resolve', { body: { accountId, ref: f.ref } });
      remember([v]);
      if (n === seq.current) setCard({ row, accountId, loading: false, view: v });
    } catch (e: any) {
      if (n === seq.current) setCard({ row, accountId, loading: false, error: String(e?.message ?? e) });
    }
  };
  const act = async (c: Card, a: P.AddAction, confirm?: boolean) => {
    const r = await actOn(c, a, setCard, () => {}, confirm);
    if (!r || r.check || r.confirm) return;
    // What the hub keeps now says joined, asked or added: every card for it shows that.
    await kept([f.ref]);
    if (!r.pending && (r.conversation || r.spaceId)) setCard(null);
  };

  return (
    <div class="invite-card" data-network={net} data-kind={f.ref.kind} data-url={f.url}>
      <div class="invite-head">
        <NetBadge network={net} size={16} />
        <span class="invite-kind">{inviteKind(f.ref)}</span>
        {joined && (
          <span class="invite-joined">
            <Icon name="check" size={12} /> Joined
          </span>
        )}
        <span class="invite-url" title={f.url}>
          {shortLink(f.url)}
        </span>
      </div>
      {shown ? (
        <AddCard
          card={shown}
          inline
          live={live}
          setLive={setLive}
          onAccount={(id) => void resolve(id)}
          onAct={(a, confirm) => void act(shown, a, confirm)}
          onOpen={openAdded}
          onBack={() => (++seq.current, setCard(null))}
          onClose={() => setCard(shown.view ? { ...shown, done: undefined } : null)}
        />
      ) : joined ? (
        <div class="btn-row">
          <button class="btn small invite-open" onClick={() => openAdded(joined.conversation, joined.space)}>
            Open
          </button>
        </div>
      ) : mine ? (
        <div class="btn-row">
          <button class="btn small invite-preview" title={`Ask ${netName(net)} what this is, as ${mine.label}`} onClick={() => void resolve(mine.id)}>
            <Icon name="eye" size={13} /> Preview
          </button>
        </div>
      ) : (
        <p class="set-help invite-unbuilt">{row ? (row.state.kind === 'unbuilt' ? row.state.line : notBuiltLine(f.ref)) : `No connected ${netName(net)} account here can join this.`}</p>
      )}
    </div>
  );
}
