/**
 * One message in the reader: folded to a line, or open with its headers, its body and its actions. The body comes
 * from the first renderer in slots.tsx that takes it (TextBody until slice 3); the actions from MESSAGE_ACTIONS.
 */
import type * as P from '@dither-chat/protocol';
import { mailAddressText, mailPreview } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { bytes, clock, dayLabel, fullTime, sameDay } from '../../format.ts';
import { bodies, bodyState, loadBody, retryBody } from '../../mail/api.ts';
import { openProfile } from '../../state.ts';
import { Avatar } from '../bits.tsx';
import { Icon } from '../icons.tsx';
import { MailFiles } from './MailFiles.tsx';
import { BODY_RENDERERS, MESSAGE_ACTIONS } from './slots.tsx';
import { Loading } from '../Loader.tsx';

/** In the reader: "10:42" today, "Yesterday 18:02", a day and a time before. */
function mailTime(ts: number, now = Date.now()): string {
  return sameDay(ts, now) ? clock(ts) : `${dayLabel(ts, now)} ${clock(ts)}`;
}

/** In a list, short: "10:42" today, "Tue" this week, "Oct 28" this year, "Oct 28, 2025" before. */
export function listTime(ts: number, now = Date.now()): string {
  if (sameDay(ts, now)) return clock(ts);
  const d = new Date(ts);
  if (now - ts < 6 * 86_400_000 && ts < now) return d.toLocaleDateString(undefined, { weekday: 'short' });
  const thisYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

const who = (a: P.MailAddressView) => a.name || a.email;
const list = (xs: P.MailAddressView[], self: Set<string>) => xs.map((a) => (self.has(a.email.toLowerCase()) ? 'me' : who(a))).join(', ');

export function MessageCard({ message: m, thread, account, open, onToggle }: { message: P.MailMessageView; thread: P.MailThreadView; account: P.MailAccountView | undefined; open: boolean; onToggle: () => void }) {
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (open) void loadBody(m.id);
  }, [open, m.id]);
  const self = new Set([account?.address?.toLowerCase()].filter((x): x is string => !!x));
  const fromMe = m.addressed === 'self';
  const name = fromMe ? 'me' : who(m.from);
  if (!open)
    return (
      <button class="mail-msg folded" data-message={m.id} onClick={onToggle} aria-expanded="false">
        <Avatar id={m.from.email || m.id} name={who(m.from)} size={28} />
        <span class="mail-msg-who">{name}</span>
        <span class="mail-msg-line">{m.preview ?? mailPreview(bodies.get(m.id)?.text) ?? ''}</span>
        <span class="mail-msg-time">{mailTime(m.receivedAt)}</span>
      </button>
    );
  const body = bodies.get(m.id);
  const state = bodyState.get(m.id);
  const actions = MESSAGE_ACTIONS.filter((a) => a.show?.(m, thread, account) ?? true);
  return (
    <article class={`mail-msg open ${m.flags.seen || m.seenHere ? '' : 'unread'}`} data-message={m.id}>
      <header class="mail-msg-head">
        <button class="mail-msg-fold" onClick={onToggle} aria-expanded="true" aria-label="Fold this message">
          <Avatar id={m.from.email || m.id} name={who(m.from)} size={36} />
        </button>
        <div class="mail-msg-meta">
          <div class="mail-msg-from">
            {m.from.identityId && !fromMe ? (
              <button class="mail-msg-name mail-msg-person" title={`${who(m.from)}: profile`} onClick={() => openProfile(m.from.identityId)}>
                {who(m.from)}
              </button>
            ) : (
              <span class="mail-msg-name">{who(m.from)}</span>
            )}
            {m.from.name && <span class="mail-msg-addr">&lt;{m.from.email}&gt;</span>}
          </div>
          <div class="mail-msg-to">
            to {list(m.to, self) || 'undisclosed recipients'}
            {m.cc.length > 0 && <>, cc {list(m.cc, self)}</>}
          </div>
        </div>
        <span class="mail-msg-time" title={fullTime(m.date)}>
          {mailTime(m.receivedAt)}
        </span>
        <button class="icon-btn mail-msg-more" aria-expanded={more} aria-label="Details" title="Details" onClick={() => setMore(!more)}>
          <Icon name={more ? 'chevronUp' : 'chevronDown'} size={16} />
        </button>
      </header>
      {more && (
        <dl class="mail-msg-details">
          <dt>From</dt>
          <dd>{mailAddressText(m.from)}</dd>
          {m.to.length > 0 && (
            <>
              <dt>To</dt>
              <dd>{m.to.map(mailAddressText).join(', ')}</dd>
            </>
          )}
          {m.cc.length > 0 && (
            <>
              <dt>Cc</dt>
              <dd>{m.cc.map(mailAddressText).join(', ')}</dd>
            </>
          )}
          {body && body.replyTo.length > 0 && (
            <>
              <dt>Reply-To</dt>
              <dd>{body.replyTo.map(mailAddressText).join(', ')}</dd>
            </>
          )}
          <dt>Date</dt>
          <dd>{fullTime(m.date)}</dd>
          {body?.sizes && (
            <>
              <dt>Size</dt>
              <dd class="mail-msg-size">{sizeLine(body)}</dd>
            </>
          )}
          {m.labels.length > 0 && (
            <>
              <dt>Labels</dt>
              <dd>{m.labels.join(', ')}</dd>
            </>
          )}
          {body?.warnings.map((w) => <dd class="mail-warning">{w}</dd>)}
        </dl>
      )}
      <div class="mail-msg-body">
        {body ? (
          <Body message={m} body={body} account={account} />
        ) : state?.error ? (
          <div class="mail-body-failed" role="alert">
            <span>Could not load this message: {state.error}</span>
            <button class="link-btn" onClick={() => void retryBody(m.id)}>
              Try again
            </button>
          </div>
        ) : (
          <Loading inline label="Loading…" />
        )}
      </div>
      {body && <MailFiles body={body} />}
      {actions.length > 0 && (
        <footer class="mail-msg-actions">
          {actions.map((a) => (
            <button class="hdr-btn" onClick={() => a.run(m, thread)}>
              <Icon name={a.icon} size={15} />
              <span class="hdr-btn-label">{a.label}</span>
            </button>
          ))}
        </footer>
      )}
    </article>
  );
}

