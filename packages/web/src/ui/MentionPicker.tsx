/**
 * The @ list over the composer (docs/mentions.md): a chunk of its own, which MentionComplete.tsx loads the first time
 * an `@` is typed. While it is open it owns the keys, as the emoji list does (EmojiComplete.tsx): arrows move, Enter or
 * Tab puts the row in, Escape closes it and nothing else. Rows come at once from this device, then from the hub 150 ms
 * after the typing stops (mentionRows.ts), which asks the network too; a row says whether its name pings.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { MentionTrigger } from '../mentionComplete.ts';
import { cleanQuery, hubRows, knownRows, localRows, matchTier, mergeRows } from '../mentionRows.ts';
import { netName } from '../model.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import type { MentionProps } from './MentionComplete.tsx';
import './mentions.css';

/** How long the typing pauses before the hub is asked. */
const WAIT = 150;

/** Replaces [start, end) of the textarea the way typing would: undoable, and through its input event. */
function replaceRange(el: HTMLTextAreaElement, start: number, end: number, text: string) {
  el.focus();
  el.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

/** What a row says beside its name. */
function noteOf(r: P.MentionRow, network: P.Network | undefined): string | null {
  if (r.kind === 'role') return 'role';
  if (r.kind === 'here') return 'everyone online here';
  if (r.kind === 'everyone') return network === 'matrix' ? 'everyone in this room' : 'everyone who can see this channel';
  return r.isBot ? 'bot' : null;
}

/**
 * `find` is mentionComplete.ts's findMentionTrigger, handed in by MentionComplete.tsx: imported here as well, it would
 * be split out of the app's own chunk into a file of its own that the app loads at start.
 */
export function MentionPicker({ ta, convId, network, accountId, find }: MentionProps & { find: (text: string, caret: number) => MentionTrigger | null }) {
  const [trig, setTrig] = useState<MentionTrigger | null>(null);
  const [sel, setSel] = useState(0);
  const [rows, setRows] = useState<P.MentionRow[]>([]);
  /** Asking: the hub's answer is on its way; partial: it came without the network's part. */
  const [state, setState] = useState<'asking' | 'done' | 'partial'>('asking');
  const dismissed = useRef<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const shown = useRef<P.MentionRow[]>([]);
  shown.current = rows;

  // The rows for what is typed: the hub's if it answered this lately, else this device's and those already shown that
  // still match, then the hub's after a pause.
  useEffect(() => {
    if (!trig) return;
    const q = cleanQuery(trig.query);
    const local = localRows(convId, trig.query);
    const known = knownRows(convId, accountId, trig.query);
    if (known) {
      setRows(mergeRows(known, local));
      setState(known.partial ? 'partial' : 'done');
      return;
    }
    const still = shown.current.filter((r) => matchTier([r.name, r.handle], q) > 0);
    const have = new Set(local.map((r) => r.insert));
    setRows([...local, ...still.filter((r) => !have.has(r.insert))]);
    setState('asking');
    let live = true;
    const timer = setTimeout(
      () =>
        hubRows(convId, accountId, trig.query).then(
          (v) => {
            if (!live) return;
            setRows(mergeRows(v, local));
            setState(v.partial ? 'partial' : 'done');
          },
          () => live && setState('partial'),
        ),
      WAIT,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [trig?.query, trig?.start, convId, accountId]);

  const open = !!trig && dismissed.current !== trig.start && rows.length > 0;

  const insert = (r: P.MentionRow) => {
    const el = ta.current;
    if (!el || !trig) return;
    // One space after it, as the network's own client puts one, unless one is there already.
    const next = el.value[trig.end];
    replaceRange(el, trig.start, trig.end, next !== undefined && /\s/.test(next) ? r.insert.trimEnd() : r.insert);
    setTrig(null);
  };

  // The latest of everything for the listeners, which are added once.
  const live = useRef({ open, rows, sel, trig, insert });
  live.current = { open, rows, sel, trig, insert };

  useEffect(() => {
    const el = ta.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const update = () => {
      const t = el.selectionStart === el.selectionEnd ? find(el.value, el.selectionStart) : null;
      if (!t || t.start !== dismissed.current) dismissed.current = null;
      setTrig((cur) => (cur?.start === t?.start && cur?.end === t?.end && cur?.query === t?.query ? cur : t));
    };
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      if (!s.open || e.isComposing || e.target !== el) return;
      const n = s.rows.length;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        stop();
        setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      } else if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
        stop();
        s.insert(s.rows[Math.min(s.sel, n - 1)]);
      } else if (e.key === 'Escape') {
        stop();
        dismissed.current = s.trig!.start;
        setTrig((t) => (t ? { ...t } : t));
      }
    };
    const onBlur = () => setTrig(null);
    // Arrows and clicks that move the caret; not the keys the list takes.
    const onKeyUp = (e: KeyboardEvent) => !['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key) && update();
    box.addEventListener('keydown', onKey, true);
    el.addEventListener('input', update);
    el.addEventListener('keyup', onKeyUp);
    el.addEventListener('click', update);
    el.addEventListener('focus', update);
    el.addEventListener('blur', onBlur);
    // Loaded because an @ was just typed: it is open already.
    if (document.activeElement === el) update();
    return () => {
      box.removeEventListener('keydown', onKey, true);
      el.removeEventListener('input', update);
      el.removeEventListener('keyup', onKeyUp);
      el.removeEventListener('click', update);
      el.removeEventListener('focus', update);
      el.removeEventListener('blur', onBlur);
    };
  }, [ta.current, convId]);

  useEffect(() => setSel(0), [trig?.query]);
  useEffect(() => {
    if (sel >= rows.length && rows.length) setSel(rows.length - 1);
  }, [rows.length]);
  useEffect(() => {
    list.current?.querySelector('.ec-opt.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel, open]);

  if (!open) return null;
  const net = network ? netName(network) : 'The network';
  return (
    <div class="ec-pop mc-pop" role="listbox" aria-label={`People matching @${trig!.query}`} ref={list} onMouseDown={(e) => e.preventDefault()}>
      <div class="ec-head">
        {trig!.query ? (
          <>
            Mention <b>@{trig!.query}</b>
          </>
        ) : (
          'Mention'
        )}
        {state === 'asking' && <span class="mc-state">asking {net}…</span>}
        {state === 'partial' && <span class="mc-state">{net} did not answer: people this hub knows</span>}
      </div>
      {rows.map((r, i) => {
        const note = noteOf(r, network);
        const tint = r.kind === 'role' && r.color ? { color: r.color } : undefined;
        return (
          <button
            class={`ec-opt mc-opt ${i === sel ? 'on' : ''}`}
            role="option"
            aria-selected={i === sel}
            tabIndex={-1}
            onMouseMove={() => i !== sel && setSel(i)}
            onClick={() => insert(r)}
          >
            {r.kind === 'identity' ? (
              <Avatar id={r.identityId ?? r.insert} name={r.name} url={r.avatar} size={24} network={r.network as P.Network | undefined} />
            ) : (
              <span class="mc-glyph" style={tint}>
                <Icon name={r.kind === 'role' ? 'users' : 'at'} size={15} />
              </span>
            )}
            <span class="mc-name" style={tint}>
              {r.kind === 'identity' ? r.name : `@${r.name}`}
            </span>
            {r.handle && <span class="mc-handle">{r.handle}</span>}
            {note && <span class="mc-note">{note}</span>}
            <span class={`mc-ping ${r.pings ? '' : 'off'}`} title={r.pings ? `${net} notifies ${r.kind === 'identity' ? 'them' : 'everyone it names'}` : 'Text only: nobody is notified'}>
              <Icon name={r.pings ? 'bell' : 'bellOff'} size={13} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
