/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Writing a post, a reply or a quote (docs/feed.md "Answering"), drawn from the network's rules (protocol compose.ts):
 * one composer for X, Mastodon, Reddit, Lemmy, Substack, Bluesky and LessWrong (its comments only).
 *
 * As X does it: "Replying to @handle" over the box; a ring that fills as you write and, from 20 left, grows and says
 * how many are left (yellow), at the limit red, past it a negative count in red and the ring gone past -10; what is
 * past the limit marked in red in the text itself; Post greyed until there is something and it fits. Links count 23
 * and most CJK characters and every emoji two, as X counts them. As Reddit does it: 40,000 characters, a "N left"
 * line from 1,000 left, Markdown. As Mastodon does it: 500, every link 23, and a content warning (CW) over the words.
 *
 * Ctrl/Cmd+Enter posts, Escape closes. What you write is kept on the device until it is posted or cleared, per post
 * answered. Each composer posts once: a key goes with it, so a double press or a retry is one post (posts.ts).
 *
 * `docked`: the one box at the bottom of a thread (docs/places.md "The box"), always open, with the line over it saying
 * where it goes and as whom, a bar when it is aimed at a reply or a quote (✕ or Escape takes the aim off), the emoji
 * button, and pictures where the network and the account take them. Its draft is the thread's, whatever it is aimed at.
 */
import { Fragment, h, type ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
// Its own path, so the rules ride in this chunk, not the app's start.
import { composeState, postRulesFor, rulesForReply, type PostRules } from '@dither-chat/protocol/compose';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, db } from '../../state.ts';
import type { Kit } from './lazy.tsx';
import { QuotedIn } from './Post.tsx';

const DRAFT = 'dither.compose.';
const readDraft = (k: string) => {
  try {
    return sessionStorage.getItem(DRAFT + k) ?? '';
  } catch {
    return '';
  }
};
const keepDraft = (k: string, v: string) => {
  try {
    if (v) sessionStorage.setItem(DRAFT + k, v);
    else sessionStorage.removeItem(DRAFT + k);
  } catch {
    /* a private window: the draft lasts while the page is open */
  }
};

/** X's ring: fills as you write; from `warnAt` left bigger, with the number. */
export function Ring({ st, rules }: { st: ReturnType<typeof composeState>; rules: PostRules }) {
  if (rules.counter === 'text')
    return st.showCount ? (
      <span class={`compose-left ${st.level}`}>
        {st.remaining >= 0 ? `${st.remaining.toLocaleString()} left` : `${(-st.remaining).toLocaleString()} too many`}
      </span>
    ) : null;
  const big = st.showCount;
  const r = big ? 13 : 9;
  const c = 2 * Math.PI * r;
  const size = (r + 3) * 2;
  return (
    <span class={`compose-ring ${st.level} ${big ? 'big' : ''}`} aria-hidden={!st.showCount} title={st.showCount ? `${st.remaining} left` : undefined}>
      {st.showRing && (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} class="ring-track" />
          <circle cx={size / 2} cy={size / 2} r={r} class="ring-fill" stroke-dasharray={c} stroke-dashoffset={c * (1 - st.progress)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        </svg>
      )}
      {st.showCount && <span class="ring-n">{st.remaining}</span>}
    </span>
  );
}

type ReactionsChunk = typeof import('../Reactions.tsx');
let reactions: ReactionsChunk | null = null;

/**
 * The chat box's emoji picker (Reactions.tsx, a chunk of its own loaded when first opened) over a thread's box. A
 * network's custom emoji are its notifications chat's.
 */
// redraws: the picker keeps its own state once open; a new list of conversations changes nothing it shows.
function EmojiPicker({ network, anchor, onInsert, onClose }: { network: P.Network; anchor: DOMRect; onInsert: (text: string) => void; onClose: () => void }) {
  const [m, setM] = useState(reactions);
  useEffect(() => {
    if (!m)
      import('../Reactions.tsx').then(
        (c) => setM((reactions = c)),
        () => onClose(),
      );
  }, []);
  const conv = [...db.conversations.values()].find((c) => c.network === network && c.variant === 'feed')?.id ?? '';
  return m ? <m.InsertPicker conversationId={conv} network={network} anchor={anchor} onInsert={onInsert} onClose={onClose} /> : null;
}

/** A picture added to the box: shown at once, sent to the hub (upload.ts) meanwhile. */
interface Pic {
  local: string;
  name: string;
  mime: string;
  id?: string;
  error?: string;
}

