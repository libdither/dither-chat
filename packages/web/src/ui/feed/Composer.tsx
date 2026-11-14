/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Writing a post, a reply or a quote (docs/feed.md "Answering"), drawn from the network's rules (protocol compose.ts):
 * one composer for X and, when one comes, Reddit.
 *
 * As X does it: "Replying to @handle" over the box; a ring that fills as you write and, from 20 left, grows and says
 * how many are left (yellow), at the limit red, past it a negative count in red and the ring gone past -10; what is
 * past the limit marked in red in the text itself; Post greyed until there is something and it fits. Links count 23
 * and most CJK characters and every emoji two, as X counts them. As Reddit does it: 10,000 characters, a "N left"
 * line from 1,000 left, Markdown.
 *
 * Ctrl/Cmd+Enter posts, Escape closes. What you write is kept on the device until it is posted or cleared, per post
 * answered. Each composer posts once: a key goes with it, so a double press or a retry is one post (posts.ts).
 */
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
// Its own path, so the rules ride in this chunk, not the app's start.
import { composeState, postRulesFor, type PostRules } from '@dither-chat/protocol/compose';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../state.ts';
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
function Ring({ st, rules }: { st: ReturnType<typeof composeState>; rules: PostRules }) {
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

export interface ComposeTarget {
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
}: {
  network: P.Network;
  target: ComposeTarget;
  kit: Kit;
  onPosted: (p: P.PostView) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  /** One line until it is focused (the reply box under a thread's post, as X shows it). */
  collapsed?: boolean;
}) {
  const rules = postRulesFor(network);
  const draftKey = `${network}:${target.quote ? `q${target.quote.id}` : target.replyTo ? `r${target.replyTo.id}` : 'new'}`;
  const [text, setText] = useState(() => readDraft(draftKey));
  const [open, setOpen] = useState(!collapsed || !!text);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ text: string; unsure: boolean } | null>(null);
  // This post's key: the same press again is the same post (posts.ts). A new one after each post, or when you choose
  // to post again after no answer.
  const fresh = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const [key, setKey] = useState(fresh);
  useEffect(() => setKey(fresh()), [draftKey]);
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
  }, [autoFocus, draftKey, open]);
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
  const words = rules.words;
  const to = target.replyTo ? kit.handle(target.replyTo.author ?? null) : null;
  const send = () => {
    if (!st.sendable || sending) return;
    setSending(true);
    setError(null);
    api<P.PostView>(`/api/posts/${network}/publish`, {
      method: 'POST',
      body: { text, key, ...(target.replyTo ? { replyTo: target.replyTo.id } : {}), ...(target.quote ? { quote: target.quote.id } : {}) },
    }).then(
      (p) => {
        setSending(false);
        setText('');
        keepDraft(draftKey, '');
        setKey(fresh());
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
  // What is past the limit, marked behind the text as X marks it.
  const overFrom = st.overFrom;
  const nfc = text.normalize('NFC');
  const label = target.quote ? words.quote : target.replyTo ? words.reply : words.post;
  if (!open)
    return (
      <button class="compose-closed" onClick={() => (setOpen(true), setTimeout(() => area.current?.focus()))} data-composer="reply">
        <span>{target.replyTo ? words.replyPlaceholder : words.placeholder}</span>
        <span class="compose-closed-btn">{label}</span>
      </button>
    );
  return (
    <div class={`post-composer ${st.level}`} data-composer={target.quote ? 'quote' : target.replyTo ? 'reply' : 'post'}>
      {to && !target.quote && (
        <span class="compose-to">
          Replying to <b>@{to}</b>
        </span>
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
          rows={2}
          placeholder={target.quote ? words.quotePlaceholder : target.replyTo ? words.replyPlaceholder : words.placeholder}
          aria-label={label}
          onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
          onScroll={(e) => back.current && (back.current.scrollTop = (e.currentTarget as HTMLTextAreaElement).scrollTop)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), send());
            if (e.key === 'Escape' && onCancel) (e.preventDefault(), onCancel());
          }}
          disabled={sending}
        />
      </div>
      {target.quote && <QuotedIn p={target.quote} kit={kit} network={network} />}
      {/* Said once when it goes over or comes back, not at every key. */}
      <span class="sr-only" aria-live="polite">
        {st.level === 'over' ? `Too long by ${-st.remaining}` : ''}
      </span>
      <div class="compose-foot">
        {rules.markdown && <span class="compose-hint">Markdown</span>}
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
        {onCancel && (
          <button class="btn compose-cancel" onClick={onCancel} disabled={sending}>
            Cancel
          </button>
        )}
        <button class="btn primary compose-send" onClick={send} disabled={!st.sendable || sending} title={`${label} on ${NETWORK_META[network].name} (Ctrl+Enter)`}>
          {sending ? 'Posting…' : label}
        </button>
      </div>
    </div>
  );
}
