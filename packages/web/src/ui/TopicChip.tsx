/**
 * The thread a channel stream's box sends to (docs/threads.md "The channel stream"), on the line over the box: "To
 * <thread>", and a click opens a card to find another by name, send to the room itself ("No thread", where the
 * channel takes messages), or name a new topic where the channel starts them (a Zulip channel, a forum).
 */
import type * as P from '@dither-chat/protocol';
import { threadNameProblem } from '@dither-chat/protocol';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { convTitle, resolvedTopic, threadsOf, threadWords } from '../model.ts';
import { db } from '../state.ts';
import { Icon } from './icons.tsx';

/** How many threads the card lists at once: a Zulip channel has a thousand; the name box finds the rest. */
const LISTED = 40;

type Row = { kind: 'thread'; t: P.ConversationView } | { kind: 'own' } | { kind: 'new'; name: string };

export function TopicChip({ c, value, newName, own, canNew, onPick, onNew }: {
  c: P.ConversationView;
  /** The thread (or, where `own`, the channel itself) the box sends to; null when none yet. */
  value: string | null;
  /** A new topic's name, named here and started by the first message. */
  newName: string | null;
  own: boolean;
  canNew: boolean;
  onPick: (convId: string) => void;
  onNew: (name: string) => void;
}) {
  const words = threadWords(c);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [at, setAt] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const cur = value ? db.conversations.get(value) : undefined;
  const shown = newName ?? (cur ? (cur.id === c.id ? 'No thread' : convTitle(cur)) : `Pick a ${words.one}`);
  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(8, Math.min(r.left, innerWidth - Math.min(360, innerWidth - 16) - 8)), bottom: innerHeight - r.top + 4, maxHeight: Math.max(160, r.top - 16) });
    setQ('');
    setHi(0);
    setOpen(true);
  };
  const close = (focusBox = true) => {
    setOpen(false);
    if (focusBox) (document.querySelector('.composer textarea') as HTMLTextAreaElement | null)?.focus();
  };
  // A press anywhere else closes it. Opened, the cursor goes to its name box.
  useLayoutEffect(() => {
    if (!open) return;
    find.current?.focus();
    const away = (e: PointerEvent) => {
      if (!card.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);

  const needle = q.trim().toLowerCase();
  const rows: Row[] = [];
  if (open) {
    if (own && !needle) rows.push({ kind: 'own' });
    const all = threadsOf(c.id);
    // A name typed that no thread has: starting it comes first, so Enter does that rather than take a longer name.
    if (canNew && needle && !all.some((t) => convTitle(t).toLowerCase() === needle)) rows.push({ kind: 'new', name: q.trim() });
    const hits = needle ? all.filter((t) => convTitle(t).toLowerCase().includes(needle)) : all;
    for (const t of hits.slice(0, LISTED)) rows.push({ kind: 'thread', t });
  }
  const choose = (r: Row | undefined) => {
    if (!r) return;
    if (r.kind === 'new') {
      if (threadNameProblem(r.name)) return;
      onNew(r.name);
    } else onPick(r.kind === 'own' ? c.id : r.t.id);
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(0, Math.min(rows.length - 1, h + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[hi]);
    }
  };
  const problem = q.trim() && canNew ? threadNameProblem(q.trim()) : null;
  return (
    <span class="topic-chip-line">
      {'To '}
      <button ref={btn} class="pair-token topic-chip" data-track="topic chip" aria-haspopup="listbox" aria-expanded={open} title={`The ${words.one} your message goes to. Click to pick another${canNew ? ` or start a new ${words.one}` : ''}.`} onClick={() => (open ? close(false) : show())}>
        {newName && <span class="topic-chip-new">New {words.one}:</span>}
        <span class="topic-chip-name">{shown}</span>
        {cur && resolvedTopic(cur) && <Icon name="check" size={11} />}
        <Icon name="chevronDown" size={11} />
      </button>
      {open && at && (
        <div ref={card} class="pair-card topic-card" style={{ left: `${at.left}px`, bottom: `${at.bottom}px`, maxHeight: `${at.maxHeight}px` }}>
          <input
            ref={find}
            class="input topic-find"
            value={q}
            placeholder={canNew ? `Find a ${words.one}, or name a new one` : `Find a ${words.one}`}
            aria-label={`Find a ${words.one}`}
            onInput={(e) => {
              setQ((e.target as HTMLInputElement).value);
              setHi(0);
            }}
            onKeyDown={onKey}
          />
          <div class="topic-rows" role="listbox">
            {rows.map((r, i) => (
              <button
                key={r.kind === 'thread' ? r.t.id : r.kind}
                role="option"
                aria-selected={i === hi}
                class={`topic-row ${i === hi ? 'hi' : ''} ${(r.kind === 'thread' && r.t.id === value) || (r.kind === 'own' && value === c.id) ? 'on' : ''}`}
                onMouseEnter={() => setHi(i)}
                onClick={() => choose(r)}
                disabled={r.kind === 'new' && !!problem}
              >
                {r.kind === 'own' ? (
                  <>
                    <Icon name="hash" size={12} /> No thread: the {c.network === 'matrix' ? 'room' : 'channel'} itself
                  </>
                ) : r.kind === 'new' ? (
                  <>
                    <Icon name="pencil" size={12} /> New {words.one}: <b>{r.name}</b>
                  </>
                ) : (
                  <>
                    <Icon name="thread" size={12} /> <span class="topic-row-name">{convTitle(r.t)}</span>
                    {resolvedTopic(r.t) && <Icon name="check" size={11} />}
                  </>
                )}
              </button>
            ))}
            {!rows.length && <div class="topic-none">{needle ? `No ${words.one} by that name` : `No ${words.many} yet`}</div>}
          </div>
          {problem && <small class="about-reason topic-problem">{problem}</small>}
        </div>
      )}
    </span>
  );
}
