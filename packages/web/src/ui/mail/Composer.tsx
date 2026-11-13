/**
 * Writing mail (docs/mail.md, docs/mail-design.md §6.4): the composer, a full-screen card on a phone and a panel docked
 * at the bottom right on a desktop, over whatever else is open. It answers a message (reply, reply all, forward),
 * starts a new one, or opens a draft. From, To, Cc and Bcc, the subject, your text, then the quote or the forwarded
 * message, which the hub adds when it sends; files upload as they are attached, as chat's do.
 *
 * Drafts save themselves (mail/drafts.ts). Send hands the message to the hub's outbox, which holds it 10 s: the strip
 * at the bottom says "Sending… Undo" meanwhile, then "Sent", or why not, with the draft to open again. An account that
 * cannot send (a read grant, or sending turned off) says why, and the rest of mail keeps working.
 */
import type * as P from '@dither-chat/protocol';
import { mailAddressText, parseMailAddress } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { bytes } from '../../format.ts';
import { details } from '../../mail/held.ts';
import {
  canSendFrom,
  cannotSend,
  deleteDraft,
  dismissSend,
  drafts,
  draftState,
  emptyDraft,
  findAddresses,
  flushDraft,
  isBlank,
  loadDrafts,
  loadOutbox,
  openDraft,
  saveDraft,
  send,
  sendingAgain,
  sendNow,
  undoSend,
} from '../../mail/drafts.ts';
import { dropLayer, phone, pushLayer } from '../../phone.ts';
import { connected, db, go, mailRev, route, startUpload } from '../../state.ts';
import { readable, refusalOf, type UploadJob } from '../../upload.ts';
import { openMenu } from '../ContextMenu.tsx';
import { Icon } from '../icons.tsx';
import { mailCompose, openCompose, type ComposeOpen } from './lazy.tsx';
import { Loading } from '../Loader.tsx';

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

export function ComposerLayer() {
  mailRev.value;
  const open = mailCompose.value;
  return (
    <>
      {open && <Composer key={open.seq} open={open} />}
      <OutboxStrip />
    </>
  );
}

// ------------------------------------------------------------------ files

interface NewFile {
  key: number;
  file: File;
  job?: UploadJob;
  refused?: string;
}
let fileKeys = 0;

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

// ------------------------------------------------------------------ recipients

