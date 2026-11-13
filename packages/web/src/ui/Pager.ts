/**
 * The phone's panels, the way Discord's app does them: the page you are on is a card over the lists. Swipe
 * it right to go back and it slides off to show the lists, with the page still peeking at the edge; swipe it
 * left for the details panel underneath on the other side. A message swiped left replies to it, and a list
 * pulled down at its top refreshes. Everything follows the finger and settles at the speed it was let go.
 */
import { signal } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { clampDrag, commits, lockAxis, rubber, settleMs, velocity } from '../gesture.ts';
import { haptic, layerCount, phone, reducedMotion } from '../phone.ts';
import { prefs, setPrefs } from '../state.ts';
import { drag } from './dnd.tsx';
import { countKey } from '../clicklog.ts';

/** Where the card rests. `peek` leaves its edge showing beside the lists, `away` takes it off screen. */
export type Rest = 'open' | 'details' | 'peek' | 'away';
export const PEEK = 56;

export interface PagerModel {
  /** The app is on screen (not the loading screen), so there is something to listen on. */
  ready: boolean;
  rest: Rest;
  /** The card is a page with somewhere to go back to, and where it would rest after going back. */
  back: Rest | null;
  details: boolean;
  onBack: () => void;
  onDetails: (open: boolean) => void;
  /** Bring the peeking page back. */
  onForward: () => void;
  onRefresh: () => Promise<unknown>;
}

/** Messages that can be swiped to reply register here. */
export const swipeReply = new WeakMap<Element, () => void>();

/**
 * A finger on something the app's listeners cannot hear: a mail's HTML, in a frame of its own document. Positions
 * are the app's (the frame's offset added); `target` is the frame, `sideways` says whether something inside it
 * scrolls sideways that way, and `prevent` stops the frame from scrolling once the swipe is the pager's.
 */
export interface ForwardedTouch {
  x: number;
  y: number;
  count: number;
  target: HTMLElement;
  sideways?: (dx: number) => boolean;
  prevent: () => void;
}
let forwarded: { start(t: ForwardedTouch): void; move(t: ForwardedTouch): void; end(): void; cancel(): void } | null = null;

/** Hands a same-origin frame's touches to the pager, so a swipe over a mail's body goes back like anywhere else. */
export function forwardTouches(frame: HTMLIFrameElement): () => void {
  const doc = frame.contentDocument;
  if (!doc) return () => {};
  const at = (e: TouchEvent): ForwardedTouch | null => {
    const t = e.touches[0];
    if (!t && e.type !== 'touchend') return null;
    const r = frame.getBoundingClientRect();
    const inner = e.target instanceof doc.defaultView!.Element ? (e.target as HTMLElement) : null;
    return {
      x: (t?.clientX ?? 0) + r.left,
      y: (t?.clientY ?? 0) + r.top,
      count: e.touches.length,
      target: frame,
      sideways: (dx) => !!inner && scrollsSideways(inner, doc.documentElement, dx),
      prevent: () => e.cancelable && e.preventDefault(),
    };
  };
  const start = (e: TouchEvent) => {
    const t = at(e);
    if (t) forwarded?.start(t);
  };
  const move = (e: TouchEvent) => {
    const t = at(e);
    if (t) forwarded?.move(t);
  };
  const end = () => forwarded?.end();
  const cancel = () => forwarded?.cancel();
  doc.addEventListener('touchstart', start, { passive: true });
  doc.addEventListener('touchmove', move, { passive: false });
  doc.addEventListener('touchend', end);
  doc.addEventListener('touchcancel', cancel);
  return () => {
    doc.removeEventListener('touchstart', start);
    doc.removeEventListener('touchmove', move);
    doc.removeEventListener('touchend', end);
    doc.removeEventListener('touchcancel', cancel);
  };
}

const OVERLAYS = '.ep-layer, .modal-backdrop, .place-menu-back, .viewer, .lv-full, .qr-full, .sheet-layer, .switcher-back, .toasts';
const PULLABLE = '.side-scroll, .board-scroll';
const REPLY_AT = 56;
const PULL_AT = 64;

function restX(rest: Rest, w: number): number {
  return rest === 'open' ? 0 : rest === 'details' ? -(w - PEEK) : rest === 'peek' ? w - PEEK : w + 40;
}
function restCss(rest: Rest): string {
  return rest === 'open' ? 'none' : rest === 'details' ? `translateX(calc(-100% + ${PEEK}px))` : rest === 'peek' ? `translateX(calc(100% - ${PEEK}px))` : 'translateX(calc(100% + 40px))';
}