/**
 * "188 KB (HTML 150 KB, files 20 KB) · pictures: 9 from 4 hosts, 1.2 MB, 2 not fetched yet; 3 not loaded": the mail
 * as the server keeps it, and what showing its pictures fetches on top (docs/mail.md "Sizes").
 */
export function sizeLine(b: P.MailBodyView): string {
  const z = b.sizes!;
  const total = z.raw ?? z.text + z.html + z.files;
  const parts = [z.html && `HTML ${bytes(z.html)}`, z.text && `text ${bytes(z.text)}`, z.files && `files ${bytes(z.files)}`].filter(Boolean);
  let out = `${bytes(total) || '0 B'}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  const p = b.html?.pictures;
  if (p && p.items.length) {
    const shown = [`${p.loaded} loaded from ${p.hosts} ${p.hosts === 1 ? 'host' : 'hosts'}`, p.bytes && bytes(p.bytes), p.unknown && `${p.unknown} not fetched yet`].filter(Boolean);
    out += ` · pictures: ${shown.join(', ')}${p.held ? `; ${p.held} not loaded` : ''}`;
  }
  return out;
}

function Body(p: { message: P.MailMessageView; body: P.MailBodyView; account: P.MailAccountView | undefined }) {
  for (const r of BODY_RENDERERS) {
    const out = r(p);
    if (out !== null && out !== undefined) return <>{out}</>;
  }
  return null;
}
