/**
 * What both Signal backup readers (signal-v2.ts, signal-legacy.ts) share: the wording the live adapter gives polls,
 * contact cards and view-once media, SMS ids for people without an ACI, and writing chats out as the facts file
 * wants them. Ids and the rest of the wording come from the live adapter itself (adapter-signal/src/mapping.ts), so
 * an import and live sync meet on the same rows.
 */
import type * as P from '@dither-chat/protocol';

export const VIEW_ONCE_BODY = '📷 View-once media (open it on your phone)';
export const MISSING_FILE_BODY = '📎 Attachment (not in the backup)';

export const joinName = (...parts: (string | null | undefined)[]) => parts.filter((p) => p && p.trim()).join(' ').trim() || undefined;

/** A poll as live sync words it, with extra.poll. */
export function pollBody(question: string, options: string[], multiple: boolean): string {
  return [`📊 **${question}**${multiple ? ' (multiple choice)' : ''}`, ...options.map((x) => `• ${x}`)].join('\n');
}

/** A shared contact as live sync words it: its name, then its numbers and addresses. */
export function contactLine(name: string, values: string[]): string {
  return `👤 ${name}${values.length ? ' · ' + values.join(', ') : ''}`;
}

/** The same file twice in one message (it happens) is still two attachments: the second gets "#<position>". */
export function distinctFiles(atts: P.AttachmentFact[]) {
  const used = new Set<string>();
  for (const [i, a] of atts.entries()) {
    if (used.has(a.nativeId!)) a.nativeId = `${a.nativeId}#${i}`;
    used.add(a.nativeId!);
  }
}

/** How an SMS-only contact is known: "tel:<number>" (short codes have no "+"), or "mailto:<email>". */
export const telId = (number: string) => `tel:${number}`;
export const mailtoId = (email: string) => `mailto:${email.toLowerCase()}`;

/**
 * SMS with someone not on Signal. Not a conversation Signal can send to (the adapter sends to dm: and group: alone),
 * so it is history only: protocol send.ts says so in the message box.
 */
export function smsConversation(self: string, peer: string): P.ConversationFact {
  return { nativeId: `sms:${self}:${peer}`, shape: 'direct', participants: [self, peer], encrypted: false };
}

export interface ChatFacts<M extends P.MessageFact = P.MessageFact> {
  conversation: P.ConversationFact;
  messages: M[];
  people: Set<string>;
}

interface ChatStats {
  conversations: number;
  messages: number;
  duplicates: number;
  selfMessages: number;
}

/** Add a mapped message to its chat, unless one with its id came before. */
export function addMessage<M extends P.MessageFact>(chat: ChatFacts<M>, m: M, seen: Set<string>, self: string, stats: ChatStats): boolean {
  if (seen.has(m.nativeId)) {
    stats.duplicates++;
    return false;
  }
  seen.add(m.nativeId);
  m.conversation = chat.conversation.nativeId;
  chat.messages.push(m);
  chat.people.add(m.author);
  if (m.author === self) stats.selfMessages++;
  return true;
}

/** Each chat with messages, with the people in it, then its messages: the order the facts file wants. */
export function emitChats(chats: Iterable<ChatFacts>, identities: Map<string, P.IdentityFact>, stats: ChatStats, emit: (line: unknown) => void) {
  for (const c of chats) {
    if (!c.messages.length) continue;
    stats.conversations++;
    stats.messages += c.messages.length;
    const people = new Set([...c.people, ...(c.conversation.participants ?? [])]);
    emit({ t: 'conversation', conversation: c.conversation, identities: [...people].map((p) => identities.get(p)).filter(Boolean), messages: c.messages.length });
    for (const m of c.messages) emit({ t: 'message', m });
  }
}
