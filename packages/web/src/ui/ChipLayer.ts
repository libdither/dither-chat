/**
 * The chips of the message box (docs/mentions.md, "In the message box"), a chunk of its own that ui/ChipBox.tsx loads
 * the first time a chip is in the box. The box draws its own text, the name included; this draws each chip's
 * background behind it, in a copy of the box's text laid out as the box lays it out, and makes the chip one piece:
 *
 * - the caret steps over it and never lands inside (a click there goes to the nearer end);
 * - Backspace after it, or Delete before it, takes it whole, and so does typing over a selection that cuts into it;
 * - a copy of it reads "@Alice" anywhere, and pastes back as the chip in a message box;
 * - a click on it, once the box has the caret, opens the person's page.
 *
 * Everything that reads the db comes in as props: imported here, a module the app also loads at start would become a
 * file of its own that the app loads at start. For the same reason it is drawn with `h`, not JSX: the JSX runtime
 * would be split out of the chunk it shares with the loader.
 */
import { h, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { Chip } from '../composerChips.ts';

export interface ChipLayerProps {
  ta: { current: HTMLTextAreaElement | null };
  shown: string;
  chips: Chip[];
  /** composerChips.ts chipsIn, toBody and toPlain. */
  parse: (shown: string) => Chip[];
  body: (shown: string) => string;
  plain: (shown: string) => string;
  /** The clipboard type a paste in a box reads the body from. */
  mime: string;
  edit: (el: HTMLTextAreaElement, a: number, b: number, text: string) => void;
  /** Whether a chip has a page to open, and opening it. */
  canOpen: (token: string) => boolean;
  open: (token: string) => void;
}

/** What the copy must share with the box for its lines to break where the box's do. */
const COPY = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'fontStretch',
  'fontKerning',
  'fontFeatureSettings',
  'fontVariationSettings',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textIndent',
  'textTransform',
  'tabSize',
  'textAlign',
  'direction',
  'wordBreak',
  'overflowWrap',
  'boxSizing',
  'paddingTop',
  'paddingLeft',
  'paddingBottom',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
] as const;

/** A selection's ends moved out of any chip they fall in. */
function widen(chips: Chip[], a: number, b: number): [number, number] {
  for (const c of chips) {
    if (c.start < a && a < c.end) a = c.start;
    if (c.start < b && b < c.end) b = c.end;
  }
  return [a, b];
}

