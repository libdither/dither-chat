/**
 * Mail and people (docs/mail.md, hub mail/people.ts), for the parts of the page outside Mail's own chunk: the profile.
 *
 * `composeTo.run` starts a new mail to someone. Slice 5's composer sets it, from code the app loads at start (the
 * profile is not in Mail's chunk); while it is set, an email account's menu on a profile offers "Email <address>" (and Message, with no chat yet).
 */
import type * as P from '@dither-chat/protocol';

export const composeTo: { run: ((to: P.MailAddressView) => void) | null } = { run: null };
