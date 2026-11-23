/**
 * Email, hub <-> client (docs/mail.md, docs/mail-design.md §5). Mail comes from dither-accounts' `mail` interface
 * (mail-iface.ts) and is kept in the hub's own mail tables; these are the views the page gets of it.
 *
 * Ids are hub ids (ids.ts mailId): `mbx_` mailboxes, `mml_` messages, `mth_` threads, `mob_` outbox items. Mail
 * accounts keep the manager's account id. Times are ms since the epoch.
 *
 * Built in slices (docs/mail-design.md §12). Fields a later slice fills are here already, with the value they have
 * until then: a seam, not a promise. Each says which slice fills it.
 */
import type { IdentityView, TriageView } from './api.ts';
import type { FileInfo } from './files.ts';
import type { MailboxRole, MailWriteKind } from './mail-iface.ts';

export type { MailboxRole, MailWriteKind } from './mail-iface.ts';

/**
 * Whether this hub may read your mail: `off` without DITHER_ACCOUNTS_URL, `unreachable` while the manager does not
 * answer, `pending` until you approve the hub's request on the manager's page, `denied` if you declined it.
 */
export interface MailAccess {
  state: 'off' | 'unreachable' | 'pending' | 'denied' | 'granted';
  /** The manager's page, where you approve the request and add mail accounts (DITHER_ACCOUNTS_PUBLIC_URL). */
  managerUrl: string | null;
}

/** What stops a mail account working (MailAccountView.problem). */
export interface MailProblem {
  layer: string | null;
  message: string;
  /**
   * `waiting`: a layer is still coming up (signing in, the page loading), which usually passes by itself; `failed`: a
   * layer failed; `attention`: the account asks for you. Absent from rows written before it was kept: read as `attention`.
   */
  state?: 'waiting' | 'failed' | 'attention';
  /** When it last stopped working (kept while only the words change). Absent on old rows. */
  since?: number;
}

export interface MailAccountView {
  /** The manager's account id. */
  id: string;
  /** dither-accounts' kind: `imap`, `proton`, `google` (Gmail on the web). */
  kind: string;
  label: string;
  /** The address it receives at, once the account has said. */
  address: string | null;
  name: string | null;
  color: string;
  /** What the hub's grant lets it do; null once access to the account has ended. */
  level: 'read' | 'write' | null;
  /** Writes are answered without reaching the account. */
  dryRun: boolean;
  online: boolean;
  /** Why it cannot work now: the account's attention, else its first layer that is not ok. */
  problem: MailProblem | null;
  /**
   * Whether sending works: false with why, true after a send, null before anyone knows (slice 5 sends). `refused`: the
   * account answered a send with 501, so it is off until you ask again (POST /api/mail/accounts/:id/sending).
   */
  send: { ok: boolean | null; why: string | null; refused?: boolean };
  /**
   * `stateAt`: the last time the followed mailbox longest without one had a changes pass that worked (null: one has
   * never had one). `error` and `failures`: the last pass's failure and how many failed in a row since one worked (0 and
   * null once one works). The page says "Hasn't synced in …" from these past half an hour.
   */
  sync: { phase: 'first' | 'backfill' | 'idle' | 'relist'; synced: number; oldest: number | null; stateAt?: number | null; error?: string | null; failures?: number };
  /** The account on the manager's page, when the hub knows the page's address. */
  managedUrl: string | null;
  /** Access ended (it left the manager's list, or the grant went): its mail here is deleted at this time. */
  deleteAt: number | null;
  /** Writes made here (slice 4): how many messages wait for the server, the last that failed, ops it refused (501). */
  ops?: MailOpsView;
  /**
   * The most bytes of files, together, one message from it may carry (a send over it is refused, 413): what its
   * extractor says (`details.sendCap`), else 25 MB on Proton and 35 MB elsewhere.
   */
  sendCap?: number;
  /** The most recipients, To, Cc and Bcc together, on one message: `details.maxRecipients`, else 100 on Proton and 500 elsewhere. */
  maxRecipients?: number;
  /**
   * The writes the account makes now, as its status says (`details.writes`): a kind not listed is refused here
   * without a call, and its buttons are hidden. Null or absent: not said, so every write is tried (a 501 says no).
   */
  writes?: MailWriteKind[] | null;
}

/** An account's writes (slice 4). */
export interface MailOpsView {
  /** Messages with a change the server has not confirmed yet. */
  waiting: number;
  /** The last change that could not be made, undone here. */
  error: { message: string; at: number } | null;
  /**
   * What the account answered 501 to: `flag.seen`, `flag.flagged`, `move`, `trash` or `junk` (a move into the trash
   * or junk; older rows say `move` for those too). Its buttons are hidden.
   */
  unsupported: string[];
}

export interface MailboxView {
  id: string;
  accountId: string;
  name: string;
  path: string;
  parentId: string | null;
  role: MailboxRole | null;
  unread: number | null;
  total: number | null;
  /** The hub keeps this mailbox up to date by itself (Inbox, Sent, All or Archive). */
  followed: boolean;
}

