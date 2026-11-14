/**
 * The message box's mentions as chips (docs/mentions.md, "In the message box"; composerChips.ts holds how). The
 * composer keeps the body, with its tokens; the box holds the chips' text. What rides in the app is this: the box's
 * text for a body, the body for what is typed, a chip taken out whole when an edit cuts into it, and a token typed or
 * pasted whole made a chip. The chips drawn behind the box's text (ui/ChipLayer.ts) are a chunk of their own, loaded
 * the first time a chip is in the box: until then the box already reads "@Alice".
 */
import type * as P from '@dither-chat/protocol';
import { useReducer, useRef, useState } from 'preact/hooks';
import { chipsIn, chipTarget, cuts, nameOf, toBody, toPlain, toShown, typedToken } from '../composerChips.ts';
import { go, openProfile } from '../state.ts';

/** A copy of chips, for a paste in a message box: their tokens. */
const MIME = 'text/x-dither-chat-body';

/** While a chip's own edit is made: its input event is not looked at for chips cut into. */
let editing = false;

/** Replaces [a, b) as typing would: undoable, through the box's input event. */
export function editBox(el: HTMLTextAreaElement, a: number, b: number, text: string) {
  editing = true;
  try {
    el.setSelectionRange(a, b);
    if (!document.execCommand(text ? 'insertText' : 'delete', false, text)) {
      el.setRangeText(text, a, b, 'end');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  } finally {
    editing = false;
  }
}

type Layer = typeof import('./ChipLayer.ts');
let layer: Layer | null = null;
let loading: Promise<Layer> | null = null;
const load = () =>
  (loading ??= import('./ChipLayer.ts').then(
    (m) => (layer = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));

export function useChipBox(ta: { current: HTMLTextAreaElement | null }, body: string, onBody: (v: string) => void, network: P.Network | undefined) {
  // The box's text, made again from the body only when the body changed other than by typing (a draft, an edit).
  const view = useRef<{ body: string; shown: string } | null>(null);
  if (view.current?.body !== body) view.current = { body, shown: toShown(body, nameOf(network)) };
  const shown = view.current.shown;
  // A token made a chip leaves the body as it was: the box is drawn again all the same.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [Layer, setLayer] = useState<Layer | null>(layer);
  const chips = chipsIn(shown);
  if (chips.length && !Layer) load().then(setLayer, () => {});

  const onInput = (e: Event) => {
    const el = e.currentTarget as HTMLTextAreaElement;
    const ev = e as InputEvent;
    // Undo and redo bring back what the box held, as it was.
    if (!editing && !ev.inputType?.startsWith('history')) {
      for (const [a, b] of cuts(view.current!.shown, el.value, el.selectionEnd)) editBox(el, a, b, '');
      const t = ev.inputType === 'insertText' && ev.data?.endsWith('>') ? typedToken(el.value, el.selectionStart) : null;
      const label = t && nameOf(network)(t.token);
      if (t && label) editBox(el, t.start, t.end, toShown(t.token, () => label));
    }
    const next = toBody(el.value);
    const same = next === view.current!.body;
    view.current = { body: next, shown: el.value };
    onBody(next);
    if (same) redraw(0);
  };

  /** A paste of a body, or of chips copied from a box: its tokens as chips. False: the box pastes it itself. */
  const onPaste = (e: ClipboardEvent): boolean => {
    const el = e.currentTarget as HTMLTextAreaElement;
    const text = e.clipboardData?.getData(MIME) || e.clipboardData?.getData('text/plain') || '';
    const as = toShown(text, nameOf(network));
    if (as === text) return false;
    e.preventDefault();
    editBox(el, el.selectionStart, el.selectionEnd, as);
    return true;
  };

  const open = (token: string) => {
    const to = chipTarget(network, token);
    if (to && 'person' in to) go({ view: 'profile', person: to.person });
    else if (to) openProfile(to.identity);
  };

  return {
    shown,
    onInput,
    onPaste,
    layer:
      Layer && chips.length > 0 ? (
        <Layer.ChipLayer ta={ta} shown={shown} chips={chips} parse={chipsIn} body={toBody} plain={toPlain} mime={MIME} edit={editBox} canOpen={(t) => !!chipTarget(network, t)} open={open} />
      ) : null,
  };
}
