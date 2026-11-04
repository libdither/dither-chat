import { useSignal } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, REACTION_RULES } from '@dither-chat/protocol';
import { emojiNow, loadEmoji, searchEmoji, SKIN_TONES, skinOf } from '../emoji.ts';
import { fullTime } from '../format.ts';
import { authorName, convTitle, netName, plainBody } from '../model.ts';
import { hasMine, knownReactionContext, pickerFor, quickReactions, reactionContext, reactionScope, reactorsFor, reactorsLabel, replacing, toggleReaction, type Picked } from '../reactions.ts';
import { canDelete, canEdit, deleteMessage, startEditing, api, db, isSelfIdentity, openProfile, prefs, rev, setPrefs, toast } from '../state.ts';
import { haptic, useLayer } from '../phone.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Sheet } from './Sheet.tsx';
import { openConv } from './Sidebar.tsx';

const isSheet = () => matchMedia('(max-width: 820px), (pointer: coarse)').matches;

/** A reaction's face: an image for custom emoji, else its text. */
export function Glyph({ k, emoji, size = 18 }: { k: string; emoji?: P.CustomEmojiView; size?: number }) {
  if (emoji?.url) return <img class="emoji-img" src={emoji.url} alt={`:${emoji.name}:`} title={`:${emoji.name}:`} style={{ width: `${size}px`, height: `${size}px` }} loading="lazy" />;
  const custom = k.match(/^(.+):\d+$/) ?? (k.startsWith('mxc://') ? [k, 'emoji'] : null);
  return <span class="emoji-text">{custom ? `:${custom[1]}:` : k}</span>;
}

/** Long-press, for touch. Scrolling or lifting the finger cancels it; once it fires, the click that lifting makes does not count. */
export function useLongPress(onPress: (e: PointerEvent) => void, ms = 420) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  return {
    onPointerDown: (e: PointerEvent & { longPressTaken?: boolean }) => {
      // A reaction pill sits inside a message: the innermost long-press is the one meant.
      if (e.pointerType !== 'touch' || e.longPressTaken) return;
      e.longPressTaken = true;
      start.current = { x: e.clientX, y: e.clientY };
      fired.current = false;
      timer.current = setTimeout(() => {
        start.current = null;
        fired.current = true;
        haptic(10);
        onPress(e);
      }, ms);
    },
    onPointerMove: (e: PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
    },
    onPointerUp: () => {
      cancel();
      if (!fired.current) return;
      fired.current = false;
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400);
    },
    onPointerCancel: cancel,
    onContextMenu: (e: Event) => {
      if (matchMedia('(pointer: coarse)').matches) e.preventDefault();
    },
  };
}

// ------------------------------------------------------------------ pills

function Pill({ m, r }: { m: P.MessageView; r: P.ReactionView }) {
  const mine = hasMine(r);
  const ref = useRef<HTMLButtonElement>(null);
  const showWho = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) reactorsFor.value = { message: m, key: r.key, style: r.style, anchor: rect };
  };
  const press = useLongPress(showWho);
  const superStyle = r.style === 'super' ? { '--r1': r.colors?.[0] ?? '#ff7ad9', '--r2': r.colors?.[1] ?? r.colors?.[0] ?? '#7c5cff' } : undefined;
  return (
    <button
      ref={ref}
      class={`reaction ${mine ? 'mine' : ''} ${r.style === 'super' ? 'super' : ''}`}
      style={superStyle as any}
      title={`${reactorsLabel(r, authorName)}${r.style === 'super' ? ' · super reaction' : ''}${!mine && replacing(m) ? ` · joining replaces your ${keyText(replacing(m)!)}` : ''}`}
      aria-pressed={mine}
      onClick={() => {
        const el = ref.current;
        if (r.style === 'super' && !mine && el) reactionContext(m.conversationId).then((ctx) => ctx.super?.available && burst(el, r));
        toggleReaction(m, { key: r.key, emoji: r.emoji }, r.style);
      }}
      {...press}
      onContextMenu={(e: Event) => {
        e.preventDefault();
        showWho();
      }}
    >
      {r.style === 'super' && <Icon name="zap" size={10} class="reaction-zap" />}
      <Glyph k={r.key} emoji={r.emoji} />
      <span class="reaction-n">{compact(r.count)}</span>
    </button>
  );
}

/** A reaction as words, for a title: the emoji itself, or a custom one's :name:. */
const keyText = (r: { key: string; emoji?: P.CustomEmojiView }) => (r.emoji ? `:${r.emoji.name}:` : r.key);

