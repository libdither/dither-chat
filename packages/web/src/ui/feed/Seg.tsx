/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A few ways of drawing something, as small pictures side by side (docs/feed.md "Looks"), as the pictures' rail in a
 * chat has them: each a drawing of what it does, the one chosen raised, the raise sliding to the next when another is
 * pressed, its name and what it is like on pointing. The arrow keys move through them as through radio buttons.
 *
 * And the move itself (`flip`): what is on the screen before the change slides to where it is after it, so a reader
 * sees where each post went instead of a page that jumps. Not with reduced motion.
 */
import { Fragment, h, type JSX } from 'preact';
import { useRef } from 'preact/hooks';

interface SegOption<T extends string> {
  id: T;
  label: string;
  line: string;
  icon: JSX.Element;
}

export function Seg<T extends string>({ value, options, pick, label, cls }: { value: T; options: readonly SegOption<T>[]; pick: (v: T) => void; label: string; cls?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const i = Math.max(0, options.findIndex((o) => o.id === value));
  const key = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(i + step + options.length) % options.length];
    pick(next.id);
    setTimeout(() => box.current?.querySelector<HTMLElement>(`[data-seg="${next.id}"]`)?.focus());
  };
  return (
    <div class={`look-seg ${cls ?? ''}`} role="radiogroup" aria-label={label} ref={box} onKeyDown={key} style={`--look-i: ${i}; --look-n: ${options.length}`}>
      <span class="look-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button
          type="button"
          role="radio"
          class="look-btn"
          data-seg={o.id}
          aria-checked={o.id === value}
          aria-label={o.label}
          tabIndex={o.id === value ? 0 : -1}
          onClick={(e) => (e.stopPropagation(), o.id !== value && pick(o.id))}
        >
          <svg class="look-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            {o.icon}
          </svg>
          <span class="look-tip" aria-hidden="true">
            <b>{o.label}</b>
            {o.line}
          </span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ pictures of the ways

/** Replies: a tree as on Reddit, compact as on Hacker News, flat as on YouTube, chains as on X. */
export const REPLY_ICONS = {
  // Faces with words beside them, each answer a step in from the one it answers, a line down each branch.
  tree: (
    <>
      <circle cx="2.6" cy="2.6" r="2" />
      <rect x="6" y="1.6" width="9.5" height="2" rx="1" />
      <rect x="2" y="5.6" width="1.2" height="9.6" rx=".6" opacity=".5" />
      <circle cx="6.6" cy="8" r="1.8" />
      <rect x="9.6" y="7" width="6" height="2" rx="1" />
      <rect x="6" y="10.8" width="1.2" height="4.4" rx=".6" opacity=".5" />
      <circle cx="10.4" cy="13.4" r="1.6" />
      <rect x="13" y="12.4" width="2.6" height="2" rx="1" />
    </>
  ),
  // Words only, stepped in, close together.
  compact: (
    <>
      <rect x=".5" y="1.5" width="13" height="1.7" rx=".85" />
      <rect x="3.5" y="4.6" width="10" height="1.7" rx=".85" />
      <rect x="6.5" y="7.7" width="8" height="1.7" rx=".85" />
      <rect x="3.5" y="10.8" width="11" height="1.7" rx=".85" />
      <rect x=".5" y="13.9" width="12" height="1.7" rx=".85" />
    </>
  ),
  // A reply, every answer under it one step in, the next reply.
  flat: (
    <>
      <circle cx="2.6" cy="2.6" r="2" />
      <rect x="6" y="1.6" width="9.5" height="2" rx="1" />
      <circle cx="6.6" cy="6.6" r="1.4" opacity=".7" />
      <rect x="9" y="5.8" width="6.5" height="1.6" rx=".8" opacity=".7" />
      <circle cx="6.6" cy="9.6" r="1.4" opacity=".7" />
      <rect x="9" y="8.8" width="6.5" height="1.6" rx=".8" opacity=".7" />
      <circle cx="2.6" cy="13.4" r="2" />
      <rect x="6" y="12.4" width="9.5" height="2" rx="1" />
    </>
  ),
  // Faces in one column joined by a line, each with its words.
  chains: (
    <>
      <rect x="2" y="3" width="1.2" height="10" rx=".6" opacity=".5" />
      <circle cx="2.6" cy="2.6" r="2" />
      <circle cx="2.6" cy="8" r="2" />
      <circle cx="2.6" cy="13.4" r="2" />
      <rect x="6" y="1.6" width="9.5" height="2" rx="1" />
      <rect x="6" y="7" width="7" height="2" rx="1" />
      <rect x="6" y="12.4" width="8.5" height="2" rx="1" />
    </>
  ),
};

/** The page's spacing: roomy, snug, dense. */
export const DENSITY_ICONS = {
  roomy: (
    <>
      <rect x="1" y="1.5" width="14" height="5.5" rx="1.6" />
      <rect x="1" y="9" width="14" height="5.5" rx="1.6" />
    </>
  ),
  snug: (
    <>
      <rect x="1" y="1.5" width="14" height="3.4" rx="1.2" />
      <rect x="1" y="6.3" width="14" height="3.4" rx="1.2" />
      <rect x="1" y="11.1" width="14" height="3.4" rx="1.2" />
    </>
  ),
  dense: (
    <>
      {[1.5, 4.6, 7.7, 10.8, 13.9].map((y) => (
        <rect x="1" y={y} width="14" height="1.7" rx=".85" />
      ))}
    </>
  ),
};

// ------------------------------------------------------------------ the move

type Snap = Map<string, DOMRect>;

const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where each post (`[data-post]`, or what `attr` names) on the screen is now. */
export function snap(root: Element | null, attr = 'data-post'): Snap {
  const out: Snap = new Map();
  if (!root || still()) return out;
  const view = root.getBoundingClientRect();
  for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    const r = el.getBoundingClientRect();
    if (r.bottom < view.top - 200 || r.top > view.bottom + 200) continue;
    const k = el.getAttribute(attr)!;
    if (!out.has(k)) out.set(k, r);
  }
  return out;
}

/** Each post from where it was to where it is: a slide, and a fade for what was not there. */
export function flip(root: Element | null, before: Snap, attr = 'data-post') {
  if (!root || !before.size || still()) return;
  const view = root.getBoundingClientRect();
  const done = new Set<string>();
  // A post inside one that moves (a reply in a tree) moves with it: it is given only the rest of its way.
  const moved = new Map<Element, [number, number]>();
  const ease = 'cubic-bezier(.2,.7,.2,1)';
  for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    const k = el.getAttribute(attr)!;
    if (done.has(k)) continue;
    done.add(k);
    const r = el.getBoundingClientRect();
    if (r.bottom < view.top || r.top > view.bottom) continue;
    const was = before.get(k);
    if (!was) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: ease });
      continue;
    }
    const up = el.parentElement?.closest(`[${attr}]`);
    const [px, py] = (up && moved.get(up)) || [0, 0];
    const dx = was.left - r.left;
    const dy = was.top - r.top;
    moved.set(el, [dx, dy]);
    if (Math.abs(dx - px) < 1 && Math.abs(dy - py) < 1) continue;
    el.animate([{ transform: `translate(${dx - px}px, ${dy - py}px)` }, { transform: 'none' }], { duration: 280, easing: ease });
  }
}
