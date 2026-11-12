/**
 * The palette (docs/palette.md): Ctrl+K and New as one box with pages on a stack. The root jumps anywhere; New, Add
 * people, a preview card, a code are pages pushed on it, shown as crumbs before the input, and each backs out to the
 * one under it: Escape, Backspace in an empty input, a crumb, or the back button. A click beside the box closes it.
 * The rules that need no browser are in palette.ts. This is the way in and the box; a page's frame is PaletteFrame.tsx,
 * and the pages (Switcher.tsx, NewPages.tsx, AddMembers.tsx) are a chunk of their own, loaded once the app is idle.
 */
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { addRows, isLink } from '../add.ts';
import { convTitle, identityName, netName } from '../model.ts';
import { backTo, entry, paletteHeld, paletteStack, pop, push, replaceTop, toRoot, update, type Entry, type PageRef } from '../palette.ts';
import { dropLayer, phone, pushLayer, slideAway, useSheetDrag } from '../phone.ts';
import { countKey } from '../clicklog.ts';
import { db } from '../state.ts';
import { Loading } from './Loader.tsx';

type Pages = typeof import('./PalettePages.tsx');
const pages = signal<Pages | null>(null);
let loading: Promise<Pages> | null = null;
/** The pages' chunk: once the app is idle after it starts, or at once when the palette opens first. */
export function preloadPalette(): Promise<Pages> {
  return (loading ??= import('./PalettePages.tsx').then(
    (m) => (pages.value = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

const NEW_TITLE = { message: 'New message', join: 'Join a server or group', add: 'Add someone' } as const;

/** What a page is called in the crumbs. */
export function titleOf(ref: PageRef): string {
  switch (ref.kind) {
    case 'root':
      return 'Jump to';
    case 'new':
      return ref.mode ? NEW_TITLE[ref.mode] : 'New';
    case 'reach': {
      const p = db.persons.get(ref.key);
      return `Message ${p?.name ?? identityName(ref.key)}`;
    }
    case 'message':
      return `Message ${ref.name} on ${netName(ref.network)}`;
    case 'card':
      return ref.row.label;
    case 'scan':
      return 'Scan a code';
    case 'mine':
      return 'My code';
    case 'groups':
      return 'Add people to a group';
    case 'add':
      return `Add people to ${convTitle(db.conversations.get(ref.conversationId))}`;
    case 'group':
      return 'New group';
    case 'group-where':
      return 'Where to make it';
    case 'group-name': {
      const a = db.accounts.get(ref.accountId);
      return a ? `New group on ${netName(a.network)}` : 'New group';
    }
  }
}

const make = (ref: PageRef, q = '') => entry(ref, titleOf(ref), q);

/** A link typed, pasted or scanned into New: its preview card, looked up at once. Anything else waits for a click. */
function cardFor(text: string): Entry | null {
  if (!isLink(text)) return null;
  const row = addRows(text.trim(), db.accounts.values()).find((r) => r.state.kind === 'resolve');
  return row ? make({ kind: 'card', row }) : null;
}

/** New with `text` in it, on top of `base`; a link goes straight on to its card. */
function withText(base: Entry[], ref: PageRef, text: string): Entry[] {
  const s = push(base, make(ref, text));
  const card = cardFor(text);
  return card ? push(s, card) : s;
}

/**
 * The way in: the palette opened at `at`, which is then its bottom page (backing out of it closes). `q`: text to
 * start with; New with a link in it goes on to the link's card.
 */
export function openPalette(at: PageRef = { kind: 'root' }, q = '') {
  paletteStack.value = at.kind === 'new' && q ? withText([], at, q) : [make(at, q)];
}

/** "Message X" for someone known, from a profile or a menu: send as, and open. */
export function messageSomeone(identityId: string) {
  const i = db.identities.get(identityId);
  if (i) openPalette({ kind: 'message', network: i.network, peer: i.nativeId, name: identityName(i.id) });
}

/** Closed, unless a page holds it (a group being made). */
export function closePalette() {
  if (paletteHeld.value) return;
  paletteStack.value = null;
}

/** A page that held the palette is done with it: let go, and close. */
export function releasePalette() {
  paletteHeld.value = false;
  paletteStack.value = null;
}

/** A page on top of this one. */
export function pushPage(ref: PageRef, q = '') {
  const s = paletteStack.value;
  if (!s) return openPalette(ref, q);
  paletteStack.value = ref.kind === 'new' && q ? withText(s, ref, q) : push(s, make(ref, q));
}

/** Back one page; from the bottom page, closed. */
export function backPage() {
  if (paletteHeld.value) return;
  const s = paletteStack.value;
  if (s) paletteStack.value = pop(s);
}

/** Back to the page at `i`. */
export function crumbTo(i: number) {
  if (paletteHeld.value) return;
  const s = paletteStack.value;
  if (s) paletteStack.value = backTo(s, i);
}

/** The root under everything: the one at the bottom, or a fresh one in place of the pages. */
export function rootPage() {
  if (paletteHeld.value) return;
  const s = paletteStack.value;
  if (s) paletteStack.value = toRoot(s, () => make({ kind: 'root' }));
}

export function setEntry(id: number, patch: Partial<Entry>) {
  const s = paletteStack.value;
  if (s) paletteStack.value = update(s, id, patch);
}

/** A link looked up from New (Enter or a paste): its card on top. False when it is not one to look up. */
export function lookUp(text: string): boolean {
  const s = paletteStack.value;
  const card = cardFor(text);
  if (!s || !card) return false;
  paletteStack.value = push(s, card);
  return true;
}

/** A code scanned: it fills the New page it was opened from as a paste would, or a New page takes the scan's place. */
export function scanned(text: string) {
  const s = paletteStack.value;
  const top = s?.[s.length - 1];
  if (!s || top?.kind !== 'scan') return;
  const at = top.into === undefined ? -1 : s.findIndex((e) => e.id === top.into);
  if (at < 0) return void (paletteStack.value = withText(s.slice(0, -1), { kind: 'new' }, text));
  const base = update(backTo(s, at), top.into!, { q: text, sel: 0 });
  const card = cardFor(text);
  paletteStack.value = card ? push(base, card) : base;
}

/** Swap the page on top for another. */
export function replacePage(ref: PageRef, q = '') {
  const s = paletteStack.value;
  if (s) paletteStack.value = replaceTop(s, make(ref, q));
}

// ------------------------------------------------------------------ the box

export function Palette() {
  const stack = paletteStack.value;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const s = paletteStack.value;
        if (!s) {
          countKey('keys: Ctrl+K (switcher)');
          openPalette();
        } else if (s.length === 1 && s[0].kind === 'root') closePalette();
        else rootPage();
      }
    };
    window.addEventListener('keydown', k);
    // Ready before the first Ctrl+K, without slowing the start: once the browser has nothing else to do.
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const later = () => void preloadPalette().catch(() => {});
    const t = idle ? idle(later, { timeout: 4000 }) : setTimeout(later, 2000);
    return () => {
      window.removeEventListener('keydown', k);
      if (idle) (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(t as number);
      else clearTimeout(t);
    };
  }, []);
  return stack ? <PaletteBox stack={stack} /> : null;
}

/**
 * One history entry for the whole palette: the back button takes one page off, and the entry is made again while
 * pages are left. A navigation that takes the entry over (go()) closes it whole.
 */
function usePaletteLayer() {
  useLayoutEffect(() => {
    let id = 0;
    let gone = false;
    const onBack = () => {
      if (gone) return;
      const s = paletteStack.value;
      if (history.state?.layer === id || !s) return void (paletteStack.value = null);
      // A page that must not be left: the back button is taken back, the page stays.
      if (paletteHeld.value) return void queueMicrotask(() => !gone && (id = pushLayer(onBack)));
      const next = pop(s);
      paletteStack.value = next;
      // After the popstate handler that called this has finished going through the layers.
      if (next) queueMicrotask(() => !gone && (id = pushLayer(onBack)));
    };
    id = pushLayer(onBack);
    return () => {
      gone = true;
      dropLayer(id);
    };
  }, []);
}

function PaletteBox({ stack }: { stack: Entry[] }) {
  const box = useRef<HTMLDivElement>(null);
  const top = stack[stack.length - 1];
  usePaletteLayer();
  // Dragged away while a page holds it: it springs back.
  useSheetDrag(box, () => (paletteHeld.value ? box.current && (box.current.style.transform = '') : closePalette()), phone.value);
  const dismiss = () => (phone.value ? slideAway(box.current, closePalette) : closePalette());
  const m = pages.value;
  useEffect(() => void (m || preloadPalette().catch(() => {})), []);
  // The keys are the palette's while it is open: a page behind it that takes the focus as it loads (a conversation's
  // message box) gives it back. Toasts, menus and other layers keep theirs.
  useEffect(() => {
    const f = (ev: FocusEvent) => {
      const b = box.current;
      const t = ev.target as Element | null;
      if (!b || !t || b.contains(t) || t.closest?.('.toast, .toasts, .cm, .sheet-layer, .viewer, .fviewer, .modal-backdrop:not(.palette-back)')) return;
      // On a phone the box itself: no keyboard unasked.
      ((!phone.value && b.querySelector<HTMLElement>('.palette-input:not(:disabled)')) || b).focus({ preventScroll: true });
    };
    document.addEventListener('focusin', f);
    return () => document.removeEventListener('focusin', f);
  }, []);
  return (
    <div class="modal-backdrop switcher-back palette-back" onClick={(e) => e.target === e.currentTarget && dismiss()}>
      <div ref={box} class={`switcher palette ${paletteHeld.value ? 'held' : ''}`} role="dialog" aria-modal="true" aria-label={top.title} data-page={top.kind} data-depth={stack.length} data-track-area="palette" tabIndex={-1}>
        <div class="sheet-grip" aria-hidden="true" />
        {m ? <m.PageOf key={top.id} e={top} /> : <Loading inline label="Loading…" />}
      </div>
    </div>
  );
}

