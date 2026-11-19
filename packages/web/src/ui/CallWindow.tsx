/**
 * The call's video window (docs/calls.md "The video window"), a chunk of its own loaded once a call has video: one
 * window you move, resize and dock above the conversation, with the videos in a grid or one big for whoever talks, and
 * your own camera as a tile, an inset in a corner, or hidden. The layout itself is callLayout.ts; every change moves the
 * same tiles to their new rectangles, so it morphs.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { areaOf, autoChoices, clampDock, clampFloat, defaultFloat, layoutTiles, nearestCorner, PAD, type Arrange, type Corner, type MeMode, type Place, type Rect, type WindowChoices } from '../callLayout.ts';
import { phone } from '../phone.ts';
import { Icon } from './icons.tsx';
import './CallWindow.css';

interface WindowTile {
  id: string;
  stream: MediaStream;
  label: string;
  /** The bridge slot it plays on (others' video). */
  slot?: string;
  /** Whose (a hub identity id): its speaking edge. */
  who: string;
  /** This device's own camera: mirrored, and what "Your camera" places. */
  self?: boolean;
  share?: boolean;
}

const KEY = 'dither-chat:call-window';
function readChoices(): WindowChoices {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function saveChoices(c: WindowChoices) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {}
}

const viewport = () => ({ w: innerWidth, h: innerHeight });
/** The conversation pane: what the window docks above. */
const pane = () => document.querySelector<HTMLElement>('.app > .center');

/** The pane's place on screen, kept as it moves (the sidebar resizing, the window resizing). */
function usePaneRect(): DOMRect | null {
  const [r, setR] = useState<DOMRect | null>(() => pane()?.getBoundingClientRect() ?? null);
  useEffect(() => {
    const el = pane();
    if (!el) return;
    const read = () => setR(el.getBoundingClientRect());
    const ro = new ResizeObserver(read);
    ro.observe(el);
    addEventListener('resize', read);
    return () => {
      ro.disconnect();
      removeEventListener('resize', read);
    };
  }, []);
  return r;
}

/** A drag just ended: the click that follows its release is not a click on a video (full screen). */
let dragEnded = false;

type Drag = { kind: 'move' | 'resize' | 'split' | 'inset'; live: boolean };

