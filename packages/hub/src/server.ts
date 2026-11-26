import type { Server, ServerWebSocket, Socket, WebSocketHandler } from 'bun';
import { createHmac } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { codeBuild } from './restarts.ts';
import { pathToFileURL } from 'node:url';
import type * as P from '@dither-chat/protocol';
import type { DownloadAs } from '@dither-chat/protocol';
import { chatIdOf, chatRef, chatRoutes, chatView, chooseRoute, defaultRoute, isEmailRoute, parseCursor } from './chats.ts';
import { ATTACHMENT_LIMITS, CALENDAR_URL_DEFAULT, LIVE_RESUME, calendarAccountUrl, CLICK_BODY_MAX, directTarget, discordEmojiUrl, downloadsAs, IMPORT_CHUNK, KEPT_KINDS, MAX_UPLOAD, NETWORK_META, NETWORKS, postIdOf, PICTURE_MAX as P_PICTURE_MAX, PICTURE_TYPES as P_PICTURE_TYPES, RETENTION_GUARDED, RULE_LEVELS, RUNGS, sendBlocker, UPLOAD_CHUNK, WATCH_EVERY } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { ACCOUNT_COLORS, loudViewOf, type Store } from './store.ts';
import type { AdapterSocketData, Supervisor } from './supervisor.ts';
import type { PushService } from './push.ts';
import type { ReadQueue } from './readqueue.ts';
import { setNativeMute } from './nativemute.ts';
import { markUnreadFrom } from './unread.ts';
import { validQuietHours, type Triage } from './triage.ts';
import type { TriageVotes } from './votes.ts';
import type { LoudLearner } from './loudlearn.ts';
import { selfIds, type Scorecard } from './scorecard.ts';
import { attentionReport } from './attnreport.ts';
import { cleanFileName, Uploads } from './uploads.ts';
import { ImportRunner } from './imports/engine.ts';
import { GapFill } from './imports/gapfill.ts';
import { Jobs } from './jobs.ts';
import { type PaceConfig, READING, ReadingPace } from './readingpace.ts';
import { realClock } from './clock.ts';
import { NetSearch } from './netsearch.ts';
import { linkPath, MediaArchiver } from './mediaarchive.ts';
import { infoFor, MediaInfo, mediaKey } from './mediainfo.ts';
import { genericType } from './fileinfo.ts';
import { downloadDisposition, mediaHeaders, SAFE_HEADERS, sniffMime } from './mediaheaders.ts';
import { findJxl, JxlServe, MediaPacker, PACKED_TYPES, takesJxl, type JxlTools } from './jxl.ts';
import { JXL } from './jxlformat.ts';
import { ImportSources } from './imports/sources.ts';
import { Calls, type CallSocketData, type TurnConfig, type VoiceSocketData } from './calls.ts';
import { type CallRoomSocketData, demoCallRoom } from './democalls.ts';
import { clampDays, parseZone } from './activitychart.ts';
import { compress, PackedFiles, pickEncoding } from './compress.ts';
import { forwardMessage } from './forward.ts';
import { firstLink, unfurl } from './unfurl.ts';
import { UsageStore } from './usage.ts';
import { ClickCounts } from './clicks.ts';
import type { Attention } from './attention.ts';
import type { ActivityStore } from './activity.ts';
import type { ForYou } from './foryou.ts';
import { Devices } from './devices.ts';
import { changesOf } from './journal.ts';
import { syncResponse } from './sync.ts';
import { TypingGate } from './typing.ts';
import { hostAllowed, hostNames } from './hosts.ts';
import { noteWork, pathShape, timedWrite } from './stalls.ts';
import { parseTraceparent, span, startSpan } from './trace.ts';
import { fetchPublicToFile } from './fetchsafe.ts';
import { AboutError, Abouts } from './about.ts';
import { Servers } from './servers.ts';
import { Apps } from './apps.ts';
import { Media, MediaError, sendMediaProblem } from './media.ts';
import { Threads } from './threads.ts';
import { Moderation } from './moderation.ts';
import { asked, attempt, candidatesAttempt } from './attempts.ts';
import { Groups } from './groups.ts';
import { People } from './people.ts';
import { AccountSelf, ignoredOf } from './accountself.ts';
import { mentionables } from './mentions.ts';
import { lowerForSend } from './mentionrefs.ts';
import { graphTuning, peopleGraph, setGraphTuning } from './graph.ts';
import { activityView, Closeness, closeTo } from './closeness.ts';
import { personVoice } from './voicetime.ts';
import { ProfileCollector, SameMatches } from './samepeople.ts';
import type { MailHub } from './mail/index.ts';
import type { Notices } from './notices/index.ts';
import type { Approvals } from './approvals.ts';
import { mailPeople } from './mail/people.ts';
import { mailPlaces } from './mail/places.ts';
import { personPage } from './mail/chatpage.ts';
import { isRung, setPlaceRung } from './rungs.ts';
import { Adding, profileLinksOf, requestHeld, requestViews } from './add.ts';
import { feedRefusalFor, isFeed } from './feed.ts';
import { Posts, PostsError } from './posts.ts';
import { Follows, type FollowConfig } from './follows.ts';
import { Events } from './events.ts';
import { eventsOf } from './eventseen.ts';
import { Timelines } from './timelines.ts';
import { TranslateError, Translator } from './translate.ts';
import { calendarOff, type CalendarLink } from './calendar.ts';
import { markCalendarAdded } from './calendar-account.ts';
import { ReplyMarks, type ReplyMark } from './replymarks.ts';
import { mailAttention } from './mail/attention.ts';
import { AnswerClock, clientReport, jobFailed, lossCovered, PerClientCap, reportedInRequest, reportError, withRequest } from './errors.ts';
import { callRoute } from './callstate.ts';
import { PHONE } from './delivery.ts';
import { handlesPolls, pollRoute } from './polls.ts';
import { SendExtras } from './sendextras.ts';
import { reminderWords } from './saved.ts';
import { ASK_LEVEL, isChatKind, type ManagerLink } from './accounts-manager.ts';
import { SearchCalledOff, SearchThread, type SearchAsk } from './search-thread.ts';
import { Auth, bearerOf, clientIp, COOKIE, cookieOf, fileTicket, fromOwnPage, MIN_PASSWORD, overHttps, sessionCookie, ticketGood, USER, type Who } from './auth.ts';


/** A page's socket, and what it says it is watching (`P.ClientWatching`), with when it said so. */
/** `resume`: the position it asked to be caught up from, as its first frame (docs/sync.md "On the socket"). */
type ClientData = { kind: 'client'; watching?: { label: string; conversationIds: string[]; at: number }; resume?: P.SyncPosition };
/** A catch-up on the socket longer than this goes gzip'd, as the same answer by POST would go compressed. */
const RESUME_GZIP_OVER = 2048;

/** The position a live socket asks to be caught up from, when it offers LIVE_RESUME (docs/sync.md "On the socket"). */
function liveResume(url: URL, protocols: string | null): P.SyncPosition | undefined {
  if (!protocols?.split(',').some((p) => p.trim() === LIVE_RESUME)) return undefined;
  const q = url.searchParams;
  const v = Number(q.get('v'));
  const seq = Number(q.get('since'));
  const epoch = q.get('epoch');
  if (!epoch || !Number.isSafeInteger(v) || !Number.isSafeInteger(seq) || seq < 0) return undefined;
  return { v, epoch, seq };
}
/** What a send carries (POST /api/conversations/:id/send, and a chat's /messages). */
type SendBody = {
  body?: string;
  accountId?: string;
  replyTo?: string;
  attachments?: string[];
  clientId?: string;
  /** A sticker from the picker's page, by its id (media.ts). */
  sticker?: string;
  /** The one attached file is a recording: sent as the network's voice message where it has one, else as a file. */
  voice?: P.VoiceOut;
  /** The files open once (Signal's view-once). */
  viewOnce?: boolean;
  /**
   * The one attached file is a GIF from the GIF picker: sent as the network's own GIF where it has one (capability
   * 'sendGifs'), else as a file.
   */
  gif?: boolean;
  /** capability 'silentSend' (sending.ts) */
  silent?: boolean;
  /** capability 'replyMention' */
  mentionReplied?: boolean;
};
/** A browser's live view, carried to the account's VNC socket here, or (remote accounts) to dither-accounts' socket for it. */
type LiveViewData = { kind: 'liveview'; accountId: string; socket?: string; url?: string; vnc?: Socket<unknown>; up?: WebSocket; queue: Uint8Array[]; closed?: boolean };

/**
 * Whether a local adapter's live view is one to connect to: a Unix socket owned by this user (its sandbox's x11vnc,
 * which listens on no TCP port). Anything else (gone, a file, someone else's socket) is not.
 */
function ownSocket(path: string): boolean {
  try {
    const st = lstatSync(path);
    const uid = process.getuid?.();
    return st.isSocket() && (uid === undefined || st.uid === uid);
  } catch {
    return false;
  }
}
type WsData = ClientData | LiveViewData | AdapterSocketData | CallSocketData | VoiceSocketData | CallRoomSocketData;

interface ServerOpts {
  port: number;
  /**
   * No login: every route answers without a session (auth.ts, docs/login.md). For a demo world (main.ts --demo) and
   * tests only; a hub with real accounts never runs open.
   */
  open?: boolean;
  hostname: string;
  dataDir: string;
  webDist: string;
  secret: string;
  /** PEM paths. When set, the main port speaks HTTPS and plainPort handles what cannot use it. */
  tls?: { cert: string; key: string; ca?: string };
  plainPort?: number;
  push?: PushService;
  readQueue?: ReadQueue;
  /** Rescore categories after they change. */
  onCategoriesChanged?: (force?: boolean) => void;
  /** Every place's P(yes) for one question, not saved (categorize.ts probe). */
  probeCategory?: (question: string) => Promise<P.CategoryProbe>;
  onDemoReset?: () => Promise<void>;
  /** TURN relay for direct-mode calls, so their media leaves from this machine. */
  turn?: TurnConfig;
  /** The inbox's ranking (attention.ts, docs/inbox.md). */
  attention?: Attention;
  /** The activity log (activity.ts, docs/activity.md). */
  activity?: ActivityStore;
  /** For you (foryou.ts, docs/foryou.md): its pages, the "N new" count and what devices say of its items. */
  foryou?: ForYou;
  /** Per-device notification rules (devices.ts, docs/devices.md). */
  devices?: Devices;
  /** Your votes on triage and the rules learned from them (votes.ts, docs/notifications.md). */
  votes?: TriageVotes;
  /** The loudness scale's answers, check-ins and settings (loudlearn.ts). */
  loud?: LoudLearner;
  /** How the models did, day by day (scorecard.ts, docs/scorecard.md): GET /api/model/scores. */
  scorecard?: Scorecard;
  /** Fetch every remote attachment into the media cache soon after it arrives (mediaarchive.ts). A real hub, not a demo. */
  archiveMedia?: boolean;
  /**
   * cjxl and djxl (jxl.ts, docs/files.md "JPEG XL"): to show a JPEG XL to a device that doesn't, and send one to a
   * network as a JPEG or PNG. Asked once, when first needed. Absent: looked for on PATH and in DITHER_JXL_DIR.
   */
  jxl?: () => Promise<JxlTools | null>;
  /** Store kept JPEGs and PNGs as JPEG XL (jxl.ts MediaPacker). A real hub, not a demo. */
  packMedia?: boolean;
  /** How index jobs and the gap fill read (readingpace.ts): a person's pace unless told otherwise. */
  pace?: PaceConfig;
  /** Mail (mail/index.ts, docs/mail.md): its routes, its part of the bootstrap and of each flush. */
  mail?: MailHub;
  /** Notices (notices/, docs/notices.md): /api/notices, the bootstrap's `notices`. */
  notices?: Notices;
  /** Approvals (approvals.ts, docs/approvals.md): /api/approvals, which askers reach with their own tokens. */
  approvals?: Approvals;
  /** dither-accounts for the accounts page (accounts-manager.ts): its kinds, asking, adding mail accounts, those without a chat account. */
  manager?: ManagerLink;
  /**
   * dither-calendar beside the hub (calendar-account.ts, docs/calendar.md): the link of the calendar account that is on,
   * if any (/calendar/*, GET /api/plans, the bootstrap's `calendar`), and `sync` after the accounts change.
   */
  calendar?: { link(): CalendarLink | undefined; sync(): void };
  /** A reminder set on a network came due (saved.ts): main.ts notifies it like an alert. */
  onSavedReminder?: (n: { title: string; body: string; conversationId: string; messageId: string }) => void;
  /** Same person? (samepeople.ts): the database file for its worker (none: worked out on this thread), and jev's address. */
  matches?: { file: string | null; jevUrl: string | null };
  /** The database file: /api/search runs on a thread of its own with a read-only connection to it (search-thread.ts). None: on this thread. */
  searchFile?: string | null;
  /** New live messages the hub made itself (a followed post's replies, follows.ts): triage decides them (main.ts). */
  onFresh?: (messageIds: string[]) => void;
  /** How often a followed post is read again (follows.ts FOLLOW unless told otherwise). */
  follow?: FollowConfig;
}

// ------------------------------------------------------------------ access

