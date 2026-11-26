/**
 * One loudness scale for notifications, the inbox and For you (docs/notifications.md): every message gets a number
 * from 0 to 100, how much of your attention it is worth right now, and the devices draw their lines across it in
 * bands. Learned mainly from your answers on the Notification calibration feed (Sound / Show / Inbox, and what it
 * was wrong about) and from Louder / Quieter and their "why".
 */

/**
 * Where a loudness lands. Loudest last. `show` is a silent notification you see only when you look in the shade (on
 * Android the minimized kind: no status-bar icon, no lock-screen line). Until 2026-11 a "next look" band sat between
 * the inbox and show (30-55), holding things for one bundle when you next looked; what fell in it is show now.
 */
export type LoudBand = 'unread' | 'inbox' | 'show' | 'sound';
export const LOUD_BANDS: readonly LoudBand[] = ['unread', 'inbox', 'show', 'sound'];
/** Each band's stretch of the 0-100 scale. */
export const BAND_RANGE: Record<LoudBand, readonly [number, number]> = { unread: [0, 10], inbox: [10, 30], show: [30, 80], sound: [80, 100] };
export const BAND_NAME: Record<LoudBand, string> = { unread: 'Unread only', inbox: 'Inbox', show: 'Show, silent', sound: 'Sound' };
export const bandOf = (loudness: number): LoudBand => (loudness >= 80 ? 'sound' : loudness >= 30 ? 'show' : loudness >= 10 ? 'inbox' : 'unread');
/** A band as stored, also one stored before the next look went (it is show now). */
export const asBand = (b: unknown): LoudBand | null => (b === 'next' ? 'show' : (LOUD_BANDS as readonly unknown[]).includes(b) ? (b as LoudBand) : null);

/**
 * Which decides what is sent (DITHER_ATTENTION): today's tiers alone, the loudness worked out beside them and stored
 * but never deciding (`shadow`), or the loudness (`on`).
 */
export type AttentionMode = 'tiers' | 'shadow' | 'on';

/** How long something can wait before it goes stale: the four half-life buckets of the can-wait model. */
export type WaitBucket = 'minutes' | 'hour' | 'today' | 'whenever';
export const WAIT_BUCKETS: readonly WaitBucket[] = ['minutes', 'hour', 'today', 'whenever'];

/** What the loudness was worked out from (TriageView.loud). */
export interface LoudParts {
  /** The chance you'd be glad to have seen it at all, 0 to 1. */
  want: number;
  /** Its chance of each half-life bucket, adding up to 1 (WAIT_BUCKETS' order). */
  wait: [number, number, number, number];
  /** A person waiting on your reply, 0 to 1 (people only). */
  owed: number;
  /** What a sound costs at that moment, against its start of 1 (computer in use, hour, a sound just before; your nudge). */
  moment: number;
  /** Quiet hours were on: no sound band. */
  quiet?: boolean;
}

/** One thing that moved it, in words, and by how many points of the scale. */
export interface LoudReason {
  text: string;
  by: number;
  /** What it is about, for Louder / Quieter at that scope. */
  key?: string;
}

/** A message's loudness: what it was, what it would have been sent as, and why. */
export interface LoudView {
  loudness: number;
  band: LoudBand;
  /** Whether this loudness decided what was sent (`on`) or was worked out beside the tiers (`shadow`). */
  live: boolean;
  /** A rule of yours set it (Always alert 100, Mute 0, List only caps it). */
  rule?: string;
  parts?: LoudParts;
  reasons: LoudReason[];
}

/** The answers the app can give about a message (POST /api/loudness/answers). */
export type AttnAnswer =
  | 'sound' // The calibration feed: it should have sounded
  | 'show' // … shown silently, in the shade
  | 'inbox' // … waited in the inbox
  | 'worth' // Worth it (a sound)
  | 'could_wait' // Could have waited
  | 'shouldnt' // Shouldn't have reached me
  | 'sooner' // Wish I'd known sooner (a quiet one)
  | 'fine' // Fine where it was
  | 'louder' // Louder, for this person or chat
  | 'quieter'; // Quieter, for this person or chat

/** Where an answer came from. */
export type AttnSource = 'checkin' | 'feed' | 'sheet' | 'notification' | 'followup';

/** Why, after Quieter, Could have waited or Shouldn't have reached me; and after Louder (or Wish I'd known sooner). */
export type WhyReason =
  | 'could_wait'
  | 'not_chat'
  | 'not_person'
  | 'not_topic'
  | 'bad_moment'
  | 'seen'
  | 'time_sensitive'
  | 'person_matters'
  | 'chat_matters'
  | 'topic_matters'
  | 'was_free';
