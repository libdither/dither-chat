/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * The heavier part of rich messages (docs/rich-messages.md), a chunk loaded the first time a message needs it: a bot's
 * buttons and selects (shown as they are, not pressable yet: link buttons open their link), an activity invite,
 * quotes of the stored messages a message links to, the voice-message player and the embed video player.
 */
// Classic JSX (the pragmas above), and the app's own helpers handed in as `kit` (parts.tsx) rather than imported:
// either would split shared chunks off the app's start.
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Kit } from './parts.tsx';
import './rich.css';

const NOT_YET = 'Pressing this from dither is not built yet: open the message on its network to use it';

/** A label or emoji written as body Markdown (custom emoji as <:name:id>), drawn as the body draws it. */
function Label({ text, network, kit }: { text: string; network: P.Network; kit: Kit }) {
  return <span dangerouslySetInnerHTML={{ __html: kit.md(text, network) }} />;
}

function Button({ c, network, kit }: { c: P.ButtonFact; network: P.Network; kit: Kit }) {
  const inner = (
    <>
      {c.emoji && <Label text={c.emoji} network={network} kit={kit} />}
      {c.label && <span>{c.label}</span>}
      {c.style === 'link' && kit.icon('external', 12)}
    </>
  );
  if (c.style === 'link' && c.url && /^https?:\/\//i.test(c.url) && !c.disabled)
    return (
      <a class="rc-btn link" href={c.url} target="_blank" rel="noreferrer noopener" title={c.url}>
        {inner}
      </a>
    );
  return (
    <button class={`rc-btn ${c.style}`} disabled title={c.disabled ? 'Turned off by the bot' : NOT_YET}>
      {inner}
    </button>
  );
}

function Select({ c, kit }: { c: P.SelectFact; kit: Kit }) {
  const picked = c.options?.filter((o) => o.default).map((o) => o.label);
  const what = { string: 'an option', user: 'people', role: 'roles', mentionable: 'people or roles', channel: 'channels' }[c.select];
  return (
    <details class="rc-select">
      <summary title={NOT_YET}>
        <span>{picked?.length ? picked.join(', ') : (c.placeholder ?? `Pick ${what}`)}</span>
        {kit.icon('chevronDown', 14)}
      </summary>
      {c.options?.length ? (
        <ul>
          {c.options.map((o) => (
            <li class={o.default ? 'picked' : ''}>
              <b>{o.label}</b>
              {o.description && <small>{o.description}</small>}
            </li>
          ))}
        </ul>
      ) : (
        <p class="rc-note">Picks {what} of this place.</p>
      )}
      <p class="rc-note">{NOT_YET}.</p>
    </details>
  );
}

function Linked({ l, network, kit }: { l: P.LinkedMessageView; network: P.Network; kit: Kit }) {
  const text = kit.plain(l.text, network).slice(0, 200) || (l.attachments ? `${l.attachments} file${l.attachments === 1 ? '' : 's'}` : '');
  return (
    <button class="reply-quote rich-linked" onClick={() => kit.open(l.conversationId, l.messageId)} title="Open this message">
      {kit.icon('link', 12)}
      <b>{l.authorId ? kit.name(l.authorId) : 'Someone'}</b>
      <span>{text}</span>
      <small>{kit.when(l.ts)}</small>
    </button>
  );
}

const ACTIVITY: Record<P.ActivityInviteFact['kind'], string> = { join: 'Invited you to join', spectate: 'Invited you to watch', listen: 'Invited you to listen along to', request: 'Asked to join' };

export function RichFoot({ m, rich, kit }: { m: P.MessageView; rich: P.RichView; kit: Kit }) {
  return (
    <>
      {rich.activity && (
        <div class="rich-line">
          {kit.icon('gamepad', 12)}
          {ACTIVITY[rich.activity.kind] ?? 'Invited you'} {rich.activity.name ?? 'an activity'}: answer it on {m.network === 'discord' ? 'Discord' : 'its network'}.
        </div>
      )}
      {rich.components?.length ? (
        <div class="rc-rows">
          {rich.components.map((row) => (
            <div class="rc-row">{row.map((c) => (c.kind === 'button' ? <Button c={c} network={m.network} kit={kit} /> : <Select c={c} kit={kit} />))}</div>
          ))}
        </div>
      ) : null}
      {rich.linked?.map((l) => <Linked l={l} network={m.network} kit={kit} />)}
    </>
  );
}

const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** A voice message: play and pause, its waveform filling as it plays (a click on it seeks), and its length. */
export function VoicePlayer({ a, index, kit }: { a: P.AttachmentView; index: number; kit: Kit }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const total = a.voice?.seconds ?? 0;
  const points = kit.points(a.voice?.waveform);
  // At most 64 bars, each the loudest of the points it covers.
  const bars: number[] = [];
  const per = Math.max(1, Math.ceil(points.length / 64));
  for (let i = 0; i < points.length; i += per) bars.push(Math.max(...points.slice(i, i + per)));
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    const on: Record<string, () => void> = {
      timeupdate: () => setAt(el.currentTime),
      ended: () => (setPlaying(false), setAt(0)),
      pause: () => setPlaying(false),
      play: () => setPlaying(true),
    };
    for (const k in on) el.addEventListener(k, on[k]);
    return () => {
      for (const k in on) el.removeEventListener(k, on[k]);
    };
  }, []);
  const length = total || audio.current?.duration || 0;
  const done = length ? at / length : 0;
  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };
  const seek = (e: MouseEvent) => {
    const el = audio.current;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!el || !length || !box.width) return;
    el.currentTime = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * length;
  };
  return (
    <div class="voice" data-att={index}>
      <audio ref={audio} src={a.url} preload="none" />
      <button class="icon-btn voice-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play voice message'}>
        {playing ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          kit.icon('play', 16)
        )}
      </button>
      <div class="voice-wave" onClick={seek} role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(length)} aria-valuenow={Math.round(at)}>
        {bars.length ? bars.map((b, i) => <span class={i / bars.length < done ? 'on' : ''} style={{ height: `${Math.max(12, Math.round(b * 100))}%` }} />) : <span class="voice-line" style={{ width: `${Math.round(done * 100)}%` }} />}
      </div>
      <small class="voice-time">{time(playing || at ? at : length)}</small>
    </div>
  );
}