/**
 * The add button's face. Where a network keeps one reaction per person (Signal, WhatsApp) and you already have one,
 * a pick replaces it rather than adding another, and the button says so: arrows where the plus was.
 */
export function addLook(m: P.MessageView): { icon: string; title: string } {
  const r = replacing(m);
  return r ? { icon: 'smileSwap', title: `Change your reaction (${keyText(r)}): ${NETWORK_META[m.network].name} keeps one per person` } : { icon: 'smilePlus', title: 'Add reaction' };
}

const compact = (n: number) => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`);

export function ReactionBar({ m }: { m: P.MessageView }) {
  if (!m.reactions.length) return null;
  return (
    <div class="reactions">
      {m.reactions.map((r) => (
        <Pill key={`${r.style}|${r.key}`} m={m} r={r} />
      ))}
      {reactionScope(m.conversationId) === 'all' && <AddButton m={m} class="reaction add" />}
    </div>
  );
}

/** The row that appears over a message on hover. */
export function HoverReactions({ m }: { m: P.MessageView }) {
  if (reactionScope(m.conversationId) !== 'all') return null;
  const swap = replacing(m);
  return (
    <>
      {quickReactions(m.network, 3).map((k) => (
        <button class={`icon-btn small emoji ${swap?.key === k ? 'on' : ''}`} title={!swap ? `React ${k}` : swap.key === k ? `Take back your ${k}` : `Replace your ${keyText(swap)} with ${k}`} onClick={() => toggleReaction(m, { key: k })}>
          {k}
        </button>
      ))}
      <AddButton m={m} class="icon-btn small" label="More reactions" />
    </>
  );
}

function AddButton({ m, class: cls, label }: { m: P.MessageView; class: string; label?: string }) {
  const look = addLook(m);
  return (
    <button
      class={`${cls} ${look.icon === 'smileSwap' ? 'swap' : ''}`}
      title={look.title}
      aria-label={label ?? look.title}
      // The catalog loads while the pointer is on its way, so the picker opens whole.
      onPointerEnter={() => void loadEmoji()}
      onClick={(e) => (pickerFor.value = { message: m, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
    >
      <Icon name={look.icon} size={15} />
    </button>
  );
}

// ------------------------------------------------------------------ the burst

/** The super reaction effect: the emoji flies out of the pill. Skipped for anyone who asked for less motion. */
function burst(from: Element, r: { key: string; emoji?: P.CustomEmojiView; colors?: string[] }) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = from.getBoundingClientRect();
  const colors = r.colors?.length ? r.colors : ['#ff7ad9', '#7c5cff', '#4ad7ff'];
  for (let i = 0; i < 14; i++) {
    const piece = document.createElement('span');
    piece.className = 'burst-piece';
    const big = i % 3 === 0;
    if (big) {
      if (r.emoji?.url) {
        const img = document.createElement('img');
        img.src = r.emoji.url;
        piece.append(img);
      } else piece.textContent = r.key;
    } else piece.style.background = colors[i % colors.length];
    piece.classList.toggle('dot', !big);
    piece.style.left = `${box.left + box.width / 2}px`;
    piece.style.top = `${box.top + box.height / 2}px`;
    document.body.append(piece);
    const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
    const reach = 40 + Math.random() * 70;
    const anim = piece.animate(
      [
        { transform: 'translate(-50%, -50%) scale(.4)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(angle) * reach}px), calc(-50% + ${Math.sin(angle) * reach}px)) scale(1.15)`, opacity: 1, offset: 0.6 },
        { transform: `translate(calc(-50% + ${Math.cos(angle) * reach * 1.15}px), calc(-50% + ${Math.sin(angle) * reach * 1.15 + 18}px)) scale(.8)`, opacity: 0 },
      ],
      { duration: 700 + Math.random() * 250, easing: 'cubic-bezier(.2,.7,.3,1)' },
    );
    anim.onfinish = () => piece.remove();
  }
}

// ------------------------------------------------------------------ the picker

/** One emoji the picker offers. */
interface Item {
  key: string;
  emoji?: P.CustomEmojiView;
  /** :shortcode: */
  name: string;
  /** The source of a custom emoji, a server or a pack. */
  from?: string;
}

interface Section {
  id: string;
  title: string;
  kind: 'here' | 'custom' | 'unicode';
  icon?: string;
  img?: string | null;
  items: Item[];
}

