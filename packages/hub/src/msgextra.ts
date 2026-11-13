/**
 * MessageFact.extra's known keys (protocol extra.ts) as MessageView shows them: a reply's own quote, contact cards, a
 * story reply, the people a send did not reach, files that did not download, and per-attachment notes (docs/messages.md).
 * Pure: the store hands in how to name identities and serve media. Anything malformed is left out, never an error.
 */
import type * as P from '@dither-chat/protocol';
import { attachmentKind } from '@dither-chat/protocol';

export interface ExtraDeps {
  /** A native identity id (or a phone number) as the hub's identity id, when it has one. */
  identity(native: string): string | null;
  /** The hub's identity for this account's own self on this network. */
  isSelf(native: string): boolean;
  /** A MediaUrl as clients fetch it. */
  media(url: string | null | undefined): string | null;
  /** Whether the message a reply points at is stored: then it is shown, and the reply's own quote is not needed. */
  stored(messageId: string): boolean;
}

export type ExtraView = Pick<P.MessageView, 'quote' | 'contacts' | 'storyReply' | 'failed' | 'missingAttachments'> & {
  /** One per attachment position. */
  notes?: (P.AttachmentNote | null)[];
};

const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const arr = <T = unknown>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const REASONS = new Set<P.SendFailureReason>(['unregistered', 'identity', 'rateLimit', 'network', 'keys', 'other']);

export function extraView(extra: Record<string, unknown> | null, replyToId: string | null, d: ExtraDeps): ExtraView {
  if (!extra) return {};
  const out: ExtraView = {};
  const e = extra as P.MessageExtra;

  const q = e.quote;
  if (q && typeof q === 'object' && typeof q.ts === 'number' && !(replyToId && d.stored(replyToId))) {
    const author = str(q.author);
    const authorId = author ? d.identity(author) : null;
    const atts = arr<{ mime?: unknown; name?: unknown; thumbnail?: unknown }>(q.attachments);
    const thumb = atts.map((a) => str(a.thumbnail)).find(Boolean);
    out.quote = {
      authorId,
      authorName: authorId ? null : author && /^\+\d+$/.test(author) ? author : null,
      ts: q.ts,
      text: typeof q.text === 'string' ? q.text.slice(0, 2000) : '',
      attachments: atts.map((a) => ({ kind: attachmentKind(str(a.mime) ?? ''), mime: str(a.mime), name: str(a.name) })),
      thumbnail: thumb ? d.media(thumb) : null,
    };
  }

  const cards = arr<P.SharedContactFact>(e.contacts).filter((c) => c && typeof c.name === 'string');
  if (cards.length)
    out.contacts = cards.map((c) => ({
      name: c.name,
      ...(Array.isArray(c.phones) ? { phones: c.phones.filter((p) => typeof p?.value === 'string') } : {}),
      ...(Array.isArray(c.emails) ? { emails: c.emails.filter((p) => typeof p?.value === 'string') } : {}),
      ...(typeof c.organization === 'string' ? { organization: c.organization } : {}),
      ...(Array.isArray(c.addresses) ? { addresses: c.addresses.filter((a) => typeof a?.text === 'string') } : {}),
      ...(typeof c.line === 'string' ? { line: c.line } : {}),
      avatar: d.media(c.avatar),
    }));

  const s = e.storyReply;
  if (s && typeof s === 'object') {
    const author = str(s.author);
    out.storyReply = { mine: !!author && d.isSelf(author), authorId: author ? d.identity(author) : null, ...(str(s.emoji) ? { emoji: s.emoji } : {}) };
  }

  const failed = arr<P.SendFailureFact>(e.failed).filter((f) => f && REASONS.has(f.reason));
  if (failed.length)
    out.failed = failed.map((f) => {
      const identityId = str(f.who) ? d.identity(f.who!) : null;
      return { identityId, name: identityId ? null : (str(f.number) ?? null), reason: f.reason };
    });

  const missing = arr<P.MissingAttachmentFact>(e.missingAttachments).filter((m) => m && typeof m === 'object');
  if (missing.length)
    out.missingAttachments = missing.map((m) => ({
      ...(str(m.name) ? { name: m.name } : {}),
      ...(str(m.mime) ? { mime: m.mime } : {}),
      ...(typeof m.size === 'number' ? { size: m.size } : {}),
    }));

  const notes = arr<P.AttachmentNote | null>(e.attachmentNotes);
  if (notes.some((n) => n && typeof n === 'object')) out.notes = notes.map((n) => (n && typeof n === 'object' ? n : null));
  return out;
}

/** An attachment view with its note (voice note, caption) from its message's extra. */
export function withNote(a: P.AttachmentView, note: P.AttachmentNote | null | undefined): P.AttachmentView {
  if (!note) return a;
  const caption = str(note.caption);
  return { ...a, ...(note.voiceNote === true ? { voiceNote: true as const } : {}), ...(caption ? { caption } : {}) };
}