/** A category's threshold from a request: a probability, or null for the provider's default. */
const threshold = (t: unknown): number | null => (typeof t === 'number' && t > 0 && t <= 1 ? t : null);
/** A person has no nickname of their own since 2026-11-11: each account of theirs has (docs/chats.md, Names). */
const NICKNAME_MOVED = 'A nickname belongs to one account of theirs now, not to the person: PATCH /api/identities/:id with { nickname }';
const v4 = (ip: string) => ip.replace(/^::ffff:/, '');
function isLoopback(ip: string) {
  return ip === '::1' || v4(ip).startsWith('127.');
}
export function isTailnet(ip: string) {
  const a = v4(ip);
  const m = a.match(/^(\d+)\.(\d+)\./);
  if (m && +m[1] === 100 && +m[2] >= 64 && +m[2] <= 127) return true; // 100.64.0.0/10
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/**
 * A write or a socket from this hub's own page: its Origin (or, without one, its Referer) names the host it was sent
 * to (auth.ts fromOwnPage). One with neither is refused: a program without a browser sends the service token instead,
 * and those requests are not asked this (docs/login.md "Cross-site requests").
 */
export function sameOrigin(req: Request): boolean {
  return fromOwnPage(req);
}

/**
 * The same on an open hub (a demo world, a test: `open`): programs there send no Origin, and the vite dev server
 * proxies from localhost. Never on a hub behind the login.
 */
function sameOriginOpen(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.host === req.headers.get('host') || o.hostname === 'localhost' || o.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Paths that answer only behind the login. Everything else a request without a session gets is the web app's own
 * files (static(): files of the build, else its index.html), whatever the path: a route added outside these still
 * never answers without a session, because the router is never reached without one.
 */
export const GATED = /^\/(api|media|emoji|voice|calendar|demo|adapter)(\/|$)/;
/**
 * Discord's DAVE library, as scripts/dave/update.ts extracted it from the public web client (docs/calls.md): public code,
 * named by its hash. Direct mode loads it in a worker with an opaque origin, which sends no cookie, so it answers
 * without a session.
 */
const DAVE_FILE = /^\/voice\/dave\/([0-9a-f]{16})\/(libdave\.mjs|libdave\.wasm)$/;
/** The only gated paths open without a session: the login itself and a bare health check. */
export const PUBLIC_API = new Set(['/api/health', '/api/login', '/api/logout']);

/** A name this hub does not have (hosts.ts). DITHER_ALLOWED_HOSTS adds one. */
const unknownHost = () => new Response('unknown host: add it to DITHER_ALLOWED_HOSTS (docs/deploy.md)', { status: 421 });

/** Adapter kinds: a package name under packages/ or extractors/, never a path. */
export const validAdapterName = (a: unknown): a is string => typeof a === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(a);

// ------------------------------------------------------------------ media

export { mediaSigner } from './mediasign.ts';

/**
 * A request answered with 5xx, as a line of traces/errors.ndjson: the route's template, the status, and the answer's
 * `error` (what the handler caught, an Error's message) when it is JSON. 503 (an account offline, the manager not
 * reachable: a state the page shows) is left out. 504 is kept: one timeout is explained to you, but the same route
 * timing out again and again is a bug, and the watcher's spike rule and ignore list tell the two apart.
 */
async function reportAnswer(req: Request, route: string, res: Response, trace: string | undefined) {
  if (res.status === 503) return;
  let message = `status ${res.status}`;
  try {
    if (res.headers.get('content-type')?.includes('json')) {
      const e = ((await res.clone().json()) as { error?: unknown })?.error;
      if (typeof e === 'string' && e) message = e;
    }
  } catch {}
  reportError({ source: 'request', where: `${req.method} ${route}`, name: 'HttpError', message, status: res.status, trace });
}

/** An error after the command went to the adapter: whether it was carried out is not known. */
const unknownOutcome = (e: unknown) => /timed out|disconnected mid/i.test(String((e as Error)?.message ?? e));

/**
 * Which account sends into a conversation: the requested one, else the last one you used there, else any connected.
 * With one connected account to choose from (nearly every conversation) the messages are not read: finding the last
 * one you wrote reads every message of a conversation you never wrote in, a second or more for one of 100k on the
 * live hub, and this is asked on every open (reactions, history) and every push (docs/perf.md).
 */
export function pickAccount(store: Store, online: (accountId: string) => boolean, conversationId: string, requested?: string): string | null {
  const vs = store.vantageAccounts('conversation', conversationId);
  if (requested && vs.includes(requested)) return requested;
  const live = vs.filter(online);
  if (live.length <= 1) return live[0] ?? vs[0] ?? null;
  const last = store.one<{ account_id: string }>(
    `SELECT s.account_id FROM message m JOIN message_seen s ON s.message_id = m.id JOIN account a ON a.id = s.account_id
     WHERE m.conversation_id = ? AND m.author_id = a.self_identity ORDER BY m.ts DESC LIMIT 1`,
    conversationId,
  );
  return last && live.includes(last.account_id) ? last.account_id : live[0];
}

export class HubServer {
  server!: Server<WsData>;
  /** The plain HTTP listener beside TLS (plainPort), for adapters and the CA download; its port is the one it got when plainPort is 0. */
  plain?: Server<WsData>;
  /** Listeners on the other addresses of a comma-separated `hostname` (DITHER_HOST), e.g. loopback and the tailnet IP. */
  private extra: Server<WsData>[] = [];
  /** The names a request's Host may carry (hosts.ts): DNS rebinding gets nowhere. */
  private names = hostNames();
  private clients = new Set<ServerWebSocket<ClientData>>();
  private flushTimer?: Timer;
  private pruneTimer?: Timer;
  private uploads: Uploads;
  /** Raw history sources waiting to be imported (imports/sources.ts, docs/import.md). */
  readonly imports: ImportSources;
  readonly importer: ImportRunner;
  readonly gapfill: GapFill;
  /** Index jobs: servers, folders and conversations fetched whole (jobs.ts, docs/indexing.md). */
  readonly jobs: Jobs;
  /** The networks' own search (netsearch.ts). */
  readonly netsearch: NetSearch;
  private archiver?: MediaArchiver;
  /** What each kept file is (mediainfo.ts, docs/files.md). */
  readonly mediaInfo: MediaInfo;
  /** cjxl and djxl, asked for once (jxl.ts). */
  private readonly jxlTools: () => Promise<JxlTools | null>;
  /** Pictures rebuilt for devices that don't show JPEG XL (jxl.ts). */
  private readonly jxlServe: JxlServe;
  /** Kept pictures stored as JPEG XL (jxl.ts). */
  readonly packer?: MediaPacker;
  private typingGate = new TypingGate();
  private usage: UsageStore;
  /** Button counts (clicks.ts). */
  private clicks: ClickCounts;
  readonly calls: Calls;
  readonly abouts: Abouts;
  readonly groups: Groups;
  readonly people: People;
  /** Same person? suggestions, and profiles collected in the background (samepeople.ts, docs/same-person.md). */
  readonly matches: SameMatches;
  /** How much you have had to do with each person, by month, for the people graph (closeness.ts). */
  readonly closeness: Closeness;
  /** Message search on its own thread, when the hub was given its database file (search-thread.ts). */
  readonly searchThread: SearchThread | null;
  readonly collector: ProfileCollector;
  /** Public posts read and logged as messages (posts.ts, docs/feed.md "Threads"). */
  readonly posts: Posts;
  /** Posts you follow, read again for new replies (follows.ts, docs/feed.md "Following a post"). */
  readonly follows: Follows;
  readonly timelines: Timelines;
  /** Events from Luma and Partiful: an event's page and RSVPs (events.ts, docs/events.md). */
  readonly events: Events;
  /** Translating posts and messages: the network's own, or a translation server (translate.ts). */
  readonly translator: Translator;
  /** The account's own self, block, ignore and notes (accountself.ts). */
  readonly self: AccountSelf;
  /** Joining, adding people, and requests waiting on you (add.ts, docs/add.md). */
  readonly adding: Adding;
  /** Scheduled events, leaving, and what a space asks on joining (servers.ts, docs/servers.md). */
  readonly servers: Servers;
  /** Bots' buttons, selects, slash commands and forms (apps.ts, docs/apps.md). */
  readonly apps: Apps;
  /** Sticker pages, installing packs, stories (media.ts, docs/media-kinds.md). */
  readonly kinds: Media;
  /** Following threads, starting threads and posts, archiving, publishing, running a group (threads.ts, docs/threads.md). */
  readonly threads: Threads;
  /** Removing, banning, roles and timeouts, others' messages and reactions, member labels (moderation.ts, docs/moderation.md). */
  readonly moderation: Moderation;
  /** Send later, saved on the network, previews off (sendextras.ts, docs/sending.md). */
  readonly sendExtras: SendExtras;
  /** Your marks on whether a message needs a reply (replymarks.ts). */
  private get marks(): ReplyMarks {
    return (this._marks ??= new ReplyMarks(this.store));
  }
  private _marks: ReplyMarks | null = null;
  /** The login: password, sessions, the service token (auth.ts, docs/login.md). */
  readonly auth: Auth;
  /** This process. A client that sees it change knows the hub restarted, and may have a new web build. */
  readonly boot = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('base64url');
  /** The hub's code (its git commit), read once: a page back after a restart says "updated" when it changed (restarts.ts). */
  readonly build = codeBuild(resolve(import.meta.dir, '../../..'));
  /** Sends by the client's id for them, so one retried after a lost answer goes out once (state.ts queues sends). */
  private sends = new Map<string, { at: number; done: Promise<Response> }>();
  /** Messages a viewed receipt was asked for (once each; viewed). */
  private viewedSent = new Set<string>();

  constructor(
    private store: Store,
    private sup: Supervisor,
    private triage: Triage,
    private opts: ServerOpts,
  ) {
    if (!existsSync(opts.dataDir)) mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
    this.auth = new Auth(opts.dataDir);
    this.uploads = new Uploads(join(opts.dataDir, 'uploads'));
    // Mail's outbox sends files uploaded the same way (mail/outbox.ts).
    if (opts.mail) opts.mail.outbox.files = this.uploads;
    this.imports = new ImportSources(opts.dataDir, (msg) => console.warn(msg));
    // An import fills and adds messages behind the journal's back: every device reloads its chats (a resync).
    this.importer = new ImportRunner(store, this.imports, opts.dataDir, (msg) => console.warn(msg), () => this.resync());
    // One pace for both, so the gap fill and a job never read through one account at once.
    const pace = new ReadingPace(store, opts.pace ?? READING, realClock);
    this.gapfill = new GapFill(store, (acc, cmd) => this.sup.command(acc, cmd, 180_000), (msg) => console.warn(msg), realClock, pace);
    this.jobs = new Jobs(store, { command: (acc, cmd, t) => this.sup.command(acc, cmd, t ?? 180_000), online: (a) => sup.online(a), log: (msg) => console.warn(msg), pace });
    this.netsearch = new NetSearch(store, {
      command: (acc, cmd, t) => this.sup.command(acc, cmd, t ?? 60_000),
      online: (a) => sup.online(a),
      probe: opts.probeCategory ? (q) => opts.probeCategory!(q) : undefined,
      log: (msg) => console.warn(msg),
    });
    // A demo hub keeps nothing ahead of time: its own files (local) are fetched to be looked at.
    this.mediaInfo = new MediaInfo(store, opts.dataDir, {
      behindArchive: !!opts.archiveMedia,
      fetch: opts.archiveMedia ? undefined : (url, acc) => (/^https?:/i.test(url) ? Promise.resolve(false) : this.archiveOne(url, acc)),
      log: (msg) => console.warn(msg),
    });
    if (opts.archiveMedia)
      this.archiver = new MediaArchiver(store, join(opts.dataDir, 'media-cache'), (url, acc, from) => this.archiveOne(url, acc, from), (msg) => console.warn(msg), (acc, urls) => this.refreshUrls(acc, urls), (a) => this.mediaInfo.kept(a));
    let tools: Promise<JxlTools | null> | null = null;
    this.jxlTools = () => (tools ??= (opts.jxl ?? (() => findJxl()))().catch(() => null));
    this.jxlServe = new JxlServe(this.jxlTools);
    if (opts.packMedia) this.packer = new MediaPacker(store, join(opts.dataDir, 'media-cache'), this.jxlTools, (msg) => console.warn(msg));
    this.calls = new Calls(store, sup, { turn: opts.turn, pickAccount: (c, a) => this.pickAccount(c, a) });
    this.abouts = new Abouts({
      store,
      online: (a) => sup.online(a),
      command: (a, c, t) => sup.command(a, c, t),
      pickAccount: (c, a) => this.pickAccount(c, a),
      note: (a, line) => sup.note(a, line),
    });
    this.groups = new Groups({ store, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t), note: (a, line) => sup.note(a, line) });
    this.posts = new Posts({ store, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t), changed: () => this.flush(), fresh: (ids) => this.opts.onFresh?.(ids) });
    // Through the same pace: a check never reads while a job or the gap fill does on that account.
    this.follows = new Follows({ store, posts: this.posts, online: (a) => sup.online(a), pace, config: opts.follow, changed: () => this.flush(), log: (l) => console.warn(l) });
    this.events = new Events({ store, posts: this.posts, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t) });
    this.timelines = new Timelines({ store, posts: this.posts, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t), files: (ids) => this.postFiles(ids), changed: () => this.flush() });
    this.translator = new Translator({ store, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t) });
    this.people = new People({ store, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t) });
    this.self = new AccountSelf({ store, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t), note: (a, line) => sup.note(a, line), flush: () => this.flush(), quietHours: () => store.quietHours() });
    this.people = new People({ store, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t), note: (a, line) => sup.note(a, line), posts: (a, ps) => this.posts.log(a, ps) });
    // A note joined from yours and the network's goes back to the network (store.ts networkNotes).
    store.contactNotesOut = (id, change) => this.people.pushContactNotes(id, change);
    this.matches = new SameMatches({ store, file: opts.matches?.file ?? null, jevUrl: opts.matches?.jevUrl ?? null, log: (l) => console.log(l), flush: () => this.flush() });
    this.closeness = new Closeness({ store, file: opts.matches?.file ?? null, log: (l) => console.log(l) });
    this.searchThread = opts.searchFile ? new SearchThread({ store, file: opts.searchFile, secret: opts.secret, log: (l) => console.log(l) }) : null;
    // Its timer starts in start() with the others: a hub built and never started (a test's) runs nothing after its
    // store closes.
    this.collector = new ProfileCollector({ store, people: this.people, online: (a) => sup.online(a), log: (l) => console.log(l) });
    this.adding = new Adding({ store, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t), note: (a, line) => sup.note(a, line), flush: () => this.flush(), liveView: (a) => !!sup.liveViewUrl?.(a) || !!store.account(a)?.live_view });
    this.threads = new Threads({
      store,
      online: (a) => sup.online(a),
      command: (a, c, t) => sup.command(a, c, t),
      pickAccount: (c, a) => this.pickAccount(c, a),
      uploads: this.uploads,
      note: (a, line) => sup.note(a, line),
      flush: () => this.flush(),
      aboutView: (k, i, n, a, ab) => this.abouts.view(k, i, n, a, ab, Date.now(), undefined, true),
    });
    this.moderation = new Moderation({
      store,
      online: (a) => sup.online(a),
      command: (a, c, t) => sup.command(a, c, t),
      pickAccount: (c, a) => this.pickAccount(c, a),
      keep: (k, i, n, a, ab) => (this.abouts.keep(i, a, ab), this.abouts.view(k, i, n, a, ab, Date.now(), undefined, true)),
      note: (a, line) => sup.note(a, line),
      flush: () => this.flush(),
    });
    this.servers = new Servers({ store, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t), pickAccount: (c, a) => this.pickAccount(c, a), note: (a, line) => sup.note(a, line), flush: () => this.flush(), aboutView: (k, i, n, a, ab) => this.abouts.view(k, i, n, a, ab, Date.now(), undefined, true) });
    this.apps = new Apps({ store, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t), pickAccount: (c, a) => this.pickAccount(c, a), note: (a, line) => sup.note(a, line) });
    this.kinds = new Media({ store, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t), pickAccount: (c, a) => this.pickAccount(c, a), flush: () => this.flush() });
    sup.calls = this.calls;
    this.sendExtras = new SendExtras({
      store,
      online: (a) => sup.online(a),
      command: (a, c, t) => sup.command(a, c, t) as Promise<any>,
      send: (cid, b) => this.sendOnce(cid, b),
      chatRoute: (chatId, b) => this.chatRoute(chatId, b),
      pickAccount: (c, a) => this.pickAccount(c, a),
      files: (ids) => this.uploads.names(ids),
      dropFiles: (ids) => this.uploads.remove(ids),
      broadcast: (evs) => this.broadcast(evs),
      flush: () => this.flush(),
      messages: (ids) => {
        const views = store.messageViews(store.raw(`SELECT * FROM message WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)));
        return { messages: views, identities: store.identitiesOf(views) };
      },
    });
    // Files waiting to be sent later stay; a reminder that came due on a network notifies (saved.ts).
    this.uploads.held = () => this.sendExtras.later.heldUploads();
    store.reminderDue = (r) => {
      const w = reminderWords(store.db, r);
      const cid = w.conversationId;
      if (cid) queueMicrotask(() => this.opts.onSavedReminder?.({ title: w.title, body: w.body, conversationId: cid, messageId: r.messageId }));
    };
    this.clicks = new ClickCounts(store.db);
    this.usage = new UsageStore(store.db, (changed, removed, all) => {
      const a = this.opts.attention;
      // Where you have been moves the inbox (docs/inbox.md): the chat you were just in stays near the top.
      const scores = a ? (all ? a.rescoreAll() : a.visited([...changed, ...removed])) : [];
      this.broadcast([{ t: 'usage', places: this.usage.get(changed), removed, ...(all ? { replace: true as const } : {}) }, ...scores]);
    });
  }

  start() {
    this.self.start();
    this.searchThread?.start();
    const self = this;
    const guarded = (handler: (req: Request, server: Server<WsData>) => Promise<Response | undefined> | Response | undefined) =>
      (req: Request, server: Server<WsData>) => {
        // Each request is a span named by its method and its path without ids (docs/tracing.md); one that brings a
        // traceparent joins that trace. It ends when the response starts: a stream's body is not in it.
        const route = pathShape(new URL(req.url).pathname);
        return span(
          `${req.method} ${route}`,
          { 'http.method': req.method, 'http.route': route },
          (s) =>
            withRequest(async () => {
              try {
                const raw = await handler(req, server);
                self.answers.answered();
                // An answer of 5xx is an error for traces/errors.ndjson (errors.ts), unless something inside the request
                // was reported already (an attempt, a job) or the client went away.
                if (raw && raw.status >= 500 && !reportedInRequest() && !req.signal.aborted) await reportAnswer(req, route, raw, s.traceId);
                const res = await compress(req, raw);
                // No response: the socket was upgraded.
                s.set({ 'http.status': res?.status ?? 101 });
                if (res && res.status >= 500) s.fail(`status ${res.status}`);
                return res;
              } catch (e: any) {
                console.error('request failed', req.method, new URL(req.url).pathname, e);
                s.set({ 'http.status': 500 }).fail(e);
                if (!req.signal.aborted) reportError({ source: 'request', where: `${req.method} ${route}`, error: e, status: 500, trace: s.traceId });
                return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
              }
            }),
          { parent: parseTraceparent(req.headers.get('traceparent')) },
        );
      };
    const tls = this.opts.tls;
    const websocket: WebSocketHandler<WsData> = {
      maxPayloadLength: 32 * 1024 * 1024,
        open(ws) {
          const d = ws.data;
          if (d.kind === 'client') {
            // Its catch-up first, then it joins: every frame it gets after is newer than the answer.
            if (d.resume) self.resumeOn(ws as ServerWebSocket<ClientData>, d.resume);
            self.clients.add(ws as ServerWebSocket<ClientData>);
          } else if (d.kind === 'adapter') self.sup.attach(ws as ServerWebSocket<AdapterSocketData>);
          else if (d.kind === 'call') return;
          else if (d.kind === 'voice') self.calls.voiceOpen(ws as ServerWebSocket<VoiceSocketData>);
          else if (d.kind === 'callroom') demoCallRoom.attach(ws as ServerWebSocket<CallRoomSocketData>);
          else self.openLiveView(ws as ServerWebSocket<LiveViewData>);
        },
        message(ws, msg) {
          const d = ws.data;
          if (d.kind === 'client') {
            // The client's heartbeat: after a phone wakes, a dead socket shows in seconds rather than at a TCP timeout.
            if (msg === 'ping') ws.send('pong');
            else if (typeof msg === 'string' && msg.startsWith('{')) self.clientSaid(ws as ServerWebSocket<ClientData>, msg);
          } else if (d.kind === 'adapter') self.sup.receive(ws as ServerWebSocket<AdapterSocketData>, msg);
          else if (d.kind === 'call') self.calls.message(ws as ServerWebSocket<CallSocketData>, msg);
          else if (d.kind === 'voice') self.calls.voiceMessage(ws as ServerWebSocket<VoiceSocketData>, msg);
          else if (d.kind === 'callroom') demoCallRoom.message(msg);
          else if (d.kind === 'liveview') {
            const buf = typeof msg === 'string' ? new TextEncoder().encode(msg) : new Uint8Array(msg);
            if (d.vnc) d.vnc.write(buf);
            else if (d.up?.readyState === WebSocket.OPEN) d.up.send(buf);
            else d.queue.push(buf);
          }
        },
        close(ws) {
          const d = ws.data;
          if (d.kind === 'client') self.clients.delete(ws as ServerWebSocket<ClientData>);
          else if (d.kind === 'adapter') self.sup.detach(ws as ServerWebSocket<AdapterSocketData>);
          else if (d.kind === 'call') self.calls.close(ws as ServerWebSocket<CallSocketData>);
          else if (d.kind === 'voice') self.calls.voiceClose(ws as ServerWebSocket<VoiceSocketData>);
          else if (d.kind === 'callroom') demoCallRoom.detach(ws as ServerWebSocket<CallRoomSocketData>);
          else {
            d.closed = true;
            d.vnc?.end();
            d.up?.close();
          }
        },
    };
    const common = { idleTimeout: 120, websocket };
    // One listener per address: binding loopback and the tailnet address rather than 0.0.0.0 keeps the LAN out.
    const hosts = this.opts.hostname.split(',').map((h) => h.trim()).filter(Boolean);
    const [first, ...rest] = hosts.length ? hosts : ['0.0.0.0'];
    const serve = (hostname: string) =>
      Bun.serve<WsData, never>({
        ...common,
        port: this.opts.port,
        hostname,
        ...(tls ? { tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) } } : {}),
        fetch: guarded((req, server) => self.route(req, server)),
      });
    this.server = serve(first);
    this.extra = rest.map(serve);
    // Adapters on this machine still speak ws://, and a device has to fetch the CA before it can trust HTTPS.
    if (tls && this.opts.plainPort !== undefined) {
      const plain = (hostname: string) =>
        Bun.serve<WsData, never>({
          ...common,
          port: this.opts.plainPort,
          hostname,
          fetch: guarded((req, server) => self.plainRoute(req, server)),
        });
      this.plain = plain(first);
      this.extra.push(...rest.map(plain));
    }
    this.flushTimer = setInterval(() => this.flush(), 80);
    this.imports.resume();
    this.gapfill.resume();
    this.jobs.start();
    void this.archiver?.start();
    this.mediaInfo.start();
    this.packer?.start();
    this.store.journal.prune();
    this.pruneTimer = setInterval(() => this.store.journal.prune(), 3_600_000);
    this.sendExtras.later.start();
    this.timelines.start();
    this.follows.start();
    this.collector.start();
    return this.server;
  }

  stop() {
    clearInterval(this.flushTimer);
    clearInterval(this.pruneTimer);
    this.sendExtras.later.stop();
    this.timelines.stop();
    this.follows.stop();
    this.importer.stop();
    this.gapfill.stopAll();
    this.jobs.stop();
    this.archiver?.stop();
    this.mediaInfo.stop();
    this.packer?.stop();
    this.imports.stop();
    this.matches.stop();
    this.searchThread?.stop();
    this.collector.stop();
    // The last frame carries presence held for coalescing too, so the journal a clean stop closes has it.
    this.flush(true);
    this.server?.stop(true);
    this.plain?.stop(true);
    for (const s of this.extra) s.stop(true);
  }

  private async loudRoute(path: string, method: string, body: <T>() => Promise<T>): Promise<Response | null> {
    const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });
    const L = this.opts.loud;
    if (!L) return bad('No loudness here', 404);
    const s = this.store;
    const ok = (x: unknown = { ok: true }) => Response.json(x);
    let m: RegExpMatchArray | null;
    try {
      if (path === '/api/loudness/state' && method === 'GET') return ok(L.view());
      if (path === '/api/loudness/prefs' && method === 'PUT') {
        L.setPrefs(await body<Partial<P.AttentionPrefs>>());
        return ok(L.view());
      }
      // The inbox's Notification calibration row: how many cards and past answers wait on the feed.
      if (path === '/api/loudness/feed/count' && method === 'GET') {
        L.feed.fill(L.prefs());
        return ok({ pending: L.feed.pendingCount() });
      }
      // The calibration feed (feed.ts): cards, rows, past answers back, and the sure ones apart.
      if (path === '/api/loudness/feed' && method === 'GET') return ok(L.feed.view(L.prefs()));
      if ((m = path.match(/^\/api\/loudness\/feed\/([\w-]+)$/)) && method === 'POST') {
        const b = await body<{ answer?: unknown }>();
        const r = L.feedAnswer(m[1], b.answer as P.CalAnswer);
        this.flush();
        return ok(r);
      }
      if ((m = path.match(/^\/api\/loudness\/feed\/([\w-]+)\/parts$/)) && method === 'POST') {
        const b = await body<{ parts?: unknown }>();
        if (!Array.isArray(b.parts)) return bad('Say parts: a list');
        return ok(L.feedParts(m[1], b.parts as P.CalPart[]));
      }
      if ((m = path.match(/^\/api\/loudness\/feed\/([\w-]+)\/settle$/)) && method === 'POST') {
        const b = await body<{ settle?: unknown }>();
        if (b.settle !== 'keep' && b.settle !== 'once' && b.settle !== 'undo') return bad('Say settle: keep, once or undo');
        L.feedSettle(m[1], b.settle);
        this.flush();
        return ok();
      }
      if ((m = path.match(/^\/api\/loudness\/feed\/([\w-]+)\/skip$/)) && method === 'POST') {
        const b = await body<{ skip?: unknown }>();
        L.feed.skip(m[1], b.skip !== false);
        return ok();
      }
      if (path === '/api/loudness/answers' && method === 'POST') {
        const b = await body<Partial<P.AttnAnswerBody>>();
        const answers: P.AttnAnswer[] = ['worth', 'could_wait', 'shouldnt', 'sooner', 'fine', 'louder', 'quieter'];
        const sources: P.AttnSource[] = ['sheet', 'notification', 'followup'];
        if (typeof b.messageId !== 'string' || !answers.includes(b.answer as P.AttnAnswer)) return bad(`Say messageId and answer: one of ${answers.join(', ')}`);
        const r = L.answer({ messageId: b.messageId, answer: b.answer as P.AttnAnswer, source: sources.includes(b.source as P.AttnSource) ? (b.source as P.AttnSource) : 'sheet', ...(b.scope === 'person' || b.scope === 'chat' ? { scope: b.scope } : {}) });
        this.flush();
        return ok(r);
      }
      if (path === '/api/loudness/why' && method === 'POST') {
        const b = await body<Partial<P.WhyBody>>();
        if (typeof b.answerId !== 'string') return bad('Say answerId');
        return ok(await L.why({ answerId: b.answerId, ...(typeof b.reason === 'string' ? { reason: b.reason as P.WhyReason } : {}), ...(typeof b.wait === 'string' ? { wait: b.wait as P.WhyWait } : {}), ...(typeof b.text === 'string' ? { text: b.text } : {}), ...(typeof b.until === 'number' ? { until: b.until } : {}) }));
      }
      if (path === '/api/loudness/forget' && method === 'POST') {
        const b = await body<{ key?: unknown; rejected?: unknown }>();
        if (typeof b.key !== 'string' || typeof b.rejected !== 'boolean') return bad('Say key and rejected: true or false');
        L.forget(b.key, b.rejected);
        return ok(L.view());
      }
      // The Why sheet: a message's loudness, whole, with its reasons.
      if ((m = path.match(/^\/api\/messages\/([\w-]+)\/loudness$/)) && method === 'GET') {
        const raw = s.one<{ loud_view: string | null }>('SELECT loud_view FROM triage WHERE message_id = ?', m[1])?.loud_view;
        return ok(raw ? loudViewOf(raw) : null);
      }
    } catch (e: any) {
      return bad(e.message, 409);
    }
    return null;
  }

  flush(all = false) {
    // What a flush writes (attention's folds, one transaction per conversation; the journal) is one transaction: one
    // commit, and each commit waits for the disk on the hub's thread. The frame goes out once it is committed.
    // Every 80 ms: a span only when there was something to send (docs/tracing.md).
    // It takes the write lock as it begins (BEGIN IMMEDIATE). Begun as a read, it reads first and writes last; if
    // another connection committed in between, SQLite cannot turn it into a write and fails at once
    // (SQLITE_BUSY_SNAPSHOT), with no wait for busy_timeout: what the live hub hit in a flush at two deploys' stops.
    // Begun immediate, it waits for the lock like any write and then reads what is newest.
    const s = startSpan('flush');
    let events: P.ClientEvent[] = [];
    let frame: string | null = null;
    const mark = this.store.journal.mark();
    try {
      frame = timedWrite('flush', () =>
        this.store.db
          .transaction(() => {
            events = this.gather(all);
            return this.record(events);
          })
          .immediate(),
      );
    } catch (e) {
      // The commit failed (a lock held past busy_timeout): attention's folds are undone and fold again later; what
      // the store gave up goes out and into the journal on its own.
      // The journal's rows went with the transaction: it takes back what it thought written, and what it cannot write now
      // (a full disk) it holds for the next frame, so this one still reaches every connected device.
      console.error('flush: one transaction failed; sending what changed as it is', e);
      jobFailed('flush', e);
      this.store.journal.undo(mark);
      frame = this.record(events);
      s.fail(e);
    }
    if (frame) for (const c of this.clients) c.send(frame);
    // Status dots are written after the commit, so a failed one leaves them to write next time (presence.ts).
    try {
      this.store.presenceNow.save();
    } catch (e) {
      console.error('flush: presence not written; again next time', e);
    }
    if (!events.length) s.drop();
    else {
      s.set({ events: events.length });
      s.end();
    }
  }

  /** What changed since the last flush: the store's, mail's, and the scores they move. */
  private gather(all = false): P.ClientEvent[] {
    // What the store gives up here is no longer dirty: it goes out even when mail's or attention's part fails (a
    // locked database), or devices would miss it until their next bootstrap.
    const events = this.store.flush(all);
    if (events.length) noteWork('flush');
    // A picture came without its size: the archive keeps the new files now, and the hub reads their sizes as it does
    // (mediainfo.ts kept), instead of up to a minute later. A walk already under way gets to them by itself.
    if (this.store.sizelessPictures) {
      this.store.sizelessPictures = false;
      void this.archiver?.nudge();
    }
    try {
      if (this.opts.mail) events.push(...this.opts.mail.flush());
    } catch (e) {
      console.error('flush: mail failed', e);
      jobFailed('flush: mail', e);
    }
    const a = this.opts.attention;
    if (a) {
      const changed: string[] = [];
      const removed: string[] = [];
      let rules = false;
      for (const e of events) {
        if (e.t === 'conversation') changed.push(e.conversation.id);
        else if (e.t === 'conversation.removed') removed.push(e.id);
        else if (e.t === 'rules') rules = true;
      }
      try {
        events.push(...(rules ? a.rescoreAll() : a.sync(changed, removed)));
      } catch (e) {
        console.error('flush: attention failed', e);
        jobFailed('flush: attention', e);
      }
    }
    return events;
  }

  /** Every device drops what it kept and loads again: for changes made behind the journal's back. */
  resync() {
    this.flush();
    this.broadcast([{ t: 'resync' }]);
  }

  private syncContext() {
    return { store: this.store, attention: this.opts.attention, usage: this.usage, devices: this.opts.devices, mail: this.opts.mail, boot: this.boot, build: this.build };
  }

  /**
   * A socket's catch-up from `pos`, as its first frame, before it joins the clients (docs/sync.md "On the socket"): what
   * POST /api/sync would answer without timelines. Flushed first, so what was waiting to go out is in the answer, and
   * all of it in this one task: no frame can fall between the answer and the socket's first live one.
   */
  resumeOn(ws: ServerWebSocket<ClientData>, pos: P.SyncPosition) {
    const s = startSpan('live resume');
    let answer: P.SyncResponse | null = null;
    try {
      this.flush();
      answer = syncResponse(this.syncContext(), { v: pos.v, epoch: pos.epoch, since: pos.seq });
    } catch (e) {
      // The client asks by POST instead.
      console.error('live resume failed', e);
      s.fail(e);
    }
    const text = JSON.stringify({ resume: answer } satisfies P.LiveResume);
    if (text.length > RESUME_GZIP_OVER) ws.send(Bun.gzipSync(Buffer.from(text)));
    else ws.send(text);
    s.set({ bytes: text.length });
    s.end();
  }

  /**
   * The stop has begun (main.ts): every page hears it before its socket closes, so it says "restarting" at once and
   * tries every second (docs/sync.md "Restarts"). Not journaled: a page that was not there has nothing to catch up on.
   */
  sayStopping(usualMs: number | undefined) {
    const frame = JSON.stringify([{ t: 'stopping', ...(usualMs !== undefined ? { usualMs } : {}) } satisfies P.ClientEvent]);
    for (const c of this.clients)
      try {
        c.send(frame);
      } catch {}
  }

  /** To every client, and into the journal: a frame that changed something ends with its position (docs/sync.md). */
  broadcast(events: P.ClientEvent[]) {
    const frame = this.record(events);
    if (frame) for (const c of this.clients) c.send(frame);
  }

  /** Into the journal, and the frame that carries it; null when there is nothing to send. */
  private record(events: P.ClientEvent[]): string | null {
    if (!events.length) return null;
    if (events.some((e) => e.t === 'resync')) this.store.journal.restart();
    const seq = this.store.journal.record(changesOf(events));
    return JSON.stringify(seq === null ? events : [...events, { t: 'sync', seq } satisfies P.ClientEvent]);
  }

  private openLiveView(ws: ServerWebSocket<LiveViewData>) {
    const d = ws.data;
    if (d.url) {
      const up = new WebSocket(d.url, ['binary']);
      up.binaryType = 'arraybuffer';
      d.up = up;
      up.onopen = () => {
        if (d.closed) return up.close();
        for (const b of d.queue) up.send(b);
        d.queue = [];
      };
      up.onmessage = (e) => ws.sendBinary(new Uint8Array(e.data as ArrayBuffer));
      up.onclose = () => {
        try {
          ws.close();
        } catch {}
      };
      up.onerror = () => {
        try {
          ws.close(1011, 'live view unreachable');
        } catch {}
      };
      return;
    }
    if (!d.socket || !ownSocket(d.socket)) return void ws.close(1011, 'vnc unreachable');
    Bun.connect({
      unix: d.socket,
      socket: {
        open(sock) {
          d.vnc = sock;
          for (const b of d.queue) sock.write(b);
          d.queue = [];
        },
        data(_sock, data) {
          ws.sendBinary(data);
        },
        close() {
          try {
            ws.close();
          } catch {}
        },
        error() {
          try {
            ws.close(1011, 'vnc error');
          } catch {}
        },
      },
    }).catch(() => ws.close(1011, 'vnc unreachable'));
  }

  // ---------------------------------------------------------------- routing

  /** The plaintext listener next to HTTPS. WireGuard already authenticates the tailnet, so a CA fetched here is safe to trust. */
  private plainRoute(req: Request, server: Server<WsData>): Promise<Response | undefined> | Response {
    const url = new URL(req.url);
    const ip = server.requestIP(req)?.address ?? '';
    if (isLoopback(ip) && url.pathname === '/adapter') return this.route(req, server);
    if (!isLoopback(ip) && !isTailnet(ip)) return new Response('tailnet only', { status: 403 });
    if (!hostAllowed(req.headers.get('host'), this.names)) return unknownHost();
    if (url.pathname === '/ca.crt') return this.caCert();
    if (url.pathname === '/api/health') return Response.json({ ok: true, now: Date.now() });
    if (url.pathname === '/trust') return new Response(this.trustPage(req), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const host = (req.headers.get('host') ?? url.host).replace(/:\d+$/, '');
    return Response.redirect(`https://${host}:${this.server.port}${url.pathname}${url.search}${url.hash}`, 307);
  }

  private caCert(): Response {
    const ca = this.opts.tls?.ca;
    if (!ca || !existsSync(ca)) return new Response('this hub has no private CA', { status: 404 });
    return new Response(Bun.file(ca), { headers: { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="dither-chat-ca.crt"', 'cache-control': 'no-cache' } });
  }

  private trustPage(req: Request): string {
    const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '');
    const fp = this.opts.tls?.ca && existsSync(this.opts.tls.ca) ? new Bun.CryptoHasher('sha256').update(Buffer.from(readFileSync(this.opts.tls.ca, 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64')).digest('hex').toUpperCase().match(/../g)!.join(':') : 'none';
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trust dither-chat</title>
<style>body{font:16px system-ui;max-width:40em;margin:2em auto;padding:0 1em;line-height:1.5}code{word-break:break-all}</style>
<h1>Trust this hub</h1><p>Installing dither-chat needs HTTPS, and this hub uses a private certificate authority limited to the tailnet.</p>
<ol><li><a href="/ca.crt">Download the certificate</a></li><li>Install it as a trusted CA on this device (steps below)</li><li><a href="https://${host}:${this.server.port}/">Open dither-chat</a> and install it</li></ol>
<p>SHA-256 fingerprint:<br><code>${fp}</code></p>
<ul><li><b>Android:</b> Settings → Security → More security settings → Install from device storage → CA certificate. The exact path varies by vendor; search settings for "CA certificate".</li>
<li><b>iOS:</b> open the download in Safari, Settings → Profile Downloaded → Install, then Settings → General → About → Certificate Trust Settings → enable it. Install with Share → Add to Home Screen.</li>
<li><b>Desktop:</b> see docs/deploy.md for your browser.</li></ul>`;
  }

  private async route(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = server.requestIP(req)?.address ?? '';

    if (path === '/adapter') {
      if (!isLoopback(ip)) return new Response('adapters connect from localhost only', { status: 403 });
      const accountId = this.sup.authorize(url.searchParams.get('account'), url.searchParams.get('token'));
      if (!accountId) return new Response('bad adapter token', { status: 401 });
      if (server.upgrade(req, { data: { kind: 'adapter', accountId } satisfies AdapterSocketData })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }

    // Everything else: this machine and the tailnet only, never the LAN.
    if (!isLoopback(ip) && !isTailnet(ip)) return new Response('tailnet only', { status: 403 });
    // And only under a name this hub has (hosts.ts), so a page that rebinds its own domain here gets nothing.
    if (!hostAllowed(req.headers.get('host'), this.names)) return unknownHost();

    if (path === '/ca.crt') return this.caCert();

    // The login (auth.ts, docs/login.md). Being on this machine or the tailnet is not enough: the proxy on this machine
    // (Caddy) reaches us from loopback too. Past here a request has a session, the service token, or a file ticket;
    // without one it gets the login's own routes, a bare health check, or the web app's files, nothing else.
    const who = clientIp(req, ip);
    const https = overHttps(req, ip);
    if (path === '/api/login' || path === '/api/logout') return this.loginRoute(req, path, who, https);
    const me = this.whoIs(req, who);
    // An asker's token (approvals.ts) reaches /api/approvals and nothing else, and is that asker even on a hub open
    // without a login (a demo world).
    if (this.opts.approvals && (path === '/api/approvals' || path.startsWith('/api/approvals/'))) {
      const asker = this.opts.approvals.askers.of(bearerOf(req));
      if (asker) return this.opts.approvals.route(req, url, asker);
    }
    if (path === '/api/health' && !me) return Response.json({ ok: true, now: Date.now() }, { headers: { 'cache-control': 'no-store' } });
    if (!me) {
      const ticketed = (path.startsWith('/media/') || path.startsWith('/emoji/')) && (req.method === 'GET' || req.method === 'HEAD') && ticketGood(this.opts.secret, path, url.searchParams.get('ticket'));
      const dave = (req.method === 'GET' || req.method === 'HEAD') && path.match(DAVE_FILE);
      if (dave) return this.daveFile(dave[1]!, dave[2]!);
      if (!ticketed) {
        if (GATED.test(path)) return this.signIn();
        return this.static(path, req);
      }
    }
    // Cross-site: a browser's write or socket must come from this page (its cookie is SameSite=Lax, and this is the
    // second lock). The service token is no browser's, so it is not asked.
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    const socket = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
    const ownPage = me?.kind === 'open' ? sameOriginOpen(req) : me?.kind === 'token' || fromOwnPage(req);
    if ((write || socket) && !ownPage) return new Response(socket ? 'cross-site socket refused' : 'cross-site request refused', { status: 403 });
    if (me?.kind === 'session' && me.refresh !== null) {
      const res = await this.routeIn(req, server, url, path, ip, me);
      res?.headers.append('set-cookie', sessionCookie(cookieOf(req)!, me.refresh, https));
      return res;
    }
    return this.routeIn(req, server, url, path, ip, me);
  }

  /** Who a request is (auth.ts Who), or null: nobody, and only the login's routes and the app's files answer. */
  private whoIs(req: Request, who: string): Who | null {
    if (this.opts.open) return { kind: 'open' };
    if (this.auth.isToken(bearerOf(req))) return { kind: 'token' };
    const s = this.auth.session(cookieOf(req), who);
    return s ? { kind: 'session', ...s } : null;
  }

  /** 401 for a gated path without a session: the page shows its sign-in (or, with no password set, how to set one). */
  private signIn(): Response {
    const setup = !this.auth.password();
    return Response.json(
      { error: setup ? 'This hub has no password yet: set one with `bun packages/hub/src/cli.ts set-password` (docs/login.md).' : 'Sign in first.', login: true, ...(setup ? { setup: true } : {}) },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }

  /**
   * GET /api/login: whether this device is signed in and whether a password is set. POST /api/login { username,
   * password }: a session cookie. POST /api/logout: this session ends. Writes only from this page.
   */
  private async loginRoute(req: Request, path: string, who: string, https: boolean): Promise<Response> {
    const json = (x: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(x, { status, headers: { 'cache-control': 'no-store', ...headers } });
    if (path === '/api/login' && (req.method === 'GET' || req.method === 'HEAD')) {
      const signedIn = !!this.opts.open || !!this.auth.session(cookieOf(req), who);
      return json({ signedIn, passwordSet: !!this.auth.password(), user: USER, open: !!this.opts.open, minPassword: MIN_PASSWORD });
    }
    if (req.method !== 'POST') return json({ error: 'POST' }, 405);
    if (!(this.opts.open ? sameOriginOpen(req) : fromOwnPage(req))) return json({ error: 'cross-site request refused' }, 403);
    if (path === '/api/logout') {
      const s = this.auth.session(cookieOf(req), who);
      if (s) this.auth.revoke(s.id);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0, https), 'clear-site-data': '"cache", "storage"' });
    }
    if (Number(req.headers.get('content-length') ?? 0) > 8192) return json({ error: 'too large' }, 413);
    const b = (await req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const r = await this.auth.login(typeof b.username === 'string' ? b.username : USER, typeof b.password === 'string' ? b.password : '', who, req.headers.get('user-agent'));
    if (r.ok) {
      console.log(`login from ${who}`);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(r.token, r.maxAge, https) });
    }
    if (r.status !== 503) console.log(`login refused from ${who}: ${r.status}`);
    return json({ error: r.error, ...(r.status === 503 ? { setup: true } : {}) }, r.status, r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {});
  }

  /**
   * GET /api/sessions: the signed-in devices. DELETE /api/sessions (?others=1: all but this one), DELETE
   * /api/sessions/:id. The CLI does the same (cli.ts sessions, revoke-sessions). POST /api/sessions, with the service
   * token only: a new session's cookie, for a script that drives a browser (scripts/hub-login.ts).
   */
  private sessionsRoute(req: Request, path: string, me: Who | null): Response {
    if (path === '/api/sessions' && req.method === 'POST') {
      if (me?.kind !== 'token') return Response.json({ error: 'the service token only' }, { status: 403 });
      const s = this.auth.create('', req.headers.get('user-agent'));
      return s ? Response.json({ cookie: sessionCookie(s.token, s.maxAge, false), name: COOKIE, value: s.token }, { headers: { 'cache-control': 'no-store' } }) : Response.json({ error: 'no password is set' }, { status: 409 });
    }
    const current = me?.kind === 'session' ? me.id : null;
    const url = new URL(req.url);
    let m: RegExpMatchArray | null;
    if (path === '/api/sessions' && req.method === 'GET') return Response.json({ sessions: this.auth.list(current) }, { headers: { 'cache-control': 'no-store' } });
    if (path === '/api/sessions' && req.method === 'DELETE') return Response.json({ revoked: this.auth.revokeAll(url.searchParams.get('others') === '1' ? current : null) });
    if ((m = path.match(/^\/api\/sessions\/([\w-]+)$/)) && req.method === 'DELETE') return this.auth.revoke(m[1]) ? Response.json({ revoked: 1 }) : Response.json({ error: 'no such session' }, { status: 404 });
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  /** Everything behind the login. */
  private async routeIn(req: Request, server: Server<WsData>, url: URL, path: string, ip: string, me: Who | null): Promise<Response | undefined> {
    // dither-calendar (calendar.ts, docs/calendar.md).
    if (path === '/calendar' || path.startsWith('/calendar/')) {
      const link = this.opts.calendar?.link();
      return link ? link.proxy(req, url) : calendarOff(path);
    }
    if (path.startsWith('/api/sessions')) return this.sessionsRoute(req, path, me);
    // Approvals (approvals.ts): you, by your session (the page answers) or the service token.
    if (path === '/api/approvals' || path.startsWith('/api/approvals/')) {
      if (!this.opts.approvals) return Response.json({ error: 'approvals are off on this hub' }, { status: 404 });
      return this.opts.approvals.route(req, url, { admin: true, page: me?.kind === 'session' || me?.kind === 'open' });
    }
    // A link a program without the cookie may fetch for a few minutes (the desktop helper: docs/desktop.md).
    if (path === '/api/ticket' && req.method === 'POST') {
      const b = (await req.json().catch(() => ({}))) as { url?: unknown };
      let u: URL;
      try {
        u = new URL(typeof b.url === 'string' ? b.url : '', url);
      } catch {
        return Response.json({ error: 'Send { url } of a /media or /emoji link' }, { status: 400 });
      }
      // Bound to the path alone: behind the proxy the page's origin is not the one this request came in on.
      if (!/^\/(media|emoji)\/[^/]/.test(u.pathname)) return Response.json({ error: 'Only /media and /emoji links' }, { status: 400 });
      u.searchParams.set('ticket', fileTicket(this.opts.secret, u.pathname));
      return Response.json({ url: u.pathname + u.search });
    }

    if (path === '/api/live') {
      // Asked from a position: the catch-up comes as its first frame, and LIVE_RESUME back says it will.
      const resume = liveResume(url, req.headers.get('sec-websocket-protocol'));
      const data: ClientData = resume ? { kind: 'client', resume } : { kind: 'client' };
      if (server.upgrade(req, { data, ...(resume ? { headers: { 'Sec-WebSocket-Protocol': LIVE_RESUME } } : {}) })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    if (path === '/api/call') {
      if (server.upgrade(req, { data: { kind: 'call' } satisfies CallSocketData })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    if (path === '/api/calls') return Response.json(this.calls.stats());
    // The demo call room (democalls.ts): the far end of demo calls, on demo hubs only.
    if (path === '/api/demo/callroom' || path === '/demo/callroom.html') {
      if (!this.store.accounts().some((a) => a.demo)) return new Response('not a demo hub', { status: 404 });
      if (path === '/demo/callroom.html') return new Response(Bun.file(join(import.meta.dir, 'demo-callroom.html')), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
      if (server.upgrade(req, { data: { kind: 'callroom' } satisfies CallRoomSocketData })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    let m: RegExpMatchArray | null;
    // Call lab (scripts/call-lab.ts): only on a hub started with DITHER_LAB=1, from loopback, never from a browser.
    if (process.env.DITHER_LAB === '1' && req.method === 'POST' && !req.headers.get('origin') && /^(127\.|::1$|::ffff:127\.)/.test(server.requestIP(req)?.address ?? '') && (m = path.match(/^\/api\/lab\/([\w-]+)$/))) {
      const b = (await req.json()) as { op: string; timeout?: number };
      try {
        return Response.json({ ok: true, result: await this.sup.command(m[1], { t: 'lab', lab: b, timeout: b.timeout }, (b.timeout ?? 30_000) + 5000) });
      } catch (e: any) {
        return Response.json({ ok: false, error: String(e?.message ?? e) });
      }
    }
    if ((m = path.match(/^\/api\/call\/([\w-]+)\/voice$/))) return this.calls.upgradeVoice(req, server, m[1], url);
    if ((m = path.match(/^\/api\/liveview\/([\w-]+)$/))) {
      // A remote account's live view comes through dither-accounts on this hub's token; a local one from its VNC socket
      // (a Unix socket; a TCP port is never connected to).
      const url = this.sup.liveViewUrl?.(m[1]) ?? null;
      const acc = this.store.account(m[1]);
      const lv = !url && acc?.live_view ? (JSON.parse(acc.live_view) as { vncSocket?: unknown }) : null;
      if (!url && (typeof lv?.vncSocket !== 'string' || !lv.vncSocket.startsWith('/'))) return new Response('no live view for this account', { status: 404 });
      const proto = req.headers.get('sec-websocket-protocol');
      const headers = proto?.split(',').map((s) => s.trim()).includes('binary') ? { 'Sec-WebSocket-Protocol': 'binary' } : undefined;
      const data: LiveViewData = url ? { kind: 'liveview', accountId: m[1], url, queue: [] } : { kind: 'liveview', accountId: m[1], socket: lv!.vncSocket as string, queue: [] };
      if (server.upgrade(req, { data, headers })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    if (path === '/api/voice/dave') return this.daveCurrent();
    if ((m = path.match(DAVE_FILE))) return this.daveFile(m[1]!, m[2]!);
    if (path === '/api/voice/sounds') return this.callSounds();
    if ((m = path.match(/^\/voice\/sounds\/([a-z0-9_]{1,40})\.mp3$/))) return this.callSound(m[1]);
    if ((m = path.match(/^\/media\/([\w-]+)\/([\w-]+)$/))) return this.media(m[1], m[2], url.searchParams.get('a'), takesJxl(req), url.searchParams.get('as'), url.searchParams.get('name'));
    // Custom emoji inside message bodies: the id is all a body has, and it can only reach Discord's CDN.
    if ((m = path.match(/^\/emoji\/discord\/(\d+)(\.animated)?$/))) return this.fetchMedia(discordEmojiUrl(m[1], !!m[2]), null);
    if (path === '/api/errors' && req.method === 'POST') return this.clientError(req, clientIp(req, ip));
    if (path.startsWith('/api/')) return this.api(req, url, path);
    return this.static(path, req);
  }

  /** At most 60 of the page's error reports a minute from one address. */
  private readonly errorCap = new PerClientCap(60, 60_000);
  /** Answers given, per second, to judge the page's reports of a hub it could not reach (errors.ts lossCovered). */
  readonly answers = new AnswerClock();

  /**
   * POST /api/errors: an error the page met (errors.ts `clientReport`), written to traces/errors.ndjson as app `web`,
   * source `client`. Authorised like every owner route (this machine or the tailnet, the page's own origin).
   */
  private async clientError(req: Request, ip: string): Promise<Response> {
    if (Number(req.headers.get('content-length') ?? 0) > 16_384) return Response.json({ error: 'too large' }, { status: 413 });
    const text = await req.text().catch(() => '');
    if (text.length > 16_384) return Response.json({ error: 'too large' }, { status: 413 });
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {}
    const r = clientReport(body);
    if (!r) return Response.json({ error: 'Send { name, message, stack, where, status?, version }, where a route template like #/chat/:id' }, { status: 400 });
    if (!this.errorCap.take(ip)) return Response.json({ error: 'too many reports' }, { status: 429 });
    const covered = lossCovered(r.extra, this.answers, Date.now());
    if (covered) {
      console.log(`errors: a device lost the hub for ${Math.round(Number(r.extra?.lostMs) / 1000)} s, not written: ${covered === 'restarted' ? 'the hub restarted meanwhile' : 'the hub answered others meanwhile'}`);
      return new Response(null, { status: 204 });
    }
    reportError(r);
    return new Response(null, { status: 204 });
  }

  private async api(req: Request, url: URL, path: string): Promise<Response> {
    const s = this.store;
    const method = req.method;
    const body = async <T>() => (method === 'GET' ? ({} as T) : ((await req.json().catch(() => ({}))) as T));
    const ok = (x: unknown = { ok: true }) => Response.json(x);
    const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });
    let m: RegExpMatchArray | null;
    const num = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : null);

    // gapRestarts: accounts the hub still has to restart after a gap (remote.ts), which the deployer waits for.
    if (path === '/api/health') return ok({ ok: true, now: Date.now(), gapRestarts: (this.sup as { gapRestartsWaiting?: () => number }).gapRestartsWaiting?.() ?? 0 });
    if (path === '/api/demo/reset' && method === 'POST') {
      if (!this.opts.onDemoReset) return bad('demo is not enabled', 404);
      await this.opts.onDemoReset();
      await this.matches.forget();
      this.flush();
      this.broadcast([{ t: 'resync' }]);
      return ok();
    }
    if (path === '/api/bootstrap') {
      // Just after a start the first scores are still being worked out a slice at a time: wait for them rather than
      // work them all out here at once (a second or more of the hub's thread).
      const attention = this.opts.attention;
      if (attention && !attention.hasScores) await attention.firstScores;
      // Everything changed so far is in the journal, so the position below covers what this reads.
      this.flush();
      const calendar = this.opts.calendar?.link();
      return ok({ ...s.bootstrap({ edgesInConversations: url.searchParams.get('edges') === 'spaces' }), attention: this.opts.attention?.list(), devices: this.opts.devices?.list(), ...(this.opts.mail ? { mail: this.opts.mail.bootstrap() } : {}), requests: requestViews(s), ...(calendar ? { calendar: calendar.view() } : {}), ...(this.opts.notices ? { notices: this.opts.notices.boot() } : {}), sync: s.journal.position(), boot: this.boot, ...(this.build ? { build: this.build } : {}) } satisfies P.Bootstrap);
    }
    // Plans the calendar found in chats, from the hub's cache (calendar.ts): the chips under messages.
    if (path === '/api/plans' && method === 'GET') {
      const link = this.opts.calendar?.link();
      return link ? ok(link.plansView() satisfies P.PlansView) : bad('calendar is off on this hub', 404);
    }
    if (path === '/api/sync' && method === 'POST') {
      const b = await body<P.SyncRequest>();
      this.flush();
      return ok(syncResponse(this.syncContext(), b));
    }
    // Calls ringing you and voice channels (callstate.ts, docs/calls.md "Ringing").
    if (path.startsWith('/api/calls/') || path === '/api/voice') {
      const r = await callRoute({ store: s, online: (a) => this.sup.online(a), command: (a, c, t) => this.sup.command(a, c, t), flush: () => this.flush() }, req, url, path);
      if (r) return r;
    }
    // Voting in polls, making them and ending them early (polls.ts, docs/polls.md).
    if (handlesPolls(path)) {
      const r = await pollRoute({ store: s, online: (a) => this.sup.online(a), command: (a, c, t) => this.sup.command(a, c, t), pickAccount: (c, a) => this.pickAccount(c, a), flush: () => this.flush() }, req, path);
      if (r) return r;
    }
    // Joining and adding, and requests (add.ts).
    if (path === '/api/add' || path.startsWith('/api/add/') || path.startsWith('/api/requests') || path === '/api/people' || /^\/api\/people\/[\w-]+\/remove$/.test(path)) return (await this.adding.route(req, url, path))!;
    // An account's own self, block, ignore and notes (accountself.ts).
    if (path.startsWith('/api/self/')) return (await this.self.route(req, url, path))!;
    // Scheduled events, leaving, and what a space asks on joining (servers.ts).
    if (Servers.handles(path)) return (await this.servers.route(req, url, path))!;
    // Bots' buttons, selects, slash commands and forms (apps.ts).
    if (Apps.handles(path)) return (await this.apps.route(req, url, path, () => this.flush()))!;
    // Following threads, starting threads and posts, archiving, publishing, running a group (threads.ts).
    if (Threads.handles(path)) return (await this.threads.route(req, url, path))!;
    // Moderating members, others' messages and reactions, member labels (moderation.ts).
    if (Moderation.handles(path)) return (await this.moderation.route(req, url, path))!;
    // Send later, saved on the network, previews off (sendextras.ts, docs/sending.md).
    if (SendExtras.handles(path)) return (await this.sendExtras.route(req, url, path))!;
    // Reply marks (replymarks.ts, docs/inbox.md "Marks"): on a message, its mail twin, and on an inbox row.
    if ((m = path.match(/^\/api\/(mail\/)?messages\/([\w-]+)\/reply-mark$/)) && method === 'POST') {
      const b = await body<{ mark?: unknown; surface?: unknown; device?: unknown }>();
      if (b.mark !== null && b.mark !== 'none' && b.mark !== 'needs') return bad('Say mark: "none", "needs" or null');
      const o = { surface: typeof b.surface === 'string' ? b.surface : 'message', device: typeof b.device === 'string' ? b.device : null };
      if (m[1]) {
        const r = this.opts.mail ? this.marks.setMail(m[2], b.mark as ReplyMark | null, o) : null;
        if (!r) return bad('No such mail message from someone else', 404);
        mailAttention(this.opts.mail)?.marked(r.threadId);
        this.flush();
        return ok({ mark: b.mark, marked: [m[2]] });
      }
      const r = this.marks.setMessage(m[2], b.mark as ReplyMark | null, o);
      if (!r) return bad('No such message from someone else', 404);
      this.flush();
      return ok({ mark: b.mark, marked: r.marked });
    }
    if (path === '/api/reply-mark' && method === 'POST') {
      const b = await body<{ targetKind?: unknown; ids?: unknown; mark?: unknown; device?: unknown }>();
      // null takes back "Reply needed" on the row's open turn; "No reply needed" is taken back on its message.
      if (b.mark !== 'none' && b.mark !== 'needs' && b.mark !== null) return bad('Say mark: "none", "needs" or null');
      const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
      if (!ids.length) return bad('Say which conversations (ids)');
      const o = { surface: 'row', device: typeof b.device === 'string' ? b.device : null };
      if (b.targetKind === 'mail') {
        if (!this.opts.mail) return bad('mail is off on this hub', 404);
        const marked = ids.flatMap((t) => this.marks.setMailRow(t, b.mark as ReplyMark | null, o).marked);
        for (const t of ids) mailAttention(this.opts.mail)?.marked(t);
        this.flush();
        return ok({ mark: b.mark, marked, kind: 'mail' });
      }
      const r = this.marks.setRow(ids, b.mark as ReplyMark | null, o);
      this.flush();
      return ok({ mark: b.mark, marked: r.marked, kind: 'message' });
    }
    // Notices (notices/index.ts).
    if (path === '/api/notices' || path.startsWith('/api/notices/')) {
      const r = this.opts.notices ? await this.opts.notices.route(req, url) : null;
      return r ?? bad(this.opts.notices ? 'no such notices route' : 'notices are off on this hub', 404);
    }
    // Mail (mail/routes.ts).
    if (path === '/api/mail' || path.startsWith('/api/mail/')) {
      const r = this.opts.mail ? await this.opts.mail.route(req, url) : null;
      return r ?? bad(this.opts.mail ? 'no such mail route' : 'mail is off on this hub', 404);
    }
    // The inbox's ranking (attention.ts, docs/inbox.md).
    if (path.startsWith('/api/attention')) {
      const a = this.opts.attention;
      if (!a) return bad('attention is off', 404);
      if (path === '/api/attention' && method === 'GET') return ok({ now: Date.now(), items: a.list() });
      // Scores still to come out of what already happened (attention.ts `waiting`). What changed is sent first, so a
      // false here also means the hub has nothing more to say about it (verify-response.ts settle()).
      if (path === '/api/attention/waiting' && method === 'GET') {
        this.flush();
        return ok({ waiting: a.waiting });
      }
      // The learned order (ranker.ts): its mode and what it learned, as weights on named features.
      if (path === '/api/attention/model' && method === 'GET') return ok((a.judge as { view?: () => unknown } | undefined)?.view?.() ?? { mode: 'off' });
      // How well "needs a reply" chances matched what you did (needsreply.ts): by day, and in bins.
      if (path === '/api/attention/needs-reply' && method === 'GET') return ok(a.needsCalibration(Date.now(), Math.min(365, Math.max(1, num('days') ?? 60))));
      // The weekly report of what attention cost (attnreport.ts, docs/scorecard.md "The weekly report").
      if (path === '/api/attention/report' && method === 'GET') {
        const r = attentionReport(this.store.db, { owed: () => a.list(), self: () => selfIds(this.store.db) });
        // Settings → "People you're drifting from" off: the report names no one.
        return ok(this.opts.loud && !this.opts.loud.prefs().drifting ? { ...r, drifting: null } : r);
      }
      if ((m = path.match(/^\/api\/attention\/([\w-]+)$/)) && method === 'GET') {
        const x = a.explain(m[1]);
        return x ? ok(x) : bad('not in the inbox', 404);
      }
      // After importing history some other way than the ingest: fold these conversations (or all) again.
      if (path === '/api/attention/rebuild' && method === 'POST') {
        const b = await body<{ conversations?: string[] }>();
        a.invalidate(Array.isArray(b.conversations) ? b.conversations.filter((x) => typeof x === 'string') : undefined);
        return ok();
      }
    }
    if (path === '/api/inbox') return ok(s.inbox(num('since') ?? Date.now() - 7 * 86_400_000));
    // For you (foryou.ts, docs/foryou.md): a page of a snapshot, how many a fresh one would add, and its events.
    if (path.startsWith('/api/foryou') && this.opts.foryou) {
      const f = this.opts.foryou;
      if (path === '/api/foryou' && method === 'GET') return ok(await f.page(url.searchParams.get('epoch') || null, num('from') ?? 0, num('limit') ?? 20));
      if (path === '/api/foryou/fresh' && method === 'GET') return ok(await f.fresh(url.searchParams.get('epoch') ?? ''));
      if (path === '/api/foryou/stats' && method === 'GET') return ok(f.stats(num('since') ?? Date.now() - 7 * 86_400_000));
      if (path === '/api/foryou/events' && method === 'POST') {
        const b = await body<{ events?: Partial<P.ForYouEvent>[] }>();
        return ok({ applied: f.events(Array.isArray(b.events) ? b.events : []) });
      }
    }
    // People and the places they share (graph.ts, docs/people-graph.md).
    if (path === '/api/graph' && method === 'GET') return ok(peopleGraph(s));
    if (path === '/api/graph/activity' && method === 'GET') return ok(activityView(s, await this.closeness.get()));
    // A person's time in voice and who they are closest to (docs/profile.md "Voice", "Close to"), keyed as the graph is.
    if ((m = path.match(/^\/api\/(persons|identities)\/([\w-]+)\/(voice|close)$/)) && method === 'GET') {
      const ids = m[1] === 'persons' ? (s.db.query('SELECT id FROM identity WHERE person_id = ?').all(m[2]) as { id: string }[]).map((r) => r.id) : [m[2]];
      if (!ids.length) return bad('nobody by that id', 404);
      const key = m[1] === 'persons' ? m[2] : (((s.db.query('SELECT person_id FROM identity WHERE id = ?').get(m[2]) as { person_id: string | null } | null)?.person_id ?? m[2]) as string);
      if (m[3] === 'voice') {
        const keyOf = s.db.query('SELECT person_id FROM identity WHERE id = ?');
        const voice = personVoice(s.db, ids, (i) => ((keyOf.get(i) as { person_id: string | null } | null)?.person_id ?? i) as string);
        return ok({ voice, identities: s.identitiesByIds(voice?.with.map((w) => w.identityId) ?? []) });
      }
      const close = closeTo(s, await this.closeness.get(), key, graphTuning(s.db), Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 12)));
      return ok({ close, identities: s.identitiesByIds(close.map((c) => c.identityId)) });
    }
    if (path === '/api/graph/tuning' && method === 'GET') return ok(graphTuning(s.db));
    if (path === '/api/graph/tuning' && method === 'PUT') {
      const b = await body<{ tuning?: unknown }>();
      try {
        return ok(setGraphTuning(s.db, b.tuning ?? null));
      } catch {
        return bad('a tuning is weights 0 to 3 for each signal and a fade of 3 to 60 months');
      }
    }
    // Same person? (samepeople.ts, docs/same-person.md): pairs to merge, decisions, merging, pictures to hash.
    if (path === '/api/matches' && method === 'GET') return ok(this.matches.view({ side: url.searchParams.get('side') ?? undefined }));
    if (path === '/api/matches/refresh' && method === 'POST') {
      void this.matches.refresh();
      return ok(this.matches.view());
    }
    if (path === '/api/matches/decide' && method === 'POST') {
      const b = await body<{ key?: unknown; decision?: unknown; undo?: unknown }>();
      if (typeof b.key !== 'string' || !/^(per|idn)_[\w-]+\+(per|idn)_[\w-]+$/.test(b.key)) return bad('key: two side ids joined by +');
      if (b.undo === true) await this.matches.undecide(b.key);
      else if (b.decision === 'no' || b.decision === 'later') this.matches.decide(b.key, b.decision);
      else return bad("decision: 'no' or 'later'");
      return ok();
    }
    if (path === '/api/matches/merge' && method === 'POST') {
      const b = await body<{ sides?: unknown }>();
      if (!Array.isArray(b.sides) || b.sides.length > 50 || !b.sides.every((x) => typeof x === 'string')) return bad('sides: the ids to make one person');
      try {
        const person = this.matches.merge(b.sides as string[]);
        this.flush();
        return ok({ person });
      } catch (e) {
        return bad((e as Error).message, (e as { status?: number }).status ?? 400);
      }
    }
    if (path === '/api/matches/pictures' && method === 'GET') return ok({ pictures: this.matches.pictures(Math.min(200, Number(url.searchParams.get('limit')) || 60)) });
    if (path === '/api/matches/pictures' && method === 'POST') {
      const b = await body<{ hashes?: unknown }>();
      if (!Array.isArray(b.hashes)) return bad('hashes: [{ identityId, url, hash }]');
      return ok({ saved: this.matches.savePictures(b.hashes as { identityId: string; url: string; hash: string | null }[]) });
    }
    if (path === '/api/profiles/collect' && method === 'GET') return ok(this.collector.status());
    // The networks' own search, a few places at a time in jev's order (netsearch.ts).
    if (path === '/api/search/network' && method === 'POST') return ok(this.netsearch.start((await body<{ q?: string }>()).q ?? ''));
    if ((m = path.match(/^\/api\/search\/network\/([\w-]+)(\/more)?$/))) {
      const v = m[2] && method === 'POST' ? await this.netsearch.more(m[1]) : this.netsearch.view(m[1]);
      return v ? ok(v) : bad('that search is over; search again', 404);
    }
    if (path === '/api/search') {
      // typing=1: asked as you type, so without the slow fallbacks (docs/search.md, "How a search runs").
      const ask: SearchAsk = { q: url.searchParams.get('q') ?? '', limit: Math.min(num('limit') ?? 40, 100), cursor: url.searchParams.get('cursor'), context: num('context') ?? 0, typing: url.searchParams.get('typing') === '1' };
      if (!this.searchThread) return ok(s.search(ask.q, ask.limit, ask.cursor, ask.context, { typing: ask.typing }));
      try {
        // A newer search as you type from the same session takes the place of one still queued.
        return ok(await this.searchThread.search(ask, { key: cookieOf(req) ?? bearerOf(req) ?? '', signal: req.signal }));
      } catch (e) {
        if (e instanceof SearchCalledOff) return bad(e.message, 409);
        throw e;
      }
    }

    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/context$/))) {
      const page = s.messageContext(m[1], Math.min(num('around') ?? 30, 100));
      return page ? ok(page) : bad('no such message', 404);
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/messages$/)) && num('after') !== null) return ok(s.messagesAfter(m[1], num('after')!, Math.min(num('limit') ?? 60, 200)));
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/messages$/))) return ok(s.messages(m[1], num('before'), Math.min(num('limit') ?? 60, 200)));
    if ((m = path.match(/^\/api\/persons\/([\w-]+)\/profile$/)) || (m = path.match(/^\/api\/identities\/([\w-]+)\/profile$/))) {
      const p = s.profile(path.startsWith('/api/persons/') ? { personId: m[1] } : { identityId: m[1] });
      const mail = p && mailPeople(this.opts.mail)?.profile(p.identityIds);
      return p ? ok({ ...p, abouts: this.people.kept(p.identityIds), links: profileLinksOf(s.db, p.identityIds), ...((ev) => (ev.length ? { events: ev } : {}))(eventsOf(s, p.identityIds)), ...((i) => (i.length ? { ignored: i } : {}))(ignoredOf(s.db, p.identityIds)), ...(mail ? { mail } : {}) }) : bad('nobody by that id', 404);
    }
    // Their message count per server, estimated from what the hub holds (msgcount.ts, docs/profile.md).
    if ((m = path.match(/^\/api\/(persons|identities)\/([\w-]+)\/activity$/))) {
      const v = s.messageActivity(m[1] === 'persons' ? { personId: m[2] } : { identityId: m[2] }, url.searchParams.get('space') || undefined);
      return v ? ok(v) : bad('nobody by that id', 404);
    }
    // When someone is around: their messages, yours to them, presence and statuses by local hour (activitychart.ts, docs/profile.md).
    if ((m = path.match(/^\/api\/people\/([\w-]+)\/activity$/)) && method === 'GET') {
      const zone = parseZone(url.searchParams.get('tz'), url.searchParams.get('offset'));
      if (!zone) return bad('unknown time zone');
      const days = clampDays(url.searchParams.get('days'));
      const v = s.activityChart(m[1].startsWith('idn_') ? { identityId: m[1] } : { personId: m[1] }, days, zone);
      return v ? ok(v) : bad('nobody by that id', 404);
    }
    // What changed (docs/history.md): a place's name, description, settings and members; a person's names, pictures
    // and profile across their identities.
    if ((m = path.match(/^\/api\/(conversations|spaces|persons|identities)\/([\w-]+)\/changes$/))) {
      const limit = Math.min(num('limit') ?? 100, 500);
      const kind = m[1] === 'conversations' ? 'conversation' : m[1] === 'spaces' ? 'space' : 'identity';
      const targets =
        m[1] === 'persons'
          ? (s.db.query('SELECT id FROM identity WHERE person_id = ?').all(m[2]) as { id: string }[]).map((r) => ({ kind: 'identity' as const, id: r.id }))
          : [{ kind: kind as P.ChangeView['target']['kind'], id: m[2] }];
      // ?fields=status,presence: only those; ?except=…: all but those.
      const list = (k: string) => url.searchParams.get(k)?.split(',').filter((f) => /^\w{1,32}$/.test(f)).slice(0, 20);
      // A person's page also has the roles they were given and lost in places.
      const rolesOf = kind === 'identity' ? targets.map((t) => t.id) : undefined;
      const changes = s.changes(targets, limit, { fields: list('fields'), except: list('except'), rolesOf });
      // Whoever they name, and whoever made them, for rendering.
      const named = new Set(changes.flatMap((c) => [c.identityId, c.actorId, c.target.kind === 'identity' ? c.target.id : undefined].filter((x): x is string => !!x)));
      return ok({ changes, identities: s.identitiesByIds(named) });
    }
    // What a file is (docs/files.md): looked at now if the walk hasn't got to it, fetching it first if need be, as
    // opening it would.
    if ((m = path.match(/^\/api\/attachments\/([\w-]+)\/info$/)) && method === 'GET') {
      const a = s.db.query(`SELECT a.url, a.name, a.mime, a.message_id, (SELECT account_id FROM message_seen x WHERE x.message_id = a.message_id LIMIT 1) AS account FROM attachment a WHERE a.id = ?`).get(m[1]) as
        | { url: string; name: string | null; mime: string | null; message_id: string; account: string | null }
        | null;
      if (!a) return bad('no such attachment', 404);
      const known = infoFor(s.db, [a.url]).get(a.url);
      if (known) return ok(known);
      const info = await this.mediaInfo.lookAt({ url: a.url, name: a.name, mime: a.mime, account: a.account }, (u, acc) => this.archiveOne(u, acc)).catch(() => null);
      if (!info) return bad(a.url.startsWith('data:') ? 'inline media' : 'the file could not be fetched', 404);
      s.dirty.messages.set(a.message_id, s.dirty.messages.get(a.message_id) ?? false);
      return ok(info);
    }
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/history$/))) {
      const h = s.messageHistory(m[1]);
      return h ? ok(h) : bad('no such message', 404);
    }
    if (path === '/api/retention') {
      if (method === 'PUT') {
        // Only the fields sent change: a device that has not loaded the settings yet cannot put the defaults back.
        const b = await body<Partial<P.RetentionSettings> & { confirm?: boolean; device?: string; showIn?: Record<string, 'shown' | 'hidden' | null> }>();
        const cur = s.retention();
        const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
        let sources = cur.sources;
        if (b.sources && typeof b.sources === 'object') {
          sources = {};
          for (const [k, v] of Object.entries(b.sources)) {
            if (!/^[\w-]{1,64}$/.test(k) || !v || typeof v !== 'object') continue;
            const o: Partial<P.KeepSettings> = {};
            for (const f of ['deleted', 'disappearing', 'edits', 'reactions', 'receipts'] as const) if (typeof v[f] === 'boolean') o[f] = v[f];
            if (Object.keys(o).length) sources[k] = o;
          }
        }
        const showIn = { ...cur.showIn };
        if (b.showIn && typeof b.showIn === 'object')
          for (const [k, v] of Object.entries(b.showIn)) {
            if (!/^[\w-]{1,64}$/.test(k)) continue;
            if (v === 'shown' || v === 'hidden') showIn[k] = v;
            else if (v === null) delete showIn[k];
          }
        const next: P.RetentionSettings = {
          deleted: bool(b.deleted, cur.deleted),
          disappearing: bool(b.disappearing, cur.disappearing),
          edits: bool(b.edits, cur.edits),
          reactions: bool(b.reactions, cur.reactions),
          receipts: bool(b.receipts, cur.receipts),
          changes: bool(b.changes, cur.changes),
          statuses: bool(b.statuses, cur.statuses),
          presence: bool(b.presence, cur.presence),
          members: bool(b.members, cur.members),
          voice: bool(b.voice, cur.voice ?? false),
          profiles: bool(b.profiles, cur.profiles ?? false),
          adversarial: bool(b.adversarial, cur.adversarial),
          show: b.show === 'hidden' ? 'hidden' : b.show === 'shown' || (b.show as unknown) === 'collapsed' ? 'shown' : cur.show,
          showIn,
          sources,
        };
        // Turning off what keeps or shows kept things is asked for on purpose, never by a stray save.
        const off = RETENTION_GUARDED.filter((k) => cur[k] && !next[k]);
        const offBySource = Object.entries(cur.sources).some(([k, v]) => (['deleted', 'disappearing'] as const).some((f) => v[f] === true && next.sources[k]?.[f] !== true));
        if ((off.length || offBySource) && b.confirm !== true)
          return Response.json({ error: `turning off ${off.length ? off.join(', ') : 'a source\'s keeping'} needs confirm: true`, confirm: off }, { status: 409 });
        const by = (typeof b.device === 'string' ? b.device : req.headers.get('user-agent') ?? 'unknown').slice(0, 160);
        s.setRetention(next, by);
        this.broadcast([{ t: 'retention', retention: s.retention() }]);
        // Shown or hidden, kept messages are served with or without their words: devices' kept copies are stale.
        if (cur.adversarial !== next.adversarial) this.resync();
      }
      return ok(s.retention());
    }
    if (path === '/api/retention/log') return ok({ changes: s.retentionLog() });
    if (path === '/api/retention/kept') return ok(s.keptKinds());
    if (path === '/api/retention/erase' && method === 'POST') {
      const b = await body<{ what?: string }>();
      if (!(KEPT_KINDS as readonly string[]).includes(b.what as string)) return bad(`what: ${KEPT_KINDS.join(', ')}`);
      const n = s.eraseKept(b.what as P.KeptKind);
      this.resync();
      return ok({ erased: n });
    }
    // What the network says about one identity (people.ts, docs/profile.md). ?fresh=1 asks even if a recent answer is kept.
    if ((m = path.match(/^\/api\/identities\/([\w-]+)\/about$/))) {
      if (!s.nativeOf('identity', m[1])) return bad('no such identity', 404);
      // Your own profile, on a network whose adapter can change it (capability 'editProfile'): the bio, and where it
      // says so the name, emoji, picture (an upload id, or null) and username (null deletes it).
      if (method === 'PUT') {
        const b = await body<{ bio?: unknown; name?: unknown; emoji?: unknown; avatar?: unknown; username?: unknown; pronouns?: unknown; banner?: unknown; accent?: unknown }>();
        const change: P.ProfileChange = {};
        if (b.bio !== undefined) {
          if (typeof b.bio !== 'string') return bad('bio: a string');
          change.bio = b.bio;
        }
        if (b.name !== undefined) {
          if (typeof b.name !== 'string' || !b.name.trim()) return bad('name: a name');
          change.name = b.name.trim().slice(0, 200);
        }
        if (b.emoji !== undefined) {
          if (typeof b.emoji !== 'string') return bad('emoji: an emoji, or "" for none');
          change.emoji = b.emoji;
        }
        if (b.username !== undefined) {
          if (b.username !== null && typeof b.username !== 'string') return bad('username: a name, or null to delete it');
          change.username = b.username;
        }
        if (b.avatar !== undefined) {
          if (b.avatar === null) change.avatar = null;
          else {
            const file = typeof b.avatar === 'string' ? this.uploads.get([b.avatar])?.[0] : undefined;
            if (!file) return bad('avatar: an upload id, or null to remove the picture');
            change.avatar = (await this.uploads.common([file], await this.jxlTools()))[0];
          }
        }
        // Pronouns, the banner and its colour (docs/account-self.md, Discord).
        if (b.pronouns !== undefined) {
          if (typeof b.pronouns !== 'string') return bad('pronouns: a string, or "" for none');
          change.pronouns = b.pronouns.trim().slice(0, 200);
        }
        if (b.banner !== undefined) {
          if (b.banner === null) change.banner = null;
          else {
            const file = typeof b.banner === 'string' ? this.uploads.get([b.banner])?.[0] : undefined;
            if (!file) return bad('banner: an upload id, or null to remove it');
            change.banner = (await this.uploads.common([file], await this.jxlTools()))[0];
          }
        }
        if (b.accent !== undefined) {
          if (b.accent !== null && (typeof b.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(b.accent))) return bad('accent: a colour like #5865f2, or null');
          change.accent = b.accent as string | null;
        }
        if (!Object.keys(change).length) return bad('bio, name, emoji, avatar, username, pronouns, banner or accent');
        try {
          const v = await this.people.setOwn(m[1], change);
          if (change.avatar) this.uploads.remove([b.avatar as string]);
          if (change.banner) this.uploads.remove([b.banner as string]);
          this.flush();
          return ok(v);
        } catch (e) {
          return bad((e as Error).message, (e as { status?: number }).status ?? 500);
        }
      }
      const v = await this.people.get(m[1], url.searchParams.get('fresh') === '1');
      this.flush();
      return ok(v);
    }
    // A post's thread (posts.ts, docs/feed.md "Threads"): read from the network and logged, else what the hub logged.
    // The same for a logged post's message (search, a profile's Recent messages): its post's thread.
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/thread$/)) && method === 'GET') {
      const n = s.nativeOf('message', m[1]);
      const post = n ? postIdOf(n.nativeId) : null;
      if (!n || !post) return bad('not a post', 404);
      try {
        const v = await this.posts.thread(n.network, post);
        this.flush();
        return ok(v);
      } catch (e) {
        return bad((e as Error).message, 502);
      }
    }
    if ((m = path.match(/^\/api\/posts\/([a-z]+)\/([A-Za-z0-9_.~:-]{1,120})\/thread$/)) && method === 'GET') {
      const network = m[1] as P.Network;
      if (!(network in NETWORK_META)) return bad('no such network', 404);
      const cursor = url.searchParams.get('cursor') ?? undefined;
      if (cursor && cursor.length > 2000) return bad('cursor: too long');
      try {
        const v = await this.posts.thread(network, m[2], cursor, url.searchParams.get('fresh') === '1');
        this.flush();
        return ok(v);
      } catch (e) {
        return bad((e as Error).message, 502);
      }
    }
    // Answering on a network with posts (posts.ts, docs/feed.md "Answering"): like, repost, post. Each is one press.
    if ((m = path.match(/^\/api\/posts\/([a-z]+)\/([A-Za-z0-9_.~:-]{1,120})\/act$/)) && method === 'POST') {
      const network = m[1] as P.Network;
      if (!(network in NETWORK_META)) return bad('no such network', 404);
      const b = await body<{ act?: unknown; account?: unknown }>();
      try {
        const r = await this.posts.act(network, m[2], String(b.act ?? '') as P.PostAct, typeof b.account === 'string' && b.account ? b.account : undefined);
        // The Feed page's timeline of that account follows what it did.
        this.timelines.noteAct(r.accountId, network, m[2], r.viewer);
        this.flush();
        return ok(r);
      } catch (e) {
        return bad((e as Error).message, e instanceof PostsError ? e.status : 500);
      }
    }
    if ((m = path.match(/^\/api\/posts\/([a-z]+)\/publish$/)) && method === 'POST') {
      const network = m[1] as P.Network;
      if (!(network in NETWORK_META)) return bad('no such network', 404);
      const b = await body<{ text?: unknown; replyTo?: unknown; quote?: unknown; key?: unknown; account?: unknown; warning?: unknown }>();
      try {
        const v = await this.posts.publish(network, { text: b.text, replyTo: b.replyTo, quote: b.quote, key: b.key, account: b.account, warning: b.warning });
        this.flush();
        return ok(v);
      } catch (e) {
        return bad((e as Error).message, e instanceof PostsError ? e.status : 500);
      }
    }
    // Following a post (follows.ts, docs/feed.md "Following a post"): PUT follows (reading the thread first), DELETE
    // stops the checks and keeps the conversation, GET says how it stands and which replies are new since it was read.
    if ((m = path.match(/^\/api\/posts\/([a-z]+)\/([A-Za-z0-9_.~:-]{1,120})\/follow$/)) && (method === 'PUT' || method === 'DELETE' || method === 'GET')) {
      const network = m[1] as P.Network;
      if (!(network in NETWORK_META)) return bad('no such network', 404);
      try {
        if (method === 'GET') {
          const f = this.follows.state(network, m[2], true);
          return f ? ok(f) : bad('That post is not followed.', 404);
        }
        const f = method === 'PUT' ? await this.follows.follow(network, m[2]) : this.follows.unfollow(network, m[2]);
        this.flush();
        return ok(f);
      } catch (e) {
        return bad((e as Error).message, e instanceof PostsError ? e.status : 500);
      }
    }
    // Delete a post of yours (posts.ts unpublish).
    if ((m = path.match(/^\/api\/posts\/([a-z]+)\/([A-Za-z0-9_.~:-]{1,120})\/delete$/)) && method === 'POST') {
      const network = m[1] as P.Network;
      if (!(network in NETWORK_META)) return bad('no such network', 404);
      const b = await body<{ account?: unknown }>();
      try {
        const r = await this.posts.unpublish(network, m[2], typeof b.account === 'string' && b.account ? b.account : undefined);
        this.flush();
        return ok(r);
      } catch (e) {
        return bad((e as Error).message, e instanceof PostsError ? e.status : 500);
      }
    }
    // An event (events.ts, docs/events.md): its page with every guest the site showed, and an RSVP sent as an account.
    if ((m = path.match(/^\/api\/events\/([a-z]+)\/([A-Za-z0-9_.~:-]{1,120})(\/rsvp)?$/)) && (m[3] ? method === 'POST' : method === 'GET')) {
      try {
        if (!m[3]) return ok(this.events.page(m[1], m[2], url.searchParams.get('account')));
        const v = await this.events.rsvp(m[1], m[2], await body<unknown>());
        this.flush();
        return ok(v);
      } catch (e) {
        return bad((e as Error).message, e instanceof PostsError ? e.status : 500);
      }
    }
    // The Feed page (timelines.ts, docs/feed.md "The Feed page"): sources, your feeds, timelines, posting to several
    // accounts, drafts.
    if (path.startsWith('/api/feed/')) {
      try {
        if (path === '/api/feed/sources' && method === 'GET') return ok(this.timelines.sources());
        if (path === '/api/feed/entries' && method === 'GET') {
          const before = url.searchParams.get('before');
          return ok(this.timelines.entries(url.searchParams.get('source') ?? 'following', before !== null && before !== '' ? Number(before) : undefined));
        }
        if (path === '/api/feed/read' && method === 'POST') {
          const b = await body<{ source?: unknown; older?: unknown }>();
          const v = await this.timelines.read(typeof b.source === 'string' ? b.source : 'following', b.older === true);
          this.flush();
          return ok(v);
        }
        if (path === '/api/feed/publish' && method === 'POST') {
          const v = await this.timelines.publish(await body<unknown>());
          this.flush();
          return ok(v);
        }
        const mm = path.match(/^\/api\/feed\/mixes\/([\w-]{1,40})$/);
        if (mm && method === 'PUT') return ok(this.timelines.saveMix(mm[1], await body<unknown>()));
        if (mm && method === 'DELETE') {
          this.timelines.dropMix(mm[1]);
          return ok({ ok: true });
        }
        if (path === '/api/feed/drafts' && method === 'GET') return ok({ drafts: this.timelines.drafts() });
        const dm = path.match(/^\/api\/feed\/drafts\/([\w-]{6,64})$/);
        if (dm && method === 'PUT') return ok(this.timelines.saveDraft(dm[1], await body<unknown>()));
        if (dm && method === 'DELETE') {
          this.timelines.dropDraft(dm[1]);
          return ok({ ok: true });
        }
      } catch (e) {
        return bad((e as Error).message, e instanceof PostsError ? e.status : 500);
      }
    }
    // Translation (translate.ts, docs/translate.md): the settings, and texts translated by the network or a server.
    if (path === '/api/translate/settings') {
      try {
        if (method === 'PUT') this.translator.setSettings(await body<Record<string, unknown>>());
        return ok({ settings: this.translator.settings(), networks: this.translator.networks() });
      } catch (e) {
        return bad((e as Error).message, e instanceof TranslateError ? e.status : 500);
      }
    }
    if (path === '/api/translate' && method === 'POST') {
      const b = await body<{ items?: unknown; to?: unknown }>();
      try {
        return ok(await this.translator.translate(b.items, b.to));
      } catch (e) {
        return bad((e as Error).message, e instanceof TranslateError ? e.status : 500);
      }
    }
    // Who liked or reposted a post, ranked for you (reactors.ts).
    if ((m = path.match(/^\/api\/posts\/([a-z]+)\/([A-Za-z0-9_.~:-]{1,120})\/reactors$/)) && method === 'GET') {
      const network = m[1] as P.Network;
      if (!(network in NETWORK_META)) return bad('no such network', 404);
      const kind = url.searchParams.get('kind') === 'repost' ? 'repost' : 'like';
      const cursor = url.searchParams.get('cursor') ?? undefined;
      if (cursor && cursor.length > 2000) return bad('cursor: too long');
      try {
        return ok(await this.posts.reactors(network, m[2], kind, cursor));
      } catch (e) {
        return bad((e as Error).message, e instanceof PostsError ? e.status : 500);
      }
    }
    // Who liked, reposted, replied to or quoted a post, from the feeds the hub holds: nothing is asked of the network.
    if ((m = path.match(/^\/api\/posts\/([a-z]+)\/([A-Za-z0-9_.~:-]{1,120})\/activity$/)) && method === 'GET') {
      const network = m[1] as P.Network;
      if (!(network in NETWORK_META)) return bad('no such network', 404);
      return ok(s.postActivity(network, m[2]));
    }
    // Your safety number with someone: mark it verified ({ safetyNumber }) or clear that ({ clear: true }).
    if ((m = path.match(/^\/api\/identities\/([\w-]+)\/verify$/)) && method === 'POST') {
      try {
        const v = await this.people.verify(m[1], await body<{ safetyNumber?: unknown; clear?: unknown }>());
        this.flush();
        return ok(v);
      } catch (e) {
        return bad((e as Error).message, (e as { status?: number }).status ?? 500);
      }
    }
    // Block someone or a group, or ({ unblock: true }) unblock them, on the owner's click (capability 'block').
    if ((m = path.match(/^\/api\/(identities|conversations)\/([\w-]+)\/block$/)) && method === 'POST') {
      const b = await body<{ unblock?: unknown }>();
      try {
        const v = m[1] === 'identities' ? await this.people.block(m[2], b.unblock === true) : await this.people.blockConversation(m[2], b.unblock === true);
        this.flush();
        return ok(v);
      } catch (e) {
        return bad((e as Error).message, (e as { status?: number }).status ?? 500);
      }
    }
    if ((m = path.match(/^\/api\/identities\/([\w-]+)\/person$/)) && method === 'POST') {
      if (!s.nativeOf('identity', m[1])) return bad('no such identity', 404);
      const personId = s.ensurePerson(m[1]);
      this.flush();
      return ok({ personId });
    }
    // Chats (chats.ts, docs/chats.md): a person or a conversation as one thing, whichever routes carry it.
    if ((m = path.match(/^\/api\/chats\/([\w:%-]+)(\/messages|\/read)?$/))) {
      const ref = chatRef(s, decodeURIComponent(m[1]));
      if (!ref) return bad('no such chat', 404);
      const id = chatIdOf(ref);
      const convs = () => [...new Set(chatRoutes(s, ref).filter((r) => !isEmailRoute(r)).map((r) => r.conversationId))];
      if (!m[2] && method === 'GET') return ok(chatView(s, ref));
      if (!m[2] && method === 'PATCH') {
        const b = await body<{ route?: { conversationId?: unknown; accountId?: unknown } | null; name?: unknown }>();
        if (b.name !== undefined) return bad(NICKNAME_MOVED);
        if (b.route !== undefined) {
          const r = b.route === null ? null : { conversationId: String(b.route.conversationId ?? ''), accountId: String(b.route.accountId ?? '') };
          if (!chooseRoute(s, ref, r)) return bad('that is not a route of this chat', 409);
        }
        return ok(chatView(s, ref));
      }
      if (m[2] === '/messages' && method === 'GET') {
        // A person's chat is their person timeline, so live events and sync (journal.ts) know it by the same key.
        const before = parseCursor(url.searchParams.get('before'));
        const limit = Math.min(num('limit') ?? 60, 200);
        // With mail (docs/mail.md "Mail as chats"): their mail with you alone, merged in by the same cursor, and what
        // they wrote in threads with others in the page's range.
        const places = ref.kind === 'person' ? mailPlaces(this.opts.mail) : null;
        if (ref.kind === 'person' && places?.chat) return ok(personPage(this.opts.mail!, places, s, ref.personId, before, limit));
        return ok(ref.kind === 'person' ? s.personTimeline(ref.personId, before, limit) : s.mergedTimeline([ref.conversationId], before, limit));
      }
      if (m[2] === '/messages' && method === 'POST') {
        const b = await body<SendBody & { route?: { conversationId?: string; accountId?: string } }>();
        const r = this.chatRoute(id, b);
        if (typeof r === 'string') return bad(r, 409);
        const { route: _, ...rest } = b;
        return this.sendOnce(r.conversationId, { ...rest, accountId: r.accountId });
      }
      if (m[2] === '/read' && method === 'POST') {
        const b = await body<{ upToTs?: number }>();
        for (const c of convs()) this.readConversation(c, b.upToTs ?? Date.now());
        this.flush();
        return ok();
      }
      return bad('not found', 404);
    }
    // How much of a place a view shows, chosen (rungs.ts, docs/mail.md "Mail as chats"): null takes the choice back.
    if (path === '/api/rungs' && method === 'PUT') {
      const b = await body<{ view?: unknown; place?: unknown; rung?: unknown }>();
      if (typeof b.view !== 'string' || !b.view || b.view.length > 300) return bad('view: a chat id');
      if (typeof b.place !== 'string' || !b.place || b.place.length > 300) return bad('place: a place id');
      if (b.rung !== null && !isRung(b.rung)) return bad(`rung: one of ${RUNGS.join(', ')}, or null`);
      setPlaceRung(s.db, b.view, b.place, b.rung);
      this.broadcast([{ t: 'rung', view: b.view, place: b.place, rung: b.rung }]);
      return ok();
    }
    // A channel's stream: its own messages and every thread's, by time (docs/threads.md "The channel stream").
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/stream$/)) && method === 'GET') {
      if (!s.one('SELECT 1 FROM conversation WHERE id = ?', m[1])) return bad('no such conversation', 404);
      return ok(s.mergedTimeline(s.channelStream(m[1]), parseCursor(url.searchParams.get('before')), Math.min(num('limit') ?? 60, 200)));
    }
    if ((m = path.match(/^\/api\/persons\/([\w-]+)\/timeline$/))) return ok(s.personTimeline(m[1], parseCursor(url.searchParams.get('before')), Math.min(num('limit') ?? 60, 200)));
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/notify$/))) return ok(this.triage.effectiveLevel(m[1]));
    // Muting a place on its network itself, with a timer (nativemute.ts, docs/notifications.md "Muted on the network").
    if ((m = path.match(/^\/api\/(conversations|spaces)\/([\w-]+)\/native-mute$/)) && method === 'POST') {
      // A click on the hub's own page: a browser sends Origin, and the server has refused any other site's.
      if (!req.headers.get('origin')) return bad('Muting on the network is done from the app itself', 403);
      try {
        const v = await setNativeMute(s, this.sup, m[1] === 'spaces' ? 'space' : 'conversation', m[2], await body<{ muted?: unknown; minutes?: unknown }>());
        this.flush();
        return ok(v);
      } catch (e) {
        if (e instanceof AboutError) return bad(e.message, e.status);
        throw e;
      }
    }
    // About and settings (about.ts, docs/group-settings.md). GET reads, POST changes one thing.
    if ((m = path.match(/^\/api\/(conversations|spaces)\/([\w-]+)\/about$/))) {
      const kind = m[1] === 'spaces' ? 'space' : 'conversation';
      try {
        if (method === 'POST') {
          const b = await body<{ change?: P.AboutChange; accountId?: string }>();
          // A new picture comes as an upload id (/api/uploads); the adapter gets the file as a file:// URL.
          let upload: string | null = null;
          let change = b.change as P.AboutChange;
          if (change?.key === 'avatar') {
            if (!req.headers.get('origin')) return bad('The picture is changed from the app itself', 403);
            upload = typeof change.value === 'string' ? change.value : null;
            const got = upload ? this.uploads.get([upload])?.[0] : undefined;
            if (!got) return bad('avatar: an upload id');
            const [file] = await this.uploads.common([got], await this.jxlTools());
            if (!P_PICTURE_TYPES.includes(file.mime)) return bad('A picture is a PNG, JPEG, GIF or WebP image', 415);
            if (file.size > P_PICTURE_MAX) return bad(`A picture is at most ${P_PICTURE_MAX / 1024 / 1024} MB`, 413);
            change = { key: 'avatar', value: pathToFileURL(file.path).href };
          }
          const v = await this.abouts.configure(kind, m[2], change, b.accountId);
          if (upload) this.uploads.remove([upload]);
          this.flush();
          return ok(v);
        }
        // ?kept=1: what was kept, without asking the network (null when nothing was).
        if (url.searchParams.get('kept') === '1') return ok(this.abouts.keptView(kind, m[2], url.searchParams.get('account') ?? undefined));
        const v = await this.abouts.get(kind, m[2], url.searchParams.get('account') ?? undefined);
        this.flush();
        return ok(v);
      } catch (e) {
        if (e instanceof AboutError) return bad(e.message, e.status);
        throw e;
      }
    }
    // Adding people to a group (about.ts, docs/group-settings.md): whom this account could add, and adding them.
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/members(\/candidates)?$/))) {
      const id = m[1];
      try {
        if (m[2] && method === 'GET') return ok(await candidatesAttempt(id, () => this.abouts.candidates(id, url.searchParams.get('account') ?? undefined)));
        if (!m[2] && method === 'POST') {
          const b = await body<{ identities?: unknown; accountId?: unknown }>();
          // Every attempt leaves one line in the hub's log, whatever came of it (attempts.ts).
          const v = await attempt(
            { kind: 'add', conversation: id, people: asked(b.identities) },
            (a) => {
              // A click on the hub's own page: a browser sends Origin, and the server has refused any other site's.
              if (!req.headers.get('origin')) throw new AboutError('People are added from the app itself', 403);
              return this.abouts.addMembers(id, b, a);
            },
            (acc, line) => this.sup.note(acc, line),
          );
          this.flush();
          return ok(v);
        }
      } catch (e) {
        if (e instanceof AboutError) return bad(e.message, e.status);
        throw e;
      }
    }
    // Making a group (groups.ts, docs/group-settings.md): who each account could put in one, and making it.
    if (path === '/api/groups/candidates' && method === 'GET') {
      try {
        return ok(await candidatesAttempt(null, () => this.groups.candidates(url.searchParams.get('account') ?? undefined)));
      } catch (e) {
        if (e instanceof AboutError) return bad(e.message, e.status);
        throw e;
      }
    }
    if (path === '/api/groups' && method === 'POST') {
      try {
        const b = await body<{ accountId?: unknown; name?: unknown; identities?: unknown }>();
        // Every attempt leaves one line in the hub's log, whatever came of it (attempts.ts).
        const v = await attempt(
          { kind: 'create', people: asked(b.identities) },
          (a) => {
            // A click on the hub's own page: a browser sends Origin, and the server has refused any other site's.
            if (!req.headers.get('origin')) throw new AboutError('Groups are made from the app itself', 403);
            return this.groups.create(b, a);
          },
          (acc, line) => this.sup.note(acc, line),
        );
        this.flush();
        return ok(v);
      } catch (e) {
        if (e instanceof AboutError) return bad(e.message, e.status);
        throw e;
      }
    }
    // Stickers to send and stories (media.ts, docs/media-kinds.md).
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/stickers$/)) && method === 'GET') {
      try {
        return ok(await this.kinds.stickers(m[1], url.searchParams.get('account') ?? undefined, url.searchParams.get('cursor') ?? undefined));
      } catch (e) {
        if (e instanceof MediaError) return bad(e.message, e.status);
        return bad(`The network did not list stickers: ${(e as Error).message}`, 502);
      }
    }
    // GIFs: search through an account that has it, and the ones already in your chats (docs/media-kinds.md "GIFs").
    if (path === '/api/gifs' && method === 'GET') {
      const q = url.searchParams;
      try {
        return ok(await this.kinds.gifs(q.get('conversation') ?? undefined, q.get('q') ?? undefined, q.get('cursor') ?? undefined));
      } catch (e) {
        if (e instanceof MediaError) return bad(e.message, e.status);
        return bad(`The network did not find GIFs: ${(e as Error).message}`, 502);
      }
    }
    if (path === '/api/gifs/yours' && method === 'GET') {
      const before = Number(url.searchParams.get('before'));
      return ok(this.kinds.yourGifs(before > 0 ? before : undefined));
    }
    if ((m = path.match(/^\/api\/accounts\/([\w-]+)\/stickers$/)) && method === 'POST') {
      // From the app itself, on the owner's click: installing a pack changes the account.
      if (!req.headers.get('origin')) return bad('Sticker packs are installed from the app itself', 403);
      const b = await body<{ uri?: string }>();
      if (typeof b.uri !== 'string' || !b.uri.trim()) return bad('Which pack? Paste its link.');
      try {
        return ok({ pack: await this.kinds.install(m[1], b.uri.trim().slice(0, 300)) });
      } catch (e) {
        if (e instanceof MediaError) return bad(e.message, e.status);
        return bad(`The network did not install it: ${(e as Error).message}`, 502);
      }
    }
    if (path === '/api/stories' && method === 'GET') {
      const identityId = url.searchParams.get('identity') ?? undefined;
      const conversationId = url.searchParams.get('conversation') ?? undefined;
      if (!identityId && !conversationId) return bad('whose stories?');
      return ok(this.kinds.stories({ identityId, conversationId }));
    }
    if ((m = path.match(/^\/api\/stories\/([\w-]+)\/(viewed|reply)$/)) && method === 'POST') {
      try {
        if (m[2] === 'viewed') return ok(this.kinds.viewed(m[1]));
        return ok(await this.kinds.reply(m[1], await body<{ body?: string; emoji?: string }>()));
      } catch (e) {
        if (e instanceof MediaError) return bad(e.message, e.status);
        return bad(`The network refused it: ${(e as Error).message}`, 502);
      }
    }
    // The composer's @ picker (mentions.ts, docs/mentions.md): who this conversation can ping.
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/mentionables$/)) && method === 'GET') {
      const v = await mentionables({ store: s, online: (a) => this.sup.online(a), command: (a, c, t) => this.sup.command(a, c, t), pickAccount: (c, a) => this.pickAccount(c, a) }, m[1], url.searchParams);
      return v ? ok(v) : bad('no such conversation', 404);
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/reaction-context$/))) {
      const conv = s.nativeOf('conversation', m[1]);
      if (!conv) return bad('no such conversation', 404);
      const accountId = this.pickAccount(m[1], url.searchParams.get('account') ?? undefined);
      if (isFeed(s.db, m[1])) return ok({ accountId, canReact: false, reason: feedRefusalFor(s.db, m[1])!, custom: [] } satisfies P.ReactionContextView);
      if (!accountId || !this.sup.online(accountId)) return ok({ accountId, canReact: false, reason: 'No connected account can react here.', custom: [] } satisfies P.ReactionContextView);
      const ctx = await this.sup.command<P.ReactionContext>(accountId, { t: 'reactionContext', conversation: conv.nativeId }, 15_000).catch(() => null);
      return ok(s.reactionContextView(accountId, conv.network, ctx ?? { canReact: true, custom: [] }));
    }

    // Files to send (docs/uploads.md): streamed to disk, whole in one request or a piece at a time at its offset.
    if (path.startsWith('/api/uploads')) {
      const fail = (e: any) => Response.json({ error: String(e?.message ?? e), ...(e?.received !== undefined ? { received: e.received } : {}) }, { status: e?.status ?? 400 });
      try {
        if (path === '/api/uploads' && method === 'POST') {
          const length = req.headers.get('content-length') ? Number(req.headers.get('content-length')) : undefined;
          if ((length ?? 0) > MAX_UPLOAD) return bad('that file is too large', 413);
          return ok(await this.uploads.receive(req.body, cleanFileName(req.headers.get('x-file-name')), req.headers.get('content-type') ?? '', { length }));
        }
        if (path === '/api/uploads/start' && method === 'POST') {
          const b = await body<{ name?: string; mime?: string; size?: number }>();
          return ok(this.uploads.start(cleanFileName(typeof b.name === 'string' ? b.name : null, false), String(b.mime ?? ''), Number(b.size)));
        }
        if ((m = path.match(/^\/api\/uploads\/([0-9a-f]{24})$/))) {
          if (method === 'GET') return this.uploads.state(m[1]) ? ok(this.uploads.state(m[1])) : bad('no such upload: it may have expired', 404);
          if (method === 'PUT') {
            if (Number(req.headers.get('content-length') ?? 0) > UPLOAD_CHUNK) return bad('piece too large', 413);
            return ok(await this.uploads.write(m[1], num('offset') ?? -1, req.body));
          }
          if (method === 'DELETE') return (this.uploads.remove([m[1]]), ok());
        }
      } catch (e) {
        return fail(e);
      }
    }
    // Index jobs (jobs.ts, docs/indexing.md).
    if (path === '/api/jobs' && method === 'GET') return ok({ jobs: this.jobs.list() });
    if (path === '/api/jobs' && method === 'POST') {
      try {
        return ok(this.jobs.create(await body<P.JobSpec>()));
      } catch (e: any) {
        return bad(String(e?.message ?? e));
      }
    }
    if ((m = path.match(/^\/api\/jobs\/([\w-]+)(?:\/(pause|resume|run))?$/))) {
      const id = m[1];
      if (method === 'DELETE') return this.jobs.remove(id) ? ok({ ok: true }) : bad('no such job', 404);
      let v: P.JobView | null = null;
      if (method === 'GET') v = this.jobs.get(id);
      else if (method === 'POST' && m[2] === 'pause') v = this.jobs.pause(id);
      else if (method === 'POST' && m[2] === 'resume') v = this.jobs.resume(id);
      else if (method === 'POST' && m[2] === 'run') v = this.jobs.runNow(id);
      else if (method === 'PATCH') v = this.jobs.update(id, await body<{ priority?: P.JobPriority; repeatHours?: number | null }>());
      return v ? ok(v) : bad('no such job', 404);
    }
    // History sources (docs/import.md): uploaded in pieces at their offset, so a dropped connection resumes.
    if ((m = path.match(/^\/api\/history-gaps\/([\w-]+)(\/stop)?$/))) {
      if (!s.account(m[1])) return bad('no such account', 404);
      try {
        if (method === 'GET') return ok(this.gapfill.status(m[1]));
        if (method === 'POST' && m[2]) return (this.gapfill.stop(m[1]), ok(this.gapfill.status(m[1])));
        if (method === 'POST') return ok(this.gapfill.start(m[1], { allChannels: !!(await body<{ allChannels?: boolean }>()).allChannels }));
      } catch (e: any) {
        return bad(String(e?.message ?? e));
      }
    }
    if (path.startsWith('/api/imports')) {
      const fail = (e: any) => Response.json({ error: String(e?.message ?? e), ...(e?.received !== undefined ? { received: e.received } : {}) }, { status: e?.status ?? 400 });
      try {
        if (path === '/api/imports' && method === 'GET') return ok({ sources: this.imports.list() });
        if (path === '/api/imports' && method === 'POST') {
          const b = await body<{ accountId?: string; name?: string; size?: number; files?: { path: string; size: number }[]; label?: string }>();
          const acc = b.accountId ? s.account(b.accountId) : null;
          if (!acc) return bad('no such account', 404);
          return ok(this.imports.create({ network: acc.network as P.Network, accountId: acc.id, name: b.name, size: b.size, files: Array.isArray(b.files) ? b.files : undefined, label: b.label }));
        }
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)\/data$/)) && method === 'PUT') {
          if (Number(req.headers.get('content-length') ?? 0) > IMPORT_CHUNK) return bad('piece too large', 413);
          return ok(await this.imports.put(m[1], num('offset') ?? -1, req.body, num('file') ?? 0));
        }
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)\/files$/)) && method === 'GET') return ok({ files: this.imports.uploadState(m[1]) });
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)\/passphrase$/)) && method === 'POST') return ok(this.imports.setPassphrase(m[1], String((await body<{ passphrase?: string }>()).passphrase ?? '')));
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)\/run$/)) && method === 'POST') return ok(this.importer.start(m[1], { dryRun: !!(await body<{ dryRun?: boolean }>()).dryRun }));
        if (path === '/api/imports/stop' && method === 'POST') return (this.importer.stop(), ok());
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)\/conflicts$/))) {
          const v = this.imports.view(m[1]);
          if (!v?.sha256) return bad('no such source', 404);
          if (method === 'POST') {
            const b = await body<{ messageId?: string; kind?: string; decision?: 'take-source' | 'ignore' | null }>();
            if (b.decision !== null && b.decision !== 'take-source' && b.decision !== 'ignore') return bad('decision is take-source, ignore or null');
            s.decideImportConflict(String(b.messageId), String(b.kind), v.sha256, b.decision);
            return ok();
          }
          return ok({ counts: s.importConflictCounts(v.sha256), items: s.importConflicts(v.sha256, Math.min(num('limit') ?? 50, 200), num('offset') ?? 0) });
        }
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)\/undo$/)) && method === 'POST') {
          const v = this.imports.view(m[1]);
          if (!v?.sha256) return bad('no such source', 404);
          if (this.importer.busy) return bad('an import is running', 409);
          const undone = s.undoImport(v.sha256);
          this.resync();
          return ok(undone);
        }
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)\/check$/)) && method === 'POST') {
          void this.imports.check(m[1]);
          return ok(this.imports.view(m[1]));
        }
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)$/))) {
          if (method === 'GET') return this.imports.view(m[1]) ? ok(this.imports.view(m[1])) : bad('no such source', 404);
          if (method === 'PATCH') {
            const b = await body<{ label?: string; accountId?: string | null }>();
            if (b.accountId && !s.account(b.accountId)) return bad('no such account', 404);
            const net = b.accountId ? (s.account(b.accountId)!.network as P.Network) : undefined;
            return ok(this.imports.patch(m[1], { label: b.label, accountId: b.accountId, network: net }));
          }
          if (method === 'DELETE') {
            if (this.importer.busy === m[1]) return bad('it is being imported; stop that first', 409);
            return (this.imports.remove(m[1]), ok());
          }
        }
      } catch (e) {
        return fail(e);
      }
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/send$/)) && method === 'POST') return this.sendOnce(m[1], await body<SendBody>());
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/forward$/)) && method === 'POST') {
      const b = await body<P.ForwardRequest>();
      const r = await forwardMessage(
        {
          store: s,
          uploads: this.uploads,
          online: (a) => this.sup.online(a),
          command: (a, c, t) => this.sup.command(a, c, t),
          pickAccount: (c, a) => this.pickAccount(c, a),
          sendRefusal: (c, a) => this.sendRefusal(c, a),
          media: (raw, a) => this.mediaBytes(raw, a),
        },
        m[1],
        { targets: Array.isArray(b.targets) ? b.targets : [], note: b.note },
      );
      this.flush();
      return 'error' in r ? bad(r.error, r.status) : ok({ results: r });
    }
    if (path === '/api/directs' && method === 'POST') {
      const b = await body<{ accountId?: string; peer?: string }>();
      const acc = b.accountId ? s.account(b.accountId) : null;
      if (!acc) return bad('no such account', 404);
      const name = NETWORK_META[acc.network].name;
      if (!(JSON.parse(acc.capabilities) as P.Capability[]).includes('openDirect')) return bad(`${acc.label} cannot start conversations on ${name}`, 409);
      if (!this.sup.online(acc.id)) return bad(`${acc.label} is not connected`, 409);
      const target = directTarget(acc.network, b.peer ?? '');
      if ('error' in target) return bad(target.error);
      if (acc.self_identity === hubId('idn', acc.network, target.peer)) return bad('That is this account');
      const r = await this.sup.command<P.OpenDirectResult>(acc.id, { t: 'openDirect', peer: target.peer }, 60_000).catch((e: Error) => e);
      if (r instanceof Error) return bad(r.message, 502);
      const id = hubId('cnv', acc.network, r.conversation);
      s.touchConversation(id);
      this.flush();
      return ok({ conversation: s.conversationView(id), existed: r.existed, startsAtFirstSend: !!r.startsAtFirstSend } satisfies P.OpenedDirect);
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/read$/)) && method === 'POST') {
      const b = await body<{ upToTs?: number }>();
      this.readConversation(m[1], b.upToTs ?? Date.now());
      this.flush();
      return ok();
    }
    if (path === '/api/read-all') {
      const q = this.opts.readQueue;
      if (!q) return bad('not available', 404);
      if (method === 'POST') {
        const b = await body<{ conversations?: string[] }>();
        if (!Array.isArray(b.conversations)) return bad('which conversations?');
        const marked = q.add(b.conversations);
        this.flush();
        return ok({ marked, pending: q.pending() });
      }
      return ok({ pending: q.pending() });
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/history$/)) && method === 'POST') {
      const b = await body<{ beforeTs?: number; limit?: number }>();
      const conv = s.nativeOf('conversation', m[1]);
      const accountId = this.pickAccount(m[1]);
      // A feed or the logged posts is no chat on the network: nothing to read back there (docs/feed.md).
      if (!conv || !accountId || isFeed(s.db, m[1])) return ok({ count: 0, done: true });
      const r = await this.sup.command(accountId, { t: 'history', conversation: conv.nativeId, beforeTs: b.beforeTs, limit: b.limit ?? 50 }, 60_000).catch((e) => ({ error: String(e.message) }));
      return ok(r ?? { count: 0, done: true });
    }
    // Mark Unread from a message on (unread.ts): here at once, and on each network that can.
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/unread$/)) && method === 'POST') {
      const r = markUnreadFrom(s, this.sup, m[1]);
      if (!r) return bad('no such message', 404);
      this.flush();
      return ok(r);
    }
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/react$/)) && method === 'POST') {
      const b = await body<{ key: string; remove?: boolean; style?: P.ReactionStyle; accountId?: string }>();
      if (!b.key) return bad('nothing to react with');
      const msg = s.one<{ conversation_id: string; native_id: string }>('SELECT conversation_id, native_id FROM message WHERE id = ?', m[1]);
      if (!msg) return bad('no such message', 404);
      const conv = s.nativeOf('conversation', msg.conversation_id)!;
      if (isFeed(s.db, msg.conversation_id)) return bad(feedRefusalFor(s.db, msg.conversation_id)!, 409);
      const style = b.style ?? 'normal';
      // Taking a reaction back has to go through the account that made it.
      const accountId = (b.remove && s.reactionAccount(m[1], b.key, style)) || this.pickAccount(msg.conversation_id, b.accountId);
      if (!accountId) return bad('no connected account can react here', 409);
      await this.sup.command(accountId, { t: 'react', conversation: conv.nativeId, message: msg.native_id, key: b.key, remove: b.remove, style, emoji: s.customEmoji(conv.network, b.key) });
      this.flush();
      return ok({ ok: true, accountId });
    }
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/reactors$/))) {
      const key = url.searchParams.get('key') ?? '';
      const style = (url.searchParams.get('style') ?? 'normal') as P.ReactionStyle;
      const msg = s.one<{ conversation_id: string; native_id: string }>('SELECT conversation_id, native_id FROM message WHERE id = ?', m[1]);
      if (!msg) return bad('no such message', 404);
      const before = s.messageView(m[1])?.reactions.find((r) => r.key === key && r.style === style);
      // Only ask the network when it has not told us everyone already.
      if (before && before.count > before.identityIds.length) {
        const conv = s.nativeOf('conversation', msg.conversation_id)!;
        const accountId = this.pickAccount(msg.conversation_id);
        const acc = accountId ? s.account(accountId) : null;
        if (acc && this.sup.online(acc.id)) {
          const r = await this.sup.command<{ authors?: string[]; at?: Record<string, number> }>(acc.id, { t: 'reactors', conversation: conv.nativeId, message: msg.native_id, key, style }, 20_000).catch(() => null);
          if (r?.authors?.length) s.addKnownReactors(acc, m[1], key, style, r.authors, r.at);
          this.flush();
        }
      }
      // With when each reacted, and who took theirs back (docs/reactions.md "When").
      return ok(s.reactorsView(m[1], key, style));
    }
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/(edit|delete)$/)) && method === 'POST') {
      const edit = m[2] === 'edit';
      const b = await body<{ body?: string }>();
      if (edit && !b.body?.trim()) return bad('empty message');
      const msg = s.one<{ conversation_id: string; native_id: string; author_id: string }>('SELECT conversation_id, native_id, author_id FROM message WHERE id = ?', m[1]);
      if (!msg) return bad('no such message', 404);
      if (isFeed(s.db, msg.conversation_id)) return bad(feedRefusalFor(s.db, msg.conversation_id)!, 409);
      // Only the account that wrote it can change it, and only on a network that allows it.
      const acc = s.accounts().find((a) => a.self_identity === msg.author_id);
      if (!acc) return bad('this message is not yours', 403);
      if (!(JSON.parse(acc.capabilities) as P.Capability[]).includes(edit ? 'edit' : 'redact')) return bad(`${NETWORK_META[acc.network].name} does not support this here`, 409);
      if (!this.sup.online(acc.id)) return bad(`${acc.label} is not connected`, 409);
      const conversation = s.nativeOf('conversation', msg.conversation_id)!.nativeId;
      const text = edit ? lowerForSend(s, msg.conversation_id, JSON.parse(acc.capabilities), b.body!) : '';
      await this.sup.command(acc.id, edit ? { t: 'edit', conversation, message: msg.native_id, body: text } : { t: 'redact', conversation, message: msg.native_id });
      this.flush();
      return ok();
    }
    // Your marks on a decision (P.TriageMarks): { alert: true } it should have alerted, { alert: false } the alert was
    // wrong, { less: true } less like this; null (or less: false) takes one back. An app from before the tiers still
    // sends { vote: 'up' | 'down' }: up says it should have alerted; down says the alert was wrong, or less like this.
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/feedback$/)) && method === 'POST') {
      const b = await body<{ alert?: unknown; less?: unknown; vote?: unknown }>();
      const marks: P.TriageMarks = {};
      if (typeof b.alert === 'boolean' || b.alert === null) marks.alert = b.alert;
      if (typeof b.less === 'boolean' || b.less === null) marks.less = b.less;
      if (b.alert === undefined && b.less === undefined && (b.vote === 'up' || b.vote === 'down')) {
        const was = s.one<{ decision: string }>('SELECT decision FROM triage WHERE message_id = ?', m[1])?.decision;
        if (b.vote === 'up') marks.alert = true;
        else if (was === 'push') marks.alert = false;
        else marks.less = true;
      }
      if (marks.alert === undefined && marks.less === undefined) return bad('Say alert: true, false or null, or less: true or false');
      if (!this.opts.votes) {
        s.triageMark(m[1], marks);
        return ok();
      }
      try {
        const r = this.opts.votes.mark(m[1], marks);
        // The same as Louder / Quieter on the loudness scale (loudlearn.ts): the old marks are its aliases.
        this.opts.loud?.fromMark(m[1], marks);
        this.flush();
        return ok(r);
      } catch (e: any) {
        return bad(e.message, 409);
      }
    }
    // The one loudness scale (loudlearn.ts, docs/notifications.md): its state and settings, check-ins, answers and why.
    if (path.startsWith('/api/loudness/') || /^\/api\/messages\/[\w-]+\/loudness$/.test(path)) {
      const r = await this.loudRoute(path, method, body);
      if (r) return r;
    }
    if (path === '/api/triage/policy' && method === 'GET') {
      if (!this.opts.votes) return bad('No triage here', 404);
      // The list's preview is worked out in the background (votes.ts): the first answer waits for it.
      await this.opts.votes.previewReady();
      return ok(this.opts.votes.view());
    }
    // The scorecard (scorecard.ts, docs/scorecard.md): each scored day's metrics, for the last ?days= days (60).
    if (path === '/api/model/scores' && method === 'GET') {
      if (!this.opts.scorecard) return bad('No scorecard here', 404);
      const days = Math.max(1, Math.min(400, Math.floor(Number(url.searchParams.get('days') ?? 60)) || 60));
      return ok(this.opts.scorecard.view(days));
    }
    // What the shadow model would have done lately (shadow.ts): counts only.
    if (path === '/api/triage/shadow' && method === 'GET') return this.opts.votes ? ok(this.opts.votes.shadow()) : bad('No triage here', 404);
    // The importance at which a message reaches the phone's list: { level: 0.01 to 0.99 }.
    if (path === '/api/triage/level' && method === 'PUT' && this.opts.votes) {
      const b = await body<{ level?: unknown }>();
      if (typeof b.level !== 'number' || !(b.level > 0 && b.level < 1)) return bad('Say level: a number between 0 and 1');
      this.opts.votes.setLevel(b.level);
      return ok(this.opts.votes.view());
    }
    if (path === '/api/triage/policy/relearn' && method === 'POST' && this.opts.votes) {
      this.opts.votes.learn('you asked');
      return ok(this.opts.votes.view());
    }
    // Forget something the model learned, for good ({ rejected: true }), or let it be learned again.
    if ((m = path.match(/^\/api\/triage\/factors\/([^/]+)$/)) && method === 'POST' && this.opts.votes) {
      const b = await body<{ rejected?: boolean }>();
      if (typeof b.rejected !== 'boolean') return bad('Say rejected: true or false');
      this.opts.votes.forget(decodeURIComponent(m[1]), b.rejected);
      return ok(this.opts.votes.view());
    }

    // The profile's merge box: people by any of their names or handles, and email identities no person holds yet.
    if (path === '/api/persons/candidates' && method === 'GET') return ok(s.mergeCandidates(url.searchParams.get('q') ?? '', url.searchParams.get('except')));
    if (path === '/api/persons/merge' && method === 'POST') {
      const b = await body<{ into: string; from: string }>();
      s.mergePersons(b.into, b.from);
      this.flush();
      this.matches.changed();
      return ok();
    }
    if ((m = path.match(/^\/api\/persons\/([\w-]+)$/)) && method === 'PATCH') {
      const b = await body<{ name?: unknown; note?: unknown; face?: unknown; picture?: unknown }>();
      if (b.name !== undefined) return bad(NICKNAME_MOVED);
      // Shown by one of their accounts (its name and picture), or null to let the hub choose (docs/chats.md, Names);
      // `picture`: another of theirs whose picture shows instead, or null for the face's (docs/profile.md).
      const idOrNull = (v: unknown) => v === undefined || v === null || typeof v === 'string';
      if (!idOrNull(b.face) || !idOrNull(b.picture)) return bad('face and picture are an identity id or null');
      if (b.face !== undefined || b.picture !== undefined) {
        if (!s.one('SELECT 1 FROM person WHERE id = ? AND is_self = 0', m[1])) return bad('no such person', 404);
        // Both checked before either is saved, so a refused request changes nothing.
        for (const id of [b.face, b.picture]) if (typeof id === 'string' && !s.one('SELECT 1 FROM identity WHERE id = ? AND person_id = ?', id, m[1])) return bad('that account is not theirs');
        if (b.face !== undefined) s.setPersonFace(m[1], b.face as string | null);
        if (b.picture !== undefined) s.setPersonPicture(m[1], b.picture as string | null);
      }
      s.updatePerson(m[1], { ...(typeof b.note === 'string' ? { note: b.note } : {}) });
      // Kept on their networks too, where an account keeps notes (capability 'contactNotes').
      if (typeof b.note === 'string') this.people.pushPersonNote(m[1], b.note);
      this.flush();
      return ok();
    }
    // Your nickname for one account of someone's (docs/chats.md, Names): a string sets it, null or '' takes it away.
    if ((m = path.match(/^\/api\/identities\/([\w-]+)$/)) && method === 'PATCH') {
      const b = await body<{ nickname?: unknown }>();
      if (b.nickname !== null && typeof b.nickname !== 'string') return bad('Say nickname: a name, or null to take it away');
      if (s.isSelf(m[1])) return bad('your own accounts go by the names you gave them on their networks');
      if (!s.setIdentityNickname(m[1], b.nickname ? b.nickname.trim().slice(0, 200) : null)) return bad('no such identity', 404);
      // Kept on their network too, where the account keeps nicknames (capability 'contactNotes').
      this.people.pushContactNotes(m[1], { nickname: b.nickname ? b.nickname.trim().slice(0, 200) : '' });
      this.flush();
      return ok({ identity: s.identitiesByIds([m[1]])[0] });
    }
    if ((m = path.match(/^\/api\/identities\/([\w-]+)\/split$/)) && method === 'POST') {
      const personId = s.splitIdentity(m[1]);
      this.flush();
      this.matches.changed();
      return ok({ personId });
    }
    if (path === '/api/folders' && method === 'PUT') {
      const b = await body<{ folders: P.FolderView[] }>();
      s.setFolders(b.folders ?? []);
      return ok();
    }
    if (path === '/api/place-prefs' && method === 'PATCH') {
      const b = await body<{ items: P.PlacePrefPatch[] }>();
      s.patchPlacePrefs(b.items ?? []);
      return ok();
    }
    // The activity log (activity.ts, docs/activity.md). Hub-only: never journaled or sent to other clients.
    if (path.startsWith('/api/activity')) {
      const a = this.opts.activity;
      if (!a) return bad('the activity log is not available', 404);
      if (path === '/api/activity' && method === 'GET') return ok(a.info());
      if (path === '/api/activity' && method === 'DELETE') return (a.clear(), ok(a.info()));
      if (path === '/api/activity/settings' && method === 'PUT') return ok({ settings: a.setSettings(await body<Partial<P.ActivitySettings>>()) });
      if (path === '/api/activity/visits' && method === 'POST') {
        const b = await body<{ visits?: Partial<P.VisitRecord>[] }>();
        return ok({ applied: a.visits(Array.isArray(b.visits) ? b.visits : []), enabled: a.enabled });
      }
      if (path === '/api/activity/actions' && method === 'POST') {
        const b = await body<{ actions?: Partial<P.InboxAction>[] }>();
        return ok({ applied: a.actions(Array.isArray(b.actions) ? b.actions : []), enabled: a.enabled });
      }
      if (path === '/api/activity/notifications' && method === 'POST') {
        const b = await body<{ events?: Partial<P.NotificationEvent>[] }>();
        const events = Array.isArray(b.events) ? b.events : [];
        const applied = a.events(events);
        // Swiped away is seen (docs/inbox.md): its conversation is scored again now, so an alert's pin goes at once.
        const swiped = applied ? a.conversationsOf(events.filter((e) => e?.event === 'dismissed').map((e) => e.id)) : [];
        const scores = swiped.length ? (this.opts.attention?.sync(swiped) ?? []) : [];
        if (scores.length) this.broadcast(scores);
        return ok({ applied, enabled: a.enabled });
      }
      if (path === '/api/activity/features' && method === 'GET') {
        const cid = url.searchParams.get('conversation');
        return ok(cid ? a.features(cid) : { places: a.top(Number(url.searchParams.get('limit')) || 10) });
      }
      const lines = path === '/api/activity/export' ? a.exportLog() : path === '/api/activity/examples' ? a.examples() : null;
      if (lines && method === 'GET') {
        const name = path.endsWith('examples') ? 'dither-triage-examples' : 'dither-activity';
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          pull(c) {
            let chunk = '';
            for (let i = 0; i < 500; i++) {
              const n = lines.next();
              if (n.done) {
                if (chunk) c.enqueue(enc.encode(chunk));
                return c.close();
              }
              chunk += n.value + '\n';
            }
            c.enqueue(enc.encode(chunk));
          },
        });
        return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', ...SAFE_HEADERS, 'content-disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.jsonl"` } });
      }
    }
    // Usage and automatic order (usage.ts, docs/organize.md).
    if (path === '/api/usage' || path === '/api/arrange') {
      const u = this.usage;
      if (path === '/api/arrange' && method === 'PATCH') {
        const arrange = u.patchArrange(await body());
        this.broadcast([{ t: 'arrange', arrange }]);
        return ok(arrange);
      }
      if (method === 'GET') return ok(u.state());
      if (method === 'POST') {
        const b = await body<{ batch?: string; deltas?: Partial<P.UsageDelta>[] }>();
        return ok({ applied: u.apply(typeof b.batch === 'string' ? b.batch.slice(0, 64) : undefined, Array.isArray(b.deltas) ? b.deltas : []) });
      }
      if (method === 'DELETE') {
        const b = await body<{ kind?: string; id?: string }>();
        u.reset(b.kind && b.id ? { kind: b.kind, id: b.id } : undefined);
        return ok();
      }
    }
    // Button counts (clicks.ts, docs/button-counts.md). Cross-site writes are refused above, like every write.
    if (path === '/api/usage/clicks') {
      if (method === 'GET') {
        const days = Math.min(Math.max(Math.floor(num('days') ?? 7) || 7, 1), 365);
        const by = url.searchParams.get('by');
        const limit = Math.min(Math.max(Math.floor(num('limit') ?? 200) || 200, 1), 1000);
        return ok(this.clicks.totals(days, by === 'device' || by === 'page' ? by : null, limit));
      }
      if (method === 'POST') {
        if (Number(req.headers.get('content-length') ?? 0) > CLICK_BODY_MAX) return bad('too many counts at once', 413);
        const text = await req.text();
        if (text.length > CLICK_BODY_MAX) return bad('too many counts at once', 413);
        let b: { batch?: unknown; counts?: unknown };
        try {
          b = JSON.parse(text);
        } catch {
          return bad('that is not JSON');
        }
        if (!Array.isArray(b?.counts)) return bad('counts: a list');
        return ok({ applied: this.clicks.apply(typeof b.batch === 'string' ? b.batch.slice(0, 64) : undefined, b.counts) });
      }
      if (method === 'DELETE') {
        this.clicks.forget();
        return ok();
      }
      return bad('GET, POST or DELETE', 405);
    }
    if (path.startsWith('/api/push')) {
      const push = this.opts.push;
      if (!push) return bad('push is not available', 404);
      if (path === '/api/push' && method === 'GET') return ok({ publicKey: push.publicKey, devices: push.devices(), servers: push.servers(), pending: push.pendingList(), topic: push.topicView() } satisfies P.PushInfo);
      if (path === '/api/push/subscribe' && method === 'POST') {
        const b = await body<{ subscription: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; label?: string; clears?: boolean }>();
        const sub = b.subscription;
        if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return bad('that is not a push subscription');
        const id = push.subscribe({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }, b.label, b.clears === true);
        if (id) {
          this.opts.devices?.touch();
          return ok({ id });
        }
        // Held for a while: allowing the server from the app (below) registers it without asking the device again.
        const p = push.pendingFor(sub.endpoint);
        if (!p) return bad('the hub cannot send to that push endpoint');
        const how = p.http ? `type ${p.origin} under Settings → Notifications → Push servers` : `open Settings → Notifications and tap Allow`;
        return Response.json({ error: `the hub does not send through ${p.origin} yet: ${how}`, server: p.origin, http: p.http }, { status: 403 });
      }
      // Which push servers the hub may POST to. Only the app itself changes this: a same-origin page, never a bare request.
      if (path === '/api/push/servers' && (method === 'POST' || method === 'DELETE')) {
        if (!req.headers.get('origin') || !(this.opts.open ? sameOriginOpen(req) : sameOrigin(req))) return bad('push servers are allowed from the app itself', 403);
        const b = await body<{ origin?: string; typed?: boolean; allowPrivate?: boolean; dismiss?: boolean }>();
        if (typeof b.origin !== 'string' || !b.origin) return bad('which server?');
        if (method === 'DELETE' && b.dismiss) return (push.dismiss(b.origin), ok());
        if (method === 'DELETE') {
          const r = push.revoke(b.origin);
          return r.ok ? ok(r) : bad(r.error!);
        }
        const r = await push.approve(b.origin, { typed: !!b.typed, allowPrivate: !!b.allowPrivate });
        return r.ok ? ok(r) : Response.json(r, { status: r.confirm ? 409 : 400 });
      }
      if (path === '/api/push/arrived' && method === 'POST') {
        const b = await body<{ id?: string }>();
        if (typeof b.id === 'string') push.arrived(b.id);
        return ok();
      }
      if (path === '/api/push/unsubscribe' && method === 'POST') {
        const b = await body<{ id?: string; endpoint?: string }>();
        push.remove(b);
        this.opts.devices?.touch();
        return ok();
      }
      if (path === '/api/push/test' && method === 'POST') {
        const b = await body<{ id?: string; endpoint?: string }>();
        return ok(await push.test(b));
      }
    }
    if (path === '/api/directory/stats') return ok(s.placeStats(Date.now() - 7 * 86_400_000));
    if (path === '/api/categories' && method === 'POST') {
      const b = await body<Partial<P.CategoryView>>();
      if (!b.name?.trim()) return bad('a category needs a name');
      const id = s.putCategory({ name: b.name.trim(), question: b.question?.trim() || `Is this community about ${b.name.trim()}?`, keywords: b.keywords ?? [], color: b.color ?? null, threshold: threshold(b.threshold) });
      this.opts.onCategoriesChanged?.();
      return ok({ id });
    }
    if (path === '/api/categories/probe' && method === 'POST') {
      const b = await body<{ question?: string }>();
      const question = b.question?.trim().slice(0, 300);
      if (!question) return bad('what should it ask?');
      if (!this.opts.probeCategory) return bad('no categorizer on this hub', 503);
      return ok(await this.opts.probeCategory(question));
    }
    if (path === '/api/categories/rescore' && method === 'POST') {
      this.opts.onCategoriesChanged?.(true);
      return ok();
    }
    if (path === '/api/category-overrides' && method === 'PUT') {
      const b = await body<{ categoryId: string; kind: 'space' | 'conversation'; id: string; assigned: boolean | null }>();
      if (!b.categoryId || !b.id || !['space', 'conversation'].includes(b.kind)) return bad('which category and place?');
      s.setCategoryOverride(b.categoryId, b.kind, b.id, b.assigned ?? null);
      return ok();
    }
    if ((m = path.match(/^\/api\/categories\/([\w-]+)$/))) {
      const cur = s.categories().find((c) => c.id === m![1]);
      if (!cur) return bad('no such category', 404);
      if (method === 'DELETE') {
        s.deleteCategory(cur.id);
        return ok();
      }
      if (method === 'PATCH') {
        const b = await body<Partial<P.CategoryView>>();
        s.putCategory({ ...cur, ...b, id: cur.id, threshold: 'threshold' in b ? threshold(b.threshold) : cur.threshold });
        this.opts.onCategoriesChanged?.();
        return ok();
      }
    }
    if (path === '/api/privacy') {
      if (method === 'PUT') {
        const b = await body<Partial<P.PrivacySettings>>();
        if (typeof b.shareTyping !== 'boolean') return bad('shareTyping: true or false');
        s.setPrivacy({ shareTyping: b.shareTyping });
      }
      return ok(s.privacy());
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/typing$/)) && method === 'POST') {
      const b = await body<{ accountId?: string; stop?: boolean }>();
      return ok(this.typing(m[1], b.accountId, !!b.stop));
    }
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/viewed$/)) && method === 'POST') return ok(this.viewed(m[1]));
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/reset-session$/)) && method === 'POST') {
      const b = await body<{ accountId?: string }>();
      const r = await this.resetSession(m[1], b.accountId);
      this.flush();
      return 'error' in r ? bad(r.error, r.status) : ok(r);
    }
    if (path === '/api/quiet-hours') {
      if (method === 'PUT') {
        const b = await body<Partial<P.QuietHours>>();
        if (!validQuietHours(b)) return bad('quiet hours need a start, an end and a time zone');
        s.setQuietHours({ enabled: !!b.enabled, start: b.start, end: b.end, timezone: b.timezone, days: b.days ?? [], allowStarred: !!b.allowStarred });
      }
      return ok({ quietHours: s.quietHours() });
    }
    // Per-device notification rules (docs/devices.md).
    if (path.startsWith('/api/devices')) {
      const d = this.opts.devices;
      if (!d) return bad('per-device rules are not available', 404);
      if (path === '/api/devices' && method === 'GET') return ok({ devices: d.list() });
      if (path === '/api/devices/hello' && method === 'POST') {
        const b = await body<{ id?: string; label?: string; endpoint?: string | null; clears?: boolean }>();
        if (!Devices.validId(b.id)) return bad('which device?');
        d.hello(b.id, typeof b.label === 'string' ? b.label : '', typeof b.endpoint === 'string' ? b.endpoint : null, Date.now(), b.clears === true);
        return ok();
      }
      if (path === '/api/devices/rules' && method === 'PUT') {
        const b = await body<{ device?: string; scope?: P.DeviceScope; target?: string; level?: P.DeviceLevel | null }>();
        if (!Devices.validId(b.device) || typeof b.target !== 'string' || !b.target) return bad('which device and place?');
        const err = d.setRule(b.device, b.scope as P.DeviceScope, b.target, b.level ?? null);
        return err ? bad(err) : ok();
      }
      if (path === '/api/devices' && method === 'DELETE') {
        const b = await body<{ id?: string }>();
        if (!Devices.validId(b.id)) return bad('which device?');
        d.forget(b.id);
        return ok();
      }
    }
    if (path === '/api/rules' && method === 'PUT') {
      const b = await body<{ scope: P.NotifyScope; target: string | null; level: P.NotifyLevel | null }>();
      // Always alert, List only or Mute; null is Automatic (no rule).
      if (b.level != null && !(RULE_LEVELS as readonly string[]).includes(b.level)) return bad('A rule is all (always alert), digest (list only) or none (mute); null for automatic');
      // Triage reads a person or a keyword only as "always alert": there is nothing else to set on one.
      if ((b.scope === 'person' || b.scope === 'keyword') && b.level != null && b.level !== 'all') return bad('A person or a keyword can only be set to always alert (all); null takes the rule away');
      s.setRule(b.scope, b.target ?? null, b.level ?? null);
      // Conversations under this rule now explain themselves differently.
      for (const c of s.raw<{ id: string }>('SELECT id FROM conversation')) s.dirty.conversations.add(c.id);
      return ok();
    }

    // The one list (docs/accounts.md): dither-accounts' kinds for Add account, asking it for more, and adding an account
    // of a kind that is not a chat network (Proton Mail) there.
    const mgr = this.opts.manager;
    if (path === '/api/accounts/kinds' && method === 'GET') {
      return ok({ kinds: (await mgr?.kinds().catch(() => null)) ?? null, url: s.accountsManager?.url ?? null } satisfies P.KindsPage);
    }
    if ((m = path.match(/^\/api\/accounts\/kinds\/([\w.-]+)\/ask$/)) && method === 'POST') {
      if (!mgr) return bad('This hub has no dither-accounts', 409);
      try {
        await mgr.askKind(m[1]);
      } catch (e) {
        return bad((e as Error).message, (e as { status?: number }).status ?? 502);
      }
      return ok();
    }
    if (path === '/api/accounts/managed' && method === 'POST') {
      if (!mgr) return bad('This hub has no dither-accounts', 409);
      const b = await body<{ kind?: unknown; label?: unknown; form?: unknown }>();
      if (typeof b.kind !== 'string' || !/^[\w.-]{1,40}$/.test(b.kind)) return bad('kind is a kind name');
      if (isChatKind(b.kind)) return bad('Chat accounts are added with POST /api/accounts');
      const form: Record<string, string> = {};
      if (b.form && typeof b.form === 'object' && !Array.isArray(b.form))
        for (const [k, v] of Object.entries(b.form).slice(0, 50)) if (typeof v === 'string' && /^[\w.-]{1,40}$/.test(k)) form[k] = v.slice(0, 4000);
      try {
        const id = await mgr.create(b.kind, typeof b.label === 'string' ? b.label.trim().slice(0, 200) : '', form);
        return ok({ id });
      } catch (e) {
        return bad((e as Error).message, (e as { status?: number }).status ?? 502);
      }
    }
    if ((m = path.match(/^\/api\/accounts\/([\w-]+)\/ask$/)) && method === 'POST') {
      if (!mgr) return bad('This hub has no dither-accounts', 409);
      const b = await body<{ interface?: unknown }>();
      if (typeof b.interface !== 'string' || !ASK_LEVEL[b.interface]) return bad(`interface is one of ${Object.keys(ASK_LEVEL).join(', ')}`);
      try {
        await mgr.ask(m[1], b.interface);
      } catch (e) {
        return bad((e as Error).message, (e as { status?: number }).status ?? 502);
      }
      return ok();
    }
    // An account with no chat account here (mail, notices) is run through the manager: restart, its log, enabling, removing.
    const only = (id: string) => (s.account(id) ? null : (mgr?.managedOnly(id) ?? null));
    if ((m = path.match(/^\/api\/accounts\/([\w-]+)(\/action|\/log)?$/)) && only(m[1])) {
      const id = m[1];
      try {
        if (!m[2] && method === 'DELETE') {
          await mgr!.remove(id, url.searchParams.get('purge') === '1');
          return ok();
        }
        if (!m[2] && method === 'PATCH') {
          const b = await body<{ enabled?: unknown }>();
          if (typeof b.enabled !== 'boolean') return bad('Only enabled can change here; rename it on dither-accounts’ page');
          await mgr!.setEnabled(id, b.enabled);
          return ok();
        }
        if (m[2] === '/action' && method === 'POST') {
          const b = await body<{ action?: string }>();
          if (b.action !== 'restart') return bad('Only restart, for an account with no chats here');
          await mgr!.restart(id);
          return ok();
        }
        if (m[2] === '/log') {
          const text = await mgr!.log(id).catch((e: Error) => `(the log is not available: ${e.message})`);
          return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', ...SAFE_HEADERS } });
        }
      } catch (e) {
        return bad((e as Error).message, (e as { status?: number }).status ?? 502);
      }
    }

    if (path === '/api/accounts' && method === 'POST') {
      const b = await body<{ network: P.Network; label?: string; color?: string; adapter?: string; config?: unknown; secret?: unknown }>();
      if (!NETWORKS.includes(b.network)) return bad('unknown network');
      if (b.adapter !== undefined && !validAdapterName(b.adapter)) return bad('unknown adapter');
      if (s.accounts().some((a) => a.demo)) return bad('This is a demo hub. Real accounts go on a hub with its own data dir, started without --demo.');
      // A calendar (docs/calendar.md): one, at an http(s) address; the hub runs its link itself.
      if (b.network === 'calendar') {
        if (!this.opts.calendar) return bad('This hub has no calendar accounts', 409);
        if (s.accounts().some((a) => a.network === 'calendar')) return bad('There is a calendar account already. Remove it first to use another calendar.', 409);
        const given = (b.config as { url?: unknown } | null)?.url;
        const url = given === undefined || given === '' ? CALENDAR_URL_DEFAULT : calendarAccountUrl(b.config);
        if (!url) return bad("The calendar's address is an http(s) URL, like http://127.0.0.1:8470");
        b.config = { url };
        b.adapter = 'calendar';
      }
      const used = new Set(s.accounts().map((a) => a.color));
      const color = b.color ?? ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[0];
      const acc = s.createAccount({ network: b.network, label: b.label?.trim() || NETWORK_META[b.network].name, color, adapter: b.adapter ?? b.network, config: b.config });
      // Added by hand: the first start's seed never adds one again (calendar-account.ts).
      if (b.network === 'calendar') markCalendarAdded(s);
      if (this.sup.created) {
        try {
          await this.sup.created(acc, b.secret ?? {});
        } catch (e) {
          // Not added after all (dither-accounts is down, or refused it): the row goes too.
          s.deleteAccount(acc.id);
          this.flush();
          return bad((e as Error).message, (e as { status?: number }).status ?? 502);
        }
      } else {
        this.sup.writeSecret(acc.id, b.secret ?? {});
        this.sup.start(acc.id);
      }
      this.opts.calendar?.sync();
      return ok(s.accountView(acc));
    }
    if ((m = path.match(/^\/api\/accounts\/([\w-]+)$/))) {
      const acc = s.account(m[1]);
      if (!acc) return bad('no such account', 404);
      if (method === 'DELETE') {
        await this.sup.stop(acc.id);
        // ?purge=1: dither-accounts deletes the session's directory too, if it made it.
        await this.sup.forget?.(acc.id, url.searchParams.get('purge') === '1');
        s.deleteAccount(acc.id);
        this.opts.calendar?.sync();
        this.flush();
        return ok();
      }
      if (method === 'PATCH') {
        const b = await body<{ label?: string; color?: string; enabled?: boolean }>();
        s.updateAccount(acc.id, {
          ...(b.label !== undefined ? { label: b.label } : {}),
          ...(b.color !== undefined ? { color: b.color } : {}),
          ...(b.enabled !== undefined ? { enabled: b.enabled ? 1 : 0 } : {}),
        });
        if (b.label !== undefined) await this.sup.renamed?.(acc.id, b.label);
        if (b.enabled === false) {
          await this.sup.stop(acc.id);
          s.updateAccount(acc.id, { status: 'disabled' });
        } else if (b.enabled === true) this.sup.start(acc.id);
        if (b.enabled !== undefined) this.opts.calendar?.sync();
        return ok();
      }
    }
    if ((m = path.match(/^\/api\/accounts\/([\w-]+)\/action$/)) && method === 'POST') {
      const b = await body<{ action: string; args?: unknown }>();
      if (b.action === 'restart') {
        await this.sup.restart(m[1]);
        return ok();
      }
      const r = await this.sup.command(m[1], { t: 'action', action: b.action, args: b.args }, 60_000);
      return ok({ ok: true, result: r });
    }
    if ((m = path.match(/^\/api\/accounts\/([\w-]+)\/log$/))) {
      // Local accounts' logs are here; remote ones' are wherever dither-accounts keeps the account.
      const text = (await this.sup.log?.(m[1]).catch((e: Error) => `(the log is not available: ${e.message})`)) ?? '';
      return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', ...SAFE_HEADERS } });
    }
    return bad('not found', 404);
  }

  /**
   * Where a send in a chat goes: the route the sender said; else a reply goes where the message it answers is; else
   * the chat's route. An error sentence when there is none.
   */
  private chatRoute(chatId: string, b: { route?: { conversationId?: string; accountId?: string }; replyTo?: string }): { conversationId: string; accountId: string } | string {
    const s = this.store;
    const ref = chatRef(s, chatId);
    if (!ref) return 'no such chat';
    // Mail is sent through POST /api/mail/send (docs/mail.md "Mail as chats"): a chat route by email is not one here.
    if (b.route?.conversationId && isEmailRoute({ conversationId: b.route.conversationId })) return 'mail is sent through /api/mail/send';
    const routes = chatRoutes(s, ref).filter((r) => !isEmailRoute(r));
    const asked = b.route ? routes.find((r) => r.conversationId === b.route!.conversationId && (!b.route!.accountId || r.accountId === b.route!.accountId)) : undefined;
    if (b.route && !asked) return 'that is not a route of this chat';
    const replied = !asked && b.replyTo ? s.one<{ conversation_id: string }>('SELECT conversation_id FROM message WHERE id = ?', b.replyTo) : null;
    const replyRoute = replied ? routes.find((r) => r.conversationId === replied.conversation_id) : undefined;
    const r = asked ?? replyRoute ?? defaultRoute(s, chatIdOf(ref), routes);
    return r ? { conversationId: r.conversationId, accountId: r.accountId } : 'nowhere to send this';
  }

  /** Read up to a time, here and on the network through each account in it. */
  private readConversation(conversationId: string, upToTs: number) {
    const s = this.store;
    const targets = s.markRead(conversationId, upToTs);
    const conv = s.nativeOf('conversation', conversationId);
    // An open message request: reading it here tells the sender nothing until it is accepted (add.ts). A feed's reads
    // stay on the hub (docs/feed.md): the network's own notifications page keeps its own.
    for (const t of requestHeld(s.db, conversationId) || isFeed(s.db, conversationId) ? [] : targets) {
      if (conv && t.upTo && this.sup.online(t.accountId))
        this.sup.command(t.accountId, { t: 'markRead', conversation: conv.nativeId, upTo: t.upTo }).catch(() => {});
    }
  }

  /** A send retried after its answer was lost goes out once: the retry gets the first one's answer. */
  private async sendOnce(conversationId: string, b: SendBody): Promise<Response> {
    const key = typeof b.clientId === 'string' && b.clientId ? `${conversationId}|${b.clientId.slice(0, 64)}` : null;
    const now = Date.now();
    for (const [k, v] of this.sends) if (now - v.at > 15 * 60_000) this.sends.delete(k);
    const earlier = key ? this.sends.get(key) : undefined;
    if (earlier) return (await earlier.done).clone();
    const done = this.sendNow(conversationId, b);
    if (key) this.sends.set(key, { at: now, done });
    try {
      const res = await done;
      if (key && !res.ok) this.sends.delete(key);
      return res.clone();
    } catch (e) {
      // The adapter took it and then went quiet: it may well have gone out. A retry with the same id gets this
      // answer rather than a second copy; a new send (a new id) is the person's call.
      if (key && unknownOutcome(e)) {
        const answer = Response.json({ error: 'The network did not answer in time. It may have been sent: look before sending it again.', unknown: true }, { status: 504 });
        this.sends.set(key, { at: now, done: Promise.resolve(answer) });
        return answer.clone();
      }
      if (key) this.sends.delete(key);
      throw e;
    }
  }

  private async sendNow(conversationId: string, b: SendBody): Promise<Response> {
    const s = this.store;
    const ok = (x: unknown) => Response.json(x);
    const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });
    const ids = b.attachments ?? [];
    const sticker = typeof b.sticker === 'string' && b.sticker ? b.sticker.slice(0, 128) : undefined;
    if (!b.body?.trim() && !ids.length && !sticker) return bad('empty message');
    const conv = s.nativeOf('conversation', conversationId);
    if (!conv) return bad('no such conversation', 404);
    const accountId = this.pickAccount(conversationId, b.accountId);
    if (!accountId) return bad('no connected account can send here', 409);
    const refused = this.sendRefusal(conversationId, accountId);
    if (refused) return bad(refused, 409);
    const replyTo = b.replyTo ? s.nativeOf('message', b.replyTo)?.nativeId : undefined;
    let files = this.uploads.get(ids);
    if (!files) return bad('that upload has expired, attach the file again', 410);
    // A JPEG XL goes as a JPEG or PNG: no chat network shows one as a picture (jxl.ts). Mail keeps the file as it is.
    if (conv.network !== 'email') files = await this.uploads.common(files, await this.jxlTools());
    const acc = s.account(accountId)!;
    const accCaps = JSON.parse(acc.capabilities) as P.Capability[];
    const name = NETWORK_META[conv.network].name;
    if (files.length) {
      const limit = ATTACHMENT_LIMITS[conv.network];
      if (!accCaps.includes('sendMedia')) return bad(`${acc.label} cannot send files on ${name}`, 409);
      if (files.length > limit.files) return bad(`${name} takes ${limit.files} files at a time`, 413);
      if (files.some((f) => f.size > limit.bytes)) return bad(`${name} takes files up to ${limit.bytes / 1024 / 1024} MB`, 413);
    }
    // Asked for, but not something this account does: refused rather than sent with a ping or a sound after all.
    const can = accCaps;
    if (b.silent === true && !can.includes('silentSend')) return bad(`${acc.label} cannot send silently on ${name}`, 409);
    const noPing = b.mentionReplied === false && !!replyTo;
    if (noPing && !can.includes('replyMention')) return bad(`${acc.label} cannot reply without a ping on ${name}`, 409);
    const extras = { ...(b.silent === true ? { silent: true } : {}), ...(noPing ? { mentionReplied: false } : {}) };
    const media = sendMediaProblem({ sticker, files: files.length, voice: b.voice, viewOnce: b.viewOnce === true }, accCaps, `${acc.label} on ${name}`);
    if (media.error) return bad(media.error, 409);
    if (media.voice) files = files.map((f, i) => (i === 0 ? { ...f, voice: media.voice } : f));
    if (b.gif === true && files.length === 1 && !media.voice && can.includes('sendGifs')) files = [{ ...files[0], gif: true }];
    // Person and identity references become the network's mentions or plain names (mentionrefs.ts).
    const text = lowerForSend(s, conversationId, accCaps, b.body ?? '');
    const preview = files.length || sticker ? null : await this.linkPreview(accountId, text);
    let result: unknown;
    try {
      result = await this.sup.command(
        accountId,
        { t: 'send', conversation: conv.nativeId, body: text, replyTo, ...(files.length ? { attachments: files } : {}), ...(preview ? { preview } : {}), ...(sticker ? { sticker } : {}), ...(media.viewOnce ? { viewOnce: true } : {}), ...extras },
        files.length ? 180_000 : undefined,
      );
    } finally {
      if (preview?.image) rmSync(preview.image, { force: true });
    }
    this.uploads.remove(ids);
    // Message ids are derived from the network's, so this is the message's id whether or not it is stored yet.
    const native = (result as { nativeId?: unknown } | undefined)?.nativeId;
    const messageId = typeof native === 'string' && native ? hubId('msg', conv.network, native) : undefined;
    // On the socket too, which on a slow link may beat this answer to the page that sent it (web outbox.ts).
    if (messageId && typeof b.clientId === 'string' && b.clientId) {
      s.dirty.extra.push({ t: 'sent', conversationId, clientId: b.clientId.slice(0, 64), messageId });
      this.flush();
    }
    return ok({ ok: true, accountId, result, ...(messageId ? { messageId } : {}) } satisfies P.SendResult);
  }

  /**
   * You are typing in a conversation, or stopped: tell its network through the account that would send (docs/typing.md).
   * Best effort and never waited for. Nothing goes out when you chose not to share it; a stop always may.
   */
  typing(conversationId: string, requested: string | undefined, stop: boolean): { sent: boolean; accountId?: string; why?: string } {
    if (!stop && !this.store.privacy().shareTyping) return { sent: false, why: 'off' };
    if (requestHeld(this.store.db, conversationId)) return { sent: false, why: 'a message request' };
    if (isFeed(this.store.db, conversationId)) return { sent: false, why: 'notifications' };
    const conv = this.store.nativeOf('conversation', conversationId);
    const accountId = conv && this.pickAccount(conversationId, requested);
    if (!conv || !accountId || !this.sup.online(accountId)) return { sent: false, why: 'no connected account' };
    const acc = this.store.account(accountId)!;
    if (!(JSON.parse(acc.capabilities) as P.Capability[]).includes('typing')) return { sent: false, why: 'not on this network' };
    if (this.sendRefusal(conversationId, accountId)) return { sent: false, why: 'cannot write here' };
    if (!this.typingGate.allow(accountId, conversationId, stop)) return { sent: false, why: 'throttled' };
    this.sup.command(accountId, { t: 'typing', conversation: conv.nativeId, ...(stop ? { stop: true } : {}) }, 15_000).catch(() => {});
    return { sent: true, accountId };
  }

  /**
   * A preview of the first link in what you send (unfurl.ts), for an account that sends previews (capability
   * 'linkPreviews': on Signal, while your phone's link-preview setting is on). Null otherwise, or when the page gives none.
   */
  private async linkPreview(accountId: string, body: string): Promise<P.LinkPreviewOut | null> {
    const acc = this.store.account(accountId);
    if (!acc || !(JSON.parse(acc.capabilities) as P.Capability[]).includes('linkPreviews')) return null;
    const url = firstLink(body);
    if (!url) return null;
    const dir = join(this.opts.dataDir, 'previews');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return unfurl(url, dir, crypto.randomUUID()).catch(() => null);
  }

  /**
   * You played a voice note or opened a video in someone's message: tell them, through the account that saw it, where its
   * network has viewed receipts (capability 'viewed'; docs/messages.md). Best effort, once per message, never waited
   * for; the adapter keeps its network's rules (Signal: read receipts on, not in a message request).
   */
  viewed(messageId: string): { sent: boolean; why?: string } {
    const s = this.store;
    const row = s.db.query('SELECT conversation_id, native_id, author_id FROM message WHERE id = ?').get(messageId) as { conversation_id: string; native_id: string; author_id: string | null } | null;
    if (!row) return { sent: false, why: 'no such message' };
    if (s.isSelf(row.author_id)) return { sent: false, why: 'your own' };
    if (this.viewedSent.has(messageId)) return { sent: false, why: 'already' };
    if (requestHeld(s.db, row.conversation_id)) return { sent: false, why: 'a message request' };
    const conv = s.nativeOf('conversation', row.conversation_id);
    const accountId = conv && this.pickAccount(row.conversation_id);
    if (!conv || !accountId || !this.sup.online(accountId)) return { sent: false, why: 'no connected account' };
    if (!(JSON.parse(s.account(accountId)!.capabilities) as P.Capability[]).includes('viewed')) return { sent: false, why: 'not on this network' };
    this.viewedSent.add(messageId);
    if (this.viewedSent.size > 5000) this.viewedSent.delete(this.viewedSent.values().next().value!);
    this.sup.command(accountId, { t: 'viewed', conversation: conv.nativeId, message: row.native_id }, 30_000).catch(() => {});
    return { sent: true };
  }

  /** Reset the encrypted session in a direct conversation (capability 'resetSession'): its About's "Reset secure session". */
  async resetSession(conversationId: string, requested?: string): Promise<{ ok: true } | { error: string; status: number }> {
    const s = this.store;
    const c = s.conversationView(conversationId);
    const conv = s.nativeOf('conversation', conversationId);
    if (!c || !conv) return { error: 'no such conversation', status: 404 };
    if (c.shape !== 'direct') return { error: 'Only a conversation with one person has a secure session to reset', status: 400 };
    if (requestHeld(s.db, conversationId)) return { error: 'Accept the message request first', status: 409 };
    const accountId = this.pickAccount(conversationId, requested);
    if (!accountId || !this.sup.online(accountId)) return { error: 'no connected account can do that here', status: 409 };
    if (!(JSON.parse(s.account(accountId)!.capabilities) as P.Capability[]).includes('resetSession')) return { error: `Resetting the session is not built for ${NETWORK_META[conv.network].name}`, status: 409 };
    try {
      await this.sup.command(accountId, { t: 'resetSession', conversation: conv.nativeId }, 60_000);
      return { ok: true };
    } catch (e) {
      return { error: `The network refused it: ${(e as Error).message}`, status: 502 };
    }
  }

  private sendRefusal(conversationId: string, accountId: string | null): string | null {
    // Writing to an open message request would answer it: Accept first, under Requests (docs/add.md).
    if (requestHeld(this.store.db, conversationId)) return 'Accept the message request first';
    // A network's notifications are read-only (docs/feed.md).
    const feed = feedRefusalFor(this.store.db, conversationId);
    if (feed) return feed;
    const c = this.store.conversationView(conversationId);
    const acc = accountId ? this.store.account(accountId) : null;
    return c ? sendBlocker(c, acc ? this.store.accountView(acc) : null) : 'No such conversation';
  }

  /**
   * What a push needs for replying from the notification: whether to offer it, and what to quote. The send itself is
   * re-checked when it arrives, since this can be out of date by then. A DM has no need for a quote.
   */
  replyFields(conversationId: string, messageId: string): { canReply?: true; replyTo?: string } {
    if (this.sendRefusal(conversationId, this.pickAccount(conversationId))) return {};
    return this.store.conversationView(conversationId)?.shape === 'direct' ? { canReply: true } : { canReply: true, replyTo: messageId };
  }

  private pickAccount(conversationId: string, requested?: string): string | null {
    return pickAccount(this.store, (a) => this.sup.online(a), conversationId, requested);
  }

  // ---------------------------------------------------------------- voice crypto

  /**
   * Discord's DAVE library for direct-mode calls, as scripts/dave/update.ts extracted, tested and promoted
   * it. Never part of this repo: it lives in DITHER_DAVE_DIR. The device loads it into an opaque-origin
   * worker, hence the open CORS header; it is public code and holds nothing of the user's.
   */
  private daveRoot(): string {
    return process.env.DITHER_DAVE_DIR ?? join(this.opts.dataDir, 'dave');
  }

  private daveCurrent(): Response {
    const file = join(this.daveRoot(), 'current.json');
    if (!existsSync(file)) return Response.json({ error: 'No DAVE library yet. Run: bun scripts/dave/update.ts --root ' + this.daveRoot() }, { status: 404 });
    const cur = JSON.parse(readFileSync(file, 'utf8')) as { dir: string; build?: string; maxProtocolVersion?: number };
    const id = cur.dir.split('/').filter(Boolean).pop()!;
    return Response.json({ id, build: cur.build ?? null, maxProtocolVersion: cur.maxProtocolVersion ?? null, module: `/voice/dave/${id}/libdave.mjs` }, { headers: { 'cache-control': 'no-cache' } });
  }

  private daveFile(id: string, name: string): Response {
    const file = join(this.daveRoot(), id, name);
    if (!existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(Bun.file(file), {
      headers: {
        'content-type': name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  /**
   * Discord's own call sounds (join, leave, mute and the rest), as scripts/dave/update.ts copied them from the public web
   * client next to libdave: never part of this repo. Which ones there are; the device makes its own for the rest.
   */
  private callSounds(): Response {
    const file = join(this.daveRoot(), 'sounds', 'sounds.json');
    const names = existsSync(file) ? ((JSON.parse(readFileSync(file, 'utf8')) as { sounds?: Record<string, unknown> }).sounds ?? {}) : {};
    return Response.json({ sounds: Object.keys(names).filter((n) => /^[a-z0-9_]{1,40}$/.test(n)) }, { headers: { 'cache-control': 'no-cache' } });
  }

  private callSound(name: string): Response {
    const file = join(this.daveRoot(), 'sounds', `${name}.mp3`);
    if (!existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(Bun.file(file), { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=86400' } });
  }

  // ---------------------------------------------------------------- media

  /** A post's pictures (timelines.ts), a JPEG XL as a JPEG or PNG: no feed network shows one (jxl.ts). */
  private async postFiles(ids: string[]): Promise<P.OutgoingAttachment[] | null> {
    const f = this.uploads.get(ids);
    return f && this.uploads.common(f, await this.jxlTools());
  }

  /** `jxl`: the device shows JPEG XL (jxl.ts takesJxl). `as`: what it is, or a download in a chosen form (mediaAs). */
  private async media(sig: string, b64: string, accountId: string | null, jxl = false, as: string | null = null, name: string | null = null): Promise<Response> {
    const raw = Buffer.from(b64, 'base64url').toString('utf8');
    const expect = createHmac('sha256', this.opts.secret).update(`${raw}|${accountId ?? ''}`).digest('base64url').slice(0, 16);
    if (sig !== expect) return new Response('bad signature', { status: 403 });
    if (as !== null) return this.mediaAs(raw, accountId, as, name, jxl);
    return this.fetchMedia(raw, accountId, undefined, jxl);
  }

  /**
   * Where a kept file's bytes are and what it is: the media cache's file, or its packed `.jxl` (`packed`), or a file
   * under the hub's data. Null when it is not kept (yet).
   */
  private keptFile(raw: string): { src: string; key: string; type: string; packed: boolean; base: string } | null {
    const key = mediaKey(raw);
    const file = join(this.opts.dataDir, 'media-cache', key);
    if (raw.startsWith('file://')) {
      // One under the hub's data is read where it is; an account's own (fetchMedia asks the account) is in the cache.
      const p = normalize(decodeURIComponent(raw.slice('file://'.length)));
      if (resolve(p).startsWith(resolve(this.opts.dataDir) + '/')) return existsSync(p) && statSync(p).isFile() ? { src: p, key, type: this.diskType(p, key), packed: false, base: file } : null;
    }
    if (!existsSync(file + '.mime')) return null;
    const type = this.trueType(key, readFileSync(file + '.mime', 'utf8'));
    if (existsSync(file)) return { src: file, key, type, packed: false, base: file };
    if (existsSync(file + '.jxl')) return { src: file + '.jxl', key, type, packed: true, base: file };
    return null;
  }

  /** A file kept on disk (an import, Signal's own copy) has no type recorded: by its name, else by its first bytes. */
  private diskType(p: string, key: string): string {
    const f = Bun.file(p);
    const named = f.type.split(';')[0];
    if (named !== 'application/octet-stream') return f.type;
    const fd = openSync(p, 'r');
    const head = new Uint8Array(16);
    try {
      readSync(fd, head, 0, 16, 0);
    } finally {
      closeSync(fd);
    }
    return sniffMime(head) ?? this.trueType(key, named);
  }

  /**
   * A kept file as the viewer's download menu asks for it (docs/files.md "Downloading"). `info`: what it came as, how it
   * is kept and what this device is sent, as JSON. Otherwise a download (`attachment`, named `name` with the form's
   * extension): `original` the bytes as they came (a packed picture rebuilt), `jxl`, `png` or `jpeg` converted.
   */
  private async mediaAs(raw: string, accountId: string | null, as: string, name: string | null, jxl: boolean): Promise<Response> {
    if (as !== 'info' && !['original', 'jxl', 'png', 'jpeg'].includes(as)) return new Response('as: info, original, jxl, png or jpeg', { status: 400 });
    let k = this.keptFile(raw);
    if (!k) {
      // Not fetched yet: fetched as showing it would, then looked at.
      const res = await this.fetchMedia(raw, accountId, undefined, true);
      await res.body?.cancel().catch(() => {});
      if (!res.ok) return new Response('not found', { status: res.status });
      k = this.keptFile(raw);
      if (!k) return new Response('not kept', { status: 404 });
    }
    const essence = k.type.split(';')[0].trim().toLowerCase();
    const forms = downloadsAs(essence);
    if (as === 'info') {
      const kept = statSync(k.src).size;
      const known = k.packed ? (this.store.db.query('SELECT size FROM media_info WHERE key = ?').get(k.key) as { size: number } | null) : null;
      // What a plain fetch of the link sends this device (serveKept): null when it is made for it (a JPEG XL turned
      // into a JPEG or PNG).
      const sent = k.packed ? (jxl ? JXL : essence) : essence === JXL && !jxl ? null : essence;
      const body = { type: essence, size: k.packed ? (known?.size ?? null) : kept, kept: { type: k.packed ? JXL : essence, size: kept }, sent, as: forms };
      return Response.json(body, { headers: { 'cache-control': 'no-store', ...SAFE_HEADERS } });
    }
    if (!forms.includes(as as DownloadAs)) return new Response(`a ${essence} file is not offered as ${as}`, { status: 400 });
    const send = (body: BodyInit, mime: string) =>
      new Response(body, { headers: { ...mediaHeaders(raw, k.key, mime), 'content-disposition': downloadDisposition(raw, k.key, mime, name) } });
    if (as === 'original') {
      if (!k.packed) return send(Bun.file(k.src), k.type);
      const r = await this.jxlServe.rebuilt(k.key, k.src);
      return r ? send(Buffer.from(r.bytes), r.mime) : new Response('this picture could not be rebuilt', { status: 503 });
    }
    if (as === 'jxl' && k.packed) return send(Bun.file(k.src), JXL);
    const r = await this.jxlServe.as(k.key, k.src, k.packed ? JXL : essence, as as Exclude<DownloadAs, 'original'>, k.base);
    return r ? send(Buffer.from(r.bytes), r.mime) : new Response('this picture could not be converted', { status: 503 });
  }

  /**
   * The type to serve a kept file as: the network's, unless it said nothing useful (application/octet-stream) and the
   * bytes say what it is (mediainfo.ts). mediaHeaders decides what may show inline either way.
   */
  private trueType(key: string, stored: string): string {
    if (!genericType(stored)) return stored;
    const r = this.store.db.query('SELECT mime FROM media_info WHERE key = ?').get(key) as { mime: string } | null;
    return r?.mime ?? stored;
  }

  /** Fetch one URL into the media cache, as showing it would (mediaarchive.ts); true when it is there. */
  private async archiveOne(url: string, accountId: string | null, from?: string): Promise<boolean> {
    // Whether it is there, not its bytes: a packed picture isn't rebuilt for it.
    const res = await this.fetchMedia(url, accountId, from, true);
    await res.body?.cancel().catch(() => {});
    return res.ok;
  }

  /**
   * A push's pictures, signed paths as mediaSigner writes them, fetched into the media cache before the push goes, so
   * the phone, which waits only seconds for them while it draws the notification, finds them there. Waits at most
   * `ms`; what is not in by then keeps coming in the background.
   */
  async warm(paths: (string | undefined | null)[], ms = 3000): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    for (const p of new Set(paths)) {
      const m = p?.match(/^\/media\/([^/?]+)\/([^/?]+)(?:\?a=([^&]+))?$/);
      if (!m) continue;
      const raw = Buffer.from(m[2], 'base64url').toString('utf8');
      const acc = m[3] ? decodeURIComponent(m[3]) : null;
      const expect = createHmac('sha256', this.opts.secret).update(`${raw}|${acc ?? ''}`).digest('base64url').slice(0, 16);
      if (m[1] !== expect) continue;
      jobs.push(this.archiveOne(raw, acc).catch(() => false));
    }
    if (!jobs.length) return;
    let timer: Timer | undefined;
    await Promise.race([Promise.all(jobs), new Promise((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
  }

  /** The bytes behind a stored media URL, for sending them on. */
  private async mediaBytes(raw: string, accountId: string | null): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const data = raw.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (data) return { mime: data[1] ?? 'application/octet-stream', bytes: data[2] ? Buffer.from(data[3], 'base64') : new TextEncoder().encode(decodeURIComponent(data[3])) };
    const res = await this.fetchMedia(raw, accountId);
    if (!res.ok) return null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  /**
   * Discord attachment links signed again by the account (its extractor's refreshUrls action): new link by old.
   * Throws when the account can't ask (offline, or an extractor from before the action).
   */
  private async refreshUrls(accountId: string, urls: string[]): Promise<Map<string, string>> {
    if (this.store.account(accountId)?.network !== 'discord') throw new Error('not a Discord account');
    const r = await this.sup.command<{ refreshed?: { original: string; refreshed: string }[] }>(accountId, { t: 'action', action: 'refreshUrls', args: { urls } }, 90_000);
    if (!Array.isArray(r?.refreshed)) throw new Error('the extractor cannot refresh links');
    return new Map(r.refreshed.map((x) => [x.original, x.refreshed]));
  }

  /**
   * The bytes behind `raw`, from the media cache, else fetched and kept there. `from` is where to fetch them when not
   * from `raw` itself: a Discord link signed again, whose bytes are kept under the old link the message has.
   */
  private async fetchMedia(raw: string, accountId: string | null, from?: string, jxl = false): Promise<Response> {
    const cacheDir = join(this.opts.dataDir, 'media-cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const key = new Bun.CryptoHasher('sha256').update(raw).digest('hex');
    const file = join(cacheDir, key);
    if (existsSync(file + '.mime') && (existsSync(file) || existsSync(file + '.jxl'))) {
      // Recently seen stays longest when the cache is trimmed (mediacache.ts).
      try {
        const t = new Date();
        utimesSync(existsSync(file) ? file : file + '.jxl', t, t);
      } catch {}
      return this.serveKept(file, key, raw, this.trueType(key, readFileSync(file + '.mime', 'utf8')), jxl);
    }

    let bytes: Uint8Array;
    let mime = 'application/octet-stream';
    if (raw.startsWith('https://') || raw.startsWith('http://')) {
      // An old Discord link, opened before the archive got to it: signed again through the account first.
      if (!from && accountId && MediaArchiver.expired(raw))
        from = await this.refreshUrls(accountId, [raw])
          .then((m) => m.get(raw) ?? [...m.entries()].find(([o]) => linkPath(o) === linkPath(raw))?.[1])
          .catch(() => undefined);
      // A URL from someone else's message: public addresses only, redirects checked, size capped (fetchsafe.ts).
      const r = await fetchPublicToFile(from ?? raw, file);
      if (!r.ok) return new Response(r.error, { status: r.status });
      writeFileSync(file + '.mime', r.mime, { mode: 0o600 });
      return this.serveKept(file, key, raw, r.mime, jxl);
    } else if (raw.startsWith('file://') && resolve(normalize(decodeURIComponent(raw.slice('file://'.length)))).startsWith(resolve(this.opts.dataDir) + '/')) {
      // A file under this hub's data (an import, an account whose session the hub keeps): read here. One elsewhere is
      // the account's own (an account dither-accounts made keeps its files in its own folder): asked of it below.
      const p = normalize(decodeURIComponent(raw.slice('file://'.length)));
      if (!existsSync(p) || !statSync(p).isFile()) return new Response('not found', { status: 404 });
      const f = Bun.file(p);
      const type = this.diskType(p, key);
      const common = !jxl && type.split(';')[0] === JXL ? await this.jxlServe.common(key, p) : null;
      if (common) return new Response(Buffer.from(common.bytes), { headers: mediaHeaders(raw, key, common.mime) });
      return new Response(f, { headers: mediaHeaders(raw, key, type) });
    } else {
      if (!accountId) return new Response('no account to resolve media', { status: 404 });
      const r = await this.sup.command<{ mime: string; base64: string }>(accountId, { t: 'fetchMedia', url: raw }, 30_000).catch(() => null);
      if (!r) return new Response('adapter could not fetch media', { status: 502 });
      mime = r.mime;
      bytes = Buffer.from(r.base64, 'base64');
    }
    // Decrypted attachments end up here too.
    writeFileSync(file, bytes, { mode: 0o600 });
    writeFileSync(file + '.mime', mime, { mode: 0o600 });
    return this.serveKept(file, key, raw, mime, jxl);
  }

  /**
   * A file in the media cache as this device gets it (jxl.ts, docs/files.md "JPEG XL"): a packed picture as JPEG XL
   * where the device shows it, else rebuilt as it came; a JPEG XL someone sent as a JPEG or PNG where it doesn't.
   * `type`: what the file is; `jxl`: the device shows JPEG XL.
   */
  private async serveKept(file: string, key: string, raw: string, type: string, jxl: boolean): Promise<Response> {
    const headers = (mime: string) => mediaHeaders(raw, key, mime);
    const essence = type.split(';')[0].trim().toLowerCase();
    if (!existsSync(file) && existsSync(file + '.jxl')) {
      if (jxl) return new Response(Bun.file(file + '.jxl'), { headers: headers(JXL) });
      const r = await this.jxlServe.rebuilt(key, file + '.jxl');
      return r ? new Response(Buffer.from(r.bytes), { headers: headers(r.mime) }) : new Response('this picture could not be rebuilt', { status: 503 });
    }
    if (essence === JXL && !jxl) {
      const r = await this.jxlServe.common(key, file);
      if (r) return new Response(Buffer.from(r.bytes), { headers: headers(r.mime) });
    }
    if (!PACKED_TYPES.has(essence)) return new Response(Bun.file(file), { headers: headers(type) });
    // One the packer may pack meanwhile is read now, not as the answer goes out.
    try {
      return new Response(readFileSync(file), { headers: headers(type) });
    } catch (e) {
      if (existsSync(file + '.jxl')) return this.serveKept(file, key, raw, type, jxl);
      throw e;
    }
  }

  // ---------------------------------------------------------------- static PWA

  private static(path: string, req: Request): Response {
    const root = resolve(this.opts.webDist);
    const candidate = resolve(join(root, normalize(decodeURIComponent(path))));
    if (candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile()) {
      const immutable = path.startsWith('/assets/');
      return this.webFile(req, candidate, {
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...(path.endsWith('.webmanifest') ? { 'content-type': 'application/manifest+json' } : {}),
      });
    }
    // A hashed asset from another build must fail as itself: as HTML it would poison a cache.
    if (path.startsWith('/assets/')) return new Response('not found', { status: 404 });
    const index = join(root, 'index.html');
    if (existsSync(index)) return this.webFile(req, index, { 'cache-control': 'no-cache', 'content-type': 'text/html; charset=utf-8' });
    return new Response('dither-chat hub is running; the web app has not been built yet (bun run web:build).', { status: 200 });
  }

  /** The web build's files, packed once with zstd at its hardest for a client that takes it (compress.ts PackedFiles). */
  readonly packed = new PackedFiles();

  private webFile(req: Request, file: string, headers: Record<string, string>): Response {
    const f = Bun.file(file);
    if (req.method === 'GET' && !req.headers.has('range') && pickEncoding(req.headers.get('accept-encoding')) === 'zstd') {
      const st = statSync(file);
      const body = this.packed.get(file, st.size, st.mtimeMs);
      if (body) return new Response(body, { headers: { 'content-type': f.type, ...headers, 'content-encoding': 'zstd', vary: 'accept-encoding' } });
    }
    return new Response(f, { headers });
  }

  /** Queue a notification for connected clients. */
  notify(ev: Extract<P.ClientEvent, { t: 'notify' }>) {
    this.store.dirty.extra.push(ev);
  }

  /** A page's word over its socket: what it is watching (`P.ClientWatching`). Anything else is ignored. */
  private clientSaid(ws: ServerWebSocket<ClientData>, msg: string, now = Date.now()) {
    let m: Partial<P.ClientWatching>;
    try {
      m = JSON.parse(msg);
    } catch {
      return;
    }
    if (m?.t !== 'watching' || !Array.isArray(m.conversationIds)) return;
    const ids = m.conversationIds.filter((x): x is string => typeof x === 'string').slice(0, 20);
    ws.data.watching = ids.length ? { label: String(m.label ?? '').slice(0, 100), conversationIds: ids, at: now } : undefined;
  }

  /**
   * Is this chat open at its newest message on a computer in use, as its page last said (within twice
   * `P.WATCH_EVERY`)? Then a push about it would only buzz a phone about what is being read (notify.ts).
   */
  watched(conversationId: string, now = Date.now()): boolean {
    for (const ws of this.clients) {
      const w = ws.data.watching;
      if (w && now - w.at <= 2 * WATCH_EVERY && !PHONE.test(w.label) && w.conversationIds.includes(conversationId)) return true;
    }
    return false;
  }
}
