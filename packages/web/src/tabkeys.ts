/**
 * Keys to the open page's switch row (docs/places.md "The switch row", docs/desktop.md "Keys"): Ctrl+Shift+] for the
 * next tab and Ctrl+Shift+[ for the one before, wrapping round, whatever the place (a person's networks, a channel's
 * Stream and Topics). They work while you type: the message box keeps the focus and what is in it.
 *
 * Why these: Alt is the window manager's (niri's default mod key, GNOME's and KDE's window keys), Alt+Left and Right
 * are history, and Option+Shift+arrows select words on a Mac; Ctrl+Tab and Ctrl+PageUp/PageDown switch the browser's
 * tabs and Ctrl+Shift+PageUp/PageDown move them; Ctrl+Shift+arrows select words. Ctrl+Shift+[ and ] edit nothing in a
 * text box and no browser takes them on Linux or Windows (on a Mac the browsers' are Cmd+Shift+[ and ]). Read from
 * the physical key (`BracketLeft`), since Shift turns it into `{` and a layout may move it.
 *
 * Imported by ui/Pairs.tsx, so it listens once the conversation's chunk is in: before that no page with a row is open.
 */

/** For a tab's tooltip. */
export const TAB_KEYS = 'Ctrl+Shift+] and Ctrl+Shift+[';

/** +1 for the next tab, -1 for the one before, null for any other key. Pure, so tests can import it. */
export function tabStep(k: { code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; composing: boolean }): 1 | -1 | null {
  if (!k.ctrl || !k.shift || k.alt || k.meta || k.composing) return null;
  return k.code === 'BracketRight' ? 1 : k.code === 'BracketLeft' ? -1 : null;
}

/** A menu, sheet, dialog, the switcher or the picture viewer over the page: the keys are theirs. */
const COVERS = '.cm, .sheet-layer, .modal-backdrop, .switcher-back, .viewer';

const shown = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth;
};

/**
 * The open page's row: the one in the pane that holds the focus, else the one on screen (a phone keeps the page it
 * came from beside it, off screen; a computer has one page with a row at a time).
 */
function openRow(): HTMLElement | null {
  const rows = [...document.querySelectorAll<HTMLElement>('.pane .view-switch[role="tablist"]')].filter(shown);
  const focused = document.activeElement?.closest('.pane');
  return rows.find((r) => focused?.contains(r)) ?? rows[rows.length - 1] ?? null;
}

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.repeat) return;
  const step = tabStep({ code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, composing: e.isComposing });
  if (!step || document.querySelector(COVERS)) return;
  const row = openRow();
  const tabs = row ? [...row.querySelectorAll<HTMLButtonElement>('[role="tab"]')] : [];
  if (tabs.length < 2) return;
  e.preventDefault();
  const at = Math.max(0, tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'));
  // A click, as a pointer's: the row does what a tap does, and the focus stays where it is (the message box).
  tabs[(at + step + tabs.length) % tabs.length].click();
  tabs[(at + step + tabs.length) % tabs.length].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

if (typeof window !== 'undefined') window.addEventListener('keydown', onKey, true);
