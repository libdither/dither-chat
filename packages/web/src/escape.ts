/**
 * Escape is the back button of a keyboard (docs/desktop.md "Escape and back"): what nothing else took closes the top
 * layer (a sheet, menu, dialog or panel: phone.ts pushLayer), as the back button does, and with none open, leaves the
 * page for where back from it goes. Anything that uses an Escape for itself (closes its own popover, cancels an edit,
 * clears a box) says so with preventDefault(), and that Escape goes no further (scripts/check-escape.ts holds every
 * handler in the app to that).
 */
/** Where the cursor is: nowhere that types, a one-line box, or somewhere text is written (a message, a bio). */
type Field = 'none' | 'line' | 'text';

interface EscapeState {
  /** Something took this Escape: it called preventDefault, or a layer closed or the page changed while it went by. */
  handled: boolean;
  /** Open layers. */
  layers: number;
  field: Field;
  /** The page has somewhere to go back to. */
  canLeave: boolean;
}

/**
 * What an Escape does. Closing a layer comes first, wherever the cursor is. Leaving the page does not happen from where
 * text is being written: a half-written message stays on screen.
 */
export function escapeAct(s: EscapeState): 'none' | 'layer' | 'page' {
  if (s.handled) return 'none';
  if (s.layers > 0) return 'layer';
  if (s.field === 'text') return 'none';
  return s.canLeave ? 'page' : 'none';
}

/** The page an address is, without its query: search rewrites its own `?q=` as you type, which is no going anywhere. */
const pageOf = (hash: string) => hash.split('?')[0];

function fieldOf(el: Element | null): Field {
  if (!el || !(el instanceof HTMLElement)) return 'none';
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return 'text';
  if (el.tagName === 'INPUT') {
    const t = (el as HTMLInputElement).type;
    return ['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(t) ? 'none' : 'line';
  }
  return 'none';
}

/**
 * Listens for Escape on the whole app. It looks before anything else sees the key and decides once the key has gone by
 * everything (a task later), so the order handlers were added in does not matter. `app` says how many layers are open
 * (phone.ts layerCount), whether the page has somewhere to go back to, and goes there.
 */
export function installEscape(app: { layers: () => number; canLeave: () => boolean; leave: () => void }): () => void {
  const key = (e: KeyboardEvent) => {
    // escape: this is where what nothing took goes; it looks, and acts a task later.
    if (e.key !== 'Escape' || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const layers = app.layers();
    const page = pageOf(location.hash);
    const field = fieldOf(document.activeElement);
    setTimeout(() => {
      const handled = e.defaultPrevented || app.layers() !== layers || pageOf(location.hash) !== page;
      const act = escapeAct({ handled, layers, field, canLeave: app.canLeave() });
      if (act === 'layer') history.back();
      else if (act === 'page') app.leave();
    }, 0);
  };
  window.addEventListener('keydown', key, true);
  return () => window.removeEventListener('keydown', key, true);
}