/** To, Cc or Bcc: chips, and a box that completes from people and your mail. */
function AddressField({ label, list, onChange, focus, extra }: { label: string; list: P.MailAddressView[]; onChange: (l: P.MailAddressView[]) => void; focus?: boolean; extra?: preact.ComponentChildren }) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<P.MailAddressHit[]>([]);
  const [pick, setPick] = useState(0);
  const [bad, setBad] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = `mc-${label.toLowerCase()}`;
  useEffect(() => {
    if (focus) input.current?.focus();
  }, []);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) return setHits([]);
    let live = true;
    const t = setTimeout(
      () =>
        void findAddresses(q).then((h) => {
          if (!live) return;
          setHits(h.filter((x) => !list.some((a) => same(a, x))));
          setPick(0);
        }),
      150,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text]);
  const add = (a: P.MailAddressView) => {
    onChange([...list.filter((x) => !same(x, a)), { name: a.name ?? null, email: a.email }]);
    setText('');
    setHits([]);
    setBad(false);
  };
  /** What is typed becomes chips; what is not an address stays, marked. */
  const commit = (raw = text) => {
    const parts = raw
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const ok: P.MailAddressView[] = [];
    const left: string[] = [];
    for (const p of parts) {
      const a = parseMailAddress(p);
      if (a) ok.push(a);
      else left.push(p);
    }
    if (ok.length) onChange([...list, ...ok.filter((a, i) => !list.some((x) => same(x, a)) && ok.findIndex((y) => same(y, a)) === i)]);
    setText(left.join(', '));
    setBad(left.length > 0);
    setHits([]);
  };
  return (
    <div class="mc-field mc-addrs">
      <label class="mc-label" for={id}>
        {label}
      </label>
      <div class="mc-chips" onClick={(e) => e.target === e.currentTarget && input.current?.focus()}>
        {list.map((a) => (
          <span class="mc-chip" title={mailAddressText(a)}>
            <span class="mc-chip-name">{a.name || a.email}</span>
            <button class="mc-chip-x" aria-label={`Remove ${a.email}`} onClick={() => onChange(list.filter((x) => x !== a))}>
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
              setText(v);
              setBad(false);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && hits.length) (e.preventDefault(), setPick((pick + 1) % hits.length));
            else if (e.key === 'ArrowUp' && hits.length) (e.preventDefault(), setPick((pick - 1 + hits.length) % hits.length));
            else if ((e.key === 'Enter' || e.key === 'Tab') && hits.length && text.trim()) (e.preventDefault(), add(hits[pick]));
            else if (e.key === 'Enter' && text.trim()) (e.preventDefault(), commit());
            else if (e.key === 'Backspace' && !text && list.length) onChange(list.slice(0, -1));
            else if (e.key === 'Escape' && hits.length) (e.stopPropagation(), setHits([]));
          }}
          onBlur={() => text.trim() && commit()}
        />
      </div>
      {extra}
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

// ------------------------------------------------------------------ the composer

function Composer({ open }: { open: ComposeOpen }) {
  mailRev.value;
  const p = phone.value;
  const [load, setLoad] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [key, setKey] = useState<string | null>(null);
  const [d, setD] = useState<P.MailDraft | null>(null);
  const [start, setStart] = useState<P.MailComposeStart | null>(null);
  const [resumed, setResumed] = useState(false);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [sending, setSending] = useState<null | 'sending' | 'waiting'>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<NewFile[]>([]);
  const clientId = useRef<string | null>(null);
  const loadedSig = useRef('');
  const fileInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    openDraft(open).then(
      (o) => {
        if (!live) return;
        setKey(o.key);
        setD(o.draft);
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

  const account = d ? db.mail.accounts.get(d.accountId) : undefined;
  const why = d ? cannotSend(account) : null;
  // Files that finished uploading are part of the draft; ones still going join it when done.
  const done = files.filter((f) => f.job?.status.value === 'done' && f.job.result).map((f) => ({ uploadId: f.job!.result!.id, name: f.file.name || 'file', mime: f.file.type || 'application/octet-stream', size: f.file.size }));
  const all: P.MailDraft | null = d ? { ...d, files: [...d.files, ...done] } : null;
  const sig = all ? JSON.stringify(all) : '';
  useEffect(() => {
    if (!key || !all || load.loading || sending === 'sending' || sig === loadedSig.current) return;
    if (isBlank(all) && !resumed) return;
    saveDraft(key, all);
  }, [sig]);

  const total = (all?.files ?? []).reduce((n, f) => n + f.size, 0) + (d?.forwardParts ?? []).reduce((n, f) => n + f.size, 0) + files.filter((f) => f.job && f.job.status.value !== 'done').reduce((n, f) => n + f.file.size, 0);
  const over = total > totalCap(account);

  const set = (patch: Partial<P.MailDraft>) => d && setD({ ...d, ...patch });

  /** Closed: kept as a draft (gone if nothing was written); files still uploading join it when done. */
  const close = () => {
    if (key && all) {
      if (isBlank(all) && !files.length) void deleteDraft(key);
      else if (sig !== loadedSig.current || draftState.value[key] === 'saving') {
        saveDraft(key, all);
        void flushDraft(key);
      }
      const going = files.filter((f) => f.job && f.job.status.peek() === 'uploading');
      if (going.length && d)
        void Promise.allSettled(going.map((f) => f.job!.settle())).then(() => {
          const more = going.filter((f) => f.job!.result).map((f) => ({ uploadId: f.job!.result!.id, name: f.file.name || 'file', mime: f.file.type || 'application/octet-stream', size: f.file.size }));
          if (!more.length) return;
          saveDraft(key, { ...all, files: [...all.files, ...more] });
          void flushDraft(key);
        });
    }
    mailCompose.value = null;
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  /** Thrown away: the draft and its files. */
  const discard = () => {
    for (const f of files) f.job?.cancel();
    for (const f of d?.files ?? []) void fetch(`/api/uploads/${f.uploadId}`, { method: 'DELETE' }).catch(() => {});
    if (key) void deleteDraft(key);
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
      if (e.key === 'Escape' && !e.defaultPrevented && box.current?.contains(document.activeElement)) closeRef.current();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const attach = async (list: File[]) => {
    const checked = await Promise.all(list.map(async (file) => ({ file, readable: file.size === 0 || (await readable(file)) })));
    let n = (d?.files.length ?? 0) + files.filter((f) => !f.refused).length;
    const added = checked.map(({ file, readable }): NewFile => {
      const refused = refusalOf({ size: file.size, readable }, n, { name: 'Email', bytes: FILE_CAP, files: 20 });
      if (refused) return { key: fileKeys++, file, refused };
      n++;
      return { key: fileKeys++, file, job: startUpload(file) };
    });
    setFiles((c) => [...c, ...added]);
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

  const title = TITLES[d?.kind ?? open.kind];
  const state = key ? draftState.value[key] : undefined;
  const choices = start?.fromChoices.length ? start.fromChoices : account?.address ? [{ accountId: account.id, email: account.address, name: account.name }] : [];
  const fromNow = choices.find((c) => c.accountId === d?.accountId && (!d?.from || same(c, { email: d.from }))) ?? choices.find((c) => c.accountId === d?.accountId);
  const quote = start?.quote ?? null;
  const original = d?.replyTo ? details.get(open.threadId ?? key?.slice(2) ?? '')?.messages.find((m) => m.id === d.replyTo) : undefined;

  return (
    <div class={`mc-layer ${p ? 'phone' : 'dock'}`}>
      <section class="mc" ref={box} role="dialog" aria-modal={p} aria-label={title}>
        <header class="mc-head">
          <button class="icon-btn" onClick={close} aria-label="Close; the draft is kept" title="Close (the draft is kept)">
            <Icon name="x" />
          </button>
          <h2 class="mc-title">{title}</h2>
          <span class="mc-saved" role="status">
            {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Draft saved' : state === 'local' ? 'Saved on this device' : resumed ? 'Draft' : ''}
          </span>
          <button class="btn primary mc-send" disabled={!d || !!why || over || sending === 'sending'} onClick={() => void doSend()}>
            <Icon name="send" size={15} />
            {sending === 'sending' ? 'Sending…' : sending === 'waiting' ? 'Waiting…' : 'Send'}
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
        ) : load.error || !d ? (
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
              label="To"
              list={d.to}
              onChange={(to) => set({ to })}
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
            {showCc && <AddressField label="Cc" list={d.cc} onChange={(cc) => set({ cc })} focus={!d.cc.length && d.to.length > 0} />}
            {showBcc && <AddressField label="Bcc" list={d.bcc} onChange={(bcc) => set({ bcc })} focus={!d.bcc.length && d.to.length > 0} />}
            <div class="mc-field">
              <label class="mc-label" for="mc-subject">
                Subject
              </label>
              <input id="mc-subject" class="mc-subject" type="text" value={d.subject} onInput={(e) => set({ subject: (e.target as HTMLInputElement).value })} />
            </div>
            <textarea
              ref={body}
              class="mc-body"
              aria-label="Message"
              placeholder="Write your message"
              value={d.text}
              onInput={(e) => set({ text: (e.target as HTMLTextAreaElement).value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), void doSend());
              }}
            />
            {d.kind === 'forward' && quote && (
              <div class="mc-quote">
                <button class="mail-quote-toggle" aria-expanded={quoteOpen} onClick={() => setQuoteOpen(!quoteOpen)} title="The forwarded message">
                  ··· Forwarded message
                </button>
                {quoteOpen && <div class="mc-quote-text">{`${quote.head}\n\n${quote.text}`}</div>}
              </div>
            )}
            {(d.kind === 'reply' || d.kind === 'replyAll') && quote && (
              <div class="mc-quote">
                <label class="mc-check">
                  <input type="checkbox" checked={d.quote} onChange={(e) => set({ quote: (e.target as HTMLInputElement).checked })} />
                  Quote {original?.from.name ?? 'the message'}
                </label>
                {d.quote && (
                  <button class="mail-quote-toggle" aria-expanded={quoteOpen} onClick={() => setQuoteOpen(!quoteOpen)} title="What is quoted">
                    ···
                  </button>
                )}
                {d.quote && quoteOpen && <div class="mc-quote-text">{`${quote.head}\n${quote.text}`}</div>}
              </div>
            )}
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
                  <FileChip
                    key={f.key}
                    name={f.file.name || 'file'}
                    size={f.file.size}
                    why={f.refused}
                    job={f.job}
                    remove={() => {
                      f.job?.cancel();
                      setFiles((c) => c.filter((x) => x !== f));
                    }}
                  />
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
          <span class={`mc-limit ${over ? 'over' : ''}`}>
            {total ? `${bytes(total)} of ${mbText(totalCap(account))}` : `Up to 25 MB a file, ${mbText(totalCap(account))} in all`}
          </span>
          <button class="icon-btn mc-discard" onClick={discard} aria-label="Discard the draft" title="Discard the draft">
            <Icon name="trash" size={16} />
          </button>
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

// ------------------------------------------------------------------ the outbox strip

/** Seen as sent by this page: shown a few seconds, then gone. */
const sentSeen = new Map<string, number>();
const SENT_SHOWN_MS = 6000;

function OutboxStrip() {
  mailRev.value;
  const [, tick] = useState(0);
  const now = Date.now();
  const items = [...db.mail.outbox.values()].filter((o) => {
    if (o.state !== 'sent') return true;
    if (!sentSeen.has(o.id)) sentSeen.set(o.id, (o.createdAt ?? 0) > now - 60_000 ? now : 0);
    return now - sentSeen.get(o.id)! < SENT_SHOWN_MS;
  });
  const live = items.some((o) => o.state === 'held' || o.state === 'sent');
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [live]);
  // Back from being away: the outbox as the hub has it now.
  const up = connected.value;
  useEffect(() => {
    if (up) void loadOutbox();
  }, [up]);
  if (!items.length) return null;
  const quoted = (s: string) => (s ? `“${s.length > 40 ? `${s.slice(0, 39)}…` : s}”` : 'your message');
  return (
    <div class="mc-strip" role="status" aria-live="polite">
      {items.map((o) => (
        <div class={`mc-out ${o.state}`} data-state={o.state} key={o.id}>
          <Icon name={o.state === 'failed' ? 'alert' : o.state === 'sent' ? 'check' : 'send'} size={15} />
          <span class="mc-out-text">
            {o.state === 'held' && (
              <>
                Sending {quoted(o.subject)} in {Math.max(0, Math.ceil(((o.holdUntil ?? now) - now) / 1000))} s
              </>
            )}
            {(o.state === 'queued' || o.state === 'sending') && (
              <>
                Sending {quoted(o.subject)}…{o.error ? ` ${o.error}` : ''}
              </>
            )}
            {o.state === 'sent' && (o.dryRun ? <>Dry run: {quoted(o.subject)} did not reach the account</> : <>Sent {quoted(o.subject)}</>)}
            {o.state === 'failed' && (
              <>
                <b>Not sent.</b> {o.error}
              </>
            )}
          </span>
          {o.state === 'held' && (
            <button class="btn small mc-send-now" title="Send it without waiting" onClick={() => void sendNow(o.id).catch(() => {})}>
              Send now
            </button>
          )}
          {o.state === 'held' && (
            <button
              class="btn small mc-undo"
              onClick={() =>
                void undoSend(o.id).then(
                  (r) => openCompose({ kind: r.draft.kind, draftKey: r.draftKey, draft: r.draft, threadId: o.threadId ?? undefined }),
                  () => {},
                )
              }
            >
              Undo
            </button>
          )}
          {o.state === 'sent' && o.threadId && route.value.view === 'mail' && (
            <button class="link-btn" onClick={() => go({ view: 'mail', list: (route.value as { list?: string }).list, thread: o.threadId! })}>
              View
            </button>
          )}
          {o.state === 'failed' && o.draftKey && (
            <button
              class="btn small"
              onClick={() => {
                openCompose({ kind: o.kind ?? 'new', draftKey: o.draftKey!, threadId: o.threadId ?? undefined });
                void dismissSend(o.id);
              }}
            >
              Open draft
            </button>
          )}
          {o.state === 'failed' && (
            <button class="icon-btn small" aria-label="Dismiss" title="Dismiss" onClick={() => void dismissSend(o.id)}>
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ where it starts from

/** Mail's ✎: a new message, from the account the list shows (or the first that can send). */
export function ComposeButton({ accountId }: { accountId: string | null }) {
  mailRev.value;
  const accounts = [...db.mail.accounts.values()].filter((a) => a.level !== null);
  if (!accounts.some((a) => a.level === 'write')) return null;
  const pickAcc = (accountId && accounts.find((a) => a.id === accountId && canSendFrom(a))) || accounts.find(canSendFrom) || accounts.find((a) => a.level === 'write');
  return (
    <button class="icon-btn small side-new mail-compose-btn" aria-label="New message" title="New message (c)" onClick={() => openCompose({ kind: 'new', accountId: pickAcc?.id })}>
      <Icon name="pencil" size={16} />
    </button>
  );
}

/** "2 drafts" under the views: each opens in the composer. */
export function DraftsLine() {
  mailRev.value;
  const list = drafts.value;
  useEffect(() => {
    void loadDrafts();
  }, []);
  if (!list.length) return null;
  const label = (x: P.MailDraftView) => {
    const to = [...x.draft.to, ...x.draft.cc].map((a) => a.name || a.email).join(', ');
    return `${x.draft.subject || '(no subject)'}${to ? ` · to ${to}` : ''}`;
  };
  return (
    <button
      class="mail-drafts-line"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(
          { x: r.left, y: r.bottom + 4 },
          {
            label: 'Drafts',
            head: <div class="cm-sheet-title">Drafts</div>,
            items: list.map((x) => ({ label: label(x), icon: x.draft.kind === 'forward' ? 'forward' : x.draft.kind === 'new' ? 'pencil' : 'reply', run: () => openCompose({ kind: x.draft.kind, draftKey: x.key }) })),
          },
          e.currentTarget,
        );
      }}
    >
      <Icon name="pencil" size={13} />
      {list.length === 1 ? '1 draft' : `${list.length} drafts`}
    </button>
  );
}

/** Under the reader: why this account cannot send, where reply would be. */
export function SendNote({ account }: { account: P.MailAccountView | undefined }) {
  if (!account || account.level !== 'write' || account.send.ok !== false) return null;
  return (
    <p class="mail-reader-note mail-send-note">
      {cannotSend(account)}
      {account.send.refused && (
        <>
          {' '}
          <button class="link-btn" onClick={() => void sendingAgain(account.id)}>
            Try sending again
          </button>
        </>
      )}
    </p>
  );
}

// ------------------------------------------------------------------ answering

/** Answering works from this message's account. */
export const canAnswer = (a: P.MailAccountView | undefined) => canSendFrom(a);

/** Reply all would reach more people than reply (as far as the page knows your addresses). */
export function replyAllHelps(m: P.MailMessageView, a: P.MailAccountView | undefined): boolean {
  const me = a?.address?.toLowerCase();
  const others = new Set([m.from, ...m.to, ...m.cc].map((x) => x.email.toLowerCase()).filter((e) => e && e !== me));
  return others.size > 1;
}

export function answer(kind: P.MailComposeKind, m: P.MailMessageView) {
  openCompose({ kind, messageId: m.id, threadId: m.threadId, accountId: m.accountId });
}

/** The message the reader's bottom bar answers: the latest. */
export function latestOf(threadId: string): P.MailMessageView | undefined {
  const ms = details.get(threadId)?.messages ?? [];
  return ms[ms.length - 1];
}

// Keys (§6.5): c composes; r, a and f answer the open thread's latest message.
if (typeof window !== 'undefined')
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || mailCompose.value) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    const r = route.value;
    if (r.view !== 'mail') return;
    if (e.key === 'c') {
      const acc = [...db.mail.accounts.values()].find(canSendFrom);
      if (acc) (e.preventDefault(), openCompose({ kind: 'new', accountId: acc.id }));
      return;
    }
    const kind = ({ r: 'reply', a: 'replyAll', f: 'forward' } as const)[e.key as 'r' | 'a' | 'f'];
    if (!kind || !r.thread) return;
    const m = latestOf(r.thread);
    if (m && canAnswer(db.mail.accounts.get(m.accountId))) (e.preventDefault(), answer(kind, m));
  });
