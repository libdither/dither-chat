import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, REACTION_RULES } from '@dither-chat/protocol';
import { loadEmoji, searchEmoji, SKIN_TONES, skinOf, type EmojiCategory } from '../emoji.ts';
import { fullTime } from '../format.ts';
import { authorName, convTitle, netName, plainBody } from '../model.ts';
import { hasMine, pickerFor, quickReactions, reactionContext, reactionScope, reactorsFor, reactorsLabel, sheetFor, toggleReaction, type Picked } from '../reactions.ts';
import { canDelete, canEdit, deleteMessage, startEditing, api, db, feedback, isSelfIdentity, openProfile, prefs, rev, setPrefs, toast } from '../state.ts';
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
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
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
      title={`${reactorsLabel(r, authorName)}${r.style === 'super' ? ' · super reaction' : ''}`}
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

const compact = (n: number) => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`);

export function ReactionBar({ m }: { m: P.MessageView }) {
  if (!m.reactions.length) return null;
  return (
    <div class="reactions">
      {m.reactions.map((r) => (
        <Pill key={`${r.style}|${r.key}`} m={m} r={r} />
      ))}
      {reactionScope(m.conversationId) === 'all' && (
        <button class="reaction add" title="Add reaction" aria-label="Add reaction" onClick={(e) => (pickerFor.value = { message: m, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
          <Icon name="smilePlus" size={15} />
        </button>
      )}
    </div>
  );
}

/** The row that appears over a message on hover. */
export function HoverReactions({ m }: { m: P.MessageView }) {
  if (reactionScope(m.conversationId) !== 'all') return null;
  return (
    <>
      {quickReactions(m.network, 3).map((k) => (
        <button class="icon-btn small emoji" title={`React ${k}`} onClick={() => toggleReaction(m, { key: k })}>
          {k}
        </button>
      ))}
      <button class="icon-btn small" title="More reactions" aria-label="More reactions" onClick={(e) => (pickerFor.value = { message: m, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
        <Icon name="smilePlus" size={15} />
      </button>
    </>
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

function EmojiButton({ k, emoji, label, onPick }: { k: string; emoji?: P.CustomEmojiView; label: string; onPick: (p: Picked, el: HTMLElement) => void }) {
  return (
    <button class="ep-emoji" title={label} aria-label={label} onClick={(e) => onPick({ key: k, emoji }, e.currentTarget as HTMLElement)}>
      <Glyph k={k} emoji={emoji} size={26} />
    </button>
  );
}

function Picker({ m, anchor, onClose }: { m: P.MessageView; anchor: DOMRect | null; onClose: () => void }) {
  const rules = REACTION_RULES[m.network];
  const net = NETWORK_META[m.network].name;
  const sheet = isSheet();
  const [q, setQ] = useState('');
  const [catalog, setCatalog] = useState<EmojiCategory[] | null>(null);
  const [ctx, setCtx] = useState<P.ReactionContextView | null>(null);
  const [superOn, setSuperOn] = useState(false);
  const tone = prefs.value.skinTone ?? 0;
  const search = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    loadEmoji().then(setCatalog);
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
    el.style.top = `${room ? anchor.top - h - 6 : Math.min(innerHeight - h - 8, anchor.bottom + 6)}px`;
  });

  const onMessage = m.reactions.filter((r, i, all) => all.findIndex((x) => x.key === r.key) === i);
  const distinctFull = rules.maxDistinct !== undefined && onMessage.length >= rules.maxDistinct;
  const existingOnly = !!ctx?.existingOnly || distinctFull;
  const customKeys = useMemo(() => new Map(ctx?.custom.flatMap((g) => g.emoji.map((e) => [e.key, e] as const)) ?? []), [ctx]);
  const usable = (key: string) => !key.match(/^mxc:|^\S+:\d+$/) || customKeys.has(key);
  // Your usage is counted per network; here one emoji is one button, and only what works on this network shows.
  const frequent = db.reactionUsage.filter((u, i, all) => (u.network === m.network || !u.emoji) && usable(u.key) && all.findIndex((x) => x.key === u.key) === i).slice(0, 16);
  const mine = rules.exclusive ? m.reactions.find(hasMine) : undefined;

  const pick = (p: Picked, el: HTMLElement) => {
    const style = superOn ? 'super' : 'normal';
    if (style === 'super') burst(el, { key: p.key, emoji: p.emoji });
    toggleReaction(m, p, style);
    onClose();
  };

  const query = q.trim().toLowerCase();
  const customHits = query ? [...customKeys.values()].filter((e) => e.name.toLowerCase().includes(query)).slice(0, 32) : [];
  const unicodeHits = query && catalog ? searchEmoji(catalog, query) : [];
  const first = customHits[0] ? { key: customHits[0].key, emoji: customHits[0] } : unicodeHits[0] ? { key: skinOf(unicodeHits[0], tone) } : rules.freeText && q.trim() ? { key: q.trim() } : null;

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

  return (
    <Shell sheet={sheet} box={box} onClose={onClose}>
      <div class="ep-head">
        {!existingOnly && (
          <label class="ep-search">
            <Icon name="search" size={15} />
            <input
              ref={search}
              value={q}
              placeholder={rules.freeText ? 'Search, or type any text' : 'Search emoji'}
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && first) pick(first, e.currentTarget as HTMLElement);
              }}
            />
          </label>
        )}
        {!existingOnly && (
          <button class="ep-tool" title="Skin tone" aria-label="Skin tone" onClick={() => setPrefs({ skinTone: (tone + 1) % SKIN_TONES.length })}>
            {SKIN_TONES[tone]}
          </button>
        )}
        {ctx?.super?.available && (
          <button class={`ep-tool ep-super ${superOn ? 'on' : ''}`} title="Super reaction" aria-pressed={superOn} onClick={() => setSuperOn(!superOn)}>
            <Icon name="zap" size={15} />
            <span>Super</span>
          </button>
        )}
      </div>

      <div class="ep-scroll">
        {query ? (
          <>
            {rules.freeText && (
              <button class="ep-free" onClick={(e) => pick({ key: q.trim() }, e.currentTarget as HTMLElement)}>
                React with <b>{q.trim()}</b>
              </button>
            )}
            {customHits.length + unicodeHits.length > 0 ? (
              <div class="ep-grid">
                {customHits.map((e) => (
                  <EmojiButton k={e.key} emoji={e} label={`:${e.name}:`} onPick={pick} />
                ))}
                {unicodeHits.map((e) => (
                  <EmojiButton k={skinOf(e, tone)} label={e.name} onPick={pick} />
                ))}
              </div>
            ) : (
              !rules.freeText && <div class="ep-none">{catalog ? 'Nothing matches that.' : 'Loading…'}</div>
            )}
          </>
        ) : (
          <>
            {onMessage.length > 0 && (
              <Section title="On this message">
                {onMessage.map((r) => (
                  <EmojiButton k={r.key} emoji={r.emoji} label={r.emoji ? `:${r.emoji.name}:` : r.key} onPick={pick} />
                ))}
              </Section>
            )}
            {!existingOnly && (
              <>
                {frequent.length > 0 && (
                  <Section title="Frequently used">
                    {frequent.map((u) => (
                      <EmojiButton k={u.key} emoji={u.emoji ?? customKeys.get(u.key)} label={u.emoji ? `:${u.emoji.name}:` : u.key} onPick={pick} />
                    ))}
                  </Section>
                )}
                {ctx?.custom.map((g) => (
                  <Section title={g.name} icon={g.icon}>
                    {g.emoji.map((e) => (
                      <EmojiButton k={e.key} emoji={e} label={`:${e.name}:`} onPick={pick} />
                    ))}
                  </Section>
                ))}
                {catalog ? (
                  catalog.map((c) => (
                    <Section title={c.name}>
                      {c.emoji.map((e) => (
                        <EmojiButton k={skinOf(e, tone)} label={e.name} onPick={pick} />
                      ))}
                    </Section>
                  ))
                ) : (
                  <div class="ep-none">Loading…</div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {(rules.exclusive || existingOnly || superOn) && (
        <div class="ep-note">
          {superOn
            ? 'Super reaction: plays an effect for everyone looking at this message.'
            : distinctFull
              ? `${net} allows ${rules.maxDistinct} different reactions on a message, and this one is full. You can still add to these.`
              : ctx?.existingOnly
                ? 'You can only add to reactions already on this message here.'
                : mine
                  ? <>{net} keeps one reaction per person, so this replaces your <Glyph k={mine.key} emoji={mine.emoji} size={14} />.</>
                  : `${net} keeps one reaction per person.`}
        </div>
      )}
    </Shell>
  );
}

function Section({ title, icon, children }: { title: string; icon?: string | null; children: any }) {
  return (
    <section class="ep-section">
      <h4>
        {icon && <img src={icon} alt="" />}
        {title}
      </h4>
      <div class="ep-grid">{children}</div>
    </section>
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

// ------------------------------------------------------------------ long-press sheet

/**
 * Long-press on a message: everything its hover bar, its tooltips and its pills offer on a desktop, in one
 * sheet. The header carries what a hover would have shown: the exact time, the network, the account it came through.
 */
function MessageSheet({ m, onReply, onClose }: { m: P.MessageView; onReply: () => void; onClose: () => void }) {
  const scope = reactionScope(m.conversationId);
  const self = isSelfIdentity(m.authorId);
  const name = self ? 'You' : authorName(m.authorId);
  const author = m.authorId ? db.identities.get(m.authorId) : null;
  const person = author?.personId ? db.persons.get(author.personId) : null;
  const via = m.seenVia.map((id) => db.accounts.get(id)).filter((a): a is P.AccountView => !!a);
  const thread = m.threadId ? db.conversations.get(m.threadId) : null;
  const t = m.triage;
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const action = (icon: string, label: string, fn: () => void, cls = '') => (
    <button class={`sheet-action ${cls}`} onClick={act(fn)}>
      <Icon name={icon} size={20} /> {label}
    </button>
  );
  return (
    <Sheet onClose={onClose} label="Message actions" class="message-sheet">
      <div class="msg-sheet-head">
        <Avatar id={person?.id ?? m.authorId ?? m.id} name={name} url={person?.avatar ?? author?.avatar} size={36} />
        <span>
          <b>{name}</b>
          <small>
            {fullTime(m.ts)}
            {m.editedTs ? ' · edited' : ''} · {netName(m.network)}
            {via.length ? ` via ${via.map((a) => a.label).join(', ')}` : ''}
          </small>
        </span>
      </div>
      {m.encryptionWarning && (
        <div class="ep-note">
          <Icon name="alert" size={13} /> {m.encryptionWarning}
        </div>
      )}
      {scope === 'all' && (
        <div class="sheet-quick">
          {quickReactions(m.network, 6).map((k) => (
            <button aria-label={`React ${k}`} onClick={act(() => toggleReaction(m, { key: k }))}>
              {k}
            </button>
          ))}
          <button class="more" aria-label="More reactions" onClick={act(() => (pickerFor.value = { message: m, anchor: null }))}>
            <Icon name="smilePlus" size={22} />
          </button>
        </div>
      )}
      {scope === 'existing' && <div class="ep-note">You can only add to reactions already on a message here. Tap one to join in.</div>}
      <div class="sheet-actions">
        {m.kind !== 'system' && action('reply', 'Reply', onReply)}
        {canEdit(m) && action('pencil', 'Edit', () => startEditing(m))}
        {m.body && !m.deleted &&
          action('copy', 'Copy text', () =>
            navigator.clipboard?.writeText(plainBody(m.body, m.network)).then(
              () => toast({ kind: 'info', title: 'Copied', body: '' }, 1500),
              () => toast({ kind: 'error', title: 'Could not copy', body: 'The browser refused.' }),
            ),
          )}
        {m.replyToId && action('chevronUp', 'Go to the message it replies to', () => document.getElementById(`m-${m.replyToId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))}
        {thread && action('thread', `Open thread: ${convTitle(thread)}`, () => openConv(thread))}
        {m.authorId && action('user', self ? 'Your profile' : `Profile of ${name}`, () => openProfile(m.authorId))}
        {canDelete(m) && action('trash', 'Delete', () => deleteMessage(m), 'danger')}
      </div>
      {t && (
        <div class="sheet-triage">
          <h4>
            <Icon name={t.decision === 'push' ? 'bell' : t.decision === 'digest' ? 'layers' : 'bellOff'} size={14} />
            {t.decision === 'push' ? 'This pinged you because' : t.decision === 'digest' ? 'This went to the digest because' : 'This was silent because'}
          </h4>
          <ul>
            {t.reasons.map((r) => (
              <li>{r}</li>
            ))}
          </ul>
          <div class="triage-fb">
            <button class={`chip-btn ${t.feedback === 'should_push' ? 'on' : ''}`} onClick={act(() => feedback(m.id, 'should_push'))}>
              <Icon name="thumbsUp" size={14} /> {t.decision === 'push' ? 'Right call' : 'Should have pinged'}
            </button>
            <button class={`chip-btn ${t.feedback === 'should_not_push' ? 'on' : ''}`} onClick={act(() => feedback(m.id, 'should_not_push'))}>
              <Icon name="thumbsDown" size={14} /> {t.decision === 'push' ? "Shouldn't have pinged" : 'Right call'}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** Mounted once at the app root. */
export function ReactionLayer() {
  rev.value;
  const p = pickerFor.value;
  const w = reactorsFor.value;
  const s = sheetFor.value;
  return (
    <>
      {p && <Picker key={p.message.id} m={p.message} anchor={p.anchor} onClose={() => (pickerFor.value = null)} />}
      {w && <Reactors m={w.message} reactionKey={w.key} style={w.style} anchor={w.anchor} onClose={() => (reactorsFor.value = null)} />}
      {s && <MessageSheet m={s.message} onReply={s.onReply} onClose={() => (sheetFor.value = null)} />}
    </>
  );
}
