/**
 * The `:` emoji list over the composer. Matching lives in ../emojiComplete.ts; this draws it and owns the keys
 * while it is open: arrows move, Enter or Tab inserts, Escape closes it and nothing else (not the reply, not
 * the edit). It listens on the composer box in the capture phase, so it sees those keys before the textarea's
 * own handler does. A closing `:` on an exact shortcode turns it into the emoji, list or not.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { loadEmoji, skinOf, type EmojiCategory, type EmojiItem } from '../emoji.ts';
import { closedCode, customMarkup, exactEmoji, findTrigger, rankEmoji, type Candidate, type CustomEmoji, type Trigger } from '../emojiComplete.ts';
import { reactionContext } from '../reactions.ts';
import { db, prefs } from '../state.ts';

/** Replaces [start, end) of the textarea with `text` the way typing would: undoable, and through its input event. */
function replaceRange(el: HTMLTextAreaElement, start: number, end: number, text: string) {
  el.focus();
  el.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

export function EmojiComplete({ ta, convId, network }: { ta: { current: HTMLTextAreaElement | null }; convId: string; network?: P.Network }) {
  const [trig, setTrig] = useState<Trigger | null>(null);
  const [sel, setSel] = useState(0);
  const [catalog, setCatalog] = useState<EmojiCategory[] | null>(null);
  const [custom, setCustom] = useState<CustomEmoji[]>([]);
  const dismissed = useRef<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  // Only Discord carries custom emoji in a message's text (<:name:id>); Matrix packs go as reactions only.
  const usable = network === 'discord';
  const load = () => {
    loadEmoji().then(setCatalog);
    if (usable)
      reactionContext(convId).then((ctx) => setCustom(ctx.custom.flatMap((g) => g.emoji).filter((e) => /^\S+:\d+$/.test(e.key))));
  };
  useEffect(() => setCustom([]), [convId]);

  const unicode = useMemo(() => catalog?.flatMap((c) => c.emoji) ?? [], [catalog]);
  const usage = useMemo(() => new Map(db.reactionUsage.map((u) => [u.key, u.count])), [db.reactionUsage]);
  const results = useMemo(() => (trig ? rankEmoji(trig.query, unicode, custom, usage) : []), [trig?.query, unicode, custom, usage]);
  const open = !!trig && dismissed.current !== trig.start && results.length > 0;

  const textOf = (c: Candidate) => (c.kind === 'custom' ? customMarkup(c.emoji) ?? `:${c.code}:` : skinOf(c.item as EmojiItem, prefs.value.skinTone ?? 0));

  const insert = (c: Candidate) => {
    const el = ta.current;
    if (!el || !trig) return;
    // A space after it, as Discord does, unless one is already there.
    const next = el.value[trig.end];
    replaceRange(el, trig.start, trig.end, textOf(c) + (next !== undefined && /\s/.test(next) ? '' : ' '));
    setTrig(null);
  };

  // Keep the latest of everything for the listeners, which are added once.
  const live = useRef({ open, results, sel, trig, insert, unicode, custom });
  live.current = { open, results, sel, trig, insert, unicode, custom };

  useEffect(() => {
    const el = ta.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const update = () => {
      const t = el.selectionStart === el.selectionEnd ? findTrigger(el.value, el.selectionStart) : null;
      if (!t || t.start !== dismissed.current) dismissed.current = null;
      setTrig((cur) => (cur?.start === t?.start && cur?.end === t?.end && cur?.query === t?.query ? cur : t));
      if (t) load();
    };
    const onInput = (e: Event) => {
      const ie = e as InputEvent;
      const caret = el.selectionStart;
      // A closing colon on an exact shortcode: swap the code for the emoji.
      if (ie.inputType?.startsWith('insert') && el.value[caret - 1] === ':' && el.selectionStart === el.selectionEnd) {
        const closed = closedCode(el.value, caret);
        const hit = closed && exactEmoji(closed.code, live.current.unicode, live.current.custom);
        if (closed && hit) {
          replaceRange(el, closed.start, closed.end, hit.kind === 'custom' ? customMarkup(hit.emoji) ?? `:${hit.code}:` : skinOf(hit.item, prefs.value.skinTone ?? 0));
          return;
        }
      }
      update();
    };
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      if (!s.open || e.isComposing || e.target !== el) return;
      const n = s.results.length;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        stop();
        setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      } else if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
        stop();
        s.insert(s.results[Math.min(s.sel, n - 1)]);
      } else if (e.key === 'Escape') {
        stop();
        dismissed.current = s.trig!.start;
        setTrig((t) => (t ? { ...t } : t));
      }
    };
    const onBlur = () => setTrig(null);
    // Arrows and clicks that move the caret; not the ones the list takes.
    const onKeyUp = (e: KeyboardEvent) => !['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key) && update();
    box.addEventListener('keydown', onKey, true);
    el.addEventListener('input', onInput);
    el.addEventListener('keyup', onKeyUp);
    el.addEventListener('click', update);
    el.addEventListener('focus', update);
    el.addEventListener('blur', onBlur);
    return () => {
      box.removeEventListener('keydown', onKey, true);
      el.removeEventListener('input', onInput);
      el.removeEventListener('keyup', onKeyUp);
      el.removeEventListener('click', update);
      el.removeEventListener('focus', update);
      el.removeEventListener('blur', onBlur);
    };
  }, [ta.current, convId]);

  useEffect(() => setSel(0), [trig?.query]);
  useEffect(() => {
    list.current?.querySelector('.ec-opt.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel, open]);

  if (!open) return null;
  return (
    <div class="ec-pop" role="listbox" aria-label={`Emoji matching :${trig!.query}`} ref={list} onMouseDown={(e) => e.preventDefault()}>
      <div class="ec-head">
        Emoji matching <b>:{trig!.query}</b>
      </div>
      {results.map((c, i) => (
        <button class={`ec-opt ${i === sel ? 'on' : ''}`} role="option" aria-selected={i === sel} tabIndex={-1} onMouseMove={() => i !== sel && setSel(i)} onClick={() => insert(c)}>
          {c.kind === 'custom' ? <img class="ec-glyph" src={c.emoji.url} alt="" loading="lazy" /> : <span class="ec-glyph">{skinOf(c.item, prefs.value.skinTone ?? 0)}</span>}
          <span class="ec-code">:{c.code}:</span>
          {c.kind === 'unicode' ? <span class="ec-name">{c.item.name}</span> : <span class="ec-name">custom</span>}
        </button>
      ))}
    </div>
  );
}
