/**
 * The composer's card (Composer.tsx has the layer, the strip and the ways in): a chunk of its own, loaded when you
 * start writing (and ahead, once Mail is open), so reading mail carries none of it. docs/mail.md, "Sending".
 *
 * The text is the mail editor's (editor/MailEditor.tsx, a chunk of its own): rich text by default, with Markdown and
 * the HTML itself a switch away; a forward or a quote sits in it as a block. Under it, how its pictures from the web
 * go (SendSize.tsx), and in the footer how big it is. Recipients are text until they are chips, and a chip opens back
 * into text (Backspace, or a click) to be fixed. Undo (Ctrl+Z) in the text is the editor's; elsewhere it goes back
 * through chips, files and From; a discarded draft comes back from the strip (discard.ts).
 */
import type * as P from '@dither-chat/protocol';
import type { ComponentChildren } from 'preact';
import { mailAddressText, parseMailAddress } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { bytes } from '../../format.ts';
import { details } from '../../mail/held.ts';
import { cannotSend, deleteDraft, draftState, findAddresses, findContacts, flushDraft, isBlank, openDraft, saveDraft, send, sendingAgain } from '../../mail/drafts.ts';
import { caretAfter, chipText, EditHistory, keptName, mergeHits } from '../../mail/edits.ts';
import { pastedFiles } from '../../mail/paste.ts';
import { dropLayer, phone, pushLayer } from '../../phone.ts';
import { connected, db, mailRev, startUpload } from '../../state.ts';
import { readable, refusalOf, type UploadJob } from '../../upload.ts';
import { Icon } from '../icons.tsx';
import { discardLater, goneKeys } from './discard.ts';
import { mailCompose, type ComposeOpen } from './lazy.tsx';
import { Loading } from '../Loader.tsx';
import type { EditorMode, MailEditorApi, MailEditorProps } from './editor/MailEditor.tsx';
import { PicturesChoice, SizeMeter, useDraftSize } from './SendSize.tsx';
import { clampDock, defaultDock, EDGES, loadDock, maxDock, moveDock, resizeDock, saveDock, BAR_W, type Dock, type DockSaved, type Edge } from '../../mail/dock.ts';

const MB = 1024 * 1024;
const FILE_CAP = 25 * MB;
/** The most bytes of files one message from the account may carry, as the hub says (its extractor's), else as before it did. */
const totalCap = (a: P.MailAccountView | undefined) => a?.sendCap ?? (a?.kind === 'proton' ? 25 * MB : 35 * MB);
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

/** A small picture of a picture being attached, from the file itself (nothing is fetched). */
function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? <img src={url} alt="" /> : <Icon name="file" size={20} />;
}
const isPicture = (f: File | undefined) => !!f && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(f.type);