/** The thread's box (see the file's head). */
interface Docked {
  /** The line over the box: "Reply to Alice on X · as @you". */
  lead: ComponentChildren;
  /** The thread's post: the draft is kept under it. */
  draft: string;
  /** Aimed at a reply, or a quote: ✕ and Escape take the aim off. */
  onUnaim?: () => void;
  /** The account posting takes pictures (capability postMedia). */
  media: boolean;
}

interface ComposeTarget {
  /** Answering this post. */
  replyTo?: P.PostFact;
  /** Quoting this post. */
  quote?: P.PostFact;
}

export function PostComposer({
  network,
  target,
  kit,
  onPosted,
  onCancel,
  autoFocus,
  collapsed,
  account,
  docked,
}: {
  network: P.Network;
  target: ComposeTarget;
  kit: Kit;
  onPosted: (p: P.PostView) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  /** One line until it is focused (the reply box under a thread's post, as X shows it). */
  collapsed?: boolean;
  /** Post as this account (the Feed page's), else the kit's, else the first that can. */
  account?: string;
  docked?: Docked;
}) {
  const base = postRulesFor(network);
  const rules = base && target.replyTo ? rulesForReply(base) : base;
  const aimed = target.quote ? `q${target.quote.id}` : target.replyTo ? `r${target.replyTo.id}` : 'new';
  const draftKey = `${network}:${docked ? `t${docked.draft}` : aimed}`;
  const [text, setText] = useState(() => readDraft(draftKey));
  const [open, setOpen] = useState(!collapsed || !!text);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ text: string; unsure: boolean } | null>(null);
  // Mastodon's content warning: none until CW is pressed. A reply to a post behind one starts with the same, as Mastodon does.
  const [warning, setWarning] = useState<string | null>(() => (target.replyTo?.warning && postRulesFor(network)?.warning ? target.replyTo.warning : null));
  // This post's key: the same press again is the same post (posts.ts). A new one after each post, or when you choose
  // to post again after no answer.
  const fresh = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const [key, setKey] = useState(fresh);
  useEffect(() => setKey(fresh()), [draftKey, aimed]);
  const [pics, setPics] = useState<Pic[]>([]);
  const [emojiAt, setEmojiAt] = useState<DOMRect | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const back = useRef<HTMLDivElement>(null);
  // Reply pressed under the post: its one-line box opens.
  useEffect(() => {
    if (!collapsed) setOpen(true);
    // Closed again with nothing written (Escape): back to one line. What you wrote keeps it open.
    else if (!text) setOpen(false);
  }, [collapsed]);
  useEffect(() => {
    if (!autoFocus || !area.current) return;
    area.current.focus({ preventScroll: true });
    // The whole box in view, its buttons too.
    area.current.closest('.post-composer')?.scrollIntoView({ block: 'nearest' });
  }, [autoFocus, draftKey, aimed, open]);
  useEffect(() => keepDraft(draftKey, text), [text, draftKey]);
  // The box grows with what is written.
  useLayoutEffect(() => {
    const a = area.current;
    if (!a) return;
    a.style.height = 'auto';
    a.style.height = `${Math.min(a.scrollHeight, 360)}px`;
  }, [text, open]);
  if (!rules) return null;
  const st = composeState(text, rules);
  const video = pics.some((p) => p.mime.startsWith('video/'));
  const maxPics = docked?.media ? rules.media.images : 0;
  const canAddPic = maxPics > 0 && pics.length < (video ? 1 : maxPics);
  const uploading = pics.some((p) => !p.id && !p.error);
  // Pictures alone are a reply, as the hub takes them.
  const sendable = (st.sendable || (pics.length > 0 && st.remaining >= 0)) && !uploading && !pics.some((p) => p.error);
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of [...files].slice(0, Math.max(0, maxPics - pics.length))) {
      const pic: Pic = { local: URL.createObjectURL(f), name: f.name, mime: f.type || 'application/octet-stream' };
      setPics((ps) => [...ps, pic]);
      try {
        const up = await kit.uploadFile(f, f.name, pic.mime);
        setPics((ps) => ps.map((p) => (p.local === pic.local ? { ...p, id: up.id } : p)));
      } catch (e) {
        setPics((ps) => ps.map((p) => (p.local === pic.local ? { ...p, error: (e as Error).message } : p)));
      }
    }
  };
  const words = rules.words;
  const to = target.replyTo ? kit.handle(target.replyTo.author ?? null) : null;
  const send = () => {
    if (!sendable || sending) return;
    setSending(true);
    setError(null);
    api<P.PostView>(`/api/posts/${network}/publish`, {
      method: 'POST',
      body: { text, key, ...(warning?.trim() ? { warning: warning.trim() } : {}), ...(target.replyTo ? { replyTo: target.replyTo.id } : {}), ...(target.quote ? { quote: target.quote.id } : {}), ...((account ?? kit.account) ? { account: account ?? kit.account } : {}), ...(pics.length ? { media: pics.map((p) => p.id!) } : {}) },
    }).then(
      (p) => {
        setSending(false);
        setText('');
        keepDraft(draftKey, '');
        setKey(fresh());
        pics.forEach((x) => URL.revokeObjectURL(x.local));
        setPics([]);
        onPosted(p);
      },
      (e) => {
        setSending(false);
        // No answer (504): it may have posted. The text stays, and the key: pressing Post again is answered with the
        // same, never a second post. "Post again anyway" takes a new key, when you have looked.
        setError({ text: (e as Error).message, unsure: (e as { status?: number }).status === 504 });
        setTimeout(() => area.current?.focus());
      },
    );
  };
  /**
   * Cancel: the box goes (the one under a thread's post closes to its line), and what was written with it; a toast
   * brings it back.
   */
  const cancel = docked
    ? undefined
    : onCancel || collapsed !== undefined
      ? () => {
          const had = text;
          if (collapsed !== undefined) {
            setText('');
            keepDraft(draftKey, '');
            setError(null);
            setOpen(false);
          }
          onCancel?.();
          if (collapsed !== undefined && had.trim())
            kit.toast({ title: `${label} discarded`, body: '', kind: 'info', actionLabel: 'Undo', action: () => (setText(had), setOpen(true), setTimeout(() => area.current?.focus())) }, 5000);
        }
      : undefined;
  // What is past the limit, marked behind the text as X marks it.
  const overFrom = st.overFrom;
  const nfc = text.normalize('NFC');
  const label = target.quote ? words.quote : target.replyTo ? words.reply : words.post;
  const aimedAt = target.quote ?? target.replyTo;
  if (!open && !docked)
    return (
      <button class="compose-closed" onClick={() => (setOpen(true), setTimeout(() => area.current?.focus()))} data-composer="reply">
        <span>{target.replyTo ? words.replyPlaceholder : words.placeholder}</span>
        <span class="compose-closed-btn">{label}</span>
      </button>
    );
  const box = (
    <div class={`post-composer ${st.level} ${docked ? 'docked' : ''}`} data-composer={target.quote ? 'quote' : target.replyTo ? 'reply' : 'post'}>
      {to && !target.quote && !docked && (
        <span class="compose-to">
          Replying to <b>@{to}</b>
        </span>
      )}
      {warning !== null && (
        <input class="compose-warning" value={warning} placeholder="Content warning" aria-label="Content warning" maxLength={rules.warning?.maxLength} onInput={(e) => setWarning((e.currentTarget as HTMLInputElement).value)} disabled={sending} />
      )}
      <div class="compose-box">
        <div class="compose-back" ref={back} aria-hidden="true">
          {overFrom === null ? (
            nfc
          ) : (
            <>
              {nfc.slice(0, overFrom)}
              <mark>{nfc.slice(overFrom)}</mark>
            </>
          )}
          {'\n'}
        </div>
        <textarea
          ref={area}
          class="compose-text"
          value={text}
          rows={docked ? 1 : 2}
          placeholder={target.quote ? words.quotePlaceholder : target.replyTo ? words.replyPlaceholder : words.placeholder}
          aria-label={label}
          onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
          onScroll={(e) => back.current && (back.current.scrollTop = (e.currentTarget as HTMLTextAreaElement).scrollTop)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), send());
            if (e.key === 'Escape' && cancel) (e.preventDefault(), cancel());
            // The thread's box: Escape takes the aim off first; then, with nothing written, leaves the box, so the next
            // Escape leaves the page.
            else if (e.key === 'Escape' && docked && (docked.onUnaim || !text)) {
              e.preventDefault();
              if (docked.onUnaim) docked.onUnaim();
              else (e.currentTarget as HTMLTextAreaElement).blur();
            }
          }}
          disabled={sending}
        />
      </div>
      {target.quote && <QuotedIn p={target.quote} kit={kit} network={network} still />}
      {pics.length > 0 && (
        <div class="feed-pics">
          {pics.map((p) => (
            <figure key={p.local} class={`feed-pic ${p.error ? 'bad' : p.id ? '' : 'up'}`} title={p.error ?? p.name}>
              {p.mime.startsWith('video/') ? <video src={p.local} muted /> : <img src={p.local} alt={p.name} />}
              <button class="feed-pic-x" aria-label={`Remove ${p.name}`} onClick={() => (URL.revokeObjectURL(p.local), setPics(pics.filter((x) => x !== p)))}>
                <kit.Icon name="x" size={12} />
              </button>
              {!p.id && !p.error && <span class="feed-pic-up">Sending…</span>}
            </figure>
          ))}
        </div>
      )}
      {/* Said once when it goes over or comes back, not at every key. */}
      <span class="sr-only" aria-live="polite">
        {st.level === 'over' ? `Too long by ${-st.remaining}` : ''}
      </span>
      <div class="compose-foot">
        {docked && (
          <>
            <button class="icon-btn composer-emoji" data-track="thread box: emoji" title="Emoji" aria-label="Emoji" aria-expanded={!!emojiAt} disabled={sending} onClick={(e) => setEmojiAt(emojiAt ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}>
              <kit.Icon name="smile" size={18} />
            </button>
            {maxPics > 0 && (
              <>
                <input ref={file} type="file" hidden multiple accept={rules.media.video ? 'image/*,video/mp4,video/quicktime' : 'image/*'} onChange={(e) => (void addFiles((e.currentTarget as HTMLInputElement).files), ((e.currentTarget as HTMLInputElement).value = ''))} />
                <button class="icon-btn compose-pics" data-track="thread box: add pictures" disabled={!canAddPic || sending} title="Add pictures" aria-label="Add pictures" onClick={() => file.current?.click()}>
                  <kit.Icon name="image" size={18} />
                </button>
              </>
            )}
          </>
        )}
        {rules.markdown && <span class="compose-hint">Markdown</span>}
        {rules.warning && (
          <button class={`link-btn compose-cw ${warning !== null ? 'on' : ''}`} aria-pressed={warning !== null} title={warning === null ? 'Add a content warning' : 'No content warning'} onClick={() => setWarning(warning === null ? '' : null)} disabled={sending}>
            CW
          </button>
        )}
        {error && (
          <span class="compose-error" role="alert">
            {error.text}
            {error.unsure && (
              <button class="compose-again" onClick={() => (setKey(fresh()), setError(null))}>
                Post again anyway
              </button>
            )}
          </span>
        )}
        <span class="compose-spacer" />
        <Ring st={st} rules={rules} />
        {cancel && (
          <button class="btn compose-cancel" onClick={cancel} disabled={sending}>
            Cancel
          </button>
        )}
        <button class="btn primary compose-send" onClick={send} disabled={!sendable || sending} title={`${label} on ${NETWORK_META[network].name} (Ctrl+Enter)`}>
          {sending ? 'Posting…' : label}
        </button>
      </div>
      {emojiAt && (
        <EmojiPicker
          network={network}
          anchor={emojiAt}
          onInsert={(t: string) => {
            const a = area.current;
            const at = a?.selectionStart ?? text.length;
            setText(text.slice(0, at) + t + text.slice(a?.selectionEnd ?? at));
            setTimeout(() => a && (a.focus(), a.setSelectionRange(at + t.length, at + t.length)));
          }}
          onClose={() => setEmojiAt(null)}
        />
      )}
    </div>
  );
  if (!docked) return box;
  // At the bottom of the thread, as a chat's box: the line over it, the aim bar, the box.
  return (
    <div class="thread-box" data-aimed={docked.onUnaim ? aimedAt?.id : undefined}>
      <div class="typing-bar with-lead compose-lead">
        <div class="typing-lead">{docked.lead}</div>
      </div>
      {docked.onUnaim && aimedAt && (
        // As a chat's reply bar: whom it answers, their first words, and ✕.
        <div class="composer-reply compose-aim">
          <kit.Icon name={target.quote ? 'quote' : 'reply'} size={13} /> {target.quote ? 'Quoting' : 'Replying to'} <b>@{kit.handle(aimedAt.author ?? null) ?? kit.name(aimedAt.author ?? null)}</b>
          <span>{aimedAt.text.slice(0, 80)}</span>
          <button class="icon-btn small" data-track="thread box: take the aim off" onClick={docked.onUnaim} aria-label={target.quote ? 'Cancel quote' : 'Cancel reply'}>
            <kit.Icon name="x" size={13} />
          </button>
        </div>
      )}
      {box}
    </div>
  );
}
