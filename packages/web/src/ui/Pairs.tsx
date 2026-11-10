/**
 * Design study: a person reached through several of your accounts, each paired with one of theirs (docs, none yet).
 *
 * `?design=current|pairs|pairs-rail` picks how the person page shows it; the choice is kept in this browser and a
 * small picker floats at the bottom left while it is anything but `current`, or the address names one.
 *
 * - pairs: one merged history. Where the pair changes, your account's picture floats at the right of that message,
 *   its text wrapping around it; pairs you are not sending through are grey. The header's pictures and the names in
 *   the message box switch the pair.
 * - pairs-rail: the same history, with every pair in a scrolling row under the name.
 */
import type * as P from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { hueOf, initials } from '../format.ts';
import { identityName, netName } from '../model.ts';
import { phone } from '../phone.ts';
import { db, isSelfIdentity } from '../state.ts';
import { Avatar, Menu, NetBadge } from './bits.tsx';

export type Design = 'current' | 'pairs' | 'pairs-rail';
const DESIGNS: { id: Design; label: string }[] = [
  { id: 'current', label: 'Current' },
  { id: 'pairs', label: 'Pairs' },
  { id: 'pairs-rail', label: 'Pairs rail' },
];
const KEY = 'dither-chat:design';

function initialDesign(): { design: Design; asked: boolean } {
  let asked = false;
  let d: string | null = null;
  try {
    const q = new URLSearchParams(location.search).get('design');
    if (q !== null) {
      asked = true;
      d = q;
      localStorage.setItem(KEY, q);
    } else d = localStorage.getItem(KEY);
  } catch {}
  const design = DESIGNS.some((x) => x.id === d) ? (d as Design) : 'current';
  return { design, asked };
}
const init = typeof location === 'undefined' ? { design: 'current' as Design, asked: false } : initialDesign();
export const design = signal<Design>(init.design);

export function setDesign(d: Design) {
  design.value = d;
  try {
    localStorage.setItem(KEY, d);
  } catch {}
}