export interface MailAddressView {
  name: string | null;
  email: string;
  /** The person and identity behind the address (slice 6). */
  identityId?: string;
  personId?: string;
}

export interface MailThreadView {
  id: string;
  accountId: string;
  subject: string;
  firstAt: number;
  lastAt: number;
  count: number;
  unread: number;
  flagged: boolean;
  attachments: boolean;
  /** Who wrote in it, latest last; your own messages have `self`. */
  from: (MailAddressView & { self?: boolean })[];
  participants: number;
  preview: string | null;
  mailboxIds: string[];
  roles: MailboxRole[];
  labels: string[];
  /** From a person, bulk, or yours (slice 8; null until then). */
  class: 'personal' | 'bulk' | 'self' | null;
  unknown: boolean;
  personIds: string[];
  lastFromMe: boolean;
  /** When the first message you have not answered came (slice 8). */
  owedSince: number | null;
  muted: boolean;
  /** A change made here the server has not confirmed yet (slice 4). */
  pending?: boolean;
  /** Triage's newest decision on a message in it from someone else (slice 9): the Triage board's mail row. */
  triage?: MailTriageItem;
}

export interface MailMessageView {
  id: string;
  threadId: string;
  accountId: string;
  /** The Message-ID header, `<abc@example.com>`. */
  messageId: string | null;
  from: MailAddressView;
  to: MailAddressView[];
  cc: MailAddressView[];
  subject: string;
  date: number;
  receivedAt: number;
  flags: { seen: boolean; flagged: boolean; answered: boolean; draft: boolean };
  /** Read here only (a read grant, or before marking on the server: slice 4). */
  seenHere: boolean;
  /** A change made here the server has not confirmed yet (slice 4). */
  pending: boolean;
  labels: string[];
  mailboxIds: string[];
  hasAttachments: boolean;
  preview: string | null;
  addressed: 'to' | 'cc' | 'hidden' | 'self';
  body: 'cached' | 'none' | 'loading' | 'failed';
  /** Triage's decision on it, and your vote (slice 9); absent when it was not triaged (bulk, yours, older mail). */
  triage?: TriageView;
}

/**
 * A message triage decided on (slice 9, docs/mail.md "Triage and notifications"): the Triage board lists these beside
 * chat's messages, by the same levels. Votes go to POST /api/messages/:id/feedback as chat's do.
 */
export interface MailTriageItem {
  kind: 'mail';
  /** The message (`mml_`). */
  id: string;
  threadId: string;
  accountId: string;
  from: MailAddressView;
  subject: string;
  preview: string | null;
  /** When it reached the server. */
  ts: number;
  unread: boolean;
  triage: TriageView;
}

/** GET /api/mail/triage?since=<ms>: the last week's, newest first. */
export interface MailTriagePage {
  items: MailTriageItem[];
}

export interface MailBodyView {
  messageId: string;
  /** The text part, or text made from the HTML when there is none. */
  text: string | null;
  /** Where quoted text starts in `text` (quoteStart). */
  quoteAt: number | null;
  /**
   * The sanitised HTML (slice 3; null until then). `plain`: it has no colours, fonts, images or tables (only text,
   * paragraphs, links, lists, quotes and Markdown's formatting) and the mail has a text part, so the reader shows
   * `text` in the app's theme rather than this on a white sheet (hub sanitize.ts `plain`, parts.ts `hasTextPart`).
   * `formatted`: plain HTML with bold, italic, headings or code, which `text` would lose: the reader shows this HTML,
   * in the app's theme.
   */
  html: { url: string; remoteImages: number; trackers: number; imagesShown: boolean; plain?: boolean; formatted?: boolean; pictures?: MailPicturesView } | null;
  /**
   * Sizes in bytes: `raw` the whole message as the server keeps it (null when it did not say), `text` and `html` its
   * two bodies, `files` its attachments together.
   */
  sizes?: { raw: number | null; text: number; html: number; files: number };
  bcc: MailAddressView[];
  replyTo: MailAddressView[];
  /** Slice 3. */
  attachments: MailAttachmentView[];
  /** Display-name spoofing, Reply-To elsewhere, links whose text names another site (slice 3). */
  warnings: string[];
}

/**
 * A mail's remote pictures (docs/mail.md "Pictures and trackers"): which load, which are held back and which trackers
 * went, under which rule. `bytes`: what the loaded ones weigh, of those the hub has fetched; `unknown` loaded ones it
 * has not fetched yet (sizes are never fetched just to measure: a fetch can report the open).
 */