export function ChipLayer(props: ChipLayerProps) {
  const { ta, shown, chips } = props;
  const copy = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;

  const sync = () => {
    const el = ta.current;
    const d = copy.current;
    if (!el || !d) return;
    const s = getComputedStyle(el);
    for (const k of COPY) d.style[k] = s[k];
    // A scrollbar takes its width from the text's.
    const bar = Math.max(0, el.offsetWidth - el.clientWidth - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth));
    d.style.paddingRight = `${parseFloat(s.paddingRight) + bar}px`;
    d.style.left = `${el.offsetLeft}px`;
    d.style.top = `${el.offsetTop}px`;
    d.style.width = `${el.offsetWidth}px`;
    d.style.height = `${el.offsetHeight}px`;
    d.scrollTop = el.scrollTop;
  };
  useLayoutEffect(sync, [shown]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.classList.add('chip-box');
    let memo: { v: string; chips: Chip[] } = { v: '', chips: [] };
    const now = () => (memo.v === el.value ? memo.chips : (memo = { v: el.value, chips: live.current.parse(el.value) }).chips);
    let last = el.selectionStart;
    let busy = false;

    // The caret steps over a chip: inside one, it goes to the end it was moving towards, or the nearer one.
    const snap = () => {
      if (busy || document.activeElement !== el) return;
      const a = el.selectionStart;
      if (a !== el.selectionEnd) return;
      const c = now().find((c) => c.start < a && a < c.end);
      if (!c) return void (last = a);
      const to = last <= c.start ? c.end : last >= c.end ? c.start : a - c.start < c.end - a ? c.start : c.end;
      el.setSelectionRange(to, to);
      last = to;
    };
    // A selection made by dragging or with Shift takes a chip whole, once it is made.
    const whole = () => {
      if (el.selectionStart === el.selectionEnd) return snap();
      const [a, b] = widen(now(), el.selectionStart, el.selectionEnd);
      if (a !== el.selectionStart || b !== el.selectionEnd) el.setSelectionRange(a, b, el.selectionDirection);
    };

    // Deleting into a chip takes it whole, as one step to undo; so does typing over a selection that cuts into one.
    const onBefore = (e: InputEvent) => {
      if (busy || e.isComposing) return;
      const t = e.inputType;
      const del = t.startsWith('delete');
      if (!del && t !== 'insertText' && t !== 'insertLineBreak') return;
      let a = el.selectionStart;
      let b = el.selectionEnd;
      if (a === b) {
        const c = del && now().find((c) => (t.includes('Backward') ? c.end === a : c.start === a));
        if (!c) return;
        [a, b] = [c.start, c.end];
      } else {
        const [x, y] = widen(now(), a, b);
        if (x === a && y === b) return;
        [a, b] = [x, y];
      }
      e.preventDefault();
      busy = true;
      try {
        live.current.edit(el, a, b, del ? '' : t === 'insertLineBreak' ? '\n' : (e.data ?? ''));
      } finally {
        busy = false;
      }
      last = el.selectionStart;
    };

    // A copy reads as the names elsewhere, and as the chips in a message box.
    const onClip = (e: ClipboardEvent) => {
      const [a, b] = widen(now(), el.selectionStart, el.selectionEnd);
      const part = el.value.slice(a, b);
      if (a === b || !part.includes('\uDB40') || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', live.current.plain(part));
      e.clipboardData.setData(live.current.mime, live.current.body(part));
      if (e.type === 'cut') live.current.edit(el, a, b, '');
    };

    // The chip under the pointer, from the copy's layout, which is the box's.
    const under = (x: number, y: number): Chip | null => {
      const spans = copy.current?.querySelectorAll<HTMLElement>('.chip-m') ?? [];
      for (let i = 0; i < spans.length; i++)
        for (const r of spans[i].getClientRects()) if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top && y <= r.bottom) return live.current.chips[i] ?? null;
      return null;
    };
    // A click opens the page only in a box that had the caret already: the tap that starts typing never leaves the chat.
    let down: { x: number; y: number; had: boolean } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, had: document.activeElement === el };
    };
    const onClick = (e: MouseEvent) => {
      const d = down;
      down = null;
      if (!d?.had || e.button !== 0 || e.shiftKey || Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 6 || el.selectionStart !== el.selectionEnd) return;
      const c = under(e.clientX, e.clientY);
      if (c && live.current.canOpen(c.token)) live.current.open(c.token);
    };
    const onMove = (e: MouseEvent) => {
      const c = e.buttons ? null : under(e.clientX, e.clientY);
      const on = !!c && live.current.canOpen(c.token);
      el.style.cursor = on ? 'pointer' : '';
      el.title = on ? `${c!.label}: open their page` : '';
    };
    const onScroll = () => {
      if (copy.current) copy.current.scrollTop = el.scrollTop;
    };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    ro?.observe(el);

    document.addEventListener('selectionchange', snap);
    el.addEventListener('selectionchange', snap);
    el.addEventListener('keyup', whole);
    el.addEventListener('mouseup', whole);
    el.addEventListener('touchend', whole);
    el.addEventListener('beforeinput', onBefore);
    el.addEventListener('copy', onClip);
    el.addEventListener('cut', onClip);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('click', onClick);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('scroll', onScroll);
    return () => {
      document.removeEventListener('selectionchange', snap);
      el.removeEventListener('selectionchange', snap);
      el.removeEventListener('keyup', whole);
      el.removeEventListener('mouseup', whole);
      el.removeEventListener('touchend', whole);
      el.removeEventListener('beforeinput', onBefore);
      el.removeEventListener('copy', onClip);
      el.removeEventListener('cut', onClip);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('click', onClick);
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      el.classList.remove('chip-box');
      el.style.cursor = '';
      el.title = '';
    };
  }, [ta.current]);

  const parts: ComponentChildren[] = [];
  let at = 0;
  for (const c of chips) {
    parts.push(shown.slice(at, c.start), h('span', { class: 'chip-m' }, shown.slice(c.start, c.end)));
    at = c.end;
  }
  // A box's last empty line has a height; a div's would not.
  parts.push(shown.slice(at), shown.endsWith('\n') ? ' ' : '');
  return h('div', { class: 'chip-copy', 'aria-hidden': 'true', ref: copy }, parts);
}