/** Player pages loaded only once clicked, from hosts known to make them; anything else opens as a link. */
const PLAYERS: [RegExp, (u: URL) => string][] = [
  // YouTube's no-cookie host serves the same player without its tracking cookies.
  [/^(www\.)?youtube(-nocookie)?\.com$/, (u) => `https://www.youtube-nocookie.com${u.pathname}?autoplay=1`],
  // Twitch's player asks to be told which page holds it.
  [/^(player|clips)\.twitch\.tv$/, (u) => (u.searchParams.set('parent', location.hostname), u.searchParams.set('autoplay', 'true'), u.href)],
  [/^player\.vimeo\.com$/, (u) => (u.searchParams.set('autoplay', '1'), u.href)],
];

export function playerUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (/youtube/.test(u.hostname) && !u.pathname.startsWith('/embed/')) return null;
    const p = PLAYERS.find(([host]) => host.test(u.hostname));
    return p ? p[1](u) : null;
  } catch {
    return null;
  }
}

export function EmbedVideo({ e, kit }: { e: P.EmbedView; kit: Kit }) {
  const v = e.video!;
  const [on, setOn] = useState(false);
  const ratio = v.width && v.height ? `${v.width} / ${v.height}` : '16 / 9';
  if (!v.player)
    return v.gifv ? (
      <video class="embed-video" src={v.url} autoplay loop muted playsinline style={{ aspectRatio: ratio }} />
    ) : (
      <video class="embed-video" src={v.url} controls preload="metadata" poster={e.image} style={{ aspectRatio: ratio }} />
    );
  const page = playerUrl(v.url);
  if (on && page)
    return <iframe class="embed-video" src={page} style={{ aspectRatio: ratio }} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" referrerpolicy="strict-origin-when-cross-origin" title={e.title ?? 'Video'} />;
  return (
    <button
      class="embed-video embed-poster"
      style={{ aspectRatio: ratio, ...(e.image ? { backgroundImage: `url("${e.image.replace(/"/g, '%22')}")` } : {}) }}
      onClick={() => (page ? setOn(true) : e.url && window.open(e.url, '_blank', 'noopener,noreferrer'))}
      title={page ? `Play here (loads ${new URL(page).hostname})` : 'Open the video'}
      aria-label="Play video"
    >
      {kit.icon('play', 28)}
    </button>
  );
}
