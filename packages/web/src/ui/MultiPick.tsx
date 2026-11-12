/**
 * Picking several people on a palette page (docs/palette.md): the rows with a check each, the picked ones as chips,
 * the cap, and the count beside the button that goes on. Enter picks or un-picks the highlighted row, Ctrl+Enter goes
 * on, Backspace in an empty input un-picks the last one (palette.ts). What is picked is kept on the page's entry, so it
 * is still there when a page pushed on top is backed out of. Nothing here assumes one account or one network.
 */
import type { ComponentChildren } from 'preact';
import { pickLine, togglePick, unpickLast, type Entry } from '../palette.ts';
import { paletteStack } from '../palette.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import { setEntry } from './Palette.tsx';
import type { Multi, Row } from './PaletteFrame.tsx';

/** Someone to pick: a row's key (an identity id, or a person's), and what it shows. */
export interface Pickable {
  key: string;
  name: string;
  /** For the picture: whose avatar, and its address. */
  avatarId: string;
  avatar?: string | null;
  /** The line under the name: a handle, how you know them, when you last talked. */
  sub?: string;
  /** Why the network refused them last time, shown in place of the line until they are picked again. */
  refused?: string;
  /** More on the row, before the check (the networks someone can be reached on). */
  extra?: ComponentChildren;
}

/** The picked keys of page `e`, and how to change them. `max`: the most at once. */
export function usePicked(e: Entry, max: number) {
  const picked = e.picked ?? [];
  const set = (next: string[]) => setEntry(e.id, { picked: next });
  // Read back from the stack, not the render's copy: two changes in one moment both count.
  const now = () => paletteStack.value?.find((x) => x.id === e.id)?.picked ?? [];
  return {
    picked,
    max,
    toggle: (key: string) => set(togglePick(now(), key, max)),
    unpickLast: () => set(unpickLast(now())),
    clear: () => set([]),
  };
}

/** The palette's rows for these people: a check each, and past the cap the rest can't be picked. */
export function pickRows(items: Pickable[], picked: readonly string[], max: number, toggle: (key: string) => void): Row[] {
  return items.map((c): Row => {
    const on = picked.includes(c.key);
    return {
      key: c.key,
      class: `fwd-row ${on ? 'on' : ''} ${c.refused ? 'refused' : ''}`,
      selected: on,
      disabled: !on && picked.length >= max,
      track: on ? 'pick (off)' : 'pick',
      run: () => toggle(c.key),
      inner: (
        <>
          <Avatar id={c.avatarId} name={c.name} url={c.avatar} size={32} />
          <span class="fwd-row-text">
            <b>{c.name}</b>
            <small>{c.refused ?? c.sub ?? ''}</small>
          </span>
          {c.extra}
          <span class={`fwd-check ${on ? 'on' : ''}`} aria-hidden="true">
            {on && <Icon name="check" size={13} />}
          </span>
        </>
      ),
    };
  });
}

/** The picked ones, as chips that un-pick. */
export function PickChips({ picked, nameOf, onRemove }: { picked: readonly string[]; nameOf: (key: string) => string; onRemove: (key: string) => void }) {
  if (!picked.length) return null;
  return (
    <div class="fwd-chips">
      {picked.map((k) => (
        <button class="fwd-chip" data-track="chip (un-pick)" onClick={() => onRemove(k)} aria-label={`Remove ${nameOf(k)}`}>
          {nameOf(k)}
          <Icon name="x" size={11} />
        </button>
      ))}
    </div>
  );
}

/** The count, and the button that goes on (Ctrl+Enter). */
export function PickFooter({ n, max, label, busy, icon = 'userPlus', class: cls, onGo, track }: { n: number; max: number; label: string; busy: boolean; icon?: string; class?: string; onGo: () => void; track?: string }) {
  return (
    <div class={`fwd-send pick-send ${cls ?? ''}`}>
      <span class="pick-count">{pickLine(n, max)}</span>
      <button class="btn primary" data-track={track} title="Ctrl+Enter" disabled={!n || busy} onClick={onGo}>
        <Icon name={icon as any} size={14} /> {label}
      </button>
    </div>
  );
}

/** What the palette needs to give the keys their meaning on a page that picks several. */
export const multiOf = (p: ReturnType<typeof usePicked>, goOn: () => void): Multi => ({ picked: p.picked.length, unpickLast: p.unpickLast, goOn });
