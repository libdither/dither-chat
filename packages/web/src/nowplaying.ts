/**
 * What is playing (docs/media-kinds.md "Playing in the background"): the voice message, sound file or video with sound
 * that was started last, wherever on the page its player is. One listener on the document hears every player's play,
 * pause and end; media events do not bubble, so it listens as they go down. Not heard: a player made with `new Audio()`
 * and never put in the page (a call's sound, call.ts; a page in another site's frame), and muted or looping ones (GIFs,
 * a story's preview), which are not something you listen to.
 *
 * Voice messages and sound files play in the app's own player (`playFile`), not in their row: a row is only its
 * controls, drawn from `playback`, so what plays goes on when you leave its chat (the playing bar, PlayingBar.tsx,
 * stays with it) and the row shows where it got to when you come back. Videos play where they are, and stop when
 * their chat closes.
 *
 * It gives the system the controls: `navigator.mediaSession` in a browser (media keys, the browser's own "now playing"),
 * and in the Android app a media notification over the bridge (android.ts), whose service keeps the page playing with
 * the screen off. One plays at a time: starting one pauses the one before, and a call starting pauses it.
 */
import { computed, signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { authorName, faceOf } from './model.ts';
import { db, quoted, timelines } from './state.ts';

/** What the system shows of it: the notification, the lock screen, the browser's media controls. */
interface NowPlaying {
  state: 'playing' | 'paused';
  title: string;
  /** Who sent it. */
  artist: string;
  /** Where: the chat's name. */
  album: string;
  /** The sender's picture, when there is one. */
  art: string | null;
  conversationId: string | null;
  messageId: string | null;
  /** In milliseconds; 0 while not known (a stream, or before its length loaded). */
  duration: number;
  position: number;
  rate: number;
}

const nowPlaying = signal<NowPlaying | null>(null);

/** Where the app's player is in the file it holds, for the row of that file and the playing bar. */
interface Playback {
  /** The file: `fileKey`. */
  key: string;
  playing: boolean;
  /** In seconds. */
  at: number;
  /** In seconds; 0 while not known. */
  length: number;
}
export const playback = signal<Playback | null>(null);
/**
 * The file playing now, if any: what a row's Play button and the playing bar's buttons are drawn from. They read this,
 * not `playback`, which changes a few times a second as it plays: drawn again that often, an icon's paths are new
 * elements each time, and a tap that lands on the one taken away makes no click.
 */
export const playingKey = computed(() => (playback.value?.playing ? playback.value.key : null));

/** A message's file, as `playback` names it. */
export const fileKey = (messageId: string, att: number) => `${messageId}:${att}`;

/** The parts of a media element this looks at, so the rules can be tested without a page. */
interface MediaLike {
  muted: boolean;
  loop: boolean;
  isConnected: boolean;
}

/** A player you listen to: in the page, not muted (GIFs and previews are), not looping (GIFs). */
export function counts(el: MediaLike): boolean {
  return el.isConnected && !el.muted && !el.loop;
}

/** The message a player sits in, by its row's `m-<id>`, and which of its files (`data-att`). */
export function placeOf(el: { closest(sel: string): { id?: string; getAttribute(n: string): string | null } | null }): { messageId: string | null; att: number | null } {
  const row = el.closest('[id^="m-"]');
  const att = el.closest('[data-att]')?.getAttribute('data-att');
  return { messageId: row?.id ? row.id.slice(2) : null, att: att != null && /^\d+$/.test(att) ? Number(att) : null };
}

function findMessage(id: string): P.MessageView | null {
  for (const t of timelines.values()) {
    const m = t.messages.find((x) => x.id === id);
    if (m) return m;
  }
  return quoted.get(id) ?? null;
}

/** The title, sender and chat of what plays: from its message when it is in one, else from the file alone. */
export function describe(m: P.MessageView | null, att: number | null, video: boolean, chatName: (id: string) => string | null, sender: (identityId: string | null) => string): Pick<NowPlaying, 'title' | 'artist' | 'album' | 'conversationId' | 'messageId'> {
  const a = m && att != null ? m.attachments[att] : undefined;
  const title = a?.voice || a?.voiceNote ? 'Voice message' : (a?.name ?? (video ? 'Video' : 'Sound'));
  return {
    title,
    artist: m ? sender(m.authorId) : '',
    album: (m && chatName(m.conversationId)) ?? '',
    conversationId: m?.conversationId ?? null,
    messageId: m?.id ?? null,
  };
}

let current: HTMLMediaElement | null = null;
/** The app's player, made the first time a file plays, and the file it holds with what the system is told of it. */
let player: HTMLAudioElement | null = null;
/**
 * The file the app's player holds, until Close or its end, whatever else has played since: what the playing bar is
 * drawn from (a video started meanwhile pauses it, and the bar stays to go on with it).
 */
interface Held {
  key: string;
  what: ReturnType<typeof describe>;
  art: string | null;
}
export const held = signal<Held | null>(null);
/** In the Android app (android.ts, which imports this, so not from there). */
const ANDROID = typeof globalThis !== 'undefined' && 'DitherAndroid' in globalThis;
let listeners: ((n: NowPlaying | null) => void)[] = [];

/** Hear each change of what plays (android.ts sends it to the app). */
export function onNowPlaying(fn: (n: NowPlaying | null) => void) {
  listeners.push(fn);
}

function ms(s: number): number {
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 0;
}

const chatName = (id: string) => db.conversations.get(id)?.name ?? null;

function publish(el: HTMLMediaElement | null) {
  // Whatever else played is done, and the app's player still holds a file: the system shows that again, paused.
  if (!el && player && current !== player && held.peek()) el = current = player;
  if (!el) {
    current = null;
    nowPlaying.value = null;
  } else {
    const track = held.peek();
    let what = track?.what;
    let art = track?.art ?? null;
    if (el !== player || !what) {
      const { messageId, att } = placeOf(el);
      const m = messageId ? findMessage(messageId) : null;
      what = describe(m, att, el instanceof HTMLVideoElement, chatName, authorName);
      art = m ? faceOf(m.authorId).url : null;
    }
    nowPlaying.value = {
      ...what,
      state: el.paused ? 'paused' : 'playing',
      art,
      duration: ms(el.duration),
      position: ms(el.currentTime),
      rate: el.playbackRate || 1,
    };
  }
  session(nowPlaying.value);
  for (const fn of listeners) fn(nowPlaying.value);
}

/** What the system's controls ask for: the media notification's buttons, media keys, a headset's button. */
export function control(action: 'play' | 'pause' | 'stop' | 'seek', toMs?: number) {
  const el = current;
  if (!el) return publish(null);
  if (action === 'play') void el.play().catch(() => {});
  else if (action === 'pause') el.pause();
  else if (action === 'stop') {
    el.pause();
    if (el === player) forget();
    publish(null);
  } else if (action === 'seek' && typeof toMs === 'number' && Number.isFinite(toMs)) {
    el.currentTime = Math.max(0, toMs / 1000);
  }
}

/** The app's player, in the page (so the document's listeners hear it) but drawn nowhere: rows are its controls. */
function thePlayer(): HTMLAudioElement {
  if (player) return player;
  const el = (player = document.createElement('audio'));
  el.id = 'app-player';
  el.preload = 'auto';
  const tell = () => {
    const track = held.peek();
    if (!track) return;
    // Played to the end: it lets go of the file, and the bar goes with it.
    if (el.ended) return forget();
    playback.value = { key: track.key, playing: !el.paused && !el.error, at: el.currentTime, length: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : (playback.value?.length ?? 0) };
  };
  for (const type of ['play', 'pause', 'ended', 'error', 'timeupdate', 'durationchange', 'seeked']) el.addEventListener(type, tell);
  document.body.append(el);
  return el;
}

/** The player lets go of its file: Close, from the system's controls or the playing bar, or its end. */
function forget() {
  held.value = null;
  playback.value = null;
}

/**
 * Play a message's voice message or sound file in the app's player, or pause or go on with it when it is the one it
 * holds. `from`, a fraction of its length: play from there (a tap on its position bar).
 */
export function playFile(m: P.MessageView, att: number, from?: number) {
  const a = m.attachments[att];
  if (!a || typeof document === 'undefined') return;
  const el = thePlayer();
  const key = fileKey(m.id, att);
  if (held.peek()?.key !== key) {
    held.value = { key, what: describe(m, att, false, chatName, authorName), art: faceOf(m.authorId).url };
    playback.value = { key, playing: false, at: 0, length: a.voice?.seconds || a.info?.duration || 0 };
    el.src = a.url;
  } else if (el.error) {
    // It failed to load before: try it again.
    el.src = a.url;
  } else if (from === undefined && !el.paused) {
    el.pause();
    return;
  }
  if (from !== undefined) {
    const length = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : (playback.value?.length ?? 0);
    if (length) el.currentTime = Math.max(0, Math.min(1, from)) * length;
  }
  void el.play().catch(() => {});
}

/**
 * The playing bar's buttons: they act on the app's player, not on whatever played last (a video started since, which
 * paused it). Play makes it what plays again.
 */
export function playerControl(action: 'play' | 'pause' | 'stop') {
  const el = player;
  if (!el || !held.peek()) return;
  if (action === 'play') void el.play().catch(() => {});
  else if (action === 'pause') el.pause();
  else {
    el.pause();
    forget();
    if (current === el) publish(null);
  }
}

/** A call starting (call.ts startCall) wants the sound to itself. */
export function pauseNowPlaying() {
  if (current && !current.paused) current.pause();
}

const HANDLED: MediaSessionAction[] = ['play', 'pause', 'stop', 'seekto', 'seekbackward', 'seekforward'];

/** The browser's own media controls and keys. */
function session(n: NowPlaying | null) {
  const sess = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  if (!sess) return;
  try {
    if (!n) {
      sess.metadata = null;
      sess.playbackState = 'none';
      for (const a of HANDLED) sess.setActionHandler(a, null);
      return;
    }
    sess.metadata = new MediaMetadata({ title: n.title, artist: n.artist, album: n.album, artwork: n.art ? [{ src: n.art }] : [] });
    sess.playbackState = n.state;
    if (n.duration > 0) sess.setPositionState({ duration: n.duration / 1000, position: Math.min(n.position, n.duration) / 1000, playbackRate: n.rate });
    sess.setActionHandler('play', () => control('play'));
    sess.setActionHandler('pause', () => control('pause'));
    sess.setActionHandler('stop', () => control('stop'));
    sess.setActionHandler('seekto', (d) => d.seekTime != null && control('seek', d.seekTime * 1000));
    sess.setActionHandler('seekbackward', (d) => current && control('seek', (current.currentTime - (d.seekOffset ?? 10)) * 1000));
    sess.setActionHandler('seekforward', (d) => current && control('seek', (current.currentTime + (d.seekOffset ?? 10)) * 1000));
  } catch (e) {
    // An older browser without some of these: what it has still works.
    console.warn('media session', e);
  }
}

export function startNowPlaying() {
  if (typeof document === 'undefined') return;
  const media = (e: Event) => (e.target instanceof HTMLMediaElement ? e.target : null);
  document.addEventListener(
    'play',
    (e) => {
      const el = media(e);
      if (!el || !counts(el)) return;
      if (current && current !== el && !current.paused) current.pause();
      current = el;
      publish(el);
    },
    true,
  );
  document.addEventListener(
    'pause',
    (e) => {
      const el = media(e);
      if (!el || el !== current) return;
      // Taken out of the page (its chat closed): Chromium pauses a player it removes, and there is nothing left to play.
      // Nor after its file failed to load. In the Android app a video stops too once the app is hidden: its WebView
      // pauses a video then and plays none until it is seen again, so Play in the notification could do nothing.
      const hiddenVideo = ANDROID && el instanceof HTMLVideoElement && document.visibilityState === 'hidden';
      publish(el.isConnected && !el.ended && !el.error && !hiddenVideo ? el : null);
    },
    true,
  );
  // The app's player empties as it takes the next file: that is not the end of what plays.
  for (const type of ['ended', 'emptied', 'error']) document.addEventListener(type, (e) => media(e) === current && current && !(type === 'emptied' && current === player) && publish(null), true);
  // The position the system's bar draws from: said again when it jumps, not as it moves.
  for (const type of ['seeked', 'ratechange', 'durationchange']) document.addEventListener(type, (e) => media(e) === current && current && publish(current), true);
}