/** A file's chip: its name, its size or how far it uploaded, or why it cannot go; × takes it off. */
function FileChip({ name, size, why, job, file, remove }: { name: string; size: number; why?: string | null; job?: UploadJob; file?: File; remove: () => void }) {
  const p = job?.progress.value;
  const status = why ? 'refused' : (p?.status ?? 'done');
  const pct = p && size ? Math.min(100, Math.floor((p.sent / size) * 100)) : 0;
  const note = why ?? (p?.status === 'failed' ? (p.offline ? 'Waiting for the hub' : `Upload failed: ${p.error}`) : null);
  return (
    <div class={`composer-file ${status}`} data-status={status} title={note ? `${name}: ${note}` : name}>
      {isPicture(file) ? <Thumb file={file!} /> : <Icon name="file" size={20} />}
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

// ------------------------------------------------------------------ the editor

const BAR_KEY = 'dither.mail.formatBar';
const MODE_KEY = 'dither.mail.editMode';
const pref = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const keepPref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};
/** The bar shows unless you hid it. */
const barWanted = () => pref(BAR_KEY) !== '0';
const modeWanted = (): EditorMode => (['rich', 'markdown', 'html'] as const).find((m) => m === pref(MODE_KEY)) ?? 'rich';

/** The editor's chunk (Tiptap, CodeMirror), loaded once when a composer first opens. */
let editorChunk: Promise<typeof import('./editor/MailEditor.tsx')> | null = null;
function useEditor() {
  const [E, setE] = useState<((p: MailEditorProps) => preact.JSX.Element) | null>(null);
  useEffect(() => {
    let live = true;
    editorChunk ??= import('./editor/MailEditor.tsx');
    void editorChunk.then((m) => live && setE(() => m.MailEditor));
    return () => {
      live = false;
    };
  }, []);
  return E;
}

// ------------------------------------------------------------------ where it sits on a computer

const view = () => ({ vw: window.innerWidth, vh: window.innerHeight });

/**
 * The dock (mail/dock.ts): dragged by its header, resized by any edge or corner, maximized to the window or minimized
 * to a bar; remembered. A double-click on the header puts it back where it starts.
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
  const placed = saved.at ? clampDock(saved.at, vw, vh) : defaultDock(vw, vh);
  const at = saved.max ? maxDock(vw, vh) : placed;
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
  const style = saved.min && !saved.max ? { right: `${Math.min(at.r, Math.max(0, vw - BAR_W))}px`, bottom: '0px', width: `${Math.min(BAR_W, vw)}px`, height: 'auto' } : { right: `${at.r}px`, bottom: `${at.b}px`, width: `${at.w}px`, height: `${at.h}px` };
  return {
    min: saved.min,
    max: !!saved.max,
    style,
    setMin: (min: boolean) => put({ ...saved, min }),
    /** Maximized, or back where it was (minimizing first opens it). */
    setMax: (max: boolean) => put({ at: saved.at, min: false, ...(max ? { max } : {}) }),
    reset: () => put({ at: null, min: false }),
    drag: (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest('button, a, input, select, textarea')) return;
      follow(e, moveDock);
    },
    grip: (e: PointerEvent, edge: Edge) => follow(e, (d, dx, dy, w, h) => resizeDock(d, edge, dx, dy, w, h)),
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
  const [sending, setSending] = useState<null | 'sending' | 'waiting'>(null);
  const [error, setError] = useState<string | null>(null);
  const [bar, setBar] = useState(barWanted);
  const [mode, setMode] = useState<EditorMode>(modeWanted);
  const Editor = useEditor();
  const editorApi = useRef<MailEditorApi | null>(null);
  const clientId = useRef<string | null>(null);
  const loadedSig = useRef('');
  const fileInput = useRef<HTMLInputElement>(null);
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
  const max = !p && !min && dock.max;
  const [dropping, setDropping] = useState(false);
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
    if (d && !load.loading && Editor && d.kind !== 'new' && d.to.length) requestAnimationFrame(() => editorApi.current?.focus());
  }, [load.loading, !!Editor]);

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

  /** The editor's text and HTML: its own undo has them, so they are not steps of the composer's. */
  const setBody = (out: { html: string; text: string }) => {
    const e = cur.current;
    if (!e || (e.d.html === out.html && e.d.text === out.text)) return;
    const n = { ...e, d: { ...e.d, html: out.html, text: out.text } };
    cur.current = n;
    setEd(n);
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
  const size = useDraftSize({ html: d?.html, text: d?.text ?? '', plainOnly: !!d?.plainOnly, mode: d?.pictures ?? 'link', files: total, accountId: d?.accountId ?? '' });
  // The hub counts files and the pictures inside the mail against the account's cap (base64 aside).
  const over = total + size.inside.bytes + size.embedded.bytes > totalCap(account);

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
  useLayoutEffect(() => {
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

  /** A picture (a screenshot, "Copy image") or files pasted anywhere in the composer are attached. */
  const onPasteFiles = (e: ClipboardEvent) => {
    // In the text, the editor takes pictures in place (and hands other files back to attach).
    if ((e.target as Element | null)?.closest?.('.me-views')) return;
    const cd = e.clipboardData;
    const got = cd && d ? pastedFiles([...cd.files], cd.getData('text/plain')) : null;
    if (!got) return;
    e.preventDefault();
    void attach(got);
  };
  /** Files dragged over it: it says it takes them. */
  const hasFiles = (e: DragEvent) => !!d && [...(e.dataTransfer?.types ?? [])].includes('Files');
  const onDrag = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    setDropping(false);
    // The editor took it (pictures in place).
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    const list = [...(e.dataTransfer?.files ?? [])];
    if (list.length) void attach(list);
  };

  /** Undo and redo anywhere in the composer: its own history, not each box's. */
  const inEditor = (e: Event) => !!(e.target as Element | null)?.closest?.('.me-views, .me-pop');
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || inEditor(e)) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    e.preventDefault();
    travel(k === 'y' || e.shiftKey);
  };
  const onBeforeInput = (e: InputEvent) => {
    if ((e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') || inEditor(e)) return;
    e.preventDefault();
    travel(e.inputType === 'historyRedo');
  };

  const title = TITLES[d?.kind ?? open.kind];
  const state = key ? draftState.value[key] : undefined;
  const choices = start?.fromChoices.length ? start.fromChoices : account?.address ? [{ accountId: account.id, email: account.address, name: account.name }] : [];
  const fromNow = choices.find((c) => c.accountId === d?.accountId && (!d?.from || same(c, { email: d.from }))) ?? choices.find((c) => c.accountId === d?.accountId);
  const original = d?.replyTo ? details.get(open.threadId ?? key?.slice(2) ?? '')?.messages.find((m) => m.id === d.replyTo) : undefined;
  const quoted = original?.from.name || original?.from.email || 'the message';
  const sendBtn = (
    <button class="btn primary mc-send" disabled={!d || !!why || over || sending === 'sending'} onClick={() => void doSend()}>
      <Icon name="send" size={15} />
      {sending === 'sending' ? 'Sending…' : sending === 'waiting' ? 'Waiting…' : 'Send'}
    </button>
  );

  return (
    <div class={`mc-layer ${p ? 'phone' : `dock${min ? ' min' : max ? ' max' : ''}`}`} style={p ? undefined : dock.style}>
      {!p &&
        !min &&
        !max &&
        EDGES.map((g) => <div key={g} class={`mc-grip ${g}`} data-edge={g} aria-hidden="true" title={g.length === 2 ? 'Drag to resize' : undefined} onPointerDown={(e) => dock.grip(e, g)} />)}
      <section
        class={`mc${dropping ? ' dropping' : ''}`}
        ref={box}
        role="dialog"
        aria-modal={p}
        aria-label={title}
        onKeyDownCapture={onKeyDownCapture}
        onBeforeInput={onBeforeInput}
        onPasteCapture={onPasteFiles}
        onDragEnter={onDrag}
        onDragOver={onDrag}
        onDragLeave={(e) => !(e.currentTarget as Element).contains(e.relatedTarget as Node | null) && setDropping(false)}
        onDrop={onDrop}
      >
        <header
          class="mc-head"
          title={p ? undefined : min ? 'Open the message again' : max ? 'Double-click to put it back' : 'Drag to move; double-click to put it back'}
          onPointerDown={p || min || max ? undefined : dock.drag}
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
          {!p && (
            <button
              class="icon-btn mc-max"
              onClick={() => dock.setMax(!max)}
              aria-pressed={max}
              aria-label={max ? 'Back to its size' : 'Maximize'}
              title={max ? 'Back to its size' : 'Maximize: as big as the window'}
            >
              <Icon name={max ? 'shrink' : 'expand'} size={15} />
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
            {Editor ? (
              <Editor
                initial={{ html: d.html, markdown: d.text, island: start?.island && (d.kind === 'forward' || d.quote) ? { island: start.island, from: d.replyTo } : null }}
                mode={mode}
                onMode={(m) => (setMode(m), keepPref(MODE_KEY, m))}
                bar={bar}
                placeholder="Write your message"
                onChange={setBody}
                onSend={() => void doSend()}
                onFiles={(list) => void attach(list)}
                apiRef={editorApi}
              />
            ) : (
              <div class="mc-body mc-body-loading">
                <Loading label="Loading…" />
              </div>
            )}
            {(d.kind === 'reply' || d.kind === 'replyAll') && start?.island && !/data-dc-island="quote"/.test(d.html ?? '') && Editor && (
              <div class="mc-quote">
                <button class="mc-quote-add" onClick={() => (set({ quote: true }), editorApi.current?.addIsland(start.island!, d.replyTo))} title={`Quote ${quoted} below your text`}>
                  <Icon name="quote" size={12} />
                  Quote {quoted}
                </button>
              </div>
            )}
            {!d.plainOnly && <PicturesChoice s={size} mode={d.pictures ?? 'link'} onMode={(m) => set({ pictures: m })} inlineParts={!!start?.inlineParts} />}
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
                  <FileChip key={f.key} name={f.file.name || 'file'} size={f.file.size} why={f.refused} job={f.job} file={f.file} remove={() => edit((e) => ({ ...e, files: e.files.filter((x) => x !== f) }))} />
                ))}
              </div>
            )}
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
            title={bar ? 'Hide the formatting bar' : 'Show the formatting bar'}
            onClick={() => {
              const v = !bar;
              setBar(v);
              keepPref(BAR_KEY, v ? '1' : '0');
            }}
          >
            <span class="mc-fmt-aa">Aa</span>
          </button>
          <SizeMeter s={size} cap={totalCap(account)} plainOnly={!!d?.plainOnly} onPlainOnly={(v) => set({ plainOnly: v })} hasHtml={!!d?.html} />
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