export function CallWindow({ tiles, speaking, people }: { tiles: WindowTile[]; speaking: Set<string>; people: number }) {
  const [saved, setSaved] = useState<WindowChoices>(readChoices);
  const [pinned, setPinned] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dockHint, setDockHint] = useState(false);
  const [vp, setVp] = useState(viewport);
  // While dragging, the window's and the inset's rectangles before they are kept.
  const [liveFloat, setLiveFloat] = useState<Rect | null>(null);
  const [liveDock, setLiveDock] = useState<number | null>(null);
  const [liveInset, setLiveInset] = useState<{ x: number; y: number } | null>(null);
  const lastFocus = useRef<string | null>(null);
  const spacer = useRef<HTMLDivElement | null>(null);
  const [dockTop, setDockTop] = useState<number | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const ctl = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const paneRect = usePaneRect();
  const isPhone = phone.value;

  useEffect(() => {
    const on = () => setVp(viewport());
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);

  const share = tiles.some((t) => t.share && !t.self);
  const auto = autoChoices({ people, share, phone: isPhone });
  // A share coming on switches to Speaker only while you have not picked an arrangement yourself.
  const arrange: Arrange = saved.arrange ?? auto.arrange;
  const me: MeMode = saved.me ?? auto.me;
  const place: Place = saved.place ?? auto.place;
  const corner: Corner = saved.corner ?? 'br';
  const choose = (c: WindowChoices) => {
    const next = { ...saved, ...c };
    setSaved(next);
    saveChoices(next);
  };

  // Where the window is.
  const paneH = paneRect?.height ?? vp.h;
  const dockH = clampDock(liveDock ?? saved.dockH ?? (isPhone ? Math.min(((paneRect?.width ?? vp.w) * 9) / 16 + 24, vp.h * 0.42) : 280), paneH);
  const float = clampFloat(liveFloat ?? saved.float ?? defaultFloat(vp.w, vp.h), vp.w, vp.h);
  // The docked window sits on a spacer at the top of the conversation, which pushes the messages down. It is put in
  // the pane by hand: a portal would put it last.
  useLayoutEffect(() => {
    const el = pane();
    if (place !== 'dock' || !el) return;
    const s = document.createElement('div');
    s.className = 'call-win-spacer';
    s.setAttribute('aria-hidden', 'true');
    el.prepend(s);
    spacer.current = s;
    return () => {
      s.remove();
      spacer.current = null;
      setDockTop(null);
    };
  }, [place]);
  useLayoutEffect(() => {
    const s = spacer.current;
    if (!s) return;
    s.style.height = `${dockH}px`;
    const top = s.getBoundingClientRect().top;
    if (top !== dockTop) setDockTop(top);
  });
  const win: Rect = place === 'dock' ? { x: paneRect?.left ?? 0, y: dockTop ?? paneRect?.top ?? 0, w: paneRect?.width ?? vp.w, h: dockH } : float;
  const { w: W, h: H } = areaOf(place, win.w, win.h);

  const lay = layoutTiles({
    w: W,
    h: H,
    tiles: tiles.map((t) => ({ id: t.id, self: t.self, share: t.share, speaking: speaking.has(t.who) })),
    arrange,
    me,
    corner,
    pinned,
    lastFocus: lastFocus.current,
  });
  lastFocus.current = lay.focus;

  // The menu: Escape or a press outside closes it.
  useEffect(() => {
    if (!menu) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMenu(false);
      btn.current?.focus();
    };
    const down = (e: PointerEvent) => {
      if (!ctl.current?.contains(e.target as Node)) setMenu(false);
    };
    addEventListener('keydown', key, true);
    addEventListener('pointerdown', down, true);
    ctl.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => {
      removeEventListener('keydown', key, true);
      removeEventListener('pointerdown', down, true);
    };
  }, [menu]);

  /** Follows the pointer from a press until it lets go; `move` gets the distance from the press. */
  const follow = (e: PointerEvent, kind: Drag['kind'], move: (dx: number, dy: number, ev: PointerEvent) => void, end: (moved: boolean, ev: PointerEvent) => void, threshold = 0) => {
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved) {
        if (Math.hypot(dx, dy) < threshold) return;
        moved = true;
        setDrag({ kind, live: true });
      }
      move(dx, dy, ev);
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      setDrag(null);
      if (moved) {
        dragEnded = true;
        setTimeout(() => (dragEnded = false));
      }
      end(moved, ev);
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  };

  // Moving the window: anywhere on the video, past 5 px so a double-click still pins. Near the conversation's top it
  // docks; the docked video dragged down floats again.
  const onWinDown = (e: PointerEvent) => {
    if (e.button || (e.target as Element).closest('.call-win-ctl, .call-win-resize, .call-win-split, .call-video.inset')) return;
    const top = paneRect?.top ?? 0;
    let base = float;
    let origin = { x: e.clientX, y: e.clientY };
    let floated = place === 'float';
    let at = base;
    follow(
      e,
      'move',
      (_dx, dy, ev) => {
        if (!floated) {
          if (dy < 40) return;
          // Out of the dock: the floating window comes under the pointer and follows it from here.
          floated = true;
          base = clampFloat({ ...base, x: ev.clientX - base.w / 2, y: ev.clientY - 20 }, vp.w, vp.h);
          origin = { x: ev.clientX, y: ev.clientY };
          choose({ place: 'float' });
        }
        at = clampFloat({ ...base, x: base.x + ev.clientX - origin.x, y: base.y + ev.clientY - origin.y }, vp.w, vp.h);
        setLiveFloat(at);
        setDockHint(floated && ev.clientY - top < 24);
      },
      (moved, ev) => {
        setDockHint(false);
        setLiveFloat(null);
        if (!moved || !floated) return;
        if (ev.clientY - top < 24) choose({ place: 'dock', float: clampFloat({ ...at, y: top + 12 }, vp.w, vp.h) });
        else choose({ place: 'float', float: at });
      },
      5,
    );
  };

  const onResizeDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = float;
    let at = start;
    follow(
      e,
      'resize',
      (dx, dy) => setLiveFloat((at = clampFloat({ ...start, w: Math.min(start.w + dx, vp.w - start.x), h: Math.min(start.h + dy, vp.h - start.y) }, vp.w, vp.h))),
      (moved) => {
        setLiveFloat(null);
        if (moved) choose({ float: at });
      },
    );
  };

  const onSplitDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = dockH;
    let at = start;
    follow(
      e,
      'split',
      (_dx, dy) => setLiveDock((at = clampDock(start + dy, paneH))),
      (moved) => {
        setLiveDock(null);
        if (moved) choose({ dockH: at });
      },
    );
  };

  const onInsetDown = (e: PointerEvent, id: string) => {
    const r = lay.tiles.get(id);
    if (!r?.inset || e.button) return;
    e.preventDefault();
    e.stopPropagation();
    let at = { x: r.rect.x, y: r.rect.y };
    follow(
      e,
      'inset',
      (dx, dy) => setLiveInset((at = { x: r.rect.x + dx, y: r.rect.y + dy })),
      (moved) => {
        setLiveInset(null);
        if (moved) choose({ corner: nearestCorner({ ...r.rect, ...at }, W, H) });
      },
    );
  };

  const onTileDouble = (id: string) => {
    if (lay.tiles.get(id)?.inset) return;
    if (arrange === 'speaker' && pinned === id) {
      setPinned(null);
      choose({ arrange: 'grid' });
    } else {
      setPinned(id);
      choose({ arrange: 'speaker' });
    }
  };

  const pick = <K extends 'arrange' | 'me' | 'place'>(k: K, v: WindowChoices[K]) => {
    if (k === 'arrange' && v === 'grid') setPinned(null);
    choose({ [k]: v } as WindowChoices);
  };

  const pad = PAD[place];
  const resizing = drag && drag.kind !== 'move' && drag.kind !== 'inset';
  return (
    <>
      {dockHint && <div class="call-win-hint">Release to dock above the chat</div>}
      <div
        class={`call-videos ${place === 'dock' ? 'docked' : ''} ${drag ? 'live' : ''} ${resizing ? 'resizing' : ''}`}
        role="region"
        aria-label="Video"
        data-arrange={arrange}
        data-me={me}
        data-place={place}
        style={{ left: `${win.x}px`, top: `${win.y}px`, width: `${win.w}px`, height: `${win.h}px` }}
        onPointerDown={onWinDown}
      >
        <div class="call-win-area" ref={area} style={{ left: `${pad.x}px`, right: `${pad.x}px`, top: `${pad.top}px`, bottom: `${pad.bottom}px` }}>
          {tiles.map((t) => {
            const p = lay.tiles.get(t.id);
            if (!p) return null;
            const r = t.self && liveInset && p.inset ? { ...p.rect, ...liveInset } : p.rect;
            return (
              <VideoTile
                key={t.id}
                tile={t}
                rect={r}
                inset={!!p.inset}
                hidden={!!p.hidden}
                pinned={pinned === t.id && arrange === 'speaker'}
                speaking={speaking.has(t.who)}
                dragging={(t.self && drag?.kind === 'inset') || !!resizing}
                onDouble={() => onTileDouble(t.id)}
                onInsetDown={(e) => onInsetDown(e, t.id)}
              />
            );
          })}
        </div>
        <div class={`call-win-ctl ${menu ? 'open' : ''}`} ref={ctl}>
          <button ref={btn} class="call-win-btn" aria-label="Video layout" title="Video layout" aria-haspopup="true" aria-expanded={menu} data-track="call video layout" onClick={() => setMenu(!menu)}>
            <Icon name="grid" size={16} />
          </button>
          {menu && (
            <div class="call-win-menu" role="group" aria-label="Video layout">
              <Choices label="Arrange" value={arrange} set={(v) => pick('arrange', v as Arrange)} options={[['grid', 'Grid', GRID], ['speaker', 'Speaker', SPEAKER]]} />
              <Choices label="Your camera" value={me} set={(v) => pick('me', v as MeMode)} options={[['tile', 'Tile', ME_TILE], ['corner', 'Corner', ME_CORNER], ['off', 'Hidden', ME_OFF]]} />
              <Choices label="Place" value={place} set={(v) => pick('place', v as Place)} options={[['float', 'Floating', FLOAT], ['dock', 'Above chat', DOCK]]} />
              <div class="call-win-tip">Double-click a person to pin them.</div>
            </div>
          )}
        </div>
        {place === 'float' && <div class="call-win-resize" aria-hidden="true" onPointerDown={onResizeDown} />}
        {place === 'dock' && <div class="call-win-split" role="separator" aria-orientation="horizontal" aria-label="Video height" onPointerDown={onSplitDown} />}
      </div>
    </>
  );
}

