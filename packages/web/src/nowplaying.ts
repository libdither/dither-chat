/**
 * What is playing (docs/media-kinds.md "Playing in the background"): the voice message, sound file or video with sound
 * that was started last, wherever on the page its player is. One listener on the document hears every player's play,
 * pause and end; media events do not bubble, so it listens as they go down. Not heard: a player made with `new Audio()`
 * and never put in the page (a call's sound, call.ts; a page in another site's frame), and muted or looping ones (GIFs,
 * a story's preview), which are not something you listen to.
 *
 * It gives the system the controls: `navigator.mediaSession` in a browser (media keys, the browser's own "now playing"),
 * and in the Android app a media notification over the bridge (android.ts), whose service keeps the page playing with
 * the screen off. One plays at a time: starting one pauses the one before, and a call starting pauses it.
 */
import { signal } from '@preact/signals';
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

function publish(el: HTMLMediaElement | null) {
  if (!el) {
    current = null;
    nowPlaying.value = null;
  } else {
    const { messageId, att } = placeOf(el);
    const m = messageId ? findMessage(messageId) : null;
    const what = describe(m, att, el instanceof HTMLVideoElement, (id) => db.conversations.get(id)?.name ?? null, authorName);
    nowPlaying.value = {
      ...what,
      state: el.paused ? 'paused' : 'playing',
      art: m ? faceOf(m.authorId).url : null,
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
    publish(null);
  } else if (action === 'seek' && typeof toMs === 'number' && Number.isFinite(toMs)) {
    el.currentTime = Math.max(0, toMs / 1000);
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
  for (const type of ['ended', 'emptied', 'error']) document.addEventListener(type, (e) => media(e) === current && current && publish(null), true);
  // The position the system's bar draws from: said again when it jumps, not as it moves.
  for (const type of ['seeked', 'ratechange', 'durationchange']) document.addEventListener(type, (e) => media(e) === current && current && publish(current), true);
}