export interface MailPicturesView {
  policy: 'none' | 'shared' | 'all';
  /** What chose the policy: you, for this message; the sender's rule; or the setting. */
  source: 'message' | 'sender' | 'setting';
  /** Trackers kept (Settings → Mail "Trackers: Keep", or this message's choice) or removed. */
  keepTrackers: boolean;
  /**
   * What chose `keepTrackers`: you, for this message (POST /api/mail/images { messageId, trackers: 'keep' | 'remove' },
   * `trackers: null` goes back to the setting), or the setting.
   */
  trackersSource?: 'message' | 'setting';
  /** Pictures by what happens to them (each picture once per place it appears): load, hold (held back), drop (removed). */
  loaded: number;
  held: number;
  removed: number;
  /** Distinct hosts of the pictures that load: "N loaded from `hosts` hosts". */
  hosts: number;
  /** Distinct hosts of every picture, loaded, held or removed (what the details list). */
  hostsAll?: number;
  /** Bytes of the pictures that load and that the hub has already. */
  bytes: number;
  /** Pictures that load but that the hub has not fetched yet: they are fetched when the mail is shown ("loads when shown"). */
  unknown: number;
  /**
   * Each picture: `size` is there exactly when the hub has its bytes (`cached`); a `load` one without it is fetched when
   * the mail is shown, a `hold` or `drop` one is never fetched.
   */
  items: { host: string; class: 'shared' | 'personal' | 'tracker'; why: string; action: 'load' | 'hold' | 'drop'; size?: number; cached?: boolean }[];
}

export interface MailAttachmentView {
  id: string;
  name: string | null;
  mime: string;
  size: number;
  /** A part shown in place (a picture in a text mail); parts the HTML shows itself are not listed. */
  inline: boolean;
  /** The bytes (fetched from the server the first time). */
  url: string;
  /** What the file is by its bytes (FileInfo), looked at when asked. */
  infoUrl: string;
  /** What it is, once the hub has looked. */
  info?: FileInfo;
}

/** Slice 5. */
export interface MailOutboxView {
  id: string;
  clientId: string;
  accountId: string;
  subject: string;
  state: 'held' | 'queued' | 'sending' | 'sent' | 'failed';
  holdUntil: number | null;
  error: string | null;
  // Slice 5 (sending): the rest.
  kind?: MailComposeKind;
  /** The thread it answers or forwards from. */
  threadId?: string | null;
  to?: MailAddressView[];
  /** The draft it came from: put back there when it is undone or fails. */
  draftKey?: string | null;
  /** It may have gone out (the account did not answer in time): look in Sent before sending it again. */
  unsure?: boolean;
  /** The Message-ID it went out with, once sent; its copy in Sent has it. */
  sentMessageId?: string | null;
  /** Answered by a dry run: nothing reached the account. */
  dryRun?: boolean;
  createdAt?: number;
  /** What happened to the pictures that were to go inside it (Embed), when any were embedded or left out. */
  pictures?: MailOutboxPictures;
}

/**
 * The pictures of a send with Embed: how many went inside the mail, and how many were left out instead of linked
 * because their bytes could not be had (`failed`) or because fetching them now would tell the original sender
 * (`canTell`: a personal picture the hub did not have already).
 */
export interface MailOutboxPictures {
  embedded: number;
  leftOut: { failed: number; canTell: number };
}

// ------------------------------------------------------------------ sending (slice 5)

export type MailComposeKind = 'new' | 'reply' | 'replyAll' | 'forward';

/** An attachment of the original that a forward carries. */
export interface MailForwardPart {
  messageId: string;
  attachmentId: string;
  name: string | null;
  mime: string;
  size: number;
}

/** A file already on the hub (an upload), as a draft keeps it. */
export interface MailDraftFile {
  uploadId: string;
  name: string;
  mime: string;
  size: number;
}

/** What the composer holds: a draft as the hub keeps it, and what a send carries. */
export interface MailDraft {
  accountId: string;
  kind: MailComposeKind;
  /** The message answered or forwarded (a hub message id, `mml_`). */
  replyTo: string | null;
  /** One of the account's own addresses; null: the account's first. */
  from: string | null;
  to: MailAddressView[];
  cc: MailAddressView[];
  bcc: MailAddressView[];
  subject: string;
  /** What you wrote. The quote or the forwarded message goes after it, made by the hub. */
  text: string;
  /** A reply quotes the original. */
  quote: boolean;
  files: MailDraftFile[];
  forwardParts: MailForwardPart[];
  /**
   * The mail's HTML as the editor made it (docs/mail.md "Writing"): your text, pictures pasted in as `data:` URLs, and
   * the forwarded mail or quote as `div[data-dc-island]`. When there is one, `text` is its Markdown (islands and pasted
   * pictures as `[[island:ref]]` and `dc-picture:ref`, which the hub fills in) and the hub adds no quote of its own.
   */
  html?: string | null;
  /** Pictures from the web in it, when sent: linked as they are, embedded (fetched now and sent in the mail), or left out. */
  pictures?: MailOutgoingPictures;
  /**
   * With Link, the ones that can tell the original sender it was opened are linked too. Unset, they are left out: the
   * rest are linked (docs/mail.md "Writing").
   */
  linkCanTell?: boolean;
  /** Sent as plain text only: no HTML part. */
  plainOnly?: boolean;
}