export const QUIETER_WHY: readonly WhyReason[] = ['could_wait', 'not_chat', 'not_person', 'not_topic', 'bad_moment', 'seen'];
export const LOUDER_WHY: readonly WhyReason[] = ['time_sensitive', 'person_matters', 'chat_matters', 'topic_matters', 'was_free'];
/** "How long could it have waited?" / "When would you have wanted it?" */
export type WhyWait = '10min' | 'hour' | 'tonight' | 'never' | 'now' | 'within_hour' | 'today';
export const QUIETER_WAITS: readonly WhyWait[] = ['10min', 'hour', 'tonight', 'never'];
export const LOUDER_WAITS: readonly WhyWait[] = ['now', 'within_hour', 'today'];
/** The follow-up's chips, in words. */
export const WHY_LABEL: Record<WhyReason, string> = {
  could_wait: 'It could have waited',
  not_chat: 'Not this chat',
  not_person: 'Not this person',
  not_topic: 'Not this topic',
  bad_moment: 'Bad moment',
  seen: 'Already seen it',
  time_sensitive: 'It was time-sensitive',
  person_matters: 'This person matters',
  chat_matters: 'This chat matters',
  topic_matters: 'This topic matters',
  was_free: 'I was free',
};
export const WAIT_LABEL: Record<WhyWait, string> = { '10min': '10 minutes', hour: 'An hour', tonight: 'Tonight', never: 'Never needed it', now: 'Right away', within_hour: 'Within the hour', today: 'Today' };

export interface AttnAnswerBody {
  messageId: string;
  answer: AttnAnswer;
  source: AttnSource;
  /** Louder / Quieter: for this person or this chat (default: the message itself, its kind). */
  scope?: 'person' | 'chat';
}

/** What an answer leaves for the app: whether to ask why, and about which side. */
export interface AttnAnswerResult {
  ok: true;
  answerId: string;
  /** Ask the one optional why (rate-limited: one per chat a day, never twice in a row for the same answer). */
  why?: 'quieter' | 'louder';
}

export interface WhyBody {
  answerId: string;
  reason?: WhyReason;
  wait?: WhyWait;
  /** Your words, read by the local model only and mapped to a reason. */
  text?: string;
  /** When the change ends ("until it's signed"), ms. */
  until?: number;
}

export interface WhyResult {
  ok: true;
  /** The reason it was taken as (from the text, when one was given). */
  reason: WhyReason | null;
}

/** Where a device drew a notification (the device's own word, `NotificationSeen`). */
export type SeenSurface = 'heads_up' | 'shade' | 'lock' | 'list_row' | 'browser' | 'toast';
/** Whether it made itself heard there. */
export type SeenSound = 'sound' | 'vibrate' | 'silent';

/** One device a notification went to, and what it said happened there. */
export interface SeenDevice {
  label: string;
  /** 'android': the Android app; 'browser': a browser's push (desktop or phone); 'page': an open page's toast. */
  kind: 'android' | 'browser' | 'page';
  phone: boolean;
  /** The hub sent it to sound here (an alert's first push of a burst). The device's own setting may still have silenced it: `sound`. */
  meantToSound: boolean;
  surface: SeenSurface | null;
  sound: SeenSound | null;
  locked: boolean | null;
  screenOn: boolean | null;
  /** A page of the app was open (not in front) on that device. */
  pageOpen: boolean | null;
  delivered: number | null;
  shown: number | null;
  /** Not shown: the app was in front there. */
  suppressed: number | null;
  tapped: number | null;
  dismissed: number | null;
  /** What else of ours was showing beside it, as the device said (null: it did not say). */
  beside: { title: string; body: string; at: number }[] | null;
}

/** A notification as the hub composed it: the words the devices drew, kept a little while for this page. */
export interface SeenSent {
  at: number;
  /** null: the words are no longer kept (older than WORDS_KEPT) or from before they were. */
  title: string | null;
  body: string | null;
  /** A group of lines (several messages in one notification), each with who wrote it. */
  lines: { author: string; body: string; ts?: number }[];
  count: number;
  conv: { title: string; shape: 'direct' | 'group' | 'channel' } | null;
  network: string | null;
  icon: string | null;
  tier: 'push' | 'quiet' | 'digest';
  sounded: boolean;
  /** A computer had the app in use when it went out. */
  computerInUse: boolean | null;
  devices: SeenDevice[];
}

/** Where and how you came across a message (docs/notifications.md, "Where you saw it"). */
export interface SeenContext {
  /** The notification that carried it; null when none went out. */
  sent: SeenSent | null;
  /** Why no notification went out: its chat was open on a computer in use, or a silent one within its ten minutes. */
  notSent: 'watched' | 'capped' | null;
  /** The first time you opened its chat after it came: from which list, on which device. */
  opened: { at: number; source: string; device: string; phone: boolean } | null;
  /** For you served it: where on the page, and whether a device said it was on screen. */
  forYou: { position: number; servedAt: number; shownAt: number | null; ms: number | null } | null;
  /** Its row in the inbox, as drawn from the message itself. */
  row: { title: string; preview: string; at: number; network: string | null; shape: string | null };
  /** What the hub cannot say, in words. */
  unknown: string[];
}

/** The device's word on where it showed a notification (sw.js, the Android app, a page's toast). Codes only. */
export interface NotificationSeen {
  surface?: SeenSurface;
  sound?: SeenSound;
  locked?: boolean;
  screenOn?: boolean;
  pageOpen?: boolean;
  /** Tags (conversation ids) of the other notifications of ours showing beside it. */
  beside?: string[];
}

