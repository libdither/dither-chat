/**
 * A mail thread's details panel (docs/mail.md "Mail as chats"), opened by its head's Details where a chat's opens: who
 * is on it (From, To and Cc, each to their page where they are a person), its files and links as the chat holds them,
 * when it started and its newest mail, which of your mail accounts it is in, and its filing. A chunk of its own,
 * loaded the first time it opens (App.tsx).
 */
import type * as P from '@dither-chat/protocol';
import { bareSubject } from '@dither-chat/protocol';
import { fullTime } from '../format.ts';
import { faceOf, identityName } from '../model.ts';
import { db, mailRev, openProfile, timelineKey, timelineRev } from '../state.ts';
import { timelines } from '../store.ts';
import { details } from '../mail/held.ts';
import { convById, mailThread } from '../mail/chats.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import { HeadOrb } from './Offline.tsx';
import { detailsShown, showDetails } from './Pager.ts';
import { MailTile } from './MailLists.tsx';
import { mailThreadPanel } from './mail/lazy.tsx';

interface Who {
  email: string;
  name: string;
  identityId: string | null;
  /** From, To or Cc: the first way they are on it. */
  as: 'From' | 'To' | 'Cc';
  self: boolean;
}

/** Everyone on the thread, yours last: each From, To and Cc of its mails, from the chat page or the thread as held. */
function peopleOf(threadId: string, msgs: P.MessageView[]): Who[] {
  const mine = new Set([...db.mail.accounts.values()].map((a) => a.address?.toLowerCase()).filter(Boolean));
  const out = new Map<string, Who>();
  const add = (as: Who['as']) => (a: P.MailAddressView & { self?: boolean }) => {
    const e = a.email.toLowerCase();
    if (out.has(e)) return;
    out.set(e, { email: a.email, name: (a.identityId && identityName(a.identityId)) || a.name || a.email, identityId: a.identityId ?? null, as, self: !!a.self || mine.has(e) });
  };
  for (const m of msgs) if (m.mail) (add('From')(m.mail.from), m.mail.to.forEach(add('To')), m.mail.cc.forEach(add('Cc')));
  for (const m of details.get(threadId)?.messages ?? []) (add('From')(m.from), m.to.forEach(add('To')), m.cc.forEach(add('Cc')));
  mailThread(threadId)?.from.forEach(add('From'));
  return [...out.values()].sort((a, b) => Number(a.self) - Number(b.self));
}

const LINK = /https?:\/\/[^\s<>"')\]]+/g;

export function MailThreadDetails({ threadId }: { threadId: string }) {
  mailRev.value;
  const tkey = timelineKey('c', threadId);
  timelineRev(tkey).value;
  const t = mailThread(threadId);
  const c = convById(threadId);
  const msgs = timelines.get(tkey)?.messages ?? [];
  const people = peopleOf(threadId, msgs);
  const files = msgs.flatMap((m) => (m.attachments ?? []).map((a) => ({ a, m })));
  const links = [...new Set(msgs.flatMap((m) => m.body.match(LINK) ?? []))];
  const account = t ? db.mail.accounts.get(t.accountId) : undefined;
  const subject = t ? bareSubject(t.subject) || '(no subject)' : (c?.name ?? 'Mail thread');
  const actions = mailThreadPanel(threadId);
  return (
    <aside class="details mail-details">
      <header class="det-head">
        <span class="det-net">
          <MailTile size={28} />
        </span>
        <div>
          <h2>{subject}</h2>
          <span class="det-kind">{t ? `Mail thread · ${t.count} ${t.count === 1 ? 'mail' : 'mails'}` : 'Mail thread'}</span>
        </div>
        {detailsShown() && <HeadOrb />}
        <button class="icon-btn" onClick={() => showDetails(false)} aria-label="Close details">
          <Icon name="x" />
        </button>
      </header>
      <div class="det-scroll">
        {actions.length > 0 && (
          <div class="btn-row det-filing">
            {actions.map((a) => (
              <button key={a.track} class={`btn ghost small ${a.danger ? 'danger' : ''}`} data-track={a.track} onClick={a.run}>
                {a.icon && <Icon name={a.icon} size={13} />} {a.label}
              </button>
            ))}
          </div>
        )}
        <section class="det-section">
          <h3>On this thread ({people.length})</h3>
          <div class="members mail-members">
            {people.map((w) => (
              <button key={w.email} class="member" disabled={!w.identityId} title={w.identityId ? `${w.name}'s page` : w.email} onClick={() => w.identityId && openProfile(w.identityId)} data-track="mail details: person">
                <Avatar id={faceOf(w.identityId).id || w.email} name={w.name} url={faceOf(w.identityId).url} size={28} />
                <span>
                  <b>{w.self ? `You (${w.name})` : w.name}</b>
                  <small>
                    {w.as} · {w.email}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </section>
        <section class="det-section">
          <h3>Thread</h3>
          <dl class="kv">
            {t && (
              <>
                <dt>Started</dt>
                <dd>{fullTime(t.firstAt)}</dd>
                <dt>Newest mail</dt>
                <dd>{fullTime(t.lastAt)}</dd>
              </>
            )}
            {account && (
              <>
                <dt>In</dt>
                <dd>
                  {account.label}
                  {account.address && account.address !== account.label ? ` · ${account.address}` : ''}
                </dd>
              </>
            )}
          </dl>
        </section>
        {files.length > 0 && (
          <section class="det-section">
            <h3>Files ({files.length})</h3>
            {files.map(({ a }) => (
              <a key={a.id} class="link-row" href={a.url} target="_blank" rel="noreferrer">
                <Icon name="file" size={13} /> {a.name ?? 'File'}
              </a>
            ))}
          </section>
        )}
        {links.length > 0 && (
          <section class="det-section">
            <h3>Links ({links.length})</h3>
            {links.map((l) => (
              <a key={l} class="link-row" href={l} target="_blank" rel="noreferrer noopener" title={l}>
                <Icon name="link" size={13} /> <span class="det-link">{l.replace(/^https?:\/\//, '')}</span>
              </a>
            ))}
          </section>
        )}
      </div>
    </aside>
  );
}