/** One row of the menu: a choice of icons, one checked. */
function Choices({ label, value, set, options }: { label: string; value: string; set: (v: string) => void; options: [string, string, preact.JSX.Element][] }) {
  return (
    <>
      <div class="call-win-label" id={`call-win-${label.replace(/\W/g, '')}`}>
        {label}
      </div>
      <div class="call-win-row" role="radiogroup" aria-labelledby={`call-win-${label.replace(/\W/g, '')}`}>
        {options.map(([v, words, svg]) => (
          <button key={v} role="radio" aria-checked={value === v} class={value === v ? 'on' : ''} data-choice={v} data-track={`call video ${words.toLowerCase()}`} onClick={() => set(v)}>
            {svg}
            {words}
          </button>
        ))}
      </div>
    </>
  );
}

/** One video at its rectangle: a stream on a <video>, a click for full screen (held a moment, so a double-click pins). */
function VideoTile(props: { tile: WindowTile; rect: Rect; inset: boolean; hidden: boolean; pinned: boolean; speaking: boolean; dragging: boolean; onDouble: () => void; onInsetDown: (e: PointerEvent) => void }) {
  const { tile, rect } = props;
  const ref = useRef<HTMLVideoElement>(null);
  const click = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (v && v.srcObject !== tile.stream) {
      v.srcObject = tile.stream;
      v.play().catch(() => {});
    }
  }, [tile.stream]);
  useEffect(() => () => void (click.current && clearTimeout(click.current)), []);
  const cls = ['call-video', tile.self && 'mirror self', props.inset && 'inset', props.hidden && 'hidden', props.pinned && 'pinned', props.speaking && 'speaking', props.dragging && 'dragging'].filter(Boolean).join(' ');
  return (
    <figure
      class={cls}
      data-video-slot={tile.slot}
      data-tile={tile.id}
      aria-hidden={props.hidden || undefined}
      style={{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }}
      onPointerDown={props.inset ? props.onInsetDown : undefined}
      onDblClick={() => {
        if (click.current) clearTimeout(click.current);
        click.current = null;
        props.onDouble();
      }}
    >
      <video
        ref={ref}
        autoplay
        playsInline
        muted
        onClick={(e) => {
          if (props.inset || e.detail > 1 || dragEnded) return;
          const v = e.currentTarget as HTMLVideoElement;
          if (click.current) clearTimeout(click.current);
          click.current = setTimeout(() => {
            click.current = null;
            v.requestFullscreen?.().catch(() => {});
          }, 260);
        }}
      />
      <figcaption>{tile.label}</figcaption>
      {props.pinned && (
        <span class="call-video-pin" title="Pinned: double-click to go back to the grid">
          <Icon name="pin" size={12} />
        </span>
      )}
    </figure>
  );
}

