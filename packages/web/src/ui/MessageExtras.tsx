/**
 * What a message carries besides its text and files (protocol extra.ts, docs/messages.md): a reply's own quote when the
 * quoted message is not here, contact cards, a story reply, the people your message did not reach, files that did not
 * download, a voice note's label and a file's caption. Each draws nothing when the message has none of it; the viewed
 * receipt goes when you play someone's voice note or video.
 */
import type * as P from '@dither-chat/protocol';
import { SEND_FAILURE_WORDS } from '@dither-chat/protocol';
import { bytes } from '../format.ts';
import { authorName, netName, plainBody } from '../model.ts';
import { api, db, isSelfIdentity, openProfile } from '../state.ts';
import { Icon } from './icons.tsx';
import { messageSomeone, openPalette } from './Palette.tsx';

/** The quote a reply carries itself, for a quoted message this hub does not have (one from before a Signal link). */
export function QuoteFallback({ m }: { m: P.MessageView }) {
  const q = m.quote;
  if (!q) return null;
  const who = q.authorId ? (isSelfIdentity(q.authorId) ? 'You' : authorName(q.authorId)) : (q.authorName ?? 'Someone');
  const files = q.attachments.length ? (q.attachments.length === 1 ? kindWord(q.attachments[0].kind) : `${q.attachments.length} files`) : '';
  const text = plainBody(q.text, m.network).slice(0, 120);
  return (
    <div class="reply-quote reply-quote-own" title="Quoted from the reply itself: the message is not on this hub">
      <Icon name="reply" size={12} />
      <b>{who}</b>
      {q.thumbnail && <img class="reply-quote-thumb" src={q.thumbnail} alt="" loading="lazy" onError={(e) => e.currentTarget.remove()} />}
      <span>{text || files || 'Message'}</span>
    </div>
  );
}

const kindWord = (k: P.AttachmentKind) => (k === 'image' ? 'Photo' : k === 'video' ? 'Video' : k === 'audio' ? 'Audio' : 'File');

/** "Replied to your story" (or "Reacted ❤️ to …"): the story itself never reaches the hub. */
export function StoryReplyLine({ m }: { m: P.MessageView }) {
  const s = m.storyReply;
  if (!s) return null;
  const whose = s.mine ? 'your story' : s.authorId ? `${authorName(s.authorId)}'s story` : 'a story';
  return (
    <div class="msg-story-reply">
      <Icon name="reply" size={12} /> {s.emoji ? `Reacted ${s.emoji} to ${whose}` : `Replied to ${whose}`}
    </div>
  );
}

/** Someone with this phone number or email the hub knows, on any network. */
function knownBy(value: string): string | null {
  for (const i of db.identities.values()) if (i.handle === value && !isSelfIdentity(i.id)) return i.id;
  return null;
}

/** A shared contact: name, organisation, numbers, emails and addresses; "Message" where someone has that number here. */
export function ContactCards({ m }: { m: P.MessageView }) {
  if (!m.contacts?.length) return null;
  const canStart = [...db.accounts.values()].some((a) => a.status === 'online' && a.capabilities.includes('openDirect') && (a.network === 'signal' || a.network === 'whatsapp'));
  return (
    <div class="contact-cards">
      {m.contacts.map((c) => {
        const known = [...(c.phones ?? []), ...(c.emails ?? [])].map((v) => knownBy(v.value)).find(Boolean) ?? null;
        const phone = c.phones?.[0]?.value;
        return (
          <div class="contact-card">
            <div class="contact-card-head">
              {c.avatar ? <img class="contact-card-pic" src={c.avatar} alt="" loading="lazy" /> : <Icon name="user" size={22} />}
              <span>
                <b>{c.name}</b>
                {c.organization && <small>{c.organization}</small>}
              </span>
            </div>
            {[...(c.phones ?? []).map((v) => ({ ...v, href: `tel:${v.value}` })), ...(c.emails ?? []).map((v) => ({ ...v, href: `mailto:${v.value}` }))].map((v) => (
              <div class="contact-card-row">
                <a href={v.href}>{v.value}</a>
                {v.label && <small>{v.label}</small>}
              </div>
            ))}
            {c.addresses?.map((a) => (
              <div class="contact-card-row">
                <span>{a.text}</span>
                {a.label && <small>{a.label}</small>}
              </div>
            ))}
            {known ? (
              <div class="contact-card-actions">
                <button class="btn ghost small" onClick={() => messageSomeone(known)}>
                  <Icon name="send" size={13} /> Message
                </button>
                <button class="btn ghost small" onClick={() => openProfile(known)}>
                  Profile
                </button>
              </div>
            ) : (
              phone &&
              canStart && (
                <div class="contact-card-actions">
                  <button class="btn ghost small" onClick={() => openPalette({ kind: 'new', mode: 'message' }, phone)}>
                    <Icon name="send" size={13} /> Message
                  </button>
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Files the account could not download: named, so they do not simply vanish. */
export function MissingFiles({ m }: { m: P.MessageView }) {
  if (!m.missingAttachments?.length) return null;
  return (
    <div class="atts-missing">
      {m.missingAttachments.map((a) => (
        <div class="att-missing" title="The account could not download this file. It may still be on your phone.">
          <Icon name="alert" size={14} />
          <span>
            Attachment not downloaded{a.name ? `: ${a.name}` : ''}
            {a.size ? ` (${bytes(a.size)})` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Your message reached the others but not these people, and why. */
export function SendFailures({ m }: { m: P.MessageView }) {
  if (!m.failed?.length) return null;
  return (
    <div class="msg-failed" role="note">
      <Icon name="alert" size={13} />
      <span>
        Not delivered to{' '}
        {m.failed.map((f, i) => (
          <>
            {i > 0 && ', '}
            {f.identityId ? (
              <button class="link" onClick={() => openProfile(f.identityId)}>
                {authorName(f.identityId)}
              </button>
            ) : (
              (f.name ?? 'someone')
            )}{' '}
            <small>({SEND_FAILURE_WORDS[f.reason].replace('the network', netName(m.network))})</small>
          </>
        ))}
        . {netName(m.network)} cannot send it again to only them; send it again if they should have it.
      </span>
    </div>
  );
}

/** A voice note's label, or a file's own caption, under it. */
export function AttachmentNote({ a }: { a: P.AttachmentView }) {
  if (!a.voiceNote && !a.caption) return null;
  return (
    <div class="att-note">
      {a.voiceNote && (
        <span class="att-voice">
          <Icon name="mic" size={12} /> Voice message
        </span>
      )}
      {a.caption && <span class="att-caption">{a.caption}</span>}
    </div>
  );
}

/** The body without the lines the adapter wrote for its contact cards, which the cards show instead. */
export function withoutCardLines(m: P.MessageView): P.MessageView {
  const lines = new Set((m.contacts ?? []).map((c) => c.line).filter(Boolean));
  if (!lines.size) return m;
  const body = m.body
    .split('\n')
    .filter((l) => !lines.has(l))
    .join('\n')
    .trim();
  return { ...m, body };
}

const viewedSent = new Set<string>();
/**
 * You played someone's voice note or video: their network hears it was played, once, where it has such receipts. The
 * hub and the account decide whether it goes (a message request, or read receipts off, sends nothing).
 */
export function played(m: P.MessageView) {
  if (isSelfIdentity(m.authorId) || viewedSent.has(m.id)) return;
  if (!m.seenVia.some((id) => db.accounts.get(id)?.capabilities.includes('viewed'))) return;
  viewedSent.add(m.id);
  void api(`/api/messages/${m.id}/viewed`, { body: {} }).catch(() => viewedSent.delete(m.id));
}