/**
 * Can something under the finger scroll sideways that way, or does it claim a swipe that way for itself
 * (`data-claims-swipe="left"`: an inbox row swiped left marks it, ui/ReplyMark.tsx)? Then the swipe is its, not ours.
 */
function scrollsSideways(from: HTMLElement | null, stop: HTMLElement, dx: number): boolean {
  for (let n = from; n && n !== stop; n = n.parentElement) {
    if (n.dataset?.claimsSwipe === (dx < 0 ? 'left' : 'right')) return true;
    if (n.scrollWidth <= n.clientWidth + 1) continue;
    const ox = getComputedStyle(n).overflowX;
    if (ox !== 'auto' && ox !== 'scroll') continue;
    if (dx < 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0) return true;
  }
  return false;
}

interface Gesture {
  x0: number;
  y0: number;
  target: HTMLElement;
  /** A forwarded touch's: whether something inside its frame scrolls sideways. */
  sideways?: (dx: number) => boolean;
  mode: null | 'pager' | 'reply' | 'pull';
  /** Layers open when the finger came down; one more means a long-press opened a sheet. */
  layers: number;
  samples: { x: number; t: number }[];
  // pager
  from?: number;
  to?: number;
  x?: number;
  action?: () => void;
  landing?: Rest;
  // reply
  msg?: HTMLElement;
  icon?: HTMLElement;
  armed?: boolean;
  // pull
  pull?: number;
}

