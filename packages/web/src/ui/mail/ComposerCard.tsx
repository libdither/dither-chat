/**
 * The composer's card (Composer.tsx has the layer, the strip and the ways in): a chunk of its own, loaded when you
 * start writing (and ahead, once Mail is open), so reading mail carries none of it. docs/mail.md, "Sending".
 *
 * Your text is Markdown, as in chat (mail/edits.ts): the format bar and Ctrl+B, Ctrl+I, Ctrl+K write it, a rich paste
 * becomes it (mail/paste.ts), and Preview shows the HTML part as it will arrive. Recipients are text until they are
 * chips, and a chip opens back into text (Backspace, or a click) to be fixed. Undo (Ctrl+Z) goes back through all of
 * it: typing, chips, files, the quote, From; a discarded draft comes back from the strip (discard.ts).
 */
import type * as P from '@dither-chat/protocol';
import { mailAddressText, parseMailAddress } from '@dither-chat/protocol';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { bytes } from '../../format.ts';
import { details } from '../../mail/held.ts';
import { cannotSend, deleteDraft, draftState, findAddresses, findContacts, flushDraft, isBlank, openDraft, saveDraft, send, sendingAgain } from '../../mail/drafts.ts';
import { applyFormat, caretAfter, chipText, continueList, EditHistory, keptName, mergeHits, pasteLink, type Format, type Sel } from '../../mail/edits.ts';
import { pastedMarkdown } from '../../mail/paste.ts';
import { dropLayer, phone, pushLayer } from '../../phone.ts';
import { connected, db, mailRev, startUpload } from '../../state.ts';
import { readable, refusalOf, type UploadJob } from '../../upload.ts';
import { Icon } from '../icons.tsx';
import { discardLater, goneKeys } from './discard.ts';
import { mailCompose, type ComposeOpen } from './lazy.tsx';
import { Loading } from '../Loader.tsx';
import { themeFrame } from './frameTheme.ts';
import { clampDock, defaultDock, loadDock, moveDock, resizeDock, saveDock, BAR_W, type Dock, type DockSaved } from '../../mail/dock.ts';

const MB = 1024 * 1024;
const FILE_CAP = 25 * MB;
/** The most bytes of files one message from the account may carry, as the hub says (its extractor's), else as before it did. */
const totalCap = (a: P.MailAccountView | undefined) => a?.sendCap ?? (a?.kind === 'proton' ? 25 * MB : 35 * MB);
const mbText = (n: number) => `${Number.isInteger(n / MB) ? n / MB : (n / MB).toFixed(1)} MB`;
const TITLES: Record<P.MailComposeKind, string> = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' };
const same = (a: { email: string }, b: { email: string }) => a.email.trim().toLowerCase() === b.email.trim().toLowerCase();

/** An id for one press of Send (crypto.randomUUID needs a secure page; this does not). */
function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ files

interface NewFile {
  key: number;
  file: File;
  job?: UploadJob;
  refused?: string;
}
let fileKeys = 0;
const asDraftFile = (f: NewFile): P.MailDraftFile => ({ uploadId: f.job!.result!.id, name: f.file.name || 'file', mime: f.file.type || 'application/octet-stream', size: f.file.size });

