/**
 * A video, played in place with controls of the app's own, as Discord's are (docs/media-kinds.md "Videos").
 *
 * With a mouse: a big play button until it starts, then a bar along the bottom while the pointer is over it or it is
 * paused (play, the time, a seek bar that says the time under the pointer, the sound with a slider, full screen), and
 * the file's name with Download along the top. A click on the picture plays or pauses it, a double click fills the
 * screen. Keys, while it has the focus: Space or K plays and pauses, F fills the screen, M mutes, the arrows go 5 s back
 * and on (J and L 10 s) and change the volume, Home goes to the start.
 *
 * On a phone: a tap plays it, and once it plays a tap shows or hides the controls (they go by themselves after a few
 * seconds): a big play and pause in the middle, the bar below with mute and full screen. The seek bar is tall enough
 * for a thumb. Full screen turns a wide video on its side where the phone allows it, and back leaves it.
 *
 * Full screen is the browser's own where it has one. Where it has not (the Android app's WebView, an iPhone), the
 * player itself is put over the whole page (a popover: the top layer, out of reach of the list's transforms) and back
 * or Escape takes it down. Its element stays where it is, so the video goes on from where it was.
 *
 * One video plays at a time: starting one pauses the one before. The volume is remembered for the next video.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { android } from '../android.ts';
import { touchOnly, useLayer } from '../phone.ts';
import { Icon } from './icons.tsx';
import './video.css';

export interface VideoProps {
  src: string;
  /** A picture shown until it plays (an embed's thumbnail). */
  poster?: string;
  /** The file's name and facts, shown along the top with Download; Download only when there is a name. */
  name?: string | null;
  facts?: string;
  /** The video's size, when the network said, so its place is kept before it loads. */
  width?: number | null;
  height?: number | null;
  /** Starts at once (the file viewer). */
  autoPlay?: boolean;
  /** As large as its place and 80% of the screen's height allow, not a message's size (the file viewer). */
  large?: boolean;
  /** Started playing (a message's "played", MessageExtras.tsx). */
  onPlay?: () => void;
  class?: string;
  /** The attachment's place in its message, for the message's menu (Timeline.tsx). */
  att?: number;
  label?: string;
}

const VOLUME_KEY = 'dither-chat:video-volume';
/** How long the controls stay after the last move or tap while it plays. */
const HIDE_MS = 2500;
/** The largest a video is drawn in a message, as Discord's are: on a phone it may take the message's width. */
const BOX = { w: 400, h: 300 };
const TOUCH_BOX = { w: 420, h: 420 };

function remembered(): { volume: number; muted: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? 'null');
    if (v && typeof v.volume === 'number') return { volume: Math.min(1, Math.max(0, v.volume)), muted: !!v.muted };
  } catch {}
  return { volume: 1, muted: false };
}
function remember(volume: number, muted: boolean) {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume, muted }));
  } catch {}
}

/** 0:07, 1:03:09. */
function clockTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** The size to draw it at in a message: its own size fitted in BOX, or nothing known yet. */
function fitted(w: number | null | undefined, h: number | null | undefined, box = BOX): { width: number; ratio: string } | null {
  if (!w || !h) return null;
  const scale = Math.min(1, box.w / w, box.h / h);
  return { width: Math.round(w * scale), ratio: `${w} / ${h}` };
}

/** The one playing now: another starting pauses it. */
let current: HTMLVideoElement | null = null;

type Full = null | 'native' | 'page';

