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

/** The answers the app can give about a message (POST /api/loudness/answers). */
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

/**
 * A check-in question (checkin.ts), waiting on the Notification calibration page (docs/notifications.md, "Asking,
 * without nagging") until you answer, skip, or it gets too old.
 */
export interface CheckinView {
  id: string;
  /** 'sounded': it sounded; 'quiet': it stayed quiet; 'foryou': a For you card. */
  side: 'sounded' | 'quiet' | 'foryou';
  messageId: string;
  conversationId: string | null;
  title: string;
  preview: string;
  /** When the message came. */
  at: number;
  /** When the question was put on the page. */
  askedAt: number;
  /** "you answered it 5 h later" */
  note?: string;
  /** Where and how you came across it, as far as the hub knows. */
  context: SeenContext;
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

/** GET /api/loudness/calibration: the numbers at the top of the Notification calibration page. */
export interface CalibrationStats {
  /** Sounds a day, from the scorecard's days (attn.sounds): the means of the last 7 and 30 days scored, and each day. */
  sounds: { last7: number | null; last30: number | null; days: { day: string; n: number | null }[] };
  /** The scorecard's weighted shares over the last 30 days (attn.worth, attn.missed): honest, from the random half. */
  worth: { value: number | null; n: number };
  missed: { value: number | null; n: number };
  /** Straight counts of your answers over the last 30 days, every question. */
  answers: { worth: number; couldWait: number; shouldnt: number; sooner: number; fine: number; glad: number; not: number };
  pending: number;
  answered: number;
  skipped: number;
  expired: number;
  /** Time from the question going on the page to your answer, the mean and the median (ms), over the last 30 days. */
  delay: { mean: number | null; median: number | null };
  /** How old the message was when you answered, the mean (ms): late answers count a little less in what is learned. */
  age: { mean: number | null };
  /** The model's chance you wanted it, against what you answered, in bins (sounded: worth it; quiet: wish I'd known sooner). */
  calibration: { bins: { lo: number; hi: number; predicted: number; observed: number; n: number }[]; brier: number | null; n: number };
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
  /** How many questions a day go on the Notification calibration page: never, rarely (one a day), up to three a day. */
  ask: 'never' | 'rarely' | 'often';
  /** A note on people you're drifting from, in the weekly report. */
  drifting: boolean;
}
export const DEFAULT_ATTENTION_PREFS: AttentionPrefs = { readily: 'learned', nextLook: 'both', times: ['12:00', '18:00'], computerFirst: true, ask: 'often', drifting: true };

/** GET /api/loudness/state: the mode, your settings, what it asks and has learned, for the app. */
export interface AttentionStateView {
  mode: AttentionMode;
  prefs: AttentionPrefs;
  /** Sounds today, for your information only. */
  soundsToday: number;
  /** Check-ins asked and answered today. */
  asked: number;
  answered: number;
  /** Waiting on the Notification calibration page. */
  pending: number;
  /** Paused after three skips in a row, until then. */
  pausedUntil: number | null;
  /** "Ask me less" halves this each time. */
  rate: number;
  /** Held for the next look. */
  held: number;
  /** What it learned, strongest first, with Forget. */
  learned: { key: string; text: string; by: number }[];
}