/** A file's chip: its name, its size or how far it uploaded, or why it cannot go; × takes it off. */
function FileChip({ name, size, why, job, remove }: { name: string; size: number; why?: string | null; job?: UploadJob; remove: () => void }) {
  const p = job?.progress.value;
  const status = why ? 'refused' : (p?.status ?? 'done');
  const pct = p && size ? Math.min(100, Math.floor((p.sent / size) * 100)) : 0;
  const note = why ?? (p?.status === 'failed' ? (p.offline ? 'Waiting for the hub' : `Upload failed: ${p.error}`) : null);
  return (
    <div class={`composer-file ${status}`} data-status={status} title={note ? `${name}: ${note}` : name}>
      <Icon name="file" size={20} />
      <div class="composer-file-text">
        <span class="composer-file-name">{name}</span>
        {note ? (
          <span class="composer-file-why" role="alert">
            {note}
          </span>
        ) : status === 'uploading' ? (
          <span class="upload-bar" role="progressbar" aria-label={`Uploading ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </span>
        ) : (
          <span class="composer-file-size">{bytes(size)}</span>
        )}
      </div>
      {status === 'failed' && (
        <button class="btn ghost small" onClick={() => job!.retry()}>
          Retry
        </button>
      )}
      <button class="icon-btn small" onClick={remove} aria-label={`Remove ${name}`} title="Remove">
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ what undo goes back through

type Field = 'to' | 'cc' | 'bcc';
/** The draft, the files being attached, and what is typed in To, Cc and Bcc before it is a chip. */
interface Ed {
  d: P.MailDraft;
  files: NewFile[];
  addr: Record<Field, string>;
}
type Typing = { field: string; wordEnd?: boolean };
/** Where the caret goes after a change the page made (an undo, a format, a paste). */
type Place = { id: string; start: number; end: number };

/** Where an undo or a redo changed something, to put the caret there. */
function placeOf(a: Ed, b: Ed): Place | null {
  if (a.d.text !== b.d.text) {
    const c = caretAfter(a.d.text, b.d.text);
    return { id: 'mc-body', start: c, end: c };
  }
  if (a.d.subject !== b.d.subject) {
    const c = caretAfter(a.d.subject, b.d.subject);
    return { id: 'mc-subject', start: c, end: c };
  }
  for (const f of ['to', 'cc', 'bcc'] as Field[]) {
    if (a.addr[f] !== b.addr[f] || JSON.stringify(a.d[f]) !== JSON.stringify(b.d[f])) return { id: `mc-${f}`, start: b.addr[f].length, end: b.addr[f].length };
  }
  return null;
}

/** Typing as one step of undo: what kind of input (inserting and deleting are steps apart), and whether a word ended. */
function typing(field: string, e: Event): Typing {
  const ev = e as InputEvent;
  const t = ev.inputType ?? '';
  return { field: `${field}:${t.startsWith('delete') ? 'del' : t.startsWith('insertFrom') ? t : 'ins'}`, wordEnd: (t === 'insertText' && /^\s$/.test(ev.data ?? '')) || t === 'insertLineBreak' || t.startsWith('insertFrom') };
}

// ------------------------------------------------------------------ recipients

/**
 * To, Cc or Bcc: chips, and a box whose text becomes them. It completes from people, your mail and the account's own
 * server (Gmail's or Proton's suggestions). Backspace at its start opens the last chip back into text, its last letter
 * gone as text's would be (Ctrl+Backspace takes the chip whole); a click on a chip opens it to edit, and it goes back
 * where it was.
 */
function AddressField(props: {
  field: Field;
  label: string;
  list: P.MailAddressView[];
  text: string;
  accountId: string | undefined;
  onEdit: (next: { list: P.MailAddressView[]; text: string }, typing?: Typing) => void;
  focus?: boolean;
  extra?: ComponentChildren;
}) {
  const { field, label, list, text, accountId, onEdit } = props;
  const [hits, setHits] = useState<P.MailAddressHit[]>([]);
  const [pick, setPick] = useState(0);
  const [bad, setBad] = useState(false);
  /** Arrows chose a suggestion: Enter takes it even over an address typed in full. */
  const moved = useRef(false);
  const picked = useRef<string | null>(null);
  picked.current = hits[pick]?.email ?? null;
  /** A chip opened back into text: who it was and where, until the text is a chip again. */
  const opened = useRef<{ was: P.MailAddressView; at: number } | null>(null);
  // Its text gone (deleted, or undone back into a chip): nothing is open any more.
  if (!text) opened.current = null;
  const input = useRef<HTMLInputElement>(null);
  const id = `mc-${field}`;
  useEffect(() => {
    if (props.focus) input.current?.focus();
  }, []);
  useEffect(() => {
    const q = text.trim();
    if (!q) return setHits([]);
    let live = true;
    let local: P.MailAddressHit[] = [];
    let server: P.MailAddressHit[] | null = null;
    const show = () => {
      if (!live) return;
      const next = mergeHits(local, server, list);
      const at = moved.current && picked.current ? next.findIndex((h) => same(h, { email: picked.current! })) : -1;
      if (at < 0) moved.current = false;
      setHits(next);
      setPick(Math.max(0, at));
    };
    const t = setTimeout(() => {
      if (q.length >= 2) void findAddresses(q).then((h) => ((local = h), show()));
      if (accountId) void findContacts(q, accountId).then((h) => ((server = h), show()));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text, accountId]);

  /** Addresses made chips (an opened chip's back in its place, with its name while it is the same person); `rest` stays typed. */
  const put = (adds: P.MailAddressView[], rest: string) => {
    const fresh = adds.filter((a, i) => !list.some((x) => same(x, a)) && adds.findIndex((y) => same(y, a)) === i);
    let next = list;
    const o = opened.current;
    if (fresh.length) {
      const at = o ? Math.min(o.at, list.length) : list.length;
      const first = o ? keptName(o.was, fresh[0]) : fresh[0];
      next = [...list.slice(0, at), first, ...fresh.slice(1), ...list.slice(at)];
    }
    if (adds.length) opened.current = null;
    setHits([]);
    moved.current = false;
    if (next !== list || rest !== text) onEdit({ list: next, text: rest });
  };
  const add = (a: P.MailAddressHit) => {
    put([{ name: a.name ?? null, email: a.email }], '');
    setBad(false);
  };
  /** What is typed becomes chips; what is not an address stays, marked. */
  const commit = (raw = text) => {
    const ok: P.MailAddressView[] = [];
    const left: string[] = [];
    for (const p of raw.split(/[,;\n]+/).map((s) => s.trim())) {
      if (!p) continue;
      const a = parseMailAddress(p);
      if (a) ok.push(a);
      else left.push(p);
    }
    put(ok, left.join(', '));
    setBad(left.length > 0);
  };
  /** A chip back into text; what was typed (all of it addresses) becomes chips at once. */
  const open = (i: number, backspace: boolean) => {
    const typed = text
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseMailAddress(s));
    if (typed.some((a) => !a)) return input.current?.focus();
    const a = list[i];
    const keep = list.filter((_, j) => j !== i);
    const plus = (typed as P.MailAddressView[]).filter((x, j) => !keep.some((y) => same(x, y)) && typed.findIndex((y) => same(y!, x)) === j);
    opened.current = { was: a, at: i };
    setBad(false);
    onEdit({ list: [...keep, ...plus], text: chipText(a, backspace) });
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };
  return (
    <div class="mc-field mc-addrs">
      <label class="mc-label" for={id}>
        {label}
      </label>
      <div class="mc-chips" onClick={(e) => e.target === e.currentTarget && input.current?.focus()}>
        {list.map((a, i) => (
          <span class="mc-chip" key={a.email} title={mailAddressText(a)}>
            <button class="mc-chip-name" type="button" aria-label={`Edit ${a.email}`} onClick={() => open(i, false)}>
              {a.name || a.email}
            </button>
            <button class="mc-chip-x" type="button" aria-label={`Remove ${a.email}`} onClick={() => onEdit({ list: list.filter((x) => x !== a), text })}>
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        <input
          id={id}
          ref={input}
          class={`mc-addr-input ${bad ? 'bad' : ''}`}
          type="text"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="off"
          spellcheck={false}
          aria-invalid={bad}
          aria-autocomplete="list"
          aria-expanded={hits.length > 0}
          value={text}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            if (/[,;]/.test(v)) commit(v);
            else {
              onEdit({ list, text: v }, typing(field, e));
              setBad(false);
            }
          }}
          onKeyDown={(e) => {
            const el = e.currentTarget;
            const typed = text.trim();
            if (e.key === 'ArrowDown' && hits.length) (e.preventDefault(), (moved.current = true), setPick((pick + 1) % hits.length));
            else if (e.key === 'ArrowUp' && hits.length) (e.preventDefault(), (moved.current = true), setPick((pick - 1 + hits.length) % hits.length));
            else if ((e.key === 'Enter' || e.key === 'Tab') && typed && hits.length && (moved.current || !parseMailAddress(typed))) (e.preventDefault(), add(hits[pick]));
            else if (e.key === 'Enter' && typed) {
              e.preventDefault();
              // An address typed in full: as typed, with the name a suggestion of it has.
              const a = parseMailAddress(typed);
              const hit = a && !a.name ? hits.find((h) => same(h, a)) : undefined;
              if (hit) add(hit);
              else commit();
            } else if (e.key === 'Backspace' && list.length && !text && el.selectionStart === 0 && el.selectionEnd === 0) {
              e.preventDefault();
              if (e.ctrlKey || e.altKey || e.metaKey) onEdit({ list: list.slice(0, -1), text });
              else open(list.length - 1, true);
            } else if (e.key === 'Escape' && hits.length) (e.preventDefault(), e.stopPropagation(), setHits([]));
          }}
          onBlur={() => text.trim() && commit()}
        />
      </div>
      {props.extra}
      {hits.length > 0 && (
        <ul class="mc-hits" role="listbox" aria-label={`${label}: suggestions`}>
          {hits.map((h, i) => (
            <li role="option" aria-selected={i === pick} class={i === pick ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), add(h))}>
              <span class="mc-hit-name">{h.name || h.email}</span>
              {h.name && <span class="mc-hit-addr">{h.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ formatting

const FORMATS: { f: Format; label: ComponentChildren; title: string }[] = [
  { f: 'bold', label: <b>B</b>, title: 'Bold (Ctrl+B)' },
  { f: 'italic', label: <i>I</i>, title: 'Italic (Ctrl+I)' },
  { f: 'strike', label: <s>S</s>, title: 'Struck through' },
  { f: 'code', label: <code>{'</>'}</code>, title: 'Code' },
  { f: 'link', label: <Icon name="link" size={15} />, title: 'Link (Ctrl+K); or paste an address over the text' },
  { f: 'bullets', label: <Icon name="list" size={15} />, title: 'Bulleted list (Ctrl+Shift+8)' },
  { f: 'numbers', label: <span class="mc-fmt-num">1.</span>, title: 'Numbered list (Ctrl+Shift+7)' },
  { f: 'quote', label: <Icon name="quote" size={15} />, title: 'Quote (Ctrl+Shift+9)' },
];
/** The keys that format, as Gmail's are where it has them. */
function formatKey(e: KeyboardEvent): Format | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (!e.shiftKey) return ({ b: 'bold', i: 'italic', k: 'link' } as const)[e.key.toLowerCase() as 'b' | 'i' | 'k'] ?? null;
  return ({ Digit7: 'numbers', Digit8: 'bullets', Digit9: 'quote', KeyX: 'strike' } as const)[e.code as 'Digit7'] ?? null;
}
const BAR_KEY = 'dither.mail.formatBar';
const barWanted = () => {
  try {
    return localStorage.getItem(BAR_KEY) === '1';
  } catch {
    return false;
  }
};

/** The HTML part as it will arrive (the hub makes it the same way, protocol mail-markdown.ts), in the app's theme. */
function Preview({ text }: { text: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let live = true;
    void import('@dither-chat/protocol/mail-markdown').then((m) => live && setHtml(m.markdownHtml(text)));
    return () => {
      live = false;
    };
  }, [text]);
  useLayoutEffect(() => {
    const f = frame.current;
    if (!f || html === null) return;
    let undo: (() => void) | null = null;
    const ready = () => {
      const doc = f.contentDocument;
      if (!doc?.querySelector('.dc-mail')) return;
      undo?.();
      const unTheme = themeFrame(f, doc);
      const fit = () => (f.style.height = `${Math.max(48, doc.documentElement.scrollHeight)}px`);
      // Its links go nowhere from here.
      const stay = (e: Event) => (e.target as Element | null)?.closest?.('a') && e.preventDefault();
      doc.addEventListener('click', stay, true);
      fit();
      const late = setTimeout(fit, 200);
      undo = () => (unTheme(), clearTimeout(late), doc.removeEventListener('click', stay, true));
    };
    f.addEventListener('load', ready);
    if (f.contentDocument?.readyState === 'complete') ready();
    return () => (f.removeEventListener('load', ready), undo?.());
  }, [html]);
  if (html === null) return <div class="mc-preview" />;
  const doc =
    '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}body{overflow-wrap:break-word}' +
    '.dc-mail{display:flow-root;padding:12px 0}.dc-mail pre{white-space:pre-wrap}.dc-mail blockquote[type=cite]{margin:0 0 0 2px;padding-left:10px;border-left:2px solid}' +
    `.dc-empty{opacity:.55}</style></head><body><div class="dc-mail">${html || '<p class="dc-empty">Nothing written yet.</p>'}</div></body></html>`;
  return (
    <div class="mc-preview" aria-label="Preview">
      <iframe ref={frame} key={html} class="mc-preview-frame" srcdoc={doc} sandbox="allow-same-origin" title="The message as it will arrive" />
    </div>
  );
}

// ------------------------------------------------------------------ where it sits on a computer

const view = () => ({ vw: window.innerWidth, vh: window.innerHeight });

/**
 * The dock (mail/dock.ts): dragged by its header, resized by its top and left edges, minimized to a bar; remembered.
 * A double-click on the header puts it back where it starts.
 */
function useDock(on: boolean) {
  const [saved, setSaved] = useState<DockSaved>(loadDock);
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!on) return;
    const r = () => redraw((x) => x + 1);
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, [on]);
  const { vw, vh } = typeof window === 'undefined' ? { vw: 1280, vh: 800 } : view();
  const at = saved.at ? clampDock(saved.at, vw, vh) : defaultDock(vw, vh);
  const put = (s: DockSaved, keep = true) => (setSaved(s), keep && saveDock(s));
  /** A pointer held down on the header or an edge: `step` says where it goes for the distance moved. */
  const follow = (e: PointerEvent, step: (d: Dock, dx: number, dy: number, vw: number, vh: number) => Dock) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const from = at;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last: Dock | null = null;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    const move = (m: PointerEvent) => {
      const v = view();
      last = step(from, m.clientX - x0, m.clientY - y0, v.vw, v.vh);
      put({ at: last, min: false }, false);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (last) saveDock({ at: last, min: false });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const style = saved.min ? { right: `${Math.min(at.r, Math.max(0, vw - BAR_W))}px`, bottom: '0px', width: `${Math.min(BAR_W, vw)}px`, height: 'auto' } : { right: `${at.r}px`, bottom: `${at.b}px`, width: `${at.w}px`, height: `${at.h}px` };
  return {
    min: saved.min,
    style,
    setMin: (min: boolean) => put({ ...saved, min }),
    reset: () => put({ at: null, min: false }),
    drag: (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest('button, a, input, select, textarea')) return;
      follow(e, moveDock);
    },
    grip: (e: PointerEvent, sides: 'tl' | 't' | 'l') => follow(e, (d, dx, dy, w, h) => resizeDock(d, sides === 't' ? 0 : dx, sides === 'l' ? 0 : dy, w, h)),
  };
}

// ------------------------------------------------------------------ the composer

export function Composer({ open }: { open: ComposeOpen }) {
  mailRev.value;
  const p = phone.value;
  const [load, setLoad] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [key, setKey] = useState<string | null>(null);
  const [ed, setEd] = useState<Ed | null>(null);
  const [start, setStart] = useState<P.MailComposeStart | null>(null);
  const [resumed, setResumed] = useState(false);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [sending, setSending] = useState<null | 'sending' | 'waiting'>(null);
  const [error, setError] = useState<string | null>(null);
  const [bar, setBar] = useState(barWanted);
  const [preview, setPreview] = useState(false);
  const clientId = useRef<string | null>(null);
  const loadedSig = useRef('');
  const fileInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLElement>(null);
  // The state as of the last change, for a change made before the page draws again.
  const cur = useRef<Ed | null>(null);
  cur.current = ed;
  const hist = useRef(new EditHistory<Ed>());
  const place = useRef<Place | null>(null);
  /** Every file attached here, to stop the uploads no longer on the message when it closes. */
  const made = useRef(new Set<NewFile>());
  const d = ed?.d ?? null;
  const files = ed?.files ?? [];
  const dock = useDock(!p);
  const min = !p && dock.min;
  const minBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    openDraft(open).then(
      (o) => {
        if (!live) return;
        setKey(o.key);
        setEd({ d: o.draft, files: [], addr: { to: '', cc: '', bcc: '' } });
        setStart(o.start);
        setResumed(o.resumed);
        setShowCc(o.draft.cc.length > 0);
        setShowBcc(o.draft.bcc.length > 0);
        loadedSig.current = JSON.stringify(o.draft);
        setLoad({ loading: false, error: null });
      },
      (e) => live && setLoad({ loading: false, error: String(e?.message ?? e) }),
    );
    return () => {
      live = false;
    };
  }, []);

  // A reply starts in the text, a new message in To.
  useEffect(() => {
    if (d && !load.loading && d.kind !== 'new' && d.to.length) body.current?.focus();
  }, [load.loading]);

  /** A change, as a step of undo (typing: a burst in one field is one step). */
  const edit = (next: (e: Ed) => Ed, t?: Typing) => {
    const e = cur.current;
    if (!e) return;
    hist.current.record(e, t);
    const n = next(e);
    cur.current = n;
    setEd(n);
  };
  const set = (patch: Partial<P.MailDraft>, t?: Typing) => edit((e) => ({ ...e, d: { ...e.d, ...patch } }), t);
  const setField = (f: Field) => (next: { list: P.MailAddressView[]; text: string }, t?: Typing) => edit((e) => ({ ...e, d: { ...e.d, [f]: next.list }, addr: { ...e.addr, [f]: next.text } }), t);
  /** Undo (or redo): the composer as it was, the caret where it changed. */
  const travel = (redo: boolean) => {
    const e = cur.current;
    const s = e && (redo ? hist.current.redo(e) : hist.current.undo(e));
    if (!e || !s) return;
    place.current = placeOf(e, s);
    if (s.d.cc.length || s.addr.cc) setShowCc(true);
    if (s.d.bcc.length || s.addr.bcc) setShowBcc(true);
    if (preview && s.d.text !== e.d.text) setPreview(false);
    cur.current = s;
    setEd(s);
  };
  useLayoutEffect(() => {
    const at = place.current;
    if (!at) return;
    place.current = null;
    const el = document.getElementById(at.id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) return;
    el.focus();
    el.setSelectionRange(at.start, at.end);
  });

  /** The body changed by the page (a format, a list going on, a paste): a step of its own, the selection as it says. */
  const putBody = (s: Sel) => {
    set({ text: s.text });
    place.current = { id: 'mc-body', start: s.start, end: s.end };
  };
  const bodySel = (): Sel | null => {
    const el = body.current;
    const e = cur.current;
    return el && e ? { text: e.d.text, start: el.selectionStart, end: el.selectionEnd } : null;
  };
  const format = (f: Format) => {
    const s = bodySel();
    if (s) putBody(applyFormat(s, f));
  };

  const account = d ? db.mail.accounts.get(d.accountId) : undefined;
  const why = d ? cannotSend(account) : null;
  // Files that finished uploading are part of the draft; ones still going join it when done.
  const done = files.filter((f) => f.job?.status.value === 'done' && f.job.result).map(asDraftFile);
  const all: P.MailDraft | null = d ? { ...d, files: [...d.files, ...done] } : null;
  const sig = all ? JSON.stringify(all) : '';
  useEffect(() => {
    if (!key || !all || load.loading || sending === 'sending' || sig === loadedSig.current) return;
    if (isBlank(all) && !resumed) return;
    saveDraft(key, all);
  }, [sig]);

  const total = (all?.files ?? []).reduce((n, f) => n + f.size, 0) + (d?.forwardParts ?? []).reduce((n, f) => n + f.size, 0) + files.filter((f) => f.job && f.job.status.value !== 'done').reduce((n, f) => n + f.file.size, 0);
  const over = total > totalCap(account);

  /** Uploads taken off the message (and not put back by undo) stop. */
  const dropOrphans = () => {
    for (const f of made.current) if (!cur.current?.files.includes(f)) f.job?.cancel();
  };
  useEffect(() => () => dropOrphans(), []);

  /**
   * Kept as a draft (`force`: saved even unchanged, for a discard's Undo); files still uploading join it when done.
   * False when there was nothing to keep: then it is gone.
   */
  const keep = (force = false): boolean => {
    if (!key || !all) return false;
    if (isBlank(all) && !files.length) {
      void deleteDraft(key);
      return false;
    }
    if (force || sig !== loadedSig.current || draftState.value[key] === 'saving') {
      saveDraft(key, all);
      void flushDraft(key);
    }
    const going = files.filter((f) => f.job && f.job.status.peek() === 'uploading');
    if (going.length)
      void Promise.allSettled(going.map((f) => f.job!.settle())).then(() => {
        const more = going.filter((f) => f.job!.result).map(asDraftFile);
        if (!more.length) return;
        if (goneKeys.has(key)) return more.forEach((f) => void fetch(`/api/uploads/${f.uploadId}`, { method: 'DELETE' }).catch(() => {}));
        saveDraft(key, { ...all, files: [...all.files, ...more] });
        void flushDraft(key);
      });
    return true;
  };
  /** Closed: kept as a draft (gone if nothing was written). */
  const close = () => {
    keep();
    dropOrphans();
    mailCompose.value = null;
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  const minRef = useRef(min);
  minRef.current = min;
  /** Minimized to a bar at the bottom edge, or open again; the draft goes on saving either way. */
  const setMin = (v: boolean) => {
    dock.setMin(v);
    // What had focus is hidden now: it moves to the button that brings it back.
    if (v) requestAnimationFrame(() => minBtn.current?.focus());
  };

  /** Thrown away, with Undo in the strip for a few seconds; then the draft and its files go. */
  const discard = () => {
    if (keep(true) && key && d) discardLater({ key, kind: d.kind, threadId: open.threadId ?? (key.startsWith('t:') ? key.slice(2) : undefined), subject: d.subject });
    dropOrphans();
    mailCompose.value = null;
  };

  // On a phone it is a page of its own: back closes it, keeping the draft.
  useLayoutEffect(() => {
    if (!p) return;
    const id = pushLayer(() => closeRef.current());
    return () => dropLayer(id);
  }, [p]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // Minimized, it stays as it is: Escape neither closes nor throws away.
      if (e.key === 'Escape' && !e.defaultPrevented && !minRef.current && box.current?.contains(document.activeElement)) (e.preventDefault(), closeRef.current());
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const attach = async (list: File[]) => {
    const checked = await Promise.all(list.map(async (file) => ({ file, readable: file.size === 0 || (await readable(file)) })));
    let n = (cur.current?.d.files.length ?? 0) + (cur.current?.files ?? []).filter((f) => !f.refused).length;
    const added = checked.map(({ file, readable }): NewFile => {
      const refused = refusalOf({ size: file.size, readable }, n, { name: 'Email', bytes: FILE_CAP, files: 20 });
      if (refused) return { key: fileKeys++, file, refused };
      n++;
      return { key: fileKeys++, file, job: startUpload(file) };
    });
    for (const f of added) made.current.add(f);
    edit((e) => ({ ...e, files: [...e.files, ...added] }));
  };
  // One that failed for want of the hub tries again once the hub is back.
  const online = connected.value;
  useEffect(() => {
    if (online) for (const f of files) if (f.job?.progress.peek().offline) f.job.retry();
  }, [online]);

  const doSend = async () => {
    if (!d || !key || sending === 'sending') return;
    setError(null);
    if (!d.to.length && !d.cc.length && !d.bcc.length) return setError('Who is it to? Add a recipient.');
    if (files.some((f) => f.refused)) return setError('Take off the files that cannot go first.');
    setSending('sending');
    let uploaded: P.MailDraftFile[];
    try {
      const jobs = files.filter((f) => f.job);
      const results = await Promise.all(jobs.map((f) => f.job!.settle()));
      uploaded = results.map((r, i) => ({ uploadId: r.id, name: jobs[i].file.name || r.name, mime: jobs[i].file.type || r.mime, size: r.size }));
    } catch (e: any) {
      setSending(e instanceof TypeError ? 'waiting' : null);
      if (!(e instanceof TypeError)) setError(`A file did not upload: ${e?.message ?? e}`);
      return;
    }
    clientId.current ??= newId();
    const r = await send(key, { ...d, files: [...d.files, ...uploaded] }, clientId.current);
    if (r.ok) {
      dropOrphans();
      mailCompose.value = null;
      return;
    }
    if (r.offline) return setSending('waiting');
    setSending(null);
    setError(r.error);
    // Refused: what you change next is a new send.
    clientId.current = null;
  };
  // Waiting for the hub: tried again when it is back.
  useEffect(() => {
    if (online && sending === 'waiting') void doSend();
  }, [online]);

  /** Undo and redo anywhere in the composer: its own history, not each box's. */
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    e.preventDefault();
    travel(k === 'y' || e.shiftKey);
  };
  const onBeforeInput = (e: InputEvent) => {
    if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
    e.preventDefault();
    travel(e.inputType === 'historyRedo');
  };

  const title = TITLES[d?.kind ?? open.kind];
  const state = key ? draftState.value[key] : undefined;
  const choices = start?.fromChoices.length ? start.fromChoices : account?.address ? [{ accountId: account.id, email: account.address, name: account.name }] : [];
  const fromNow = choices.find((c) => c.accountId === d?.accountId && (!d?.from || same(c, { email: d.from }))) ?? choices.find((c) => c.accountId === d?.accountId);
  const quote = start?.quote ?? null;
  const original = d?.replyTo ? details.get(open.threadId ?? key?.slice(2) ?? '')?.messages.find((m) => m.id === d.replyTo) : undefined;
  const quoted = original?.from.name || original?.from.email || 'the message';
  const sendBtn = (
    <button class="btn primary mc-send" disabled={!d || !!why || over || sending === 'sending'} onClick={() => void doSend()}>
      <Icon name="send" size={15} />
      {sending === 'sending' ? 'Sending…' : sending === 'waiting' ? 'Waiting…' : 'Send'}
    </button>
  );

  return (
    <div class={`mc-layer ${p ? 'phone' : `dock${min ? ' min' : ''}`}`} style={p ? undefined : dock.style}>
      {!p && !min && (
        <>
          <div class="mc-grip t" aria-hidden="true" onPointerDown={(e) => dock.grip(e, 't')} />
          <div class="mc-grip l" aria-hidden="true" onPointerDown={(e) => dock.grip(e, 'l')} />
          <div class="mc-grip tl" aria-hidden="true" title="Drag to resize" onPointerDown={(e) => dock.grip(e, 'tl')} />
        </>
      )}
      <section class="mc" ref={box} role="dialog" aria-modal={p} aria-label={title} onKeyDownCapture={onKeyDownCapture} onBeforeInput={onBeforeInput}>
        <header
          class="mc-head"
          title={p ? undefined : min ? 'Open the message again' : 'Drag to move; double-click to put it back'}
          onPointerDown={p || min ? undefined : dock.drag}
          onClick={min ? (e) => !(e.target as Element).closest('button') && setMin(false) : undefined}
          onDblClick={p || min ? undefined : (e) => !(e.target as Element).closest('button, input, select') && dock.reset()}
        >
          <button class="icon-btn" onClick={close} aria-label="Close; the draft is kept" title="Close (the draft is kept)">
            <Icon name="x" />
          </button>
          <h2 class="mc-title">{min && d?.subject ? d.subject : title}</h2>
          <span class="mc-saved" role="status">
            {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Draft saved' : state === 'local' ? 'Saved on this device' : resumed ? 'Draft' : ''}
          </span>
          {!p && (
            <button
              ref={minBtn}
              class="icon-btn mc-min"
              onClick={() => setMin(!min)}
              aria-expanded={!min}
              aria-label={min ? 'Open the message again' : 'Minimize; the draft is kept'}
              title={min ? 'Open the message again' : 'Minimize (the draft is kept)'}
            >
              <Icon name={min ? 'chevronUp' : 'minus'} size={16} />
            </button>
          )}
          <button class="icon-btn mc-discard" onClick={discard} disabled={!d} aria-label="Discard the draft" title="Discard the draft (Undo in the strip below)">
            <Icon name="trash" size={16} />
          </button>
        </header>
        {account?.dryRun && <div class="mc-banner">Dry run: nothing reaches the account.</div>}
        {why && (
          <div class="mc-banner warn" role="alert">
            <span>{why}</span>
            {account?.send.refused && (
              <button class="link-btn" onClick={() => void sendingAgain(account.id)}>
                Try sending again
              </button>
            )}
          </div>
        )}
        {error && (
          <div class="mc-banner error" role="alert">
            {error}
          </div>
        )}
        {sending === 'waiting' && (
          <div class="mc-banner" role="status">
            Waiting for the hub: it goes when the hub is back.
          </div>
        )}
        {load.loading ? (
          <div class="mc-scroll">
            <Loading fill label="Loading…" />
          </div>
        ) : load.error || !d || !ed ? (
          <div class="mc-scroll">
            <div class="mc-banner error" role="alert">
              Could not start this message: {load.error}
            </div>
          </div>
        ) : (
          <div class="mc-scroll">
            <div class="mc-field">
              <span class="mc-label">From</span>
              {choices.length > 1 ? (
                <select
                  class="mc-from"
                  aria-label="From"
                  value={fromNow ? `${fromNow.accountId}\n${fromNow.email}` : ''}
                  onChange={(e) => {
                    const [acc, email] = (e.target as HTMLSelectElement).value.split('\n');
                    set({ accountId: acc, from: email });
                  }}
                >
                  {choices.map((c) => (
                    <option value={`${c.accountId}\n${c.email}`}>{c.name ? `${c.name} <${c.email}>` : c.email}</option>
                  ))}
                </select>
              ) : (
                <span class="mc-from-text">{fromNow ? mailAddressText(fromNow) : (account?.label ?? '')}</span>
              )}
            </div>
            <AddressField
              field="to"
              label="To"
              list={d.to}
              text={ed.addr.to}
              accountId={d.accountId}
              onEdit={setField('to')}
              focus={d.kind === 'new' || !d.to.length}
              extra={
                (!showCc || !showBcc) && (
                  <span class="mc-more">
                    {!showCc && (
                      <button class="link-btn" onClick={() => setShowCc(true)}>
                        Cc
                      </button>
                    )}
                    {!showBcc && (
                      <button class="link-btn" onClick={() => setShowBcc(true)}>
                        Bcc
                      </button>
                    )}
                  </span>
                )
              }
            />
            {showCc && <AddressField field="cc" label="Cc" list={d.cc} text={ed.addr.cc} accountId={d.accountId} onEdit={setField('cc')} focus={!d.cc.length && d.to.length > 0} />}
            {showBcc && <AddressField field="bcc" label="Bcc" list={d.bcc} text={ed.addr.bcc} accountId={d.accountId} onEdit={setField('bcc')} focus={!d.bcc.length && d.to.length > 0} />}
            <div class="mc-field">
              <label class="mc-label" for="mc-subject">
                Subject
              </label>
              <input id="mc-subject" class="mc-subject" type="text" value={d.subject} onInput={(e) => set({ subject: (e.target as HTMLInputElement).value }, typing('subject', e))} />
            </div>
            {preview ? (
              <Preview text={d.text} />
            ) : (
              <textarea
                id="mc-body"
                ref={body}
                class="mc-body"
                aria-label="Message"
                placeholder="Write your message"
                value={d.text}
                onInput={(e) => set({ text: (e.target as HTMLTextAreaElement).value }, typing('body', e))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return (e.preventDefault(), void doSend());
                  const f = formatKey(e);
                  if (f) return (e.preventDefault(), format(f));
                  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                    const s = bodySel();
                    const next = s && continueList(s);
                    if (next) (e.preventDefault(), putBody(next));
                  }
                }}
                onPaste={(e) => {
                  const s = bodySel();
                  const cd = e.clipboardData;
                  if (!s || !cd) return;
                  const plain = cd.getData('text/plain');
                  const html = cd.getData('text/html');
                  let next = pasteLink(s, plain);
                  if (!next && html) {
                    const md = pastedMarkdown(new DOMParser().parseFromString(html, 'text/html').body);
                    if (md) next = { text: s.text.slice(0, s.start) + md + s.text.slice(s.end), start: s.start + md.length, end: s.start + md.length };
                  }
                  if (next) (e.preventDefault(), putBody(next));
                }}
              />
            )}
            {d.kind === 'forward' && quote && (
              <div class="mc-quote">
                <button class="mail-quote-toggle" aria-expanded={quoteOpen} onClick={() => setQuoteOpen(!quoteOpen)} title="The forwarded message">
                  ··· Forwarded message
                </button>
                {quoteOpen && <div class="mc-quote-text">{`${quote.head}\n\n${quote.text}`}</div>}
              </div>
            )}
            {(d.kind === 'reply' || d.kind === 'replyAll') &&
              quote &&
              (d.quote ? (
                <div class="mc-quote">
                  <div class="mc-quote-line">
                    <button class="mail-quote-toggle" aria-expanded={quoteOpen} onClick={() => setQuoteOpen(!quoteOpen)} title={quoteOpen ? 'Hide what is quoted' : 'Show what is quoted'}>
                      ···
                    </button>
                    <span class="mc-quote-note">Quoting {quoted}</span>
                    <button class="icon-btn small mc-quote-off" onClick={() => set({ quote: false })} aria-label="Leave the quote out" title="Leave the quote out">
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                  {quoteOpen && <div class="mc-quote-text">{`${quote.head}\n${quote.text}`}</div>}
                </div>
              ) : (
                <div class="mc-quote">
                  <button class="mc-quote-add" onClick={() => set({ quote: true })} title={`Quote ${quoted} below your text`}>
                    <Icon name="quote" size={12} />
                    Quote {quoted}
                  </button>
                </div>
              ))}
            {start?.quoteError && <p class="mc-note">The original could not be fetched to quote it: {start.quoteError}</p>}
            {(d.files.length > 0 || d.forwardParts.length > 0 || files.length > 0) && (
              <div class="composer-files mc-files">
                {d.forwardParts.map((f) => (
                  <FileChip name={f.name ?? 'attachment'} size={f.size} remove={() => set({ forwardParts: d.forwardParts.filter((x) => x !== f) })} />
                ))}
                {d.files.map((f) => (
                  <FileChip name={f.name} size={f.size} remove={() => set({ files: d.files.filter((x) => x !== f) })} />
                ))}
                {files.map((f) => (
                  <FileChip key={f.key} name={f.file.name || 'file'} size={f.file.size} why={f.refused} job={f.job} remove={() => edit((e) => ({ ...e, files: e.files.filter((x) => x !== f) }))} />
                ))}
              </div>
            )}
          </div>
        )}
        {bar && (
          <div class="mc-format" role="toolbar" aria-label="Formatting">
            {FORMATS.map((x) => (
              <button class={`mc-fmt mc-fmt-${x.f}`} type="button" disabled={!d || preview} title={x.title} aria-label={x.title} onMouseDown={(e) => e.preventDefault()} onClick={() => format(x.f)}>
                {x.label}
              </button>
            ))}
            <span class="mc-fmt-gap" />
            <button class={`mc-fmt mc-preview-btn ${preview ? 'on' : ''}`} type="button" disabled={!d} aria-pressed={preview} title="See it as it will arrive" onClick={() => setPreview(!preview)}>
              <Icon name="eye" size={15} />
              <span>Preview</span>
            </button>
          </div>
        )}
        <footer class="mc-foot">
          <button class="hdr-btn" onClick={() => fileInput.current?.click()} disabled={!d}>
            <Icon name="paperclip" size={15} />
            <span class="hdr-btn-label">Attach</span>
          </button>
          <button
            class={`icon-btn mc-fmt-toggle ${bar ? 'on' : ''}`}
            type="button"
            aria-pressed={bar}
            aria-label="Formatting"
            title="Formatting: Markdown, as in chat"
            onClick={() => {
              const v = !bar;
              setBar(v);
              if (!v) setPreview(false);
              try {
                localStorage.setItem(BAR_KEY, v ? '1' : '0');
              } catch {}
            }}
          >
            <span class="mc-fmt-aa">Aa</span>
          </button>
          <span class={`mc-limit ${over ? 'over' : ''}`}>
            {total ? `${bytes(total)} of ${mbText(totalCap(account))}` : `Up to 25 MB a file, ${mbText(totalCap(account))} in all`}
          </span>
          {sendBtn}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const el = e.target as HTMLInputElement;
              void attach([...(el.files ?? [])]);
              el.value = '';
            }}
          />
        </footer>
      </section>
    </div>
  );
}
