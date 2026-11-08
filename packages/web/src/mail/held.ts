/**
 * What the reader has open: threads with their messages, and bodies (mail/api.ts fills them). Apart from api.ts so the
 * snapshot (snapshot.ts) can keep and restore them without the network code.
 */
import type * as P from '@dither-chat/protocol';

/** Threads the reader has opened: their messages, as the hub last said. */
export const details = new Map<string, P.MailThreadDetail & { loading?: boolean; error?: string }>();
/** Bodies by message, oldest fetched first. */
export const bodies = new Map<string, P.MailBodyView>();
/** Bodies on their way, or failed. */
export const bodyState = new Map<string, { loading: boolean; error: string | null }>();