export type MailOutgoingPictures = 'link' | 'embed' | 'drop';

/**
 * A forwarded mail or a quote, as an editor island (MailComposeStart.island): the original's HTML with its style sheets
 * written into each element's style (so it keeps its look in mail apps that drop style sheets), trackers gone, and each
 * picture from the web as `img[data-dc-src]` (the address it has in the original; `src` is this hub's copy when your
 * picture setting loads it, else a placeholder).
 */
export interface MailIsland {
  kind: 'forward' | 'quote';
  /** "Sam Lee, Tue, Nov 3 at 10:42 AM". */
  label: string;
  html: string;
  /**
   * Bytes the island adds to the mail's text part as made (hub island.ts islandText: a forward's headers and the
   * original's own text, or the quote), which is not the island's HTML's text. Once the island is edited, the hub
   * makes its text from the HTML instead.
   */
  textBytes?: number;
  /** That text itself, which the editor's Plain view shows (while the island is as made). */
  text?: string;
}

/**
 * POST /api/mail/pictures/sizes { urls, accountId }: what the hub knows of pictures from the web, for the composer's size
 * meter, one answer per address asked (in order). `urls` may hold this hub's picture addresses too (`/api/mail/img/…`).
 */
export interface MailPictureSizes {
  /** Bytes each one is, when the hub has fetched it; null when not known (fetching it could tell its sender). */
  sizes: (number | null)[];
  /** Each one's class (pictures.ts): `personal` ones tell their sender when fetched. */
  classes: ('shared' | 'personal' | 'tracker')[];
  /**
   * The hub has its bytes now. With Embed, a picture whose class is not `shared` goes inside the mail only when this
   * is true; otherwise it is left out (fetching it would tell its sender).
   */
  cached?: boolean[];
  /**
   * The address each one stands for: itself, or for this hub's address of a picture (`/api/mail/img/<token>`, as a
   * forward's backgrounds have) the picture's own; null when it stands for nothing (it goes nowhere when sent).
   */
  originals?: (string | null)[];
}

/** GET /api/mail/drafts[/:key]. Keys: `t:<thread>` for a reply or forward, `new:<uuid>` for a new message. */
export interface MailDraftView {
  key: string;
  draft: MailDraft;
  updatedAt: number;
}

/** POST /api/mail/send. Sent once per `clientId`. */
export interface MailSendRequest extends MailDraft {
  clientId: string;
  draftKey: string | null;
  /** The page's time zone, for the "On <date>, <name> wrote:" line. */
  tz?: string;
}

/** GET /api/mail/compose: a reply, reply all or forward filled in, or a new message's choices. */
export interface MailComposeStart {
  draft: MailDraft;
  /** Where the draft goes: `t:<thread>` or `new:<uuid>`. */
  draftKey: string;
  /** The addresses it may send as (status.self.addresses), the account's own first. */
  fromChoices: { accountId: string; email: string; name: string | null }[];
  /** "On Tue, Nov 3, 2026 at 10:42 AM, Sam Lee <sam@lee.example> wrote:" and the quoted text, or the forwarded block. */
  quote: { head: string; text: string } | null;
  /** The quote or the forwarded mail as HTML, for the editor (null when the original has no HTML: then `quote`). */
  island?: MailIsland | null;
  /** The account sends pictures inside the mail as parts of it (`cid:`); else they go as `data:` URLs, which some apps (Gmail) hide. */
  inlineParts?: boolean;
  /** The original could not be fetched to quote: why. */
  quoteError: string | null;
  /** Reply all would reach more people than reply. */
  replyAllDiffers: boolean;
}

/** A recipient the composer offers as you type. */
export interface MailAddressHit extends MailAddressView {
  /** You have written to it. */
  wroteTo: boolean;
  count: number;
}

/** What the bootstrap carries of mail: the live window of threads, at most 300. */
export interface MailBootstrap {
  access: MailAccess;
  accounts: MailAccountView[];
  mailboxes: MailboxView[];
  threads: MailThreadView[];
  /** What the outbox still shows (slice 5). */
  outbox?: MailOutboxView[];
  /** Every person's email routes (mail as chats): a person you mail with one-to-one has a chat. */
  chats?: MailChatView[];
  /** The rungs you chose for places in people's chats. */
  rungs?: PlaceRungView[];
}

/** GET /api/mail/threads: a page of a list, newest first. */
export interface MailThreadPage {
  threads: MailThreadView[];
  /** The cursor for the next page, or null at the end of what the hub holds. */
  next: string | null;
  /** The hub holds the whole list (else older mail is on the server only, for now). */
  complete: boolean;
  /** The page is being fetched from the server; a `mail.threads` event brings it (slice 2). */
  pending: boolean;
}

