/**
 * A person's name in their profile's hero (docs/profile.md "Choosing from the hero"): the name, a click copies it; their
 * other names on a line under it, a click copies each, with a mark where more than one of their accounts has one; and a
 * pencil that turns the name into a field with their names listed under it, to pick one or to type a nickname.
 */
import { Fragment } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { NameEntry, NameRow } from '../namechoices.ts';
import { whereFrom } from '../namechoices.ts';
import { copy } from './ContextMenu.tsx';
import { NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';

/** "×2" after a name more than one of their accounts has, the accounts on hover. */
function Shared({ e }: { e: NameEntry }) {
  if (e.refs.length < 2) return null;
  return (
    <span class="pf-name-shared" title={`${e.text}: ${whereFrom(e)}`} aria-label={`on ${e.refs.length} of their accounts`}>
      ×{e.refs.length}
    </span>
  );
}

export function HeroName({
  name,
  also,
  rows,
  nickname,
  editing,
  setEditing,
  onPick,
  onNickname,
}: {
  name: string;
  /** The line under the name. */
  also: NameEntry[];
  /** The names to pick from (namechoices.ts nameRows); empty where none may be chosen. */
  rows: NameRow[];
  /** Whether a typed name may be saved, as your nickname for their main account. */
  nickname: boolean;
  editing: boolean;
  setEditing: (on: boolean) => void;
  onPick: (r: NameRow) => void;
  onNickname: (text: string) => void;
}) {
  const [q, setQ] = useState(name);
  const [hi, setHi] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const canEdit = nickname || rows.length > 1;
  // Opened: the field holds the name, selected, so typing replaces it. A press anywhere else closes it.
  useLayoutEffect(() => {
    if (!editing) return;
    setQ(name);
    setHi(0);
    // The field may still hold what was typed last time: set now, so the render after setQ changes nothing and the
    // selection stays.
    if (field.current) field.current.value = name;
    field.current?.focus();
    field.current?.select();
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setEditing(false);
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [editing]);

  const typed = q.trim();
  // Typing something else filters the names; a name none of them is goes first, so Enter calls them what you typed.
  const fresh = !!typed && typed !== name;
  const needle = typed.toLowerCase();
  const shown = fresh ? rows.filter((r) => r.text.toLowerCase().includes(needle)) : rows;
  const offer = fresh && nickname && !rows.some((r) => r.text === typed);
  const list: (NameRow | { text: string; new: true })[] = offer ? [{ text: typed, new: true }, ...shown] : shown;
  const choose = (k: number) => {
    const r = list[k];
    setEditing(false);
    if (!r) return;
    if ('new' in r) onNickname(r.text);
    else if (!r.on) onPick(r);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % Math.max(1, list.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // The name as it was: nothing to change.
      if (!fresh) setEditing(false);
      else choose(Math.min(hi, list.length - 1));
    }
  };

  return (
    <>
      {editing ? (
        <div class="pf-name-edit" ref={box}>
          <div class="pf-name-fieldline">
            <input
              ref={field}
              class="pf-name-field"
              value={q}
              aria-label="Their name"
              aria-autocomplete="list"
              aria-controls="pf-name-list"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => {
                setQ((e.target as HTMLInputElement).value);
                setHi(0);
              }}
              onKeyDown={onKey}
            />
            <button class="pf-name-btn ok" data-track="name: done" title="Done (Enter)" aria-label="Done" onClick={() => (fresh ? choose(Math.min(hi, list.length - 1)) : setEditing(false))}>
              <Icon name="check" size={18} />
            </button>
            <button class="pf-name-btn" data-track="name: cancel" title="Cancel (Esc)" aria-label="Cancel" onClick={() => setEditing(false)}>
              <Icon name="x" size={16} />
            </button>
          </div>
          <div class="pf-name-list" id="pf-name-list" role="listbox">
            {list.map((r, k) => (
              <button key={('new' in r ? '+' : '') + r.text} role="option" aria-selected={k === hi} class={`pf-name-row ${k === hi ? 'hi' : ''} ${'new' in r ? 'new' : ''}`} data-track={'new' in r ? 'name: nickname' : 'name: choose'} onPointerEnter={() => setHi(k)} onClick={() => choose(k)}>
                <span class="pf-name-tick">{'new' in r ? <Icon name="pencil" size={13} /> : r.on ? <Icon name="check" size={14} /> : null}</span>
                <span class="pf-name-text">{'new' in r ? `Call them “${r.text}”` : r.text}</span>
                <span class="pf-name-from">
                  {'new' in r ? 'your nickname' : r.detail}
                  {!('new' in r) && r.refs.map((x) => <NetBadge key={x.i.id} network={x.i.network} size={14} />)}
                </span>
              </button>
            ))}
            <div class="pf-name-hint">{nickname ? 'Type to call them something else · ↑↓ · Enter · Esc' : '↑↓ · Enter · Esc'}</div>
          </div>
        </div>
      ) : (
        <h1 class="pf-name-line">
          <button class="pf-name-copy" data-track="name: copy" title={`Copy “${name}”`} onClick={() => void copy(name, 'Name copied')}>
            {name}
          </button>
          {canEdit && (
            <button class="pf-name-btn pen" data-track="name: edit" title="Change the name shown, or give them a nickname" aria-label="Change the name shown" onClick={() => setEditing(true)}>
              <Icon name="pencil" size={16} />
            </button>
          )}
        </h1>
      )}
      {also.length > 0 && (
        <div class="pf-also">
          <span class="pf-also-label">also</span>{' '}
          {also.map((e, k) => (
            <Fragment key={e.text}>
              <span class="pf-also-it">
                <button class="pf-also-name" data-track="name: copy also" title={`Copy “${e.text}” (${whereFrom(e)})`} onClick={() => void copy(e.text, 'Name copied')}>
                  {e.text}
                </button>
                <Shared e={e} />
                {/* The dot rides at the end of the name before it, so a wrapped line never starts with one. */}
                {k < also.length - 1 && <span class="pf-also-dot"> ·</span>}
              </span>{' '}
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}