const svg = (body: preact.JSX.Element) => (
  <svg viewBox="0 0 22 16" fill="currentColor" aria-hidden="true">
    {body}
  </svg>
);
const GRID = svg(
  <>
    <rect x="1" y="1" width="9.5" height="6.5" rx="1.2" />
    <rect x="11.5" y="1" width="9.5" height="6.5" rx="1.2" />
    <rect x="1" y="8.5" width="9.5" height="6.5" rx="1.2" />
    <rect x="11.5" y="8.5" width="9.5" height="6.5" rx="1.2" />
  </>,
);
const SPEAKER = svg(
  <>
    <rect x="1" y="1" width="20" height="10" rx="1.2" />
    <rect x="1" y="12" width="6" height="3" rx=".7" />
    <rect x="8" y="12" width="6" height="3" rx=".7" />
    <rect x="15" y="12" width="6" height="3" rx=".7" />
  </>,
);
const ME_TILE = svg(
  <>
    <rect x="1" y="1" width="9.5" height="14" rx="1.2" opacity=".45" />
    <rect x="11.5" y="1" width="9.5" height="14" rx="1.2" />
  </>,
);
const ME_CORNER = svg(
  <>
    <rect x="1" y="1" width="20" height="14" rx="1.2" opacity=".45" />
    <rect x="13" y="9" width="7" height="5" rx="1" />
  </>,
);
const ME_OFF = svg(
  <>
    <rect x="1" y="1" width="20" height="14" rx="1.2" opacity=".45" />
    <path d="M3 15 19 1" stroke="currentColor" stroke-width="1.6" />
  </>,
);
const FLOAT = svg(
  <>
    <rect x="1" y="1" width="20" height="14" rx="1.2" opacity=".3" />
    <rect x="10" y="3" width="9" height="6.5" rx="1" />
  </>,
);
const DOCK = svg(
  <>
    <rect x="1" y="1" width="20" height="14" rx="1.2" opacity=".3" />
    <rect x="1" y="1" width="20" height="5.5" rx="1.2" />
  </>,
);