/** GET /api/mail/threads/:id */
export interface MailThreadDetail {
  thread: MailThreadView;
  messages: MailMessageView[];
  /** The email identities of the people on it (slice 6). */
  identities?: IdentityView[];
}

// ------------------------------------------------------------------ writes (slice 4)

/** Where a move goes: a mailbox id, or one by its role in each thread's own account. */
export type MailMoveTarget = 'archive' | 'inbox' | 'trash' | 'junk' | (string & {});

/** POST /api/mail/flag. Threads: read marks all of them read, unread its latest; star its latest, unstar all. */
export interface MailFlagRequest {
  threadIds?: string[];
  messageIds?: string[];
  seen?: boolean;
  flagged?: boolean;
  /** The page's id for this change: sent again (after the connection dropped), it is made once. */
  clientId?: string;
}

/** POST /api/mail/move. Archive moves only what is in Inbox; the others move the whole thread but what you sent. */
export interface MailMoveRequest {
  threadIds?: string[];
  messageIds?: string[];
  to: MailMoveTarget;
  clientId?: string;
}

/** What a write did here: threads changed, messages that will be told to the server. */
export interface MailOpResult {
  ok: true;
  threads: number;
  messages: number;
}

/**
 * GET/PUT /api/mail/settings. `markRead`: on the server after a second in view, or only when you mark it (§14 Q3).
 * `pictures`: which remote pictures load by themselves (docs/mail.md "Pictures and trackers"): none, only those unlikely
 * to report an open (`shared`), or all; a sender's own rule (Always / Never from them) comes first. `trackers`: open
 * pixels are removed, or kept as pictures that report the open (they load only when all pictures do).
 */
export interface MailSettings {
  markRead: 'view' | 'manual';
  pictures: 'none' | 'shared' | 'all';
  trackers: 'remove' | 'keep';
}

// ------------------------------------------------------------------ search (slice 7)

/** One thread a mail search found. */
export interface MailSearchHit {
  thread: MailThreadView;
  /** Its newest message that matched, and when that came. */
  messageId: string;
  at: number;
  /** Matched text with \u0001 and \u0002 around each match, or the start of the message; null when only its subject or people matched. */
  snippet: string | null;
  /** How many of its messages matched here (1 for a server hit). */
  matches: number;
  /** Only a server found it: the hub did not hold it, or did not hold the text that matched. */
  server?: boolean;
}

/** How one account's server search went. */
export interface MailServerSearch {
  accountId: string;
  /**
   * `skipped`: nothing a server can search for (only filters), or the account cannot be asked now. `local`: not asked
   * (server=auto), because the hub holds all of this account's mail and searched it here ("Keeping all mail").
   */
  state: 'done' | 'failed' | 'offline' | 'skipped' | 'local';
  /** Messages it answered with. */
  found: number;
  error: string | null;
  /** What this server cannot search, e.g. Proton: subjects and addresses only. */
  note: string | null;
}

/** GET /api/mail/search?q=&cursor=&limit=&server=0|1|auto: the hub's own hits, newest first, then the servers'. */
export interface MailSearchPage {
  hits: MailSearchHit[];
  next: string | null;
  /** How the words matched: whole words, inside words (nothing matched as whole words), or no words, only filters. */
  mode: 'fulltext' | 'substring' | 'filters';
  /** Nothing matched as typed: these hits are for this query (misspelt words corrected). */
  corrected?: string;
  /** Asked of the servers (server=1, or server=auto and a first page under 20 hits): threads the hub's own search did not find, newest first. */
  server?: { hits: MailSearchHit[]; accounts: MailServerSearch[] };
}

// ------------------------------------------------------------------ keeping all mail (docs/mail.md "Keeping all mail")

/** Why an account's background reads stopped: what its status said (`details.backgroundStopped`), or a call's 503 `paused`. */
export type MailKeepStop = 'challenge' | 'signedOut' | 'quota' | 'paused' | (string & {});

/** One mailbox of a kept account: what its server counts in it, what the hub holds there, and whether it is listed to its end. */
export interface MailKeepBox {
  id: string;
  name: string;
  role: MailboxRole | null;
  /** The server's count (mail.mailboxes), null when it gives none. */
  total: number | null;
  held: number;
  complete: boolean;
}

/**
 * GET /api/mail/keep: each mail account's copy here measured against its server. Settings → Indexing's Mail section.
 * A kept account's walk lists every mailbox to its end, its bodies are all fetched and never evicted, and its search
 * text is whole (up to 1 MB a message).
 */