const CATEGORY_ICON: Record<string, string> = { people: 'smile', nature: 'leaf', foods: 'apple', activity: 'gamepad', places: 'car', objects: 'bulb', symbols: 'heart', flags: 'flag' };

const isCustomKey = (key: string) => /^mxc:|^\S+:\d+$/.test(key);
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 3);

/** The cells of a grid. Each one's index into `flat` is how a click or hover over the grid finds its emoji. */
function cells(items: Item[], flat: Item[], mine: Set<string>) {
  return items.map((it) => (
    <button class={`ep-emoji ${mine.has(it.key) ? 'mine' : ''}`} data-i={flat.push(it) - 1} aria-label={it.name} aria-pressed={mine.has(it.key)}>
      <Glyph k={it.key} emoji={it.emoji} size={32} />
    </button>
  ));
}

/**
 * Discord's emoji picker: search with skin tones across the top, a rail of categories (your frequent ones, each
 * server's or pack's custom emoji, then Unicode's) down the side, and the emoji under the pointer named along the
 * bottom. On a network that keeps one reaction per person, that bottom line also says which of yours a pick replaces.
 */
function Picker({ m, anchor, onClose }: { m: P.MessageView; anchor: DOMRect | null; onClose: () => void }) {
  const rules = REACTION_RULES[m.network];
  const net = NETWORK_META[m.network].name;
  const sheet = isSheet();
  const [q, setQ] = useState('');
  // Both are usually known already, so the picker draws whole in its first frame instead of filling in.
  const [catalog, setCatalog] = useState(emojiNow);
  const [ctx, setCtx] = useState(() => knownReactionContext(m.conversationId));
  const [superOn, setSuperOn] = useState(false);
  const [tonesOpen, setTonesOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const hovered = useSignal<Item | null>(null);
  const tone = prefs.value.skinTone ?? 0;
  const search = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const flat = useRef<Item[]>([]);
  useEffect(() => {
    if (!catalog) loadEmoji().then(setCatalog);
    reactionContext(m.conversationId).then(setCtx);
    if (!sheet) search.current?.focus();
  }, [m.id]);

  // Place it next to whatever opened it, inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || sheet || !anchor) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const room = anchor.top - 8 >= h;
    el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, anchor.right - w))}px`;
    el.style.top = `${room ? anchor.top - h - 6 : Math.max(8, Math.min(innerHeight - h - 8, anchor.bottom + 6))}px`;
  }, [anchor]);

  const style: P.ReactionStyle = superOn ? 'super' : 'normal';
  const onMessage = m.reactions.filter((r, i, all) => all.findIndex((x) => x.key === r.key) === i);
  const distinctFull = rules.maxDistinct !== undefined && onMessage.length >= rules.maxDistinct;
  const existingOnly = !!ctx?.existingOnly || distinctFull;
  const swap = replacing(m);
  const mine = useMemo(() => new Set(m.reactions.filter((r) => r.style === style && hasMine(r)).map((r) => r.key)), [m.reactions, style]);

  const { sections, customs, names } = useMemo(() => {
    const names = new Map<string, string>();
    for (const c of catalog ?? []) for (const e of c.emoji) for (const s of e.skins) names.set(s, `:${e.id}:`);
    const customs = new Map(ctx?.custom.flatMap((g) => g.emoji.map((e) => [e.key, { e, from: g.name }] as const)) ?? []);
    const item = (key: string, emoji?: P.CustomEmojiView): Item => {
      const c = customs.get(key);
      const e = emoji ?? c?.e;
      return { key, emoji: e, name: e ? `:${e.name}:` : names.get(key) ?? key, from: c?.from };
    };
    const sections: Section[] = [];
    if (onMessage.length) sections.push({ id: 'here', title: 'On this message', kind: 'here', items: onMessage.map((r) => item(r.key, r.emoji)) });
    if (!existingOnly) {
      // Your usage is counted per network; here one emoji is one button, and only what works on this network shows.
      const frequent = db.reactionUsage.filter((u, i, all) => (u.network === m.network || !u.emoji) && (!isCustomKey(u.key) || customs.has(u.key)) && all.findIndex((x) => x.key === u.key) === i).slice(0, 18);
      if (frequent.length) sections.push({ id: 'frequent', title: 'Frequently used', kind: 'custom', icon: 'clock', items: frequent.map((u) => item(u.key, u.emoji)) });
      ctx?.custom.forEach((g) => sections.push({ id: `custom:${g.id}`, title: g.name, kind: 'custom', img: g.icon, items: g.emoji.map((e) => item(e.key, e)) }));
      for (const c of catalog ?? []) sections.push({ id: c.id, title: c.name, kind: 'unicode', icon: CATEGORY_ICON[c.id] ?? 'smile', items: c.emoji.map((e) => ({ key: skinOf(e, tone), name: `:${e.id}:` })) });
    }
    return { sections, customs, names };
  }, [catalog, ctx, tone, existingOnly]);

  const query = q.trim().toLowerCase();
  const hits = useMemo((): Item[] => {
    if (!query) return [];
    const custom = [...customs.values()].filter(({ e }) => e.name.toLowerCase().includes(query)).slice(0, 36);
    const unicode = catalog ? searchEmoji(catalog, query) : [];
    return [...custom.map(({ e, from }) => ({ key: e.key, emoji: e, name: `:${e.name}:`, from })), ...unicode.map((e) => ({ key: skinOf(e, tone), name: `:${e.id}:` }))];
  }, [query, customs, catalog, tone]);

  // Built once per change of what is shown: hovering and scrolling re-render the picker, not its 1,900 buttons.
  const grid = useMemo(() => {
    const items: Item[] = [];
    flat.current = items;
    if (query) return hits.length ? <div class="ep-grid">{cells(hits, items, mine)}</div> : null;
    return sections.map((s) => (
      <section class={`ep-section ${collapsed.has(s.id) ? 'collapsed' : ''}`} data-sec={s.id} key={s.id}>
        <h4>
          <button
            aria-expanded={!collapsed.has(s.id)}
            onClick={() => {
              const next = new Set(collapsed);
              next.has(s.id) ? next.delete(s.id) : next.add(s.id);
              setCollapsed(next);
            }}
          >
            {s.img ? <img src={s.img} alt="" /> : s.icon && <Icon name={s.icon} size={13} />}
            <span>{s.title}</span>
            <Icon name="chevronDown" size={13} class="ep-chevron" />
          </button>
        </h4>
        {!collapsed.has(s.id) && <div class="ep-grid">{cells(s.items, items, mine)}</div>}
      </section>
    ));
  }, [query, hits, sections, collapsed, mine]);

  const pick = (p: Picked, el: HTMLElement) => {
    if (style === 'super') burst(el, { key: p.key, emoji: p.emoji });
    toggleReaction(m, p, style);
    onClose();
  };
  const first = hits[0] ?? (rules.freeText && q.trim() ? { key: q.trim(), name: q.trim() } : null);
  const at = (e: Event) => {
    const el = (e.target as Element).closest?.('.ep-emoji') as HTMLElement | null;
    const it = el ? flat.current[Number(el.dataset.i)] : undefined;
    return el && it ? { el, it } : null;
  };

  // The rail follows the scroll, and jumps it.
  const frame = useRef(0);
  const spy = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      let cur: string | null = null;
      for (const s of el.querySelectorAll<HTMLElement>('.ep-section')) {
        if (s.offsetTop - 2 > el.scrollTop) break;
        cur = s.dataset.sec ?? null;
      }
      setActive(cur);
    });
  };
  const jump = (id: string) => {
    const el = scroller.current;
    const s = el?.querySelector<HTMLElement>(`[data-sec="${CSS.escape(id)}"]`);
    if (!el || !s) return;
    el.scrollTop = s.offsetTop;
    setActive(id);
  };
  useEffect(spy, [sections]);
  // The rail scrolls too when there are many servers: keep the marked category in sight.
  const railBox = useRef<HTMLElement>(null);
  useEffect(() => railBox.current?.querySelector('.ep-rail-btn.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }), [active]);

  if (ctx && !ctx.canReact) {
    return (
      <Shell sheet={sheet} box={box} onClose={onClose}>
        <div class="ep-blocked">
          <Icon name="info" size={18} />
          <span>{ctx.reason ?? `You can't react here on ${net}.`}</span>
        </div>
      </Shell>
    );
  }

  const note = superOn
    ? 'Super reaction: plays an effect for everyone looking at this message.'
    : distinctFull
      ? `${net} allows ${rules.maxDistinct} different reactions on a message, and this one is full. You can still add to these.`
      : ctx?.existingOnly
        ? 'You can only add to reactions already on this message here.'
        : rules.exclusive
          ? swap
            ? <>{net} keeps one reaction per person: a pick replaces your <Glyph k={swap.key} emoji={swap.emoji} size={16} />.</>
            : `${net} keeps one reaction per person.`
          : null;
  const rail = !query && sections.filter((s) => s.kind !== 'here');

  return (
    <Shell sheet={sheet} box={box} onClose={onClose}>
      <div class="ep-head">
        {existingOnly ? (
          <span class="ep-head-title">Add to a reaction on this message</span>
        ) : (
          <label class="ep-search">
            <input
              ref={search}
              value={q}
              placeholder={rules.freeText ? 'Find an emoji, or type any text' : 'Find the perfect emoji'}
              onInput={(e) => {
                setQ((e.target as HTMLInputElement).value);
                scroller.current?.scrollTo(0, 0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && first) pick(first, e.currentTarget as HTMLElement);
              }}
            />
            {q ? (
              <button class="ep-clear" aria-label="Clear search" onClick={() => setQ('')}>
                <Icon name="x" size={14} />
              </button>
            ) : (
              <Icon name="search" size={16} />
            )}
          </label>
        )}
        {!existingOnly && (
          <div class="ep-tones-wrap">
            <button class="ep-tool" title="Skin tone" aria-label="Skin tone" aria-expanded={tonesOpen} onClick={() => setTonesOpen(!tonesOpen)}>
              {SKIN_TONES[tone]}
            </button>
            {tonesOpen && (
              <div class="ep-tones" role="listbox" aria-label="Skin tone">
                {SKIN_TONES.map((h, i) => (
                  <button
                    role="option"
                    aria-selected={i === tone}
                    class={i === tone ? 'on' : ''}
                    onClick={() => {
                      setPrefs({ skinTone: i });
                      setTonesOpen(false);
                    }}
                  >
                    {h}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {ctx?.super?.available && (
          <button class={`ep-tool ep-super ${superOn ? 'on' : ''}`} title="Super reaction" aria-pressed={superOn} onClick={() => setSuperOn(!superOn)}>
            <Icon name="zap" size={15} />
            <span>Super</span>
          </button>
        )}
      </div>

      <div class="ep-body">
        {rail && rail.length > 1 && (
          <nav class="ep-rail" aria-label="Categories" ref={railBox}>
            {rail.map((s, i) => (
              <>
                {i > 0 && rail[i - 1].kind !== s.kind && <hr />}
                <button class={`ep-rail-btn ${active === s.id ? 'on' : ''} ${s.img ? 'img' : ''}`} title={s.title} aria-label={s.title} onClick={() => jump(s.id)}>
                  {s.img ? <img src={s.img} alt="" /> : s.icon ? <Icon name={s.icon} size={20} /> : <span>{initials(s.title)}</span>}
                </button>
              </>
            ))}
          </nav>
        )}
        <div
          class="ep-scroll"
          ref={scroller}
          onScroll={spy}
          onClick={(e) => {
            const hit = at(e);
            if (hit) pick(hit.it, hit.el);
          }}
          onMouseOver={(e) => {
            const hit = at(e);
            if (hit && hovered.peek() !== hit.it) hovered.value = hit.it;
          }}
          onFocusIn={(e) => {
            const hit = at(e);
            if (hit) hovered.value = hit.it;
          }}
        >
          {!!query && rules.freeText && (
            <button class="ep-free" onClick={(e) => pick({ key: q.trim() }, e.currentTarget as HTMLElement)}>
              React with <b>{q.trim()}</b>
            </button>
          )}
          {grid}
          {!!query && !hits.length && !rules.freeText && <div class="ep-none">{catalog ? 'Nothing matches that.' : 'Loading…'}</div>}
          {!query && !catalog && !existingOnly && <div class="ep-none">Loading…</div>}
        </div>
      </div>

      <Inspector hovered={hovered} fallback={sheet ? null : (sections.find((s) => s.kind !== 'here') ?? sections[0])?.items[0] ?? null} note={note} mine={mine} swap={swap} superOn={superOn} names={names} />
    </Shell>
  );
}

/** The line along the bottom: the emoji under the pointer, by name, and what picking it does here. */
function Inspector({ hovered, fallback, note, mine, swap, superOn, names }: { hovered: { value: Item | null }; fallback: Item | null; note: any; mine: Set<string>; swap?: P.ReactionView; superOn: boolean; names: Map<string, string> }) {
  const it = hovered.value ?? (note ? null : fallback);
  if (!it)
    return note ? (
      <div class="ep-foot note">
        <span>{note}</span>
      </div>
    ) : null;
  const yours = mine.has(it.key);
  return (
    <div class="ep-foot">
      <span class="ep-foot-glyph">
        <Glyph k={it.key} emoji={it.emoji} size={30} />
      </span>
      <span class="ep-foot-name">
        <b>{it.name}</b>
        {it.from && <small>from {it.from}</small>}
      </span>
      {yours ? (
        <span class="ep-foot-act">Picking it takes yours back</span>
      ) : swap ? (
        <span class="ep-foot-act swap" title={`Replaces your ${names.get(swap.key) ?? (swap.emoji ? `:${swap.emoji.name}:` : swap.key)}`}>
          <Icon name="smileSwap" size={15} /> replaces <Glyph k={swap.key} emoji={swap.emoji} size={16} />
        </span>
      ) : superOn ? (
        <span class="ep-foot-act">
          <Icon name="zap" size={13} /> super
        </span>
      ) : null}
    </div>
  );
}

function Shell({ sheet, box, onClose, children }: { sheet: boolean; box: { current: HTMLDivElement | null }; onClose: () => void; children: any }) {
  if (sheet)
    return (
      <Sheet onClose={onClose} label="Add a reaction" class="emoji-picker" tall>
        {children}
      </Sheet>
    );
  return <Popover box={box} onClose={onClose} class="emoji-picker" label="Add a reaction">{children}</Popover>;
}

/** Desktop: floats beside what opened it. */
function Popover({ box, onClose, class: cls, label, children }: { box: { current: HTMLDivElement | null }; onClose: () => void; class: string; label?: string; children: any }) {
  useLayer(onClose);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);
  return (
    <div class="ep-layer" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={cls} ref={box} role="dialog" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ who reacted

function Reactors({ m, reactionKey, style, anchor, onClose }: { m: P.MessageView; reactionKey: string; style: P.ReactionStyle; anchor: DOMRect; onClose: () => void }) {
  const r = m.reactions.find((x) => x.key === reactionKey && x.style === style);
  const [ids, setIds] = useState<string[]>(r?.identityIds ?? []);
  const [count, setCount] = useState(r?.count ?? 0);
  const [loading, setLoading] = useState((r?.count ?? 0) > (r?.identityIds.length ?? 0));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!loading) return;
    api<{ count: number; identityIds: string[]; identities: P.IdentityView[] }>(`/api/messages/${m.id}/reactors?key=${encodeURIComponent(reactionKey)}&style=${style}`)
      .then((res) => {
        for (const i of res.identities) db.identities.set(i.id, i);
        setIds(res.identityIds);
        setCount(res.count);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  const sheet = isSheet();
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || sheet) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, anchor.left))}px`;
    el.style.top = `${anchor.top - 8 >= h ? anchor.top - h - 6 : Math.min(innerHeight - h - 8, anchor.bottom + 6)}px`;
  });
  const unknown = count - ids.length;
  const body = (
    <>
      <h4>
        {r && <Glyph k={r.key} emoji={r.emoji} size={18} />}
        {style === 'super' && <Icon name="zap" size={12} />}
        <span>{count === 1 ? '1 reaction' : `${count} reactions`}</span>
      </h4>
      <div class="reactors-list">
        {[...ids.filter(isSelfIdentity), ...ids.filter((i) => !isSelfIdentity(i))].map((id) => {
          const name = isSelfIdentity(id) ? 'You' : authorName(id);
          return (
            <div class="reactor">
              <Avatar id={id} name={name} url={db.identities.get(id)?.avatar} size={24} />
              <span>{name}</span>
            </div>
          );
        })}
        {loading && <div class="reactor-more">Asking the network…</div>}
        {!loading && unknown > 0 && <div class="reactor-more">and {unknown} more</div>}
      </div>
    </>
  );
  if (sheet)
    return (
      <Sheet onClose={onClose} label="Who reacted" class="reactors">
        {body}
      </Sheet>
    );
  return (
    <Popover box={box} onClose={onClose} class="reactors" label="Who reacted">
      {body}
    </Popover>
  );
}

/** Mounted once at the app root. */
export function ReactionLayer() {
  rev.value;
  // The catalog loads once the app is idle, so even the first picker opens whole rather than filling in.
  useEffect(() => {
    const t = setTimeout(() => void loadEmoji(), 4000);
    return () => clearTimeout(t);
  }, []);
  const p = pickerFor.value;
  const w = reactorsFor.value;
  return (
    <>
      {p && <Picker key={p.message.id} m={p.message} anchor={p.anchor} onClose={() => (pickerFor.value = null)} />}
      {w && <Reactors m={w.message} reactionKey={w.key} style={w.style} anchor={w.anchor} onClose={() => (reactorsFor.value = null)} />}
    </>
  );
}
