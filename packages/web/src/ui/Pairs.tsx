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
 * - sliders: two sliders under the name, theirs then yours (only your accounts that talk with the one of theirs
 *   picked); drag between pictures or click to step, with a spring. Their messages name their account in a pill
 *   beside the name; yours say "sent from" which of yours, in grey. No pictures at the right.
 * - chunks: all chats together by default, each run of one pair a chunk with a label at its top and a bar down its
 *   side; a dropdown on the name's line (press and drag to a pair, or click) shows one pair's history alone.
 *
 * Every design starts by sending where the place you came from points: from a Discord group on one of your accounts,
 * the DM through that account; else the pair of the latest message.
 */
import type * as P from '@dither-chat/protocol';
import { effect, signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { hueOf, initials } from '../format.ts';
import { identityName, netName } from '../model.ts';
import { phone } from '../phone.ts';
import { api, db, isSelfIdentity, route, toast } from '../state.ts';
import { Avatar, Menu, NetBadge } from './bits.tsx';

export type Design = 'current' | 'pairs' | 'pairs-rail' | 'sliders' | 'chunks';
const DESIGNS: { id: Design; label: string }[] = [
  { id: 'current', label: 'Current' },
  { id: 'pairs', label: 'Pairs' },
  { id: 'pairs-rail', label: 'Pairs rail' },
  { id: 'sliders', label: 'Sliders' },
  { id: 'chunks', label: 'Chunks' },
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

/** Their name on the network: the username, or the profile name where the handle is a phone number (Signal, WhatsApp). */
export const theirName = (p: Pair) => {
  const h = p.theirs?.handle;
  if (h && /^\+?[\d\s()-]{6,}$/.test(h) && p.theirs?.displayName) return p.theirs.displayName;
  return h ?? p.theirs?.displayName ?? netName(p.conv.network);
};
export const myName = (p: Pair) => p.acc?.label || identityName(p.mine?.id) || 'you';
export const pairTitle = (p: Pair) => `${myName(p)} ⇄ ${theirName(p)} on ${netName(p.conv.network)}`;

/** Focus picked per person, this session. Until one is picked, the pair of the latest message. */
const picked = signal<Record<string, string>>({});

/** The last conversation open before this page: where you came from, to guess which of your accounts to send as. */
const cameFrom = signal<string | null>(null);
if (typeof window !== 'undefined')
  effect(() => {
    const r = route.value as { view: string; conv?: string };
    if (r.view !== 'people' && r.conv) cameFrom.value = r.conv;
  });

export function focusedPair(personId: string, directs: P.ConversationView[]): P.ConversationView {
  const id = picked.value[personId];
  const hit = id && directs.find((d) => d.id === id);
  if (hit) return hit;
  const latest = (xs: P.ConversationView[]) => [...xs].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))[0];
  const from = cameFrom.value ? db.conversations.get(cameFrom.value) : null;
  if (from) {
    // Their DM itself; else a DM through the account you were reading on; else one on that network.
    const same = directs.find((d) => d.id === from.id);
    if (same) return same;
    const accs = new Set(from.vantages.map((v) => v.accountId));
    const viaAcc = directs.filter((d) => d.vantages.some((v) => accs.has(v.accountId)));
    if (viaAcc.length) return latest(viaAcc);
    const onNet = directs.filter((d) => d.network === from.network);
    if (onNet.length) return latest(onNet);
  }
  return latest(directs);
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
  // On a phone the line only says where it goes: a tap in the box is for typing, not for switching accounts.
  if (options.length < 2 || phone.value)
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

// ------------------------------------------------------------------ sliders

const PAD = 3;
/** A picture's width in the track: smaller on a phone, where both sliders share the header with the back button. */
const slotWidth = () => (phone.value ? 26 : 30);

/**
 * Pictures in a track with a thumb on the picked one. Drag the thumb (or anywhere on the track) and let go near a
 * picture; a click without a drag steps to the next. The thumb moves on a spring that overshoots a little, starting
 * from the speed it was let go at; the track's width springs too as pictures come and go.
 */
function Slider({ items, index, onPick, label }: { items: { id: string; picture: ComponentChildren; title: string }[]; index: number; onPick: (i: number) => void; label: string }) {
  const SLOT = slotWidth();
  const thumb = useRef<HTMLSpanElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const s = useRef({ x: index * SLOT, v: 0, target: index * SLOT, raf: 0, last: 0, drag: null as null | { id: number; x0: number; pos0: number; moved: boolean; lastX: number; lastT: number } });
  const n = items.length;
  const draw = () => {
    if (thumb.current) thumb.current.style.transform = `translateX(${s.current.x}px)`;
  };
  const run = () => {
    const st = s.current;
    if (st.raf) return;
    st.last = performance.now();
    const step = (t: number) => {
      const dt = Math.min(0.032, (t - st.last) / 1000);
      st.last = t;
      if (!st.drag) {
        // Underdamped: settles in about half a second with one small overshoot.
        const a = -420 * (st.x - st.target) - 21 * st.v;
        st.v += a * dt;
        st.x += st.v * dt;
      }
      draw();
      if (st.drag || Math.abs(st.x - st.target) > 0.2 || Math.abs(st.v) > 2) st.raf = requestAnimationFrame(step);
      else {
        st.x = st.target;
        st.v = 0;
        st.raf = 0;
        draw();
      }
    };
    st.raf = requestAnimationFrame(step);
  };
  useLayoutEffect(() => {
    s.current.target = index * SLOT;
    run();
  }, [index, n, SLOT]);
  useEffect(() => () => cancelAnimationFrame(s.current.raf), []);
  const max = (n - 1) * SLOT;
  const onDown = (e: PointerEvent) => {
    if (n < 2) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    s.current.drag = { id: e.pointerId, x0: e.clientX, pos0: s.current.x, moved: false, lastX: e.clientX, lastT: performance.now() };
  };
  const onMove = (e: PointerEvent) => {
    const d = s.current.drag;
    if (!d || d.id !== e.pointerId) return;
    if (Math.abs(e.clientX - d.x0) > 4) d.moved = true;
    if (!d.moved) return;
    let x = d.pos0 + e.clientX - d.x0;
    // Past either end it gives, a third as far.
    if (x < 0) x /= 3;
    if (x > max) x = max + (x - max) / 3;
    const t = performance.now();
    if (t > d.lastT) s.current.v = ((e.clientX - d.lastX) / (t - d.lastT)) * 1000;
    d.lastX = e.clientX;
    d.lastT = t;
    s.current.x = x;
    run();
  };
  const onUp = (e: PointerEvent) => {
    const d = s.current.drag;
    if (!d || d.id !== e.pointerId) return;
    s.current.drag = null;
    if (!d.moved) {
      onPick((index + 1) % n);
      return;
    }
    // Where it would coast to, so a flick goes further than a slow drag.
    const coast = s.current.x + s.current.v * 0.05;
    const i = Math.max(0, Math.min(n - 1, Math.round(coast / SLOT)));
    s.current.target = i * SLOT;
    run();
    if (i !== index) onPick(i);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    onPick((index + step + n) % n);
  };
  return (
    <div
      ref={track}
      class={`pair-slider ${n < 2 ? 'single' : ''}`}
      style={{ width: `${n * SLOT + 2 * PAD}px`, '--slot': `${SLOT}px` } as Record<string, string>}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={n}
      aria-valuenow={index + 1}
      aria-valuetext={items[index]?.title}
      title={n < 2 ? items[0]?.title : `${items[index]?.title}. Drag, or click for the next`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
    >
      <span class="pair-slider-thumb" ref={thumb} style={{ transform: `translateX(${s.current.x}px)` }} />
      {items.map((it, i) => (
        <span key={it.id} class={`pair-slider-item ${i === index ? 'on' : 'off'}`}>
          {it.picture}
        </span>
      ))}
    </div>
  );
}

/** Under the name: their accounts, then yours that talk with the one picked, then the pair in words. */
export function PairSliders({ personId, directs, focus }: { personId: string; directs: P.ConversationView[]; focus: P.ConversationView }) {
  const pairs = directs.map(pairOf);
  const cur = pairOf(focus);
  const theirs: Pair[] = [];
  for (const p of [...pairs].sort((a, b) => a.conv.network.localeCompare(b.conv.network) || theirName(a).localeCompare(theirName(b)))) if (!theirs.some((x) => x.theirs?.id === p.theirs?.id)) theirs.push(p);
  const mine = pairs.filter((p) => p.theirs?.id === cur.theirs?.id).sort((a, b) => myName(a).localeCompare(myName(b)));
  const ti = Math.max(0, theirs.findIndex((p) => p.theirs?.id === cur.theirs?.id));
  const mi = Math.max(0, mine.findIndex((p) => p.conv.id === focus.id));
  const pickTheirs = (i: number) => {
    const id = theirs[i]?.theirs?.id;
    const withThem = pairs.filter((p) => p.theirs?.id === id);
    const next = withThem.find((p) => p.acc?.id === cur.acc?.id) ?? withThem.sort((a, b) => (b.conv.lastMessageAt ?? 0) - (a.conv.lastMessageAt ?? 0))[0];
    if (next) focusPair(personId, focus.id, next.conv.id);
  };
  return (
    <span class="pair-sliders">
      <Slider
        label="Their account"
        items={theirs.map((p) => ({ id: p.theirs?.id ?? p.conv.id, title: `${theirName(p)} on ${netName(p.conv.network)}`, picture: <Avatar id={p.theirs?.id ?? p.conv.id} name={theirName(p)} url={p.theirs?.avatar} size={22} network={p.conv.network} /> }))}
        index={ti}
        onPick={pickTheirs}
      />
      <span class="pair-sliders-arrow" aria-hidden="true">
        ⇄
      </span>
      <Slider label="Your account" items={mine.map((p) => ({ id: p.conv.id, title: myName(p), picture: <MyPicture p={p} size={22} /> }))} index={mi} onPick={(i) => mine[i] && focusPair(personId, focus.id, mine[i].conv.id)} />
      <span class="pair-sliders-text">
        <b>{theirName(cur)}</b> ⇄ {myName(cur)}
      </span>
    </span>
  );
}

/** The person's name, which is your nickname for them: click the pencil to change it (this hub only). */
export function Nickname({ person, onOpen }: { person: P.PersonView; onOpen: () => void }) {
  const [editing, setEditing] = useState(false);
  const save = async (name: string) => {
    setEditing(false);
    const v = name.trim();
    if (!v || v === person.name) return;
    await api(`/api/persons/${person.id}`, { method: 'PATCH', body: { name: v } }).catch((e) => toast({ kind: 'error', title: 'Could not save that', body: e.message }));
  };
  if (editing)
    return (
      <input
        class="pair-nick-input"
        value={person.name}
        aria-label="Nickname"
        ref={(el) => {
          if (el && document.activeElement !== el) {
            el.focus();
            el.select();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save((e.target as HTMLInputElement).value);
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={(e) => void save((e.target as HTMLInputElement).value)}
      />
    );
  return (
    <>
      <button class="conv-head-name" title={`${person.name}'s profile`} onClick={onOpen}>
        {person.name}
      </button>
      <button class="pair-nick-edit" title="Nickname (only you see it)" aria-label="Change nickname" onClick={() => setEditing(true)}>
        ✎
      </button>
    </>
  );
}

// ------------------------------------------------------------------ chunks

/** What the person page shows, per person this session: every chat (the default) or one pair's. */
export const viewing = signal<Record<string, string>>({});
export const viewOf = (personId: string, directs: P.ConversationView[]) => {
  const v = viewing.value[personId];
  return v && directs.some((d) => d.id === v) ? v : 'all';
};

/** A pair as a line: their picture and account, ⇄, yours; or, with `net`, the network's icon and the two names. */
function PairLine({ p, size = 16, net }: { p: Pair; size?: number; net?: boolean }) {
  if (net)
    return (
      <>
        <NetBadge network={p.conv.network} size={size} />
        <span class="pair-line-theirs">{theirName(p)}</span>
        <span class="pair-line-arrow">⇄</span>
        <span class="pair-line-mine">{myName(p)}</span>
      </>
    );
  return (
    <>
      <Avatar id={p.theirs?.id ?? p.conv.id} name={theirName(p)} url={p.theirs?.avatar} size={size} network={p.conv.network} />
      <span class="pair-line-theirs">{theirName(p)}</span>
      <span class="pair-line-arrow">⇄</span>
      <MyPicture p={p} size={size} />
      <span class="pair-line-mine">{myName(p)}</span>
    </>
  );
}

/**
 * On the name's line: all chats, or one pair's. Press and drag down to a row and let go to pick it, or click to open
 * and click a row.
 */
export function PairDropdown({ personId, directs, focus }: { personId: string; directs: P.ConversationView[]; focus: P.ConversationView }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  // The header clips what overflows it, so the list is placed on the page, under the button.
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(8, Math.min(r.left, innerWidth - 320)), top: r.bottom + 4 });
    setOpen(true);
  };
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pairs = directs.map(pairOf).sort((a, b) => a.conv.network.localeCompare(b.conv.network) || theirName(a).localeCompare(theirName(b)) || myName(a).localeCompare(myName(b)));
  const v = viewOf(personId, directs) === 'all' ? 'all' : focus.id;
  const cur = v === 'all' ? null : pairOf(directs.find((d) => d.id === v)!);
  const pick = (id: string) => {
    setOpen(false);
    setHover(null);
    viewing.value = { ...viewing.value, [personId]: id };
    if (id !== 'all') focusPair(personId, focus.id, id);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const rowAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-pair-row]')?.dataset.pairRow ?? null;
  return (
    <div class="pair-dd" ref={root}>
      <button
        ref={btn}
        class={`pair-dd-btn ${open ? 'open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Which chats to show. Press and drag to pick, or click"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          press.current = { x: e.clientX, y: e.clientY, moved: false };
          try {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
          } catch {}
          if (!open) show();
          else press.current = null;
          // Moves and the release are followed on the document, so the drag can end on a row.
          const move = (ev: PointerEvent) => {
            if (!press.current) return;
            if (Math.hypot(ev.clientX - press.current.x, ev.clientY - press.current.y) > 6) press.current.moved = true;
            setHover(rowAt(ev.clientX, ev.clientY));
          };
          const up = (ev: PointerEvent) => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            const p0 = press.current;
            press.current = null;
            if (!p0) {
              setOpen(false);
              return;
            }
            const row = rowAt(ev.clientX, ev.clientY);
            if (p0.moved && row) pick(row);
            else if (p0.moved) setOpen(false);
          };
          document.addEventListener('pointermove', move);
          document.addEventListener('pointerup', up);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault();
            show();
          }
        }}
      >
        {cur ? (
          <PairLine p={cur} size={16} net />
        ) : (
          <span class="pair-dd-all">
            All chats <span class="pair-dd-count">{directs.length}</span>
          </span>
        )}
        <span class="pair-dd-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div class="pair-dd-menu" role="listbox" aria-label="Show" style={at ? { left: `${at.left}px`, top: `${at.top}px` } : undefined}>
          <button role="option" aria-selected={v === 'all'} data-pair-row="all" class={`pair-dd-row ${v === 'all' ? 'on' : ''} ${hover === 'all' ? 'hover' : ''}`} onClick={() => pick('all')}>
            <span class="pair-dd-all">All chats together</span>
            <span class="pair-dd-count">{directs.length}</span>
          </button>
          {pairs.map((p) => {
            const unread = p.conv.vantages.reduce((n, x) => n + x.unread, 0);
            return (
              <button role="option" aria-selected={v === p.conv.id} data-pair-row={p.conv.id} class={`pair-dd-row ${v === p.conv.id ? 'on' : ''} ${hover === p.conv.id ? 'hover' : ''}`} onClick={() => pick(p.conv.id)}>
                <PairLine p={p} size={18} net />
                <span class="pair-dd-net">{netName(p.conv.network)}</span>
                {unread > 0 && <span class="pair-item-unread">{unread}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The top of a chunk: whose accounts these messages went between. Click to send there. */
export function ChunkHead({ p, focused, onPick }: { p: Pair; focused: boolean; onPick: () => void }) {
  return (
    <div class={`pair-chunk-head ${focused ? 'on' : 'off'}`}>
      <button title={focused ? `Sending as ${myName(p)} to ${theirName(p)}` : `Send as ${myName(p)} to ${theirName(p)}`} onClick={onPick}>
        <PairLine p={p} size={16} net />
        {focused && <span class="pair-chunk-sending">sending here</span>}
      </button>
    </div>
  );
}

/**
 * Whether you gave them a name of your own. The hub keeps one flag for "merged or renamed by you", so for this study
 * a name counts as yours when none of their accounts goes by it.
 */
export function hasNickname(person: P.PersonView | null | undefined): boolean {
  if (!person || person.isSelf) return false;
  const n = person.name.trim().toLowerCase();
  return !person.identityIds.some((id) => {
    const i = db.identities.get(id);
    return [i?.displayName, i?.handle].some((x) => x && x.trim().toLowerCase().replace(/^@/, '') === n.replace(/^@/, ''));
  });
}