export interface MailKeepView {
  accountId: string;
  /** Keep all of its mail (on unless turned off for the account). */
  keep: boolean;
  /** Paused here (Pause/Resume). */
  paused: boolean;
  /**
   * `running`: walking or fetching bodies; `idle`: nothing left to do now; `paused`; `disk`: the disk guard stopped body
   * fetching; `stopped`: the account stopped background reads (`stopped` says why); `waiting`: a Google account whose
   * status has not said it has a background lane keeps only what any account keeps (a year and all of Inbox) until it
   * does; `offline`: the account or the manager cannot be reached; `off`: not kept.
   */
  state: 'running' | 'idle' | 'paused' | 'disk' | 'stopped' | 'waiting' | 'offline' | 'off';
  stopped: MailKeepStop | null;
  /** The account's status says it has a background lane: the archive's reads go in it (`background: true`). */
  backgroundLane: boolean;
  /** Messages held here, and the server's count of them: All mail (else Archive) with Trash and Junk, else every mailbox. */
  messages: { held: number; total: number | null };
  /** Held messages whose body text is here (whole, for a kept account). */
  bodies: number;
  /** Bytes used here for this account: bodies and search text, as stored (an estimate: indexes come on top). */
  bytes: { bodies: number; text: number };
  /** The walk: complete once every mailbox it lists is; else how far back the mailbox it is on has come. */
  walk: { complete: boolean; mailbox: string | null; back: number | null; done: number; mailboxes: number };
  boxes: MailKeepBox[];
  /**
   * Gmail only (its search takes dates): month windows searched on the server and compared with what is held.
   * `estimate`: the server's own count of the account's mail, when its ids-only search gives one.
   */
  audit: { windows: number; matched: number; missed: number; checked: number; caught: number; estimate: number | null } | null;
  /** The last 30 days of server searches (GET /api/mail/search with the servers): their hits, held here before, with body text here, found by the hub's own search. */
  measure: { searches: number; found: number; held: number; bodies: number; local: number };
  /** Searched locally: server=auto asks this account's server no more. `missing`: what still stands in the way. */
  local: { on: boolean; missing: string[] };
  /** What the account's server says it uses (`details.storage`, `storageUsed`, `storageTotal`), when it says. */
  storage: { text: string | null; used: number | null; total: number | null } | null;
}

export interface MailKeepPage {
  accounts: MailKeepView[];
  /** The disk guard: bytes free where the hub keeps its data, and the floor under which body fetching stops. */
  disk: { free: number | null; floor: number };
}

/** PUT /api/mail/keep/:accountId: keep all of it or not, pause or resume. */
export interface MailKeepChange {
  keep?: boolean;
  paused?: boolean;
}

/** A search as a list key, so Mail's route shows it in place of a list: `s:<query>`. */
export const searchList = (q: string): MailListKey => `s:${q}`;
export const searchOfList = (key: string): string | null => (key.startsWith('s:') ? key.slice(2) : null);

// ------------------------------------------------------------------ lists

/**
 * The views a list key can name. `people` and `updates` come with classification (slice 8). `inbox` is Inbox without
 * Updates (the page ranks it: docs/mail.md "Ranked"); `all` is the whole of Inbox, Updates too, newest first.
 * `people` and `unread` have no chip any more, but their keys still list.
 */
export type MailView = 'inbox' | 'all' | 'unread' | 'starred' | 'sent' | 'people' | 'updates';

/**
 * A list of threads: `mb:<mailbox id>`, or `v:<view>:<account id or *>`. The page keeps lists by these keys, and
 * `mail.lists` names them when they are stale (slice 2).
 */
export type MailListKey = string;

export const mailboxList = (mailboxId: string): MailListKey => `mb:${mailboxId}`;
/** A view of every account (`*`), one account (its id), or one platform's accounts (`k.<platform>`, platformScope). */
export const viewList = (view: MailView, scope: string | null = null): MailListKey => `v:${view}:${scope ?? '*'}`;

/**
 * Which service a mail account is on, for the account switcher's first wheel: Gmail (on the web, or IMAP at a Gmail
 * address), Proton, Outlook, else plain email. Hub and page agree on it, so a platform's list pages the same accounts.
 */
export function mailPlatform(a: { kind: string; address: string | null }): string {
  if (a.kind === 'google') return 'gmail';
  if (a.kind === 'proton') return 'proton';
  const domain = a.address?.split('@')[1]?.toLowerCase() ?? '';
  if (/^(gmail|googlemail)\./.test(domain)) return 'gmail';
  if (/^(outlook|hotmail|live|msn)\./.test(domain)) return 'outlook';
  return 'email';
}
export const MAIL_PLATFORM_NAMES: Record<string, string> = { gmail: 'Gmail', proton: 'Proton', outlook: 'Outlook', email: 'Email' };
export const platformScope = (platform: string) => `k.${platform}`;

/**
 * Every thread with someone, in any mailbox of any account (slice 6): `w:<person id>`, `w:<identity id>` or
 * `w:<address>`. A person's list follows merges: it is all the addresses of the person as it is now.
 */
export const withList = (who: string): MailListKey => `w:${who}`;

/** Who a `withList` key is with; null for any other key. */
export function parseWithList(key: string): string | null {
  const m = key.match(/^w:(\S+)$/);
  return m ? m[1] : null;
}