export function usePager(app: { current: HTMLElement | null }, card: { current: HTMLElement | null }, pull: { current: HTMLElement | null }, model: PagerModel) {
  const m = useRef(model);
  m.current = model;
  /** The rest the card was last sent to, and whether a back swipe left it waiting for a new page. */
  const applied = useRef<Rest | null>(null);
  const enterFromLeft = useRef(false);

  // An attribute, not a class: the app's class list is the render's to set.
  const under = (details: boolean) => app.current && (app.current.dataset.under = details ? 'details' : 'lists');
  const place = (x: number | Rest, ms: number, done?: () => void) => {
    const el = card.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2,.8,.2,1)` : 'none';
    el.style.transform = typeof x === 'number' ? `translateX(${x}px)` : restCss(x);
    if (done) {
      if (!ms) done();
      else {
        const t = setTimeout(done, ms + 40);
        el.addEventListener('transitionend', () => (clearTimeout(t), done()), { once: true });
      }
    }
  };

  // Settle where the route says, whenever that changes.
  useLayoutEffect(() => {
    const el = card.current;
    const rest = model.rest;
    if (!el || !phone.value) {
      if (el) el.style.transform = el.style.transition = '';
      applied.current = null;
      return;
    }
    if (applied.current === rest) return;
    const first = applied.current === null;
    applied.current = rest;
    if (rest === 'details') under(true);
    const ms = first || reducedMotion() ? 0 : 280;
    if (rest === 'open' && enterFromLeft.current && ms) {
      // Back onto a page, not a list: it comes from underneath, the way it went.
      enterFromLeft.current = false;
      el.style.transition = 'none';
      el.style.transform = 'translateX(-30%)';
      el.style.opacity = '0.4';
      void el.offsetWidth;
      el.style.transition = `transform ${ms}ms cubic-bezier(.2,.8,.2,1), opacity ${ms}ms`;
      el.style.transform = 'none';
      el.style.opacity = '';
      return;
    }
    enterFromLeft.current = false;
    place(rest, ms, () => rest !== 'details' && applied.current === rest && under(false));
  });

  useLayoutEffect(() => {
    const root = app.current;
    if (!root) return;
    let g: Gesture | null = null;

    const choose = (dx: number, dy: number, axis: 'x' | 'y', target: HTMLElement): Gesture['mode'] => {
      const md = m.current;
      if (axis === 'y') {
        const sc = target.closest<HTMLElement>(PULLABLE);
        if (!sc || dy <= 0 || sc.scrollTop > 0) return null;
        // Only a list that is in view: the one on the card while it is open, the ones under it otherwise.
        const visible = card.current?.contains(sc) ? md.rest === 'open' : md.rest === 'peek' || md.rest === 'away';
        return visible ? 'pull' : null;
      }
      if (scrollsSideways(target, root, dx) || g!.sideways?.(dx)) return null;
      const w = root.clientWidth;
      const inCard = !!card.current?.contains(target);
      const inDetails = !!target.closest('.details');
      const setPager = (from: Rest, to: Rest, action: () => void, landing: Rest = to) => {
        g!.from = restX(from, w);
        g!.to = restX(to, w);
        g!.x = g!.from;
        g!.action = action;
        g!.landing = landing;
        return 'pager' as const;
      };
      if (md.rest === 'open' && inCard) {
        if (dx < 0) {
          const msg = target.closest<HTMLElement>('.msg');
          if (msg && swipeReply.has(msg)) {
            g!.msg = msg;
            return 'reply';
          }
          if (md.details) return setPager('open', 'details', () => md.onDetails(true));
          return null;
        }
        if (md.back) {
          // Off to the side it goes; where it rests is up to the route it goes back to.
          const landing = md.back;
          return setPager('open', landing === 'open' ? 'away' : landing, () => {
            if (landing === 'open') enterFromLeft.current = true;
            md.onBack();
          }, landing === 'open' ? 'away' : landing);
        }
        return null;
      }
      if (md.rest === 'details' && dx > 0 && (inCard || inDetails)) return setPager('details', 'open', () => md.onDetails(false));
      // Forward from the peeking card at the edge, or the lists anywhere but on a row that took the swipe (above).
      if (md.rest === 'peek' && dx < 0 && !inDetails) return setPager('peek', 'open', () => md.onForward());
      return null;
    };

    const begin = (x: number, y: number, count: number, target: HTMLElement, sideways?: (dx: number) => boolean) => {
      g = null;
      if (!phone.value || count !== 1 || drag.value || document.body.classList.contains('dragging')) return;
      if (target.closest(OVERLAYS)) return;
      if (target === document.activeElement && target.matches('input, textarea')) return;
      g = { x0: x, y0: y, target, sideways, mode: null, layers: layerCount(), samples: [{ x, t: performance.now() }] };
    };
    const start = (e: TouchEvent) => begin(e.touches[0]?.clientX ?? 0, e.touches[0]?.clientY ?? 0, e.touches.length, e.target as HTMLElement);

    const move = (e: TouchEvent) => {
      if (e.touches.length) step(e.touches[0].clientX, e.touches[0].clientY, e.touches.length, () => e.cancelable && e.preventDefault());
    };
    const step = (x: number, y: number, count: number, prevent: () => void) => {
      if (!g) return;
      if (count !== 1) return cancel();
      // A hold that became a drag in the list, or opened a sheet: the finger is theirs now.
      if (!g.mode && (drag.value || layerCount() > g.layers)) return void (g = null);
      const t = { clientX: x, clientY: y };
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      if (!g.mode) {
        const axis = lockAxis(dx, dy);
        if (!axis) return;
        const mode = choose(dx, dy, axis, g.target);
        if (!mode) return void (g = null);
        g.mode = mode;
        if (mode === 'pager') under((g.to ?? 0) < 0 || (g.from ?? 0) < 0);
        if (mode === 'reply') {
          const icon = document.createElement('div');
          icon.className = 'swipe-reply-icon';
          icon.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17l-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
          const r = g.msg!.getBoundingClientRect();
          const c = card.current!.getBoundingClientRect();
          icon.style.top = `${r.top + r.height / 2 - 18}px`;
          icon.style.left = `${c.right - 52}px`;
          document.body.append(icon);
          g.icon = icon;
          g.msg!.style.transition = 'none';
        }
      }
      prevent();
      const now = performance.now();
      g.samples.push({ x: t.clientX, t: now });
      if (g.samples.length > 5) g.samples.shift();

      if (g.mode === 'pager') {
        g.x = clampDrag(g.from! + dx, Math.min(g.from!, g.to!), Math.max(g.from!, g.to!));
        place(g.x, 0);
      } else if (g.mode === 'reply') {
        const x = -rubber(Math.max(0, -dx), REPLY_AT + 8);
        g.msg!.style.transform = x ? `translateX(${x}px)` : '';
        const p = Math.min(1, -x / REPLY_AT);
        g.icon!.style.opacity = String(p);
        g.icon!.style.transform = `scale(${0.6 + 0.4 * p})`;
        const armed = -x >= REPLY_AT;
        if (armed && !g.armed) haptic();
        g.armed = armed;
        g.icon!.classList.toggle('armed', armed);
      } else if (g.mode === 'pull') {
        g.pull = rubber(Math.max(0, dy) * 0.55, PULL_AT);
        const el = pull.current;
        if (el) {
          el.style.transition = 'none';
          el.style.transform = `translate(-50%, ${g.pull - 48}px) rotate(${g.pull * 4}deg)`;
          el.style.opacity = String(Math.min(1, g.pull / PULL_AT));
          const armed = g.pull >= PULL_AT;
          if (armed && !el.classList.contains('armed')) haptic();
          el.classList.toggle('armed', armed);
        }
      }
    };

    const end = () => {
      const cur = g;
      g = null;
      if (!cur?.mode) return;
      const v = velocity(cur.samples);
      if (cur.mode === 'pager') {
        const go = commits(cur.from!, cur.to!, cur.x!, v);
        const target = go ? cur.to! : cur.from!;
        const ms = reducedMotion() ? 0 : settleMs(target - cur.x!, v);
        if (go) {
          // The keyboard belongs to the page being left.
          (document.activeElement as HTMLElement | null)?.blur?.();
          applied.current = cur.landing!;
          place(target, ms, () => cur.landing !== 'details' && under(false));
          cur.action!();
        } else place(target, ms, () => cur.from! >= 0 && under(false));
        // Back at rest, the CSS takes over again (and a card at 0 drops its transform, so fixed children are not caught by it).
        if (ms) setTimeout(() => applied.current && card.current?.style.transform.includes('px') && place(applied.current, 0), ms + 60);
        else if (applied.current) place(applied.current, 0);
      } else if (cur.mode === 'reply') {
        const msg = cur.msg!;
        msg.style.transition = reducedMotion() ? 'none' : 'transform 180ms cubic-bezier(.2,.8,.2,1)';
        msg.style.transform = '';
        cur.icon!.remove();
        if (cur.armed) {
          countKey('pager: swipe to reply');
          swipeReply.get(msg)?.();
        }
      } else if (cur.mode === 'pull') {
        const el = pull.current;
        if (!el) return;
        const reset = () => {
          el.style.transition = reducedMotion() ? 'none' : 'transform 200ms, opacity 200ms';
          el.style.transform = 'translate(-50%, -48px)';
          el.style.opacity = '0';
          el.classList.remove('armed', 'busy');
        };
        if ((cur.pull ?? 0) >= PULL_AT) {
          el.style.transition = 'transform 160ms';
          el.style.transform = 'translate(-50%, 16px)';
          el.classList.add('busy');
          countKey('pager: pull to refresh');
          m.current.onRefresh().finally(() => setTimeout(reset, 250));
        } else reset();
      }
    };

    const cancel = () => {
      if (!g) return;
      // A second finger, or the browser took over: put everything back where it was.
      if (g.mode === 'pager') place(g.from!, 0);
      if (g.mode === 'reply') {
        g.msg!.style.transform = '';
        g.icon!.remove();
      }
      if (g.mode === 'pull' && pull.current) pull.current.style.opacity = '0';
      g = null;
    };

    root.addEventListener('touchstart', start, { passive: true });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', end);
    const lost = () => (g?.mode === 'pager' ? end() : cancel());
    root.addEventListener('touchcancel', lost);
    forwarded = {
      start: (t) => begin(t.x, t.y, t.count, t.target, t.sideways),
      move: (t) => step(t.x, t.y, t.count, t.prevent),
      end,
      cancel: lost,
    };
    return () => {
      forwarded = null;
      root.removeEventListener('touchstart', start);
      root.removeEventListener('touchmove', move);
      root.removeEventListener('touchend', end);
      root.removeEventListener('touchcancel', lost);
    };
  }, [model.ready]);
}

// ------------------------------------------------------------------ the details panel

/** On a phone the details are a panel beside the page; on a desktop a column you keep open. */
export const panel = signal<'main' | 'details'>('main');
export const detailsShown = () => (phone.value ? panel.value === 'details' : prefs.value.details);
export function showDetails(open: boolean) {
  if (phone.value) panel.value = open ? 'details' : 'main';
  else setPrefs({ details: open });
}
