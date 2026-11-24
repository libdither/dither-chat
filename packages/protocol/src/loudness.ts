/**
 * One loudness scale for notifications, the inbox and For you (docs/notifications.md): every message gets a number
 * from 0 to 100, how much of your attention it is worth right now, and the devices draw their lines across it in
 * bands. Learned mainly from your answers to "was that worth it?" (check-ins, Louder / Quieter and their "why").
 */

/** Where a loudness lands. Loudest last. */
export type LoudBand = 'unread' | 'inbox' | 'next' | 'show' | 'sound';
export const LOUD_BANDS: readonly LoudBand[] = ['unread', 'inbox', 'next', 'show', 'sound'];
/** Each band's stretch of the 0-100 scale. */
export const BAND_RANGE: Record<LoudBand, readonly [number, number]> = { unread: [0, 10], inbox: [10, 30], next: [30, 55], show: [55, 80], sound: [80, 100] };
export const BAND_NAME: Record<LoudBand, string> = { unread: 'Unread only', inbox: 'Inbox', next: 'Next look', show: 'Show now, silent', sound: 'Sound' };
export const bandOf = (loudness: number): LoudBand => (loudness >= 80 ? 'sound' : loudness >= 55 ? 'show' : loudness >= 30 ? 'next' : loudness >= 10 ? 'inbox' : 'unread');

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

/** The answers the app can give about a message (POST /api/attention/answers). */
export type AttnAnswer =
  | 'worth' // Worth it (a sound)
  | 'could_wait' // Could have waited
  | 'shouldnt' // Shouldn't have reached me
  | 'sooner' // Wish I'd known sooner (a quiet one)
  | 'fine' // Fine where it was
  | 'louder' // Louder, for this person or chat
  | 'quieter'; // Quieter, for this person or chat

/** Where an answer came from. */
export type AttnSource = 'checkin' | 'sheet' | 'notification' | 'followup';

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

export interface AttnAnswerBody {
  messageId: string;
  answer: AttnAnswer;
  source: AttnSource;
  /** Louder / Quieter: for this person or this chat (default: the message itself, its kind). */
  scope?: 'person' | 'chat';
  /** The check-in it answers. */
  checkinId?: string;
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

/** A check-in question at the top of the inbox (checkin.ts). */
export interface CheckinView {
  id: string;
  /** 'sounded': it sounded; 'quiet': it stayed quiet; 'foryou': a For you card. */
  side: 'sounded' | 'quiet' | 'foryou';
  messageId: string;
  conversationId: string | null;
  title: string;
  preview: string;
  at: number;
  /** "you answered it 5 h later" */
  note?: string;
}

/** The attention settings (Settings → Notifications). */
export interface AttentionPrefs {
  /** A nudge on what it learned: how readily it sounds. */
  readily: 'less' | 'learned' | 'more';
  /** When the next look comes: when you open the app or unlock the phone, at set times, or both. */
  nextLook: 'open' | 'times' | 'both';
  /** "HH:MM" local times, for `times` and `both`. */
  times: string[];
  /** While a computer is in use, the phone stays silent and nothing reaches it for a chat open and read there. */
  computerFirst: boolean;
  /** Ask "was that worth it?": never, rarely (one a day), up to three a day. */
  ask: 'never' | 'rarely' | 'often';
  /** A note on people you're drifting from, in the weekly report. */
  drifting: boolean;
}
export const DEFAULT_ATTENTION_PREFS: AttentionPrefs = { readily: 'learned', nextLook: 'both', times: ['12:00', '18:00'], computerFirst: true, ask: 'often', drifting: true };

/** GET /api/attention: the mode, your settings, what it asks and has learned, for the app. */
export interface AttentionStateView {
  mode: AttentionMode;
  prefs: AttentionPrefs;
  /** Sounds today, for your information only. */
  soundsToday: number;
  /** Check-ins asked and answered today. */
  asked: number;
  answered: number;
  /** Paused after three skips in a row, until then. */
  pausedUntil: number | null;
  /** "Ask me less" halves this each time. */
  rate: number;
  /** Held for the next look. */
  held: number;
  /** What it learned, strongest first, with Forget. */
  learned: { key: string; text: string; by: number }[];
}