export function parseMailList(key: string): { mailbox: string } | { view: MailView; accountId: string | null; platform: string | null } | null {
  const m = key.match(/^mb:([\w-]+)$/);
  if (m) return { mailbox: m[1] };
  const v = key.match(/^v:(inbox|all|unread|starred|sent|people|updates):(k\.[a-z]+|[\w-]+|\*)$/);
  if (!v) return null;
  const platform = v[2].startsWith('k.') ? v[2].slice(2) : null;
  return { view: v[1] as MailView, accountId: v[2] === '*' || platform ? null : v[2], platform };
}

// ------------------------------------------------------------------ text

const ATTRIBUTION = [
  /^On\b.{4,200}\bwrote:\s*$/i,
  /^Am\b.{4,200}\bschrieb\b.{0,40}:\s*$/i,
  /^Le\b.{4,200}\ba écrit\s*:\s*$/i,
  /^El\b.{4,200}\bescribió:\s*$/i,
  /^.{2,120} <[^<>\s]+@[^<>\s]+> (?:wrote|schrieb|a écrit|escribió):\s*$/i,
];
const FORWARD_HEAD = /^\s*(-{2,}\s*(Original Message|Forwarded message|Ursprüngliche Nachricht|Message d'origine)\s*-{2,}|_{20,})\s*$/i;

/**
 * Where the quoted part of a plain-text mail starts: the last block of `>` lines that runs to the end (with the
 * "On … wrote:" line before it, even when a client wrapped it over two lines), or an Outlook-style "Original Message"
 * header and everything after it. Null when there is none, or nothing would be left above it to show.
 */
export function quoteStart(text: string): number | null {
  const lines = text.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  let cut: number | null = null;
  // A forwarded or Outlook-quoted original: from its header line on.
  for (let i = 0; i < lines.length; i++) {
    if (FORWARD_HEAD.test(lines[i]) && lines.slice(i + 1, i + 4).some((l) => /^\s*(From|Von|De):/i.test(l))) {
      cut = i;
      break;
    }
  }
  // The trailing `>` block: blank lines may sit between quoted ones, and after it.
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  let first = -1;
  for (let i = end; i >= 0; i--) {
    const l = lines[i];
    if (/^\s*>/.test(l)) first = i;
    else if (!l.trim() && first >= 0) continue;
    else break;
  }
  if (first >= 0) {
    let i = first;
    while (i > 0 && !lines[i - 1].trim()) i--;
    const one = lines[i - 1] ?? '';
    const two = `${lines[i - 2] ?? ''} ${one}`.trim();
    if (ATTRIBUTION.some((r) => r.test(one))) i -= 1;
    else if (i >= 2 && ATTRIBUTION.some((r) => r.test(two))) i -= 2;
    cut = cut === null ? i : Math.min(cut, i);
  }
  if (cut === null) return null;
  // Something must be left to show above it.
  if (!lines.slice(0, cut).some((l) => l.trim())) return null;
  return starts[cut];
}

/** A list row's line from a body: 200 characters, without the quoted part or the signature. */
export function mailPreview(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  const q = quoteStart(text);
  let t = q === null ? text : text.slice(0, q);
  const sig = t.search(/^-- ?$/m);
  if (sig > 0) t = t.slice(0, sig);
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** A plain address check: something@something.tld, nothing that would split a header. */
export const MAIL_ADDRESS = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/;
export const validMailAddress = (e: string) => MAIL_ADDRESS.test(e.trim());

/** `Sam Lee <sam@lee.example>`, `"Lee, Sam" <sam@lee.example>` or `sam@lee.example`; null when it is not an address. */
export function parseMailAddress(raw: string): { name: string | null; email: string } | null {
  const s = raw.trim();
  const m = s.match(/^(.*?)\s*<([^<>\s]+)>$/);
  const email = (m ? m[2] : s).trim();
  if (!validMailAddress(email)) return null;
  const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1').trim() : '';
  return { name: name || null, email };
}

/** `Name <a@b>` or the address alone. */
export function mailAddressText(a: { name: string | null; email: string }): string {
  return a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email;
}

// ------------------------------------------------------------------ links

/** Top-level domains a bare name in a link's text is read as a site by ("paypal.com"); others need http or www. */
const COMMON_TLDS = new Set('com org net edu gov mil int io co ai app dev me info biz xyz online site shop store zip mov top link click'.split(' '));

/** The host a link's text names, when its text is a web address or a bare domain ("paypal.com/login"). */
export function shownHost(text: string): string | null {
  const t = text.trim().replace(/[\s\u200b-\u200d]+/g, '');
  if (!t || t.length > 300) return null;
  const m = t.match(/^(https?:\/\/)?((?:[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]*[a-z0-9\u00a1-\uffff])?\.)+([a-z\u00a1-\uffff]{2,63}))\.?(?::\d+)?(?:[/?#]\S*)?$/i);
  if (!m) return null;
  const tld = m[3].toLowerCase();
  if (!m[1] && !/^www\./i.test(m[2]) && !(tld.length === 2 || COMMON_TLDS.has(tld))) return null;
  try {
    return new URL(`https://${m[2]}`).hostname;
  } catch {
    return null;
  }
}
const bareHost = (h: string) => h.replace(/^www\./, '').replace(/\.$/, '');
/** The text names another site than the link goes to (subdomains of the named site are the same site). */
export function hostsDiffer(shown: string, goes: string): boolean {
  const a = bareHost(shown);
  const b = bareHost(goes);
  return a !== b && !b.endsWith('.' + a);
}

// ------------------------------------------------------------------ mail as chats (docs/mail.md "Mail as chats")

/**
 * How much of something a view shows, coarsest to finest (docs/mail.md "Mail as chats"): left out, counted, a link to
 * where it is, one line, a few lines, all of it, and a notification. One ladder for every view, so a person's chat, a
 * group and the feed can use the same words; which rung a thing gets is the view's default (the hub's `defaultRung`)
 * unless you chose one for that place (`PlaceRungView`).
 */
export type Rung = 'hidden' | 'counted' | 'link' | 'line' | 'excerpt' | 'full' | 'notify';
export const RUNGS: readonly Rung[] = ['hidden', 'counted', 'link', 'line', 'excerpt', 'full', 'notify'];

/**
 * A mail message drawn as a chat message (`MessageView.mail`): what a chat message has no field for. The message's id
 * is the mail's own (`mml_`), and `conversationId` is the chat place it is shown in: `email:<account>:<address>` in a
 * person's chat, else its thread (`mth_`).
 */
export interface MessageMailView {
  threadId: string;
  accountId: string;
  subject: string;
  /** The place the thread belongs to: `person:<id>` while it is you and one other person, else the thread `mth_…`. */
  place: string;
  /** The Message-ID header. */
  messageId: string | null;
  from: MailAddressView;
  to: MailAddressView[];
  cc: MailAddressView[];
  /** When the sender says they wrote it. `MessageView.ts` is when it reached the server (`receivedAt`), as mail sorts. */
  date: number;
  receivedAt: number;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  /** The body here: `MessageView.body` holds its text (the words above the quote) when it is 'cached', else the preview. */
  bodyState: 'cached' | 'none' | 'loading' | 'failed';
  /** It has HTML that plain text would lose (styles, pictures, tables): the chat shows it framed. */
  rich: boolean;
  /** The text under the words: the quoted mail it answers, folded in the chat. */
  quoted: boolean;
  /** The first message of its thread here: the chat shows the subject on it. */
  opens: boolean;
}

/**
 * A route of a person's chat by email (`ChatRoute.network` 'email'): you and one address of theirs, through one of
 * your mail accounts. Its id, `email:<account>:<address>`, is the `conversationId` of its route and of its messages.
 */
export interface MailChatView {
  id: string;
  personId: string;
  /** Their email identity. */
  identityId: string;
  accountId: string;
  address: string;
  /** The threads between you and only them, newest first: the latest is where a message goes unless you start one. */
  threadIds: string[];
  /** The latest thread's subject. */
  subject: string;
  lastAt: number;
  /** The newest message's start, and whether it was yours. */
  preview: string | null;
  lastFromMe: boolean;
  /** Messages in its threads not read yet. */
  unread: number;
}

/**
 * Something a person wrote somewhere else, shown in their chat at a rung below 'full' (docs/mail.md "Mail as chats",
 * "What they wrote elsewhere"): a message of theirs in a thread with others. The page groups these into one row of
 * links between two of the chat's own messages. `excerpt` is there only when the rung is 'excerpt'.
 */
export interface ElsewhereView {
  /** Where it is: a thread `mth_…`. */
  place: string;
  placeKind: 'mail-thread';
  /** The place's name: the thread's subject. */
  title: string;
  /** The others there besides you and them, by name. */
  others: string[];
  messageId: string;
  ts: number;
  unread: boolean;
  rung: Rung;
  /** Why it is shown as it is: 'awaits' (to you, from them, under a week, not answered or opened since) or 'elsewhere'. */
  why: 'awaits' | 'elsewhere' | 'chosen';
  excerpt?: string;
  /** The start of its words on one line (about 140 characters), always: what "Read here" opens in place. */
  line: string;
  /** It was to you (To, or naming you), not only to the others. */
  toYou: boolean;
}

/** A page of a chat that has mail in it: the messages, mail among them, and what they wrote elsewhere in its range. */
export interface MailChatPage {
  elsewhere?: ElsewhereView[];
}

/** A rung you chose for a place in a view (PUT /api/rungs): `view` is a chat id (`person:<id>`), `place` the place's id. */
export interface PlaceRungView {
  view: string;
  place: string;
  rung: Rung;
  setAt: number;
}
