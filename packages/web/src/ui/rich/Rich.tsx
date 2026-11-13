/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * The heavier part of rich messages (docs/rich-messages.md), a chunk loaded the first time a message needs it: a bot's
 * buttons and selects (pressed and chosen from here where the account can, docs/apps.md; link buttons open their link), an activity invite,
 * quotes of the stored messages a message links to, the voice-message player and the embed video player.
 */
// Classic JSX (the pragmas above), and the app's own helpers handed in as `kit` (parts.tsx) rather than imported:
// either would split shared chunks off the app's start.
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Kit } from './parts.tsx';
import './rich.css';

const NOT_YET = 'None of your accounts here can press this from dither: open the message on its network to use it';

/** A label or emoji written as body Markdown (custom emoji as <:name:id>), drawn as the body draws it. */
function Label({ text, network, kit }: { text: string; network: P.Network; kit: Kit }) {
  return <span dangerouslySetInnerHTML={{ __html: kit.md(text, network) }} />;
}

function Button({ c, m, kit }: { c: P.ButtonFact; m: P.MessageView; kit: Kit }) {
  const inner = (
    <>
      {c.emoji && <Label text={c.emoji} network={m.network} kit={kit} />}
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
  // Pressed only by a click of the owner's, once: no press goes while the last one on this message waits.
  const pressable = !c.disabled && !!c.id && c.style !== 'link' && c.style !== 'premium' && kit.canPress(m);
  const busy = kit.pressState(m.id)?.state === 'sending';
  return (
    <button class={`rc-btn ${c.style}`} disabled={!pressable || busy} title={c.disabled ? 'Turned off by the bot' : pressable ? undefined : NOT_YET} data-track="bot button" onClick={() => pressable && !busy && void kit.press(m, c.id!)}>
      {inner}
    </button>
  );
}

const WHAT: Record<P.SelectKind, string> = { string: 'an option', user: 'people', role: 'roles', mentionable: 'people or roles', channel: 'channels' };

/** A select: its options (or the place's people, roles or channels) to choose from, sent once when chosen. */
function Select({ c, m, kit }: { c: P.SelectFact; m: P.MessageView; kit: Kit }) {
  const usable = !c.disabled && !!c.id && kit.canPress(m);
  const min = c.min ?? 1;
  const max = c.max ?? 1;
  const [picked, setPicked] = useState<string[]>(() => (c.options ?? []).filter((o) => o.default).map((o) => o.value));
  const [names, setNames] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [picks, setPicks] = useState<P.AppPickView[]>([]);
  const box = useRef<HTMLDetailsElement>(null);
  const busy = kit.pressState(m.id)?.state === 'sending';
  const fromPlace = c.select !== 'string';
  useEffect(() => {
    if (!usable || !fromPlace) return;
    const t = setTimeout(() => void kit.picks(m.conversationId, c.select, q).then(setPicks, () => setPicks([])), 250);
    return () => clearTimeout(t);
  }, [q, usable]);
  const send = (values: string[]) => {
    if (busy || values.length < min || values.length > max) return;
    if (box.current) box.current.open = false;
    void kit.press(m, c.id!, values);
  };
  const toggle = (value: string, name: string) => {
    setNames((n) => ({ ...n, [value]: name }));
    if (max === 1) return send([value]);
    setPicked((p) => (p.includes(value) ? p.filter((x) => x !== value) : p.length >= max ? p : [...p, value]));
  };
  const label = picked.length ? picked.map((v) => c.options?.find((o) => o.value === v)?.label ?? names[v] ?? v).join(', ') : (c.placeholder ?? `Pick ${WHAT[c.select]}`);
  const rows: { value: string; label: string; description?: string }[] = fromPlace ? picks.map((p) => ({ value: p.value, label: p.kind === 'channel' ? `#${p.name}` : p.kind === 'role' ? `@${p.name}` : p.name })) : (c.options ?? []).map((o) => ({ value: o.value, label: o.label, description: o.description }));
  return (
    <details class="rc-select" ref={box}>
      <summary title={usable ? undefined : NOT_YET} data-track="bot select">
        <span>{label}</span>
        {kit.icon('chevronDown', 14)}
      </summary>
      {usable && fromPlace && <input class="rc-find" type="search" placeholder={`Find ${WHAT[c.select]} you know here`} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />}
      {rows.length ? (
        <ul>
          {rows.map((o) =>
            usable ? (
              <li class={picked.includes(o.value) ? 'picked' : ''}>
                <button class="rc-opt" disabled={busy} aria-pressed={picked.includes(o.value)} onClick={() => toggle(o.value, o.label)}>
                  <b>{o.label}</b>
                  {o.description && <small>{o.description}</small>}
                </button>
              </li>
            ) : (
              <li class={picked.includes(o.value) ? 'picked' : ''}>
                <b>{o.label}</b>
                {o.description && <small>{o.description}</small>}
              </li>
            ),
          )}
        </ul>
      ) : (
        <p class="rc-note">{fromPlace ? (usable ? `No ${WHAT[c.select]} the hub knows here match.` : `Picks ${WHAT[c.select]} of this place.`) : 'No options.'}</p>
      )}
      {usable && max > 1 && (
        <p class="rc-choose">
          <button class="btn small" disabled={busy || picked.length < min || picked.length > max} data-track="bot select (choose)" onClick={() => send(picked)}>
            Choose{picked.length ? ` ${picked.length}` : ''}
          </button>
          <small>{min === max ? `Pick ${min}` : `Pick ${min} to ${max}`}</small>
        </p>
      )}
      {!usable && <p class="rc-note">{c.disabled ? 'Turned off by the bot.' : `${NOT_YET}.`}</p>}
    </details>
  );
}

/** What became of the last press on this message from here. */
function PressState({ m, kit }: { m: P.MessageView; kit: Kit }) {
  const v = kit.pressState(m.id);
  if (!v) return null;
  return (
    <div class={`rc-state ${v.state}`} role="status">
      {kit.words(v)}
    </div>
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
            <div class="rc-row">{row.map((c) => (c.kind === 'button' ? <Button c={c} m={m} kit={kit} /> : <Select c={c} m={m} kit={kit} />))}</div>
          ))}
          <PressState m={m} kit={kit} />
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