/** The floating picker: shown when the address asked for a design, or one other than today's is kept. */
export function DesignPicker() {
  if (!init.asked && design.value === 'current') return null;
  return (
    <div class="design-picker" role="radiogroup" aria-label="Person page design">
      <span>Design</span>
      {DESIGNS.map((d) => (
        <button role="radio" aria-checked={design.value === d.id} class={design.value === d.id ? 'on' : ''} onClick={() => setDesign(d.id)}>
          {d.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ pairs

export interface Pair {
  conv: P.ConversationView;
  acc: P.AccountView | null;
  /** Your identity on that account. */
  mine: P.IdentityView | null;
  /** Theirs in the conversation. */
  theirs: P.IdentityView | null;
}

export function pairOf(conv: P.ConversationView): Pair {
  const acc = conv.vantages.map((v) => db.accounts.get(v.accountId)).find((a): a is P.AccountView => !!a) ?? null;
  const mine = acc?.selfIdentityId ? (db.identities.get(acc.selfIdentityId) ?? null) : null;
  const peer = conv.participantIds.find((p) => !isSelfIdentity(p));
  const theirs = peer ? (db.identities.get(peer) ?? null) : null;
  return { conv, acc, mine, theirs };
}

export const theirName = (p: Pair) => p.theirs?.handle ?? p.theirs?.displayName ?? netName(p.conv.network);
export const myName = (p: Pair) => p.acc?.label || identityName(p.mine?.id) || 'you';
export const pairTitle = (p: Pair) => `${myName(p)} ⇄ ${theirName(p)} on ${netName(p.conv.network)}`;

/** Focus picked per person, this session. Until one is picked, the pair of the latest message. */
const picked = signal<Record<string, string>>({});

export function focusedPair(personId: string, directs: P.ConversationView[]): P.ConversationView {
  const id = picked.value[personId];
  const hit = id && directs.find((d) => d.id === id);
  if (hit) return hit;
  return [...directs].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))[0];
}

/** Focus a pair; a draft typed for the old one moves along, so switching mid-sentence keeps the sentence. */
export function focusPair(personId: string, from: string | null, to: string) {
  if (from && from !== to) {
    try {
      const k = (id: string) => `dither-chat:draft:${id}`;
      const draft = localStorage.getItem(k(from));
      if (draft && !localStorage.getItem(k(to))) {
        localStorage.setItem(k(to), draft);
        localStorage.removeItem(k(from));
      }
    } catch {}
  }
  picked.value = { ...picked.value, [personId]: to };
}

/** Whether the person has more than one account on this network, so which of theirs needs saying. */
function ambiguous(directs: P.ConversationView[], p: Pair): boolean {
  const ids = new Set(directs.filter((d) => d.network === p.conv.network).map((d) => pairOf(d).theirs?.id));
  return ids.size > 1;
}

/** Your account: its picture, else its colour and initials (your accounts' pictures often look alike), and its network. */
function MyPicture({ p, size }: { p: Pair; size: number }) {
  const name = myName(p);
  if (p.mine?.avatar) return <Avatar id={p.acc?.id ?? p.conv.id} name={name} url={p.mine.avatar} size={size} network={p.conv.network} />;
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px` }}>
      <span class="avatar-fallback" style={{ borderRadius: `${size / 2}px`, background: p.acc?.color ?? hueOf(p.conv.id), color: '#14161d', fontSize: `${Math.max(9, Math.round(size * 0.38))}px` }}>
        {initials(name.replace(/^[@+]/, ''))}
      </span>
      <NetBadge network={p.conv.network} size={Math.max(11, Math.round(size * 0.5))} class="avatar-net" />
    </span>
  );
}

/** The picture at the start of a run: your account (and, when it is not obvious, which of theirs). */
export function PairMark({ p, directs, focused, onPick }: { p: Pair; directs: P.ConversationView[]; focused: boolean; onPick: () => void }) {
  const both = ambiguous(directs, p);
  return (
    <button
      class={`pair-mark ${focused ? 'on' : 'off'}`}
      title={focused ? `${pairTitle(p)} (sending here)` : `${pairTitle(p)}. Click to send here`}
      aria-label={focused ? `Sending as ${myName(p)} to ${theirName(p)}` : `Send as ${myName(p)} to ${theirName(p)}`}
      onClick={(e) => {
        e.stopPropagation();
        onPick();
      }}
    >
      <MyPicture p={p} size={26} />
      {both && <span class="pair-mark-theirs">{theirName(p)}</span>}
    </button>
  );
}

/** Under the name: your accounts that talk with them, the one sending in colour. */
export function PairIcons({ personId, directs, focus }: { personId: string; directs: P.ConversationView[]; focus: P.ConversationView }) {
  const pairs = directs.map(pairOf);
  const cur = pairOf(focus);
  const accs: Pair[] = [];
  for (const p of pairs) if (!accs.some((x) => x.acc?.id === p.acc?.id)) accs.push(p);
  return (
    <span class="pair-icons">
      {accs.map((p) => {
        const on = p.acc?.id === cur.acc?.id;
        // The same person of theirs if this account talks with them too, else the latest pair on the account.
        const pick = () => {
          const mineHere = pairs.filter((x) => x.acc?.id === p.acc?.id);
          const same = mineHere.find((x) => x.theirs?.id === cur.theirs?.id);
          const next = same ?? mineHere.sort((a, b) => (b.conv.lastMessageAt ?? 0) - (a.conv.lastMessageAt ?? 0))[0];
          focusPair(personId, focus.id, next.conv.id);
        };
        return (
          <button class={`pair-icon ${on ? 'on' : 'off'}`} title={on ? `Sending as ${myName(p)}` : `Send as ${myName(p)} (${netName(p.conv.network)})`} aria-pressed={on} onClick={pick}>
            <MyPicture p={p} size={22} />
          </button>
        );
      })}
      <span class="pair-icons-name">{myName(cur)}</span>
    </span>
  );
}

/** Under the name, the other design: every pair in a row that scrolls sideways. */
export function PairRail({ personId, directs, focus }: { personId: string; directs: P.ConversationView[]; focus: P.ConversationView }) {
  const pairs = directs.map(pairOf).sort((a, b) => a.conv.network.localeCompare(b.conv.network) || myName(a).localeCompare(myName(b)) || theirName(a).localeCompare(theirName(b)));
  return (
    <span class="pair-rail" role="radiogroup" aria-label="Send through">
      {pairs.map((p) => {
        const on = p.conv.id === focus.id;
        const unread = p.conv.vantages.reduce((n, v) => n + v.unread, 0);
        return (
          <button role="radio" aria-checked={on} class={`pair-item ${on ? 'on' : 'off'}`} title={pairTitle(p)} onClick={() => focusPair(personId, focus.id, p.conv.id)}>
            <MyPicture p={p} size={18} />
            <span class="pair-item-arrow">⇄</span>
            <span class="pair-item-theirs">{theirName(p)}</span>
            {unread > 0 && !on && <span class="pair-item-unread">{unread}</span>}
          </button>
        );
      })}
    </span>
  );
}

/** A name in the message box's line that changes the pair: cycles between two, lists more. */
function Token({ label, options, onPick, picture }: { label: string; options: { id: string; label: string; picture?: ComponentChildren }[]; onPick: (id: string) => void; picture?: ComponentChildren }) {
  const cur = options.findIndex((o) => o.label === label);
  if (options.length < 2)
    return (
      <span class="pair-token fixed">
        {picture}
        {label}
      </span>
    );
  if (options.length === 2)
    return (
      <button class="pair-token" title={`Switch to ${options[(cur + 1) % 2].label}`} onClick={() => onPick(options[(cur + 1) % 2].id)}>
        {picture}
        {label}
      </button>
    );
  return (
    <Menu
      up
      trigger={(toggle) => (
        <button class="pair-token" title="Choose" onClick={toggle} aria-haspopup="menu">
          {picture}
          {label}
        </button>
      )}
    >
      {(close) => (
        <div class="level-menu pair-menu">
          {options.map((o) => (
            <button
              class={`menu-item ${o.label === label ? 'on' : ''}`}
              onClick={() => {
                onPick(o.id);
                close();
              }}
            >
              {o.picture}
              {o.label}
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}

/** "Message Kit (kit.exe) from zyansheep": both names switch. In the box while it is empty, on its edge once typed in. */
export function PairLead({ person, personId, directs, focus }: { person: P.PersonView; personId: string; directs: P.ConversationView[]; focus: P.ConversationView }) {
  const pairs = directs.map(pairOf);
  const cur = pairOf(focus);
  // Theirs you can reach, each once; picking one keeps your account when it talks with them too.
  const theirs: Pair[] = [];
  for (const p of pairs) if (!theirs.some((x) => x.theirs?.id === p.theirs?.id)) theirs.push(p);
  const pickTheirs = (identityId: string) => {
    const withThem = pairs.filter((p) => p.theirs?.id === identityId);
    const next = withThem.find((p) => p.acc?.id === cur.acc?.id) ?? withThem.sort((a, b) => (b.conv.lastMessageAt ?? 0) - (a.conv.lastMessageAt ?? 0))[0];
    if (next) focusPair(personId, focus.id, next.conv.id);
  };
  const mine = pairs.filter((p) => p.theirs?.id === cur.theirs?.id);
  const theirLabel = (p: Pair) => `${netName(p.conv.network)} ${theirName(p)}`;
  // A phone has room for the two names only.
  const short = phone.value;
  const curLabel = short ? theirName(cur) : `${person.name} (${theirName(cur)})`;
  return (
    <span class="pair-lead-line">
      {short ? 'To' : 'Message'}{' '}
      <Token
        label={curLabel}
        options={theirs.map((p) => ({ id: p.theirs?.id ?? p.conv.id, label: p.theirs?.id === cur.theirs?.id ? curLabel : theirLabel(p), picture: <Avatar id={p.theirs?.id ?? p.conv.id} name={theirName(p)} url={p.theirs?.avatar} size={16} network={p.conv.network} /> }))}
        onPick={pickTheirs}
      />{' '}
      from{' '}
      <Token
        label={myName(cur)}
        picture={<MyPicture p={cur} size={16} />}
        options={mine.map((p) => ({ id: p.conv.id, label: myName(p), picture: <MyPicture p={p} size={16} /> }))}
        onPick={(id) => focusPair(personId, focus.id, id)}
      />
    </span>
  );
}
