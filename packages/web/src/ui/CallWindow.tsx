/**
 * The call's window (docs/calls.md "The video window"), a chunk of its own loaded once a call has video or a room is
 * on the page: one window of tiles, a tile for each person in the call (their camera when it is on, else their picture
 * with the same speaking ring and badge) and one for each shared screen. In a grid, or one big for whoever talks (call.ts
 * featuredSpeaker); your own tile among them, an inset in a corner, or hidden. It floats over the app, docks above the
 * call's chat, or fills its page or its room's speakers, by moving into the slot that page has (CallSlot.tsx), so it
 * moves with the page. The layout itself is callLayout.ts; every change moves the same tiles to their new rectangles,
 * so it morphs.
 */
import { createPortal, type JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { type ActiveCall, callMedia, callName, featuredSpeaker, isCallSelf } from '../call.ts';
import { BADGE_WORDS } from '../callmarks.ts';
import { areaOf, autoChoices, type Bounds, clampDock, clampFloat, defaultFloat, fitHeight, layoutTiles, nearestCorner, PAD, type Arrange, type Corner, type LayoutTile, type MeMode, type Place, placeFor, type Rect } from '../callLayout.ts';
import { phone } from '../phone.ts';
import { db } from '../state.ts';
import { callOpen } from './CallBar.tsx';
import { CallAvatar, CallBadgeMark, callMarks } from './CallAvatar.tsx';
import { CallControls } from './CallControls.tsx';
import { chooseWin, liveDockH, roomTiles, winChoices, winControls, winIn, winSlot } from './CallSlot.tsx';
import { openMenu } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import './CallWindow.css';

interface WindowTile extends LayoutTile {
  label: string;
  stream?: MediaStream;
  /** The bridge slot it plays on (others' video). */
  slot?: string;
  /** The person a person's tile is (a screen's tile has none). */
  person?: P.CallParticipant;
}

/**
 * The window's tiles: everyone in the call (on a stage, its speakers), then the screens being shared. Your own tile
 * is there with your camera on or off; your screen is yours too (`mine`), so it is never Speaker's big tile by itself.
 */
function tilesOf(call: ActiveCall, media: typeof callMedia.value): WindowTile[] {
  const me = db.accounts.get(call.accountId)?.selfIdentityId ?? '';
  const staged = !!call.stage || db.conversations.get(call.conversationId)?.variant === 'stage';
  const people = call.participants.filter((p) => !staged || (p.stage ?? 'audience') === 'speaker');
  const camera = new Map(call.video.filter((v) => v.source === 'camera').map((v) => [v.who, v]));
  const out: WindowTile[] = people.map((p) => {
    const self = isCallSelf(call, p.id);
    const v = camera.get(p.id);
    const stream = (self ? media.camera : v ? media.slots.get(v.slot) : null) ?? undefined;
    return { id: `p:${p.id}`, who: p.id, person: p, self, mine: self, stream, slot: self ? undefined : v?.slot, label: self ? 'You' : callName(p.id) };
  });
  // Your camera on before the call lists you.
  if (media.camera && !out.some((t) => t.self)) out.push({ id: `p:${me}`, who: me, self: true, mine: true, stream: media.camera, label: 'You' });
  for (const v of call.video) {
    const stream = v.source === 'stream' ? media.slots.get(v.slot) : undefined;
    if (stream) out.push({ id: `s:${v.slot}:${v.who}`, who: v.who, share: true, stream, slot: v.slot, label: `${callName(v.who)} · screen` });
  }
  if (media.screen) out.push({ id: 'my-screen', who: me, mine: true, share: true, stream: media.screen, label: 'Your screen' });
  return out;
}

/** The screen less the call bar, where a floating window may go. */
function freeBounds(): Bounds {
  const vw = innerWidth;
  const vh = innerHeight;
  let top = 0;
  let bottom = vh;
  const bar = document.querySelector('.call-bar')?.getBoundingClientRect();
  if (bar && bar.height) {
    if (bar.top < vh / 2) top = Math.max(top, bar.bottom);
    else bottom = Math.min(bottom, bar.top);
  }
  return { x: 0, y: top, w: vw, h: Math.max(0, bottom - top) };
}

/** The window's buttons on a phone: the dock's, with the round ones only. */
const WIN_BUTTONS = ['mute', 'deafen', 'camera', 'share', 'hand', 'leave'] as const;
const STEP = 24;

/** A drag just ended: the click that follows its release is not a click on a tile. */
let dragEnded = false;

type Drag = { kind: 'move' | 'resize' | 'split' | 'inset' };

export function CallWindow({ call }: { call: ActiveCall }) {
  const media = callMedia.value;
  const tiles = tilesOf(call, media);
  const saved = winChoices.value;
  const slot = winSlot.value;
  const isPhone = phone.value;
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [menuUp, setMenuUp] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dockHint, setDockHint] = useState(false);
  const [full, setFull] = useState(false);
  const [bounds, setBounds] = useState(freeBounds);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // While dragging, the window's and the inset's rectangles before they are kept.
  const [liveFloat, setLiveFloat] = useState<Rect | null>(null);
  const [liveInset, setLiveInset] = useState<{ x: number; y: number } | null>(null);
  const lastFocus = useRef<string | null>(null);
  const [host] = useState(() => {
    const d = document.createElement('div');
    d.className = 'call-win-host';
    return d;
  });
  const winEl = useRef<HTMLDivElement>(null);
  const areaEl = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const ctl = useRef<HTMLDivElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  const prev = useRef<{ place: Place | null; rect: DOMRect | null }>({ place: null, rect: null });

  const share = tiles.some((t) => t.share && !t.mine);
  const auto = autoChoices({ people: call.participants.length, share, phone: isPhone });
  // A share coming on switches to Speaker only while you have not picked an arrangement yourself (Auto).
  const arrange: Arrange = saved.arrange ?? auto.arrange;
  const me: MeMode = saved.me ?? auto.me;
  const corner: Corner = saved.corner ?? 'br';
  const place = placeFor(saved.place, slot?.kind ?? null, isPhone);
  // What the menu shows checked: your choice, or Auto's here (a room's speakers are Fill).
  const chosen: Place = saved.place ?? (slot?.kind === 'room' ? 'fill' : auto.place);
  const inRoom = place === 'fill' && slot?.kind === 'room';
  const target = place && place !== 'float' && slot ? slot.el : (document.querySelector<HTMLElement>('.app') ?? document.body);
  // A clicked tile that has gone is no longer big.
  const focusedHere = focused && tiles.some((t) => t.id === focused) ? focused : null;

  // The free part of the screen, kept as the call bar comes and goes and the screen changes size.
  useLayoutEffect(() => {
    const b = freeBounds();
    if (b.x !== bounds.x || b.y !== bounds.y || b.w !== bounds.w || b.h !== bounds.h) setBounds(b);
  });
  useEffect(() => {
    const on = () => setBounds(freeBounds());
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);

  // Into its place: the page's slot, or the app (floating). A change of place animates from the old rectangle.
  useLayoutEffect(() => {
    if (!place) {
      host.remove();
      prev.current = { place: null, rect: null };
      winIn.value = null;
      return;
    }
    if (host.parentNode !== target) {
      target.appendChild(host);
      // Moved in the page, a video keeps playing; asked again in case a browser paused it.
      for (const v of host.querySelectorAll('video')) if (v.paused) v.play().catch(() => {});
    }
    winIn.value = target === slot?.el ? target : null;
    const el = winEl.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const was = prev.current;
    if (was.place && was.place !== place && was.rect && r.width && r.height && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const dx = was.rect.left - r.left;
      const dy = was.rect.top - r.top;
      el.animate([{ transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${was.rect.width / r.width}, ${was.rect.height / r.height})` }, { transformOrigin: '0 0', transform: 'none' }], { duration: 280, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)' });
    }
    prev.current = { place, rect: r };
  });
  useEffect(
    () => () => {
      host.remove();
      winIn.value = null;
      winControls.value = false;
      liveDockH.value = null;
      // A call ending mid-drag: its listeners go with it.
      stopDrag.current?.();
    },
    [],
  );

  // The tile area's size, as the window, its slot or full screen give it.
  useLayoutEffect(() => {
    const el = areaEl.current;
    if (!el) return;
    // Its layout size, not its rectangle on screen: a move between places animates it with a transform.
    const read = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!place]);

  // Full screen: the whole window, its captions, your inset and its buttons.
  useEffect(() => {
    const on = () => setFull(!!winEl.current && document.fullscreenElement === winEl.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void winEl.current?.requestFullscreen?.().catch(() => {});
  };

  // The call's buttons on the window: on a phone, where the dock's strip steps aside for it, and in full screen. A
  // room has its own.
  const buttons = !!place && !inRoom && (isPhone || full);
  useEffect(() => {
    winControls.value = buttons && isPhone;
  }, [buttons, isPhone]);

  // Where the window is.
  const float = clampFloat(liveFloat ?? saved.float ?? defaultFloat(bounds), bounds);
  const padPlace: Place = full ? 'fill' : (place ?? 'float');
  const pad = PAD[padPlace];
  const W = size?.w ?? 0;
  const H = size?.h ?? 0;
  const lay = layoutTiles({ w: W, h: H, tiles, arrange, me, corner, focused: focusedHere, featured: featuredSpeaker.value, lastFocus: lastFocus.current });
  lastFocus.current = lay.focus;

  // The menu: Escape or a press outside closes it; it opens upward when there is no room below.
  useLayoutEffect(() => {
    if (!menu) return setMenuUp(false);
    const r = menuEl.current?.getBoundingClientRect();
    const w = winEl.current?.getBoundingClientRect();
    if (r && w && r.bottom > innerHeight - 8 && w.top + 36 - r.height > 8) setMenuUp(true);
  }, [menu]);
  useLayoutEffect(() => {
    if (!menu) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
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
    stopDrag.current?.();
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved) {
        if (Math.hypot(dx, dy) < threshold) return;
        moved = true;
        setDrag({ kind });
      }
      move(dx, dy, ev);
    };
    const stop = () => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      stopDrag.current = null;
    };
    const up = (ev: PointerEvent) => {
      stop();
      setDrag(null);
      if (moved) {
        dragEnded = true;
        setTimeout(() => (dragEnded = false));
      }
      end(moved, ev);
    };
    stopDrag.current = stop;
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  };

  /** Where dragging the floating window docks: the top of the call's chat (under its header) or its room. */
  const dockLine = () => (slot ? slot.el.getBoundingClientRect().top : null);

  // Moving the window: anywhere on it, past 5 px so a click still shows a tile big. Floating, dropped at the top of
  // the call's chat it docks; docked or filling, dragged down it floats again.
  const onWinDown = (e: PointerEvent) => {
    if (e.button || full || (e.target as Element).closest('.call-win-ctl, .call-win-resize, .call-win-split, .call-win-controls, .call-tile-menu, .call-video.inset')) return;
    let base = float;
    let origin = { x: e.clientX, y: e.clientY };
    let floated = place === 'float';
    let at = base;
    const near = (y: number) => {
      const line = dockLine();
      return line !== null && Math.abs(y - line) < 28;
    };
    follow(
      e,
      'move',
      (_dx, dy, ev) => {
        if (!floated) {
          if (dy < 40) return;
          // Out of its slot: the floating window comes under the pointer and follows it from here.
          floated = true;
          base = clampFloat({ ...base, x: ev.clientX - base.w / 2, y: ev.clientY - 20 }, bounds);
          origin = { x: ev.clientX, y: ev.clientY };
          chooseWin({ place: 'float' });
        }
        at = clampFloat({ ...base, x: base.x + ev.clientX - origin.x, y: base.y + ev.clientY - origin.y }, bounds);
        setLiveFloat(at);
        setDockHint(near(at.y));
      },
      (moved) => {
        setDockHint(false);
        setLiveFloat(null);
        if (!moved || !floated) return;
        if (near(at.y)) chooseWin({ place: 'dock', float: clampFloat({ ...at, y: at.y + 40 }, bounds) });
        else chooseWin({ place: 'float', float: at });
      },
      5,
    );
  };

  /** A resize ended: the window's height fits its tiles. */
  const fitted = (r: Rect): Rect => {
    const a = areaOf('float', r.w, r.h);
    const h = fitHeight({ w: a.w, h: a.h, tiles, arrange, me, focused: focusedHere }) + PAD.float.top + PAD.float.bottom;
    return clampFloat({ ...r, h }, bounds);
  };
  const onResizeDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = float;
    let at = start;
    follow(
      e,
      'resize',
      (dx, dy) => setLiveFloat((at = clampFloat({ ...start, w: Math.min(start.w + dx, bounds.x + bounds.w - start.x), h: Math.min(start.h + dy, bounds.y + bounds.h - start.y) }, bounds))),
      (moved) => {
        setLiveFloat(null);
        if (moved) chooseWin({ float: fitted(at) });
      },
    );
  };

  const paneH = () => slot?.el.parentElement?.getBoundingClientRect().height ?? innerHeight;
  const dockNow = () => winEl.current?.getBoundingClientRect().height ?? 280;
  /** A docked height kept: fitted to its tiles once a drag ends. */
  const keepDock = (h: number, fit: boolean) => {
    let out = h;
    if (fit) {
      const w = (slot?.el.getBoundingClientRect().width ?? innerWidth) - 2 * PAD.dock.x;
      out = fitHeight({ w, h: h - PAD.dock.top - PAD.dock.bottom, tiles, arrange, me, focused: focusedHere }) + PAD.dock.top + PAD.dock.bottom;
    }
    chooseWin({ dockH: clampDock(out, paneH()) });
  };
  const onSplitDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = dockNow();
    let at = start;
    follow(
      e,
      'split',
      (_dx, dy) => (liveDockH.value = at = clampDock(start + dy, paneH())),
      (moved) => {
        liveDockH.value = null;
        if (moved) keepDock(at, true);
      },
    );
  };
  const onSplitKey = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowUp' ? -STEP : e.key === 'ArrowDown' ? STEP : 0;
    if (!d) return;
    e.preventDefault();
    keepDock(dockNow() + d, false);
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
        if (moved) chooseWin({ corner: nearestCorner({ ...r.rect, ...at }, W, H) });
      },
    );
  };

  // Moving and resizing by keys: the grip and the corner take the arrows.
  const arrows = (e: KeyboardEvent): [number, number] | null => {
    const n = e.shiftKey ? STEP * 4 : STEP;
    const d: Record<string, [number, number]> = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] };
    return d[e.key] ?? null;
  };
  const onMoveKey = (e: KeyboardEvent) => {
    const d = arrows(e);
    if (!d) return;
    e.preventDefault();
    chooseWin({ float: clampFloat({ ...float, x: float.x + d[0], y: float.y + d[1] }, bounds) });
  };
  const onSizeKey = (e: KeyboardEvent) => {
    const d = arrows(e);
    if (!d) return;
    e.preventDefault();
    chooseWin({ float: clampFloat({ ...float, w: float.w + d[0], h: float.h + d[1] }, bounds) });
  };

  /** A click on a tile shows it big; another click puts it back. Never kept as a choice. */
  const toggleFocus = (id: string) => {
    if (lay.tiles.get(id)?.inset) return;
    setFocused(focusedHere === id ? null : id);
  };

  const pick = <K extends 'arrange' | 'me' | 'place'>(k: K, v: string) => {
    if (k === 'arrange' && v === 'grid') setFocused(null);
    chooseWin({ [k]: v === 'auto' ? undefined : v });
  };

  if (!place) return null;
  const resizing = drag && drag.kind !== 'move' && drag.kind !== 'inset';
  const room = roomTiles.value;
  const winStyle: Record<string, string> = place === 'float' && !full ? { left: `${float.x}px`, top: `${float.y}px`, width: `${float.w}px`, height: `${float.h}px` } : {};
  return createPortal(
    <>
      {dockHint && <div class="call-win-hint">Release to dock above the chat</div>}
      <div
        ref={winEl}
        class={`call-videos ${place} ${size ? 'ready' : ''} ${drag ? 'live' : ''} ${resizing ? 'resizing' : ''} ${full ? 'full' : ''} ${buttons ? 'with-buttons' : ''}`}
        role="region"
        aria-label={inRoom ? 'Speakers' : 'Call video'}
        data-arrange={arrange}
        data-arranged={saved.arrange ?? 'auto'}
        data-me={me}
        data-place={place}
        style={winStyle}
        onPointerDown={onWinDown}
      >
        <div class="call-win-area" ref={areaEl} style={{ left: `${pad.x}px`, right: `${pad.x}px`, top: `${pad.top}px`, bottom: `${pad.bottom + (buttons ? 52 : 0)}px` }}>
          {size &&
            tiles.map((t) => {
              const p = lay.tiles.get(t.id);
              if (!p) return null;
              const r = t.self && liveInset && p.inset ? { ...p.rect, ...liveInset } : p.rect;
              return (
                <Tile
                  key={t.id}
                  call={call}
                  tile={t}
                  rect={r}
                  inset={!!p.inset}
                  hidden={!!p.hidden}
                  big={focusedHere === t.id}
                  role={t.person && room ? room.role(t.person.id) : undefined}
                  fill={place === 'fill' || full}
                  dragging={(t.self && drag?.kind === 'inset') || !!resizing}
                  onToggle={() => toggleFocus(t.id)}
                  onFull={toggleFull}
                  onInsetDown={(e) => onInsetDown(e, t.id)}
                />
              );
            })}
          {size &&
            room &&
            tiles.map((t) => {
              const p = lay.tiles.get(t.id);
              const moves = t.person && p && !p.hidden ? room.moves(t.person.id) : [];
              if (!moves.length || !p) return null;
              return (
                <button
                  key={`m:${t.id}`}
                  class="call-tile-menu"
                  aria-haspopup="menu"
                  aria-label={`${t.label}: more`}
                  data-who={t.who}
                  style={{ left: `${p.rect.x + p.rect.w - 34}px`, top: `${p.rect.y + 6}px` }}
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    openMenu({ x: r.left + r.width / 2, y: r.bottom }, { items: moves, head: <b>{t.label}</b>, track: 'room person menu' }, e.currentTarget);
                  }}
                >
                  <Icon name="more" size={16} />
                </button>
              );
            })}
        </div>
        <div class={`call-win-ctl ${menu ? 'open' : ''}`} ref={ctl}>
          {place === 'float' && !full && (
            <button class="call-win-btn call-win-grip" aria-label="Move the video window (arrow keys)" title="Move: drag, or arrow keys" data-track="call video move" onKeyDown={onMoveKey}>
              <Icon name="move" size={16} />
            </button>
          )}
          <button class="call-win-btn" aria-label={full ? 'Leave full screen' : 'Full screen'} title={full ? 'Leave full screen' : 'Full screen'} aria-pressed={full} data-track="call video full screen" onClick={toggleFull}>
            <Icon name={full ? 'shrink' : 'expand'} size={16} />
          </button>
          <button ref={btn} class="call-win-btn call-win-layout" aria-label="Video layout" title="Video layout" aria-haspopup="true" aria-expanded={menu} data-track="call video layout" onClick={() => setMenu(!menu)}>
            <Icon name="grid" size={16} />
          </button>
          {menu && (
            <div ref={menuEl} class={`call-win-menu ${menuUp ? 'up' : ''}`} role="group" aria-label="Video layout">
              <Choices label="Arrange" value={saved.arrange ?? 'auto'} set={(v) => pick('arrange', v)} options={[['auto', 'Auto', AUTO], ['grid', 'Grid', GRID], ['speaker', 'Speaker', SPEAKER]]} />
              <Choices label="Your camera" value={me} set={(v) => pick('me', v)} options={[['tile', 'Tile', ME_TILE], ['corner', 'Corner', ME_CORNER], ['off', 'Hidden', ME_OFF]]} />
              <Choices label="Place" value={chosen} set={(v) => pick('place', v)} options={[['float', 'Floating', FLOAT], ['dock', 'Above chat', DOCK], ['fill', 'Fill', FILL]]} />
              <div class="call-win-tip">Click someone to see them big. Above chat and Fill show on the call's own chat.</div>
            </div>
          )}
        </div>
        {buttons && (
          <div class="call-win-controls">
            <CallControls call={call} only={WIN_BUTTONS} />
            {isPhone && (
              <button class="call-btn" aria-label="The call's people and settings" aria-expanded={callOpen.value} data-track="call window: people" onClick={() => (callOpen.value = !callOpen.value)}>
                <Icon name="users" size={18} />
              </button>
            )}
          </div>
        )}
        {place === 'float' && !full && <button class="call-win-resize" aria-label="Resize the video window (arrow keys)" title="Resize: drag, or arrow keys" data-track="call video resize" onPointerDown={onResizeDown} onKeyDown={onSizeKey} />}
        {place === 'dock' && !full && (
          <div
            class="call-win-split"
            role="separator"
            tabIndex={0}
            aria-orientation="horizontal"
            aria-label="Video height"
            aria-valuenow={Math.round(winEl.current?.getBoundingClientRect().height ?? saved.dockH ?? 0)}
            aria-valuemin={120}
            aria-valuemax={Math.round(paneH())}
            onPointerDown={onSplitDown}
            onKeyDown={onSplitKey}
          />
        )}
      </div>
    </>,
    host,
  );
}

/** One row of the menu: a choice of icons, one checked; the arrow keys move through them (one tab stop). */
function Choices({ label, value, set, options }: { label: string; value: string; set: (v: string) => void; options: [string, string, JSX.Element][] }) {
  const id = `call-win-${label.replace(/\W/g, '')}`;
  const onKey = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = options.findIndex(([v]) => v === value);
    const next = options[(i + d + options.length) % options.length][0];
    set(next);
    const row = (e.currentTarget as HTMLElement).closest('[role=radiogroup]');
    requestAnimationFrame(() => row?.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus());
  };
  return (
    <>
      <div class="call-win-label" id={id}>
        {label}
      </div>
      <div class="call-win-row" role="radiogroup" aria-labelledby={id}>
        {options.map(([v, words, svg]) => (
          <button key={v} role="radio" aria-checked={value === v} tabIndex={value === v ? 0 : -1} class={value === v ? 'on' : ''} data-choice={v} data-track={`call video ${words.toLowerCase()}`} onClick={() => set(v)} onKeyDown={onKey}>
            {svg}
            {words}
          </button>
        ))}
      </div>
    </>
  );
}

interface TileProps {
  call: ActiveCall;
  tile: WindowTile;
  rect: Rect;
  inset: boolean;
  hidden: boolean;
  /** Clicked big. */
  big: boolean;
  /** A room's rank under the name. */
  role?: string;
  /** Filling a page or the screen: cameras cropped to fill their tile (shared screens never). */
  fill: boolean;
  dragging: boolean;
  onToggle: () => void;
  onFull: () => void;
  onInsetDown: (e: PointerEvent) => void;
}

/**
 * One tile at its rectangle: a person (their camera, else their picture with its ring and badge) or a shared screen.
 * A click or Enter shows it big and back; F puts the window full screen.
 */
function Tile(props: TileProps) {
  const { call, tile, rect } = props;
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (v && tile.stream && v.srcObject !== tile.stream) {
      v.srcObject = tile.stream;
      v.play().catch(() => {});
    }
  }, [tile.stream]);
  const marks = tile.person ? callMarks(call, tile.person) : null;
  const speaking = !tile.share && !!marks?.speaking;
  // The picture above the name: sized to what the caption leaves.
  const face = Math.round(Math.max(20, Math.min(128, Math.min(rect.w * 0.5, (rect.h - 30) * 0.75))));
  const cls = ['call-video', tile.stream && 'speak-ring', tile.stream && speaking && 'speaking', tile.stream && tile.self && 'mirror', tile.self && 'self', tile.share && 'share', !tile.stream && 'face', props.inset && 'inset', props.hidden && 'hidden', props.big && 'pinned', props.fill && 'fill', props.dragging && 'dragging']
    .filter(Boolean)
    .join(' ');
  const words = [tile.label, props.role?.toLowerCase(), speaking ? 'speaking' : '', marks?.badge ? BADGE_WORDS[marks.badge] : '', props.big ? 'shown big' : ''].filter(Boolean).join(', ');
  return (
    <figure
      class={cls}
      data-video-slot={tile.slot}
      data-tile={tile.id}
      data-who={tile.person ? tile.who : undefined}
      data-role={tile.person ? 'speaker' : undefined}
      aria-hidden={props.hidden || undefined}
      role={props.inset || props.hidden ? undefined : 'button'}
      tabIndex={props.inset || props.hidden ? undefined : 0}
      aria-label={props.inset || props.hidden ? undefined : words}
      aria-pressed={props.inset || props.hidden ? undefined : props.big}
      aria-keyshortcuts={props.inset || props.hidden ? undefined : 'Enter F'}
      style={{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }}
      onPointerDown={props.inset ? props.onInsetDown : undefined}
      onClick={() => {
        if (props.inset || dragEnded) return;
        props.onToggle();
      }}
      onKeyDown={(e) => {
        if (props.inset) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onToggle();
        } else if (e.key === 'f' || e.key === 'F') {
          e.preventDefault();
          props.onFull();
        }
      }}
    >
      {tile.stream ? (
        <video ref={ref} autoplay playsInline muted />
      ) : (
        marks && (
          <span class="call-tile-face">
            <CallAvatar {...marks} size={face} />
          </span>
        )
      )}
      <figcaption>
        {tile.label}
        {props.role && <small> · {props.role}</small>}
        {tile.stream && marks?.badge && <CallBadgeMark badge={marks.badge} size={14} />}
      </figcaption>
      {props.big && (
        <span class="call-video-pin" aria-hidden="true">
          <Icon name="pin" size={12} />
        </span>
      )}
    </figure>
  );
}

const svg = (body: JSX.Element) => (
  <svg viewBox="0 0 22 16" fill="currentColor" aria-hidden="true">
    {body}
  </svg>
);
const AUTO = svg(
  <>
    <rect x="1" y="1" width="20" height="14" rx="1.2" opacity=".3" />
    <path d="M7 12 11 3l4 9M8.5 9h5" stroke="currentColor" stroke-width="1.6" fill="none" />
  </>,
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
const FILL = svg(<rect x="1" y="1" width="20" height="14" rx="1.2" />);
