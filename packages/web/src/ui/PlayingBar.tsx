/**
 * The playing bar (docs/media-kinds.md "Playing in the background"): the voice message or sound file the app's player
 * holds (nowplaying.ts), while its chat is not the page on screen. A slim row of the layout where the call bar goes
 * (CallBar.tsx), which it gives way to: play or pause, what it is and who sent it (a tap goes to the message), how far
 * it has got, and Close. It stays while paused, until Close or the end, and while a video plays in its place (which
 * paused it): its buttons are the app's player's own (nowplaying.ts playerControl).
 */
import { activeCall } from '../call.ts';
import { held, playback, playerControl, playingKey } from '../nowplaying.ts';
import { openMessage } from '../state.ts';
import { isCallChat } from './CallBar.tsx';
import { Icon } from './icons.tsx';
import './PlayingBar.css';

/** Does the bar show, with `shown` the conversation on screen? Not in a call: the call has the sound, and the bar's row. */
export function playingBarShown(shown: string | null): boolean {
  const id = held.value?.what.conversationId;
  if (!id || activeCall.value) return false;
  return !isCallChat(shown, id);
}

export function PlayingBar() {
  // Drawn from what changes at play and pause, not from the position (nowplaying.ts playingKey says why): that is the
  // line's own.
  const h = held.value;
  if (!h) return null;
  const n = h.what;
  const playing = playingKey.value === h.key;
  const where = [n.artist, n.album].filter(Boolean).join(' · ');
  const open = () => n.conversationId && n.messageId && openMessage(n.conversationId, n.messageId);
  return (
    <section class="playing-bar" aria-label="Playing">
      <button class="icon-btn" onClick={() => playerControl(playing ? 'pause' : 'play')} aria-label={playing ? 'Pause' : 'Play'} data-track={`playing bar: ${playing ? 'pause' : 'play'}`}>
        <Icon name={playing ? 'pause' : 'play'} size={18} />
      </button>
      <button class="playing-bar-open" onClick={open} title="Go to the message" data-track="playing bar: go to the message">
        <b>{n.title}</b>
        {where && <small>{where}</small>}
      </button>
      <button class="icon-btn" onClick={() => playerControl('stop')} aria-label="Close" title="Stop and close" data-track="playing bar: close">
        <Icon name="x" size={16} />
      </button>
      <PlayingLine fileKey={h.key} />
    </section>
  );
}

/** How far it has got: a line along the bar's foot. */
function PlayingLine({ fileKey }: { fileKey: string }) {
  const p = playback.value;
  const done = p?.key === fileKey && p.length ? Math.min(1, p.at / p.length) : 0;
  return <span class="playing-bar-line" style={{ width: `${Math.round(done * 1000) / 10}%` }} aria-hidden="true" />;
}