/** The calibration feed's answers (docs/notifications.md, "The calibration feed"): what it should have been. */
export type CalAnswer = 'sound' | 'show' | 'inbox';
export const CAL_ANSWERS: readonly CalAnswer[] = ['sound', 'show', 'inbox'];
export const CAL_ANSWER_NAME: Record<CalAnswer, string> = { sound: 'Sound', show: 'Show', inbox: 'Inbox' };
/** The band a feed answer stands for, and back (unread only is the inbox's here). */
export const calAnswerOf = (b: LoudBand): CalAnswer => (b === 'sound' ? 'sound' : b === 'show' ? 'show' : 'inbox');

/** The parts of the model a correction can be routed to ("What was it wrong about?"). */
export type CalPart = 'person' | 'chat' | 'topic' | 'wait' | 'moment' | 'delivery';
export const CAL_PARTS: readonly CalPart[] = ['person', 'chat', 'topic', 'wait', 'moment', 'delivery'];
export const CAL_PART_NAME: Record<CalPart, string> = { person: 'person', chat: 'chat', topic: 'topic', wait: 'can wait', moment: 'moment', delivery: 'delivery' };

/** Chances or spreads, one for each answer in CAL_ANSWERS' order. */
export type Trio = [number, number, number];

/**
 * One notification on the calibration feed, as it looked, with what the model gave each answer (p, with u its
 * uncertainty), what it did, and what you did.
 */
export interface CalItem {
  id: string;
  /** card: open with its answers; row: compact, tap to open; past: an answer of yours back once; sure: hidden as sure. */
  kind: 'card' | 'row' | 'past' | 'sure';
  messageId: string;
  conversationId: string | null;
  network: string | null;
  /** The picture the notification had, where it had one. */
  icon: string | null;
  /** Its title as drawn (the person, or the chat), and its text. */
  who: string;
  text: string;
  at: number;
  /** Where it was seen: a notification in the shade, a toast or browser notification, or only a row in the app. */
  look: 'shade' | 'toast' | 'row';
  /** The model's chance of each answer, and how unsure each is (a spread, not a range). */
  p: Trio;
  u: Trio;
  /** What the model did: it sounded, showed silently, or sent nothing. */
  did: CalAnswer;
  /** What you did, read from how soon you opened or answered it; null while that is not known. */
  you: CalAnswer | null;
  /** "Opened in 1 min", "Not opened" */
  youWhat: string;
  /** How surprised (bits, at most 5) and how unsure (0 to 1) the model is, and worth asking now (with its fading). */
  surprise: number;
  unsure: number;
  score: number;
  /** The chance it had of being drawn as a card: answers are weighted back by it. */
  chance: number;
  /** A sound held back (quiet hours, a computer in use, a burst): never hidden as sure. */
  held?: boolean;
  /** Your answer, where there is one (a past card). */
  answer?: CalAnswer;
  /** The model's chances now, after your answer (a past card; and after answering on any card). */
  after?: Trio;
  /** Which way each part pushed it, −1 (quieter) to 1 (louder), with what that part is here ("Ben", "Family"). */
  parts: { part: CalPart; label: string; push: number }[];
  /** Where and how it was seen, in a line, and what moved it, by how many points. */
  context: string;
  reasons: LoudReason[];
}

/** GET /api/loudness/feed: the cards and rows, newest worth asking first; the sure ones apart. */
export interface CalFeedView {
  items: CalItem[];
  sure: CalItem[];
}

/** POST /api/loudness/feed/:id { answer }: the chances before and after it was learned. */
export interface CalAnswerResult {
  ok: true;
  answerId: string;
  before: Trio;
  after: Trio;
}

/** POST /api/loudness/feed/:id/parts { parts }: the chances once the answer was routed to those parts. */
export interface CalPartsResult {
  ok: true;
  after: Trio;
}

/** A past answer come back: kept, kept as a one-off that teaches nothing, or taken back. */
export type CalSettle = 'keep' | 'once' | 'undo';

/** The attention settings (Settings → Notifications). */
export interface AttentionPrefs {
  /** A nudge on what it learned: how readily it sounds. */
  readily: 'less' | 'learned' | 'more';
  /** While a computer is in use, the phone stays silent and nothing reaches it for a chat open and read there. */
  computerFirst: boolean;
  /** How many cards a day open on the calibration feed: never, rarely (one a day), up to three a day. */
  ask: 'never' | 'rarely' | 'often';
  /** A note on people you're drifting from, in the weekly report. */
  drifting: boolean;
}
export const DEFAULT_ATTENTION_PREFS: AttentionPrefs = { readily: 'learned', computerFirst: true, ask: 'often', drifting: true };

/** GET /api/loudness/state: the mode, your settings, what it asks and has learned, for the app. */
export interface AttentionStateView {
  mode: AttentionMode;
  prefs: AttentionPrefs;
  /** Sounds today, for your information only. */
  soundsToday: number;
  /** Cards opened and answered today. */
  asked: number;
  answered: number;
  /** Waiting on the calibration feed (cards, and past answers back). */
  pending: number;
  /** What it learned, strongest first, with Forget. */
  learned: { key: string; text: string; by: number }[];
}