export function VideoPlayer(props: VideoProps) {
  const box = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(!!props.autoPlay);
  const [paused, setPaused] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [{ volume, muted }, setSound] = useState(remembered);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [full, setFull] = useState<Full>(null);
  const [shown, setShown] = useState(true);
  const [scrub, setScrub] = useState<number | null>(null);
  const hideAt = useRef<ReturnType<typeof setTimeout>>(undefined);
  const coarse = touchOnly.value;
  const onPlay = useRef(props.onPlay);
  onPlay.current = props.onPlay;

  // The controls go away a while after the last move while it plays, and stay while it is paused.
  const wake = (keep = false) => {
    setShown(true);
    clearTimeout(hideAt.current);
    if (!keep) hideAt.current = setTimeout(() => setShown(false), HIDE_MS);
  };
  useEffect(() => () => clearTimeout(hideAt.current), []);
  useEffect(() => {
    if (paused || scrub !== null) (clearTimeout(hideAt.current), setShown(true));
    else wake();
  }, [paused, scrub !== null]);

  useLayoutEffect(() => {
    const v = vid.current!;
    v.volume = volume;
    v.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    const v = vid.current!;
    const on = (type: string, f: () => void) => (v.addEventListener(type, f), () => v.removeEventListener(type, f));
    const offs = [
      on('play', () => {
        if (current && current !== v) current.pause();
        current = v;
        setPaused(false);
        setStarted(true);
        onPlay.current?.();
      }),
      on('pause', () => (setPaused(true), current === v && (current = null))),
      on('ended', () => setPaused(true)),
      on('waiting', () => setWaiting(true)),
      on('playing', () => setWaiting(false)),
      on('canplay', () => setWaiting(false)),
      on('timeupdate', () => setTime(v.currentTime)),
      on('durationchange', () => setDuration(Number.isFinite(v.duration) ? v.duration : 0)),
      on('loadedmetadata', () => v.videoWidth && setSize({ w: v.videoWidth, h: v.videoHeight })),
      on('progress', () => setBuffered(v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0)),
      on('error', () => setFailed(true)),
      on('volumechange', () => (setSound({ volume: v.volume, muted: v.muted }), remember(v.volume, v.muted))),
      // A new file in the same place starts over.
      on('emptied', () => (setFailed(false), setTime(0), setDuration(0), setBuffered(0), setPaused(true))),
    ];
    // What it already has: its metadata can come in before these listen (a file the cache had).
    if (Number.isFinite(v.duration)) setDuration(v.duration);
    if (v.videoWidth) setSize({ w: v.videoWidth, h: v.videoHeight });
    if (v.error) setFailed(true);
    return () => {
      offs.forEach((f) => f());
      if (current === v) current = null;
    };
  }, []);

  useEffect(() => {
    if (props.autoPlay) {
      box.current?.focus({ preventScroll: true });
      vid.current?.play().catch(() => {});
    }
  }, []);

  // The browser's full screen, left by its own Escape or back: follow it.
  useEffect(() => {
    const f = () => {
      if (document.fullscreenElement === box.current) setFull('native');
      else setFull((x) => (x === 'native' ? null : x));
    };
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);

  const toggle = () => {
    const v = vid.current!;
    if (failed) return;
    if (v.paused || v.ended) v.play().catch(() => {});
    else v.pause();
  };
  const seekTo = (s: number) => {
    const v = vid.current!;
    const end = duration || v.duration || 0;
    v.currentTime = Math.min(Math.max(0, s), end || s);
    setTime(v.currentTime);
  };
  const setVolume = (x: number) => {
    const v = vid.current!;
    v.volume = Math.min(1, Math.max(0, x));
    v.muted = v.volume === 0;
  };
  const mute = () => {
    const v = vid.current!;
    if (v.muted || v.volume === 0) (v.volume === 0 && (v.volume = 0.5), (v.muted = false));
    else v.muted = true;
  };

  const enterFull = async () => {
    const el = box.current!;
    const wide = (size?.w ?? props.width ?? 16) >= (size?.h ?? props.height ?? 9);
    // The Android app's WebView shows nothing for the browser's own full screen: the page one there.
    if (!android && el.requestFullscreen) {
      try {
        await el.requestFullscreen({ navigationUI: 'hide' });
        // A wide video on its side on a phone, as Discord's does; the phone may say no.
        if (coarse && wide) await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {});
        return;
      } catch {}
    }
    setFull('page');
  };
  const leaveFull = () => {
    if (full === 'native') {
      try {
        screen.orientation.unlock?.();
      } catch {}
      void document.exitFullscreen?.().catch(() => {});
    } else setFull(null);
  };
  const toggleFull = () => (full ? leaveFull() : void enterFull());

  // Escape leaves full screen and nothing more: the browser's own may let the key through to the page, where it would
  // also leave the chat (escape.ts).
  useLayoutEffect(() => {
    if (!full) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      leaveFull();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [full]);

  // The page's full screen is a popover, so it sits above everything; its element is never moved.
  useLayoutEffect(() => {
    const el = box.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el || full !== 'page' || !el.showPopover) return;
    el.setAttribute('popover', 'manual');
    el.showPopover();
    return () => {
      try {
        el.hidePopover?.();
      } catch {}
      el.removeAttribute('popover');
    };
  }, [full]);

  // A tap on the picture: play it, or once it plays, show or hide the controls. A click: play or pause. Taken on the
  // click, not the pointer's lifting, so a spoiler's veil (rich/parts.tsx Veil) that takes the click keeps it shut.
  const lastTap = useRef(0);
  const pointer = useRef('mouse');
  const onSurface = () => {
    if (pointer.current === 'mouse') return toggle();
    const now = Date.now();
    const double = now - lastTap.current < 300;
    lastTap.current = now;
    if (!started || paused) return toggle();
    if (double) return;
    if (shown) (clearTimeout(hideAt.current), setShown(false));
    else wake();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' && /^Arrow/.test(e.key)) return;
    const v = vid.current!;
    const act: Record<string, () => void> = {
      ' ': toggle,
      k: toggle,
      f: toggleFull,
      m: mute,
      ArrowLeft: () => seekTo(v.currentTime - 5),
      ArrowRight: () => seekTo(v.currentTime + 5),
      j: () => seekTo(v.currentTime - 10),
      l: () => seekTo(v.currentTime + 10),
      ArrowUp: () => setVolume(v.volume + 0.1),
      ArrowDown: () => setVolume(v.volume - 0.1),
      Home: () => seekTo(0),
      End: () => seekTo(duration),
    };
    const a = act[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    // A button's own Space and Enter press the button.
    if (!a || (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter'))) return;
    e.preventDefault();
    e.stopPropagation();
    a();
    wake(v.paused);
  };

  const w = size?.w ?? props.width;
  const h = size?.h ?? props.height;
  const fit = full ? null : fitted(w, h, coarse ? TOUCH_BOX : BOX);
  const sized: Record<string, string> = full
    ? {}
    : props.large
      ? { width: `min(${w ?? 1920}px, 100%, ${(80 * (w && h ? w / h : 16 / 9)).toFixed(2)}vh)`, aspectRatio: w && h ? `${w} / ${h}` : '16 / 9' }
      : fit
        ? { width: `${fit.width}px`, aspectRatio: fit.ratio }
        : {};
  const hideUi = started && !paused && !shown && scrub === null;
  const end = duration || 0;
  const at = scrub ?? time;
  const volIcon = muted || volume === 0 ? 'volumeOff' : volume < 0.5 ? 'volumeLow' : 'voice';
  const label = props.label ?? props.name ?? 'Video';

  return (
    <div
      ref={box}
      class={`vp ${coarse ? 'vp-touch' : ''} ${full ? `vp-full vp-${full}` : ''} ${hideUi ? 'vp-idle' : ''} ${started ? 'vp-started' : ''} ${props.class ?? ''}`}
      data-att={props.att}
      style={sized}
      tabIndex={0}
      role="group"
      aria-label={label}
      onKeyDown={onKey}
      onPointerMove={(e) => e.pointerType === 'mouse' && wake(paused)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && started && !paused && scrub === null && (clearTimeout(hideAt.current), setShown(false))}
    >
      {full === 'page' && <PageFull onBack={() => setFull(null)} />}
      <video
        ref={vid}
        class="vp-video"
        src={props.src}
        poster={props.poster}
        preload="metadata"
        playsInline
        onPointerDown={(e) => (pointer.current = e.pointerType)}
        onClick={onSurface}
        onDblClick={() => !coarse && toggleFull()}
      />
      {failed ? (
        <div class="vp-failed">
          <span>This video can't be played here.</span>
          {props.name && (
            <a href={props.src} download={props.name}>
              Download it
            </a>
          )}
        </div>
      ) : (
        <>
          {waiting && !paused && <div class="vp-spin" aria-hidden="true" />}
          {/* With a mouse, only until it first plays (then the bar's button, and a click anywhere); on a phone, with the controls. */}
          {(!started || (coarse && (paused || !hideUi))) && !waiting && (
            <button class="vp-big" onClick={toggle} aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play' : 'Pause'}>
              <Icon name={paused ? 'play' : 'pause'} size={coarse ? 30 : 26} class="vp-solid" />
            </button>
          )}
          {!started && end > 0 && <span class="vp-length">{clockTime(end)}</span>}
        </>
      )}
      {(props.name || full) && (
        <div class="vp-top">
          {full && (
            <button class="vp-btn" onClick={leaveFull} aria-label="Leave full screen" title="Leave full screen">
              <Icon name="x" size={20} />
            </button>
          )}
          {props.name && (
            <span class="vp-name">
              <b title={props.name}>{props.name}</b>
              {props.facts && <small>{props.facts}</small>}
            </span>
          )}
          {props.name && (
            <a class="vp-btn" href={props.src} download={props.name} aria-label="Download" title="Download" onClick={(e) => e.stopPropagation()}>
              <Icon name="download" size={18} />
            </a>
          )}
        </div>
      )}
      {started && !failed && (
        <div class="vp-bar">
          {!coarse && (
            <button class="vp-btn" onClick={toggle} aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play (K)' : 'Pause (K)'}>
              <Icon name={paused ? 'play' : 'pause'} size={18} class="vp-solid" />
            </button>
          )}
          <span class="vp-time">
            {clockTime(at)}
            <span class="vp-of"> / {clockTime(end)}</span>
          </span>
          <Seek at={at} end={end} buffered={buffered} onScrub={setScrub} onSeek={(s) => (setScrub(null), seekTo(s))} />
          <div class="vp-sound">
            <button class="vp-btn" onClick={mute} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute (M)' : 'Mute (M)'}>
              <Icon name={volIcon} size={18} />
            </button>
            {!coarse && (
              <input
                class="vp-volume"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="Volume"
                onInput={(e) => setVolume(Number((e.currentTarget as HTMLInputElement).value))}
              />
            )}
          </div>
          <button class="vp-btn" onClick={toggleFull} aria-label={full ? 'Leave full screen' : 'Full screen'} title={full ? 'Leave full screen (F)' : 'Full screen (F)'}>
            <Icon name={full ? 'fullscreenOff' : 'fullscreen'} size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

/** While the player fills the page: back (or Escape) takes it down. */
function PageFull({ onBack }: { onBack: () => void }) {
  useLayer(onBack);
  return null;
}

/**
 * The seek bar: a press anywhere on it goes there, and a drag follows the pointer, the time shown as it goes and the
 * video sent there when let go. With a mouse, the time under the pointer shows above it.
 */
function Seek({ at, end, buffered, onScrub, onSeek }: { at: number; end: number; buffered: number; onScrub: (s: number | null) => void; onSeek: (s: number) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; s: number } | null>(null);
  const held = useRef(false);
  const timeAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
    return { x: f * r.width, s: f * end };
  };
  const pct = (s: number) => `${end ? Math.min(100, (s / end) * 100) : 0}%`;
  return (
    <div
      ref={bar}
      class="vp-seek"
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(end)}
      aria-valuenow={Math.round(at)}
      aria-valuetext={`${clockTime(at)} of ${clockTime(end)}`}
      onPointerDown={(e) => {
        if (!end || e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        held.current = true;
        onScrub(timeAt(e.clientX).s);
      }}
      onPointerMove={(e) => {
        if (!end) return;
        const t = timeAt(e.clientX);
        if (e.pointerType === 'mouse') setHover(t);
        if (held.current) onScrub(t.s);
      }}
      onPointerUp={(e) => {
        if (!held.current) return;
        held.current = false;
        onSeek(timeAt(e.clientX).s);
      }}
      onPointerCancel={() => ((held.current = false), onScrub(null))}
      onPointerLeave={() => setHover(null)}
    >
      <div class="vp-track">
        <div class="vp-loaded" style={{ width: pct(buffered) }} />
        <div class="vp-played" style={{ width: pct(at) }} />
      </div>
      <div class="vp-thumb" style={{ left: pct(at) }} />
      {hover && (
        <span class="vp-tip" style={{ left: `${hover.x}px` }}>
          {clockTime(hover.s)}
        </span>
      )}
    </div>
  );
}
