/**
 * Notification calibration (docs/notifications.md, "The calibration feed"): one feed of notifications as they looked,
 * each with three answers, Sound, Show and Inbox. Under each answer a bar: its fill is the chance the model gave it, the
 * whisker how unsure it was, ▲ what you did, and the underlined answer what the model did. Answering draws the chances
 * again, after the answer, over a dashed line at the old one; "What was it wrong about?" routes the answer to parts of
 * it (the person, the chat, the topic, how long it could wait, the moment, the delivery).
 *
 * The few worth asking open as cards; the rest are rows that open in place. A past answer that surprised the model
 * comes back once (Keep, Only that once, Undo). The ones it was sure of sit folded at the end.
 *
 * On a phone: one column, × or a swipe skips (Undo on the toast). On a computer: the list on the left, the chosen one
 * open on the right, 1–3 answer, x skips, j and k move, w opens what it was wrong about.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { CAL_ANSWER_NAME, CAL_ANSWERS, CAL_PART_NAME, NETWORK_META, NETWORKS } from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { countKey } from '../clicklog.ts';
import { hueOf, initials, stamp } from '../format.ts';
import { answerFeed, calFeed, feedParts, loadFeed, settleFeed, skipFeed } from '../loudness.ts';
import { phone } from '../phone.ts';
import { go, toast } from '../state.ts';
import { Empty, NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';
import { memo } from './memo.ts';
import { HeadOrb } from './Offline.tsx';
import './calibration.css';

/** What this page did with one item: your answer, the chances before and after, the parts, the drill open. */
interface Local {
  answer?: P.CalAnswer;
  before?: P.Trio;
  after?: P.Trio;
  parts: P.CalPart[];
  drill: boolean;
  /** A past answer settled: it leaves the page. */
  settled?: P.CalSettle;
}
const NONE: Local = { parts: [], drill: false };

const local = signal<ReadonlyMap<string, Local>>(new Map());
const skipped = signal<ReadonlySet<string>>(new Set());
/** Rows opened in place (phone). */
const opened = signal<ReadonlySet<string>>(new Set());
/** The one open on the right (computer). */
const chosen = signal<string | null>(null);

const stOf = (id: string) => local.value.get(id) ?? NONE;
function setSt(id: string, f: (s: Local) => Local) {
  const m = new Map(local.value);
  m.set(id, f(stOf(id)));
  local.value = m;
}

const asNet = (n: string | null | undefined): P.Network | null => (n && (NETWORKS as readonly string[]).includes(n) ? (n as P.Network) : null);
const netName = (n: string | null) => {
  const net = asNet(n);
  return net ? NETWORK_META[net].name : (n ?? 'dither');
};
const idx = (a: P.CalAnswer) => CAL_ANSWERS.indexOf(a);

// ------------------------------------------------------------------ what you do

async function answerIt(it: P.CalItem, a: P.CalAnswer) {
  const was = stOf(it.id);
  setSt(it.id, (s) => ({ ...s, answer: a, drill: true }));
  const r = await answerFeed(it, a);
  if (!r) return setSt(it.id, () => was);
  setSt(it.id, (s) => ({ ...s, before: r.before, after: r.after, parts: [] }));
}

async function togglePart(it: P.CalItem, part: P.CalPart) {
  const s = stOf(it.id);
  if (!s.answer) return;
  const parts = s.parts.includes(part) ? s.parts.filter((x) => x !== part) : [...s.parts, part];
  setSt(it.id, (x) => ({ ...x, parts }));
  const after = await feedParts(it, parts);
  if (after) setSt(it.id, (x) => ({ ...x, after }));
}

function skip(it: P.CalItem) {
  skipped.value = new Set([...skipped.value, it.id]);
  if (chosen.value === it.id) chosen.value = nextOf(it.id, 1);
  void skipFeed(it, true);
  toast({
    kind: 'info',
    title: 'Skipped',
    body: it.who,
    actionLabel: 'Undo',
    action: () => {
      const s = new Set(skipped.value);
      s.delete(it.id);
      skipped.value = s;
      void skipFeed(it, false);
    },
  });
}

async function settle(it: P.CalItem, how: P.CalSettle) {
  setSt(it.id, (s) => ({ ...s, settled: how }));
  await settleFeed(it, how);
}

/** A row: on a phone it opens where it is; on a computer it is the one shown on the right. */
function pick(it: P.CalItem) {
  if (phone.value) opened.value = new Set([...opened.value, it.id]);
  else chosen.value = it.id;
}

const setDrill = (it: P.CalItem, open: boolean) => stOf(it.id).drill !== open && setSt(it.id, (s) => ({ ...s, drill: open }));

/** The items on the page, in their order: cards and past answers, then the rows (the sure ones apart). */
function shownItems(v: P.CalFeedView | null): P.CalItem[] {
  if (!v) return [];
  return v.items.filter((i) => !skipped.value.has(i.id) && !stOf(i.id).settled);
}

function nextOf(id: string, by: 1 | -1): string | null {
  const l = shownItems(calFeed.value);
  const at = l.findIndex((i) => i.id === id);
  const to = l[at + by] ?? l[at - by] ?? null;
  return to && to.id !== id ? to.id : null;
}

// ------------------------------------------------------------------ the page

export function CalibrationPane({ onBack }: { onBack?: () => void }) {
  useEffect(() => {
    void loadFeed();
    const back = () => document.visibilityState === 'visible' && void loadFeed();
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, []);
  const v = calFeed.value;
  const items = shownItems(v);
  const sure = (v?.sure ?? []).filter((i) => !skipped.value.has(i.id));
  const ask = items.filter((i) => (i.kind === 'card' || i.kind === 'past') && !stOf(i.id).answer).length;
  const onPhone = phone.value;
  const cur = onPhone ? null : ([...items, ...sure].find((i) => i.id === chosen.value) ?? items[0] ?? null);

  // 1–3 answer, x skips, j and k move, w opens what it was wrong about; never while typing or under a menu.
  useLayoutEffect(() => {
    if (onPhone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select, [contenteditable], .cm, .sheet-layer, .modal-backdrop, .switcher-back')) return;
      if (document.querySelector('.cm, .sheet-layer, .modal-backdrop, .switcher-back, .viewer')) return;
      const all = [...shownItems(calFeed.value), ...(calFeed.value?.sure ?? []).filter((i) => !skipped.value.has(i.id))];
      const it = all.find((i) => i.id === chosen.value) ?? all[0];
      if (!it) return;
      const at = all.indexOf(it);
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        if (it.kind === 'past') return;
        void answerIt(it, CAL_ANSWERS[Number(e.key) - 1]);
      } else if (e.key === 'x') skip(it);
      else if (e.key === 'j' || e.key === 'k') {
        const to = all[Math.max(0, Math.min(all.length - 1, at + (e.key === 'j' ? 1 : -1)))];
        if (!to) return;
        chosen.value = to.id;
        requestAnimationFrame(() => document.querySelector(`.cal-side [data-cal-id="${CSS.escape(to.id)}"]`)?.scrollIntoView({ block: 'nearest' }));
      } else if (e.key === 'w') {
        if (!stOf(it.id).answer) return;
        setDrill(it, !stOf(it.id).drill);
      } else return;
      countKey(`calibration: key ${e.key}`);
      e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onPhone]);

  return (
    <section class="pane requests-pane calibration-pane" aria-label="Notification calibration" data-track-area="calibration">
      <header class="conv-head">
        {onBack && (
          <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
            <Icon name="back" />
          </button>
        )}
        <span class="conv-head-icon requests-icon">
          <Icon name="bell" size={18} />
        </span>
        <div class="conv-head-text">
          <h2>Notification calibration</h2>
          <div class="conv-head-sub">
            <span class="muted-label">{v === null ? 'Loading…' : ask ? `${ask} to answer · whenever you like` : 'Nothing to answer'}</span>
          </div>
        </div>
        <HeadOrb />
      </header>
      {v === null ? (
        <Loading label="Loading…" />
      ) : !items.length && !sure.length ? (
        <div class="requests-scroll cal-scroll">
          <Empty icon="bell" title="Nothing here yet">
            Notifications from the last few days land here, the ones worth asking about open with their answers. Your answers teach it what to sound for.
          </Empty>
        </div>
      ) : onPhone ? (
        <div class="requests-scroll cal-scroll cal-phone">
          <Legend />
          {items.map((it) => (it.kind === 'row' && !opened.value.has(it.id) ? <Row key={it.id} it={it} sel={false} done={!!local.value.get(it.id)?.answer} /> : <Card key={it.id} it={it} st={local.value.get(it.id) ?? NONE} desk={false} />))}
          <Sure items={sure} desk={false} />
          <How />
        </div>
      ) : (
        <div class="cal-desk">
          <div class="cal-side" aria-label="The feed">
            {items.map((it) => (
              <Row key={it.id} it={it} sel={it.id === cur?.id} done={!!local.value.get(it.id)?.answer} />
            ))}
            <Sure items={sure} desk sel={cur?.id ?? null} />
          </div>
          <div class="requests-scroll cal-main">
            <Legend />
            {cur && <Card key={cur.id} it={cur} st={local.value.get(cur.id) ?? NONE} desk />}
            <div class="cal-hints" aria-hidden="true">
              <span>
                <kbd>1</kbd>–<kbd>3</kbd> answer
              </span>
              <span>
                <kbd>x</kbd> skip
              </span>
              <span>
                <kbd>j</kbd> <kbd>k</kbd> next, back
              </span>
              <span>
                <kbd>w</kbd> what it was wrong about
              </span>
            </div>
            <How />
          </div>
        </div>
      )}
    </section>
  );
}

function Legend() {
  return (
    <div class="cal-key">
      <span>
        <svg width="12" height="16" aria-hidden="true">
          <rect x="2" y="7" width="8" height="9" fill="currentColor" opacity=".4" />
          <path d="M3 2h6M6 2v11M3 13h6" stroke="currentColor" stroke-width="1.5" />
        </svg>
        its guess, and how unsure
      </span>
      <span>▲ what you did</span>
      <span>
        <u>Show</u> what it did
      </span>
      <span>- - - its guess before</span>
    </div>
  );
}

/** The ones it was sure of, folded. */
function Sure({ items, desk, sel }: { items: P.CalItem[]; desk: boolean; sel?: string | null }) {
  if (!items.length) return null;
  return (
    <details class="cal-sure">
      <summary data-track="calibration sure fold">{items.length} it was sure of</summary>
      {items.map((it) => (!desk && opened.value.has(it.id) ? <Card key={it.id} it={it} st={local.value.get(it.id) ?? NONE} desk={false} /> : <Row key={it.id} it={it} sel={sel === it.id} done={!!local.value.get(it.id)?.answer} />))}
    </details>
  );
}

function How() {
  return (
    <details class="cal-how">
      <summary data-track="calibration how">How the order and the hiding work</summary>
      <p>Each notification gets a worth asking score: how surprised the model is by what you did, mixed with how unsure it was, fading by half every 3 days.</p>
      <div class="cal-formula">
        surprise = −log₂ P(what you did), capped at 5 bits
        <br />
        unsure = how spread its guess was × how few answers are behind it
        <br />
        worth asking = (0.6 · surprise/5 + 0.4 · unsure) × fading(age)
      </div>
      <p>The few over 0.5 (about 3 a day) open with their answers; the rest are rows, tap one to open it. Open ones are drawn at random in proportion to the score, and that chance is kept so the scorecard can weight answers back.</p>
      <p>A past answer comes back once if it surprised the model (it gave it under 20%), with its guess before and after.</p>
      <p>Hidden as sure only when all hold: it gave what you did 95% or more, 30 or more answers about that person or chat, none against it in 30 days, and not a sound it held back. 1 in 20 of those still shows, at random.</p>
    </details>
  );
}

// ------------------------------------------------------------------ a swipe (phone)

/** A sideways drag past ~100 px skips; less springs back. Only from the card itself, never a button on it. */
function useSwipe(it: P.CalItem, on: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    let x0: number | null = null;
    let y0 = 0;
    let dx = 0;
    let id = -1;
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button, summary, a, details[open] > :not(summary)')) return;
      x0 = e.clientX;
      y0 = e.clientY;
      dx = 0;
      id = e.pointerId;
      el.style.transition = 'none';
    };
    const move = (e: PointerEvent) => {
      if (x0 === null || e.pointerId !== id) return;
      dx = e.clientX - x0;
      if (Math.abs(e.clientY - y0) > Math.abs(dx) + 8 && Math.abs(dx) < 10) return void end();
      if (Math.abs(dx) > 6) {
        if (!el.hasPointerCapture(id)) el.setPointerCapture(id);
        el.style.transform = `translateX(${dx}px)`;
        el.style.opacity = String(1 - Math.min(Math.abs(dx) / 300, 0.6));
      }
    };
    const end = () => {
      if (x0 === null) return;
      x0 = null;
      el.style.transition = '';
      if (Math.abs(dx) > 100) {
        el.style.transform = `translateX(${dx < 0 ? -110 : 110}%)`;
        el.style.opacity = '0';
        el.dataset.swiped = '1';
        setTimeout(() => skip(it), 180);
      } else {
        el.style.transform = '';
        el.style.opacity = '';
      }
      dx = 0;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
  }, [it, on]);
  return ref;
}

// ------------------------------------------------------------------ one row

const Row = memo(function Row({ it, sel, done }: { it: P.CalItem; sel: boolean; done: boolean }) {
  const ref = useSwipe(it, phone.value);
  const mx = Math.max(...it.p, 0.01);
  return (
    <div
      ref={ref}
      class={`cal-row${sel ? ' cal-sel' : ''}${it.kind === 'card' ? ' cal-asks' : ''}${done ? ' cal-done' : ''}`}
      data-cal-id={it.id}
      data-kind={it.kind}
      role="button"
      tabIndex={0}
      data-track={`calibration row ${it.kind}`}
      onClick={(e) => {
        if ((e.currentTarget as HTMLElement).dataset.swiped) return;
        pick(it);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          pick(it);
        }
      }}
    >
      <Pic it={it} size={22} />
      <span class="cal-row-main">
        <span class="cal-row-who">{it.who}</span>
        <span class="cal-row-text">
          {it.kind === 'past' ? '↺ ' : ''}
          {it.text}
        </span>
      </span>
      <span class="cal-mini" aria-label={`It gave ${CAL_ANSWERS.map((a, i) => `${CAL_ANSWER_NAME[a]} ${Math.round(it.p[i] * 100)}%`).join(', ')}`}>
        {it.p.map((v, i) => (
          <i class={`${CAL_ANSWERS[i] === it.you ? 'cal-y' : ''}${CAL_ANSWERS[i] !== it.did ? ' cal-f' : ''}`} style={{ height: `${Math.max(2, (v / mx) * 18)}px` }} />
        ))}
      </span>
      {phone.value && (
        <button
          class="cal-x"
          aria-label="Skip"
          data-track="calibration skip"
          onClick={(e) => {
            e.stopPropagation();
            skip(it);
          }}
        >
          ×
        </button>
      )}
    </div>
  );
});

// ------------------------------------------------------------------ one card

function Pic({ it, size }: { it: P.CalItem; size: number }) {
  const net = asNet(it.network);
  return (
    <span class="cal-ico" style={{ width: `${size}px`, height: `${size}px` }}>
      {it.icon ? (
        <img src={it.icon} alt="" width={size} height={size} loading="lazy" />
      ) : (
        <span class="cal-ico-letters" style={{ background: hueOf(it.conversationId ?? it.messageId), fontSize: `${Math.round(size * 0.4)}px` }}>
          {size < 20 ? initials(it.who).slice(0, 1) : initials(it.who)}
        </span>
      )}
      {net && size >= 20 && <NetBadge network={net} size={11} class="cal-ico-net" />}
    </span>
  );
}

const H = 32;

/** One answer's bar: the chance as a fill, how unsure as a whisker, the chance before as a dashed line. */
function Bar({ p, u, old }: { p: number; u: number; old?: number }) {
  const lo = Math.max(0, p - u) * H;
  const hi = Math.min(1, p + u) * H;
  return (
    <span class="cal-bar" aria-hidden="true">
      <span class="cal-u" style={{ bottom: `${lo}px`, height: `${Math.max(3, hi - lo)}px` }} />
      <span class="cal-p" style={{ height: `${Math.max(1.5, p * H)}px` }} />
      {old !== undefined && <span class="cal-old" style={{ bottom: `${old * H}px` }} />}
    </span>
  );
}

/** The three answers with their bars. Before an answer: the model's guess. After: its guess now, over the old one. */
function Acts({ it, st, past }: { it: P.CalItem; st: Local; past: boolean }) {
  const mine = past ? it.answer : st.answer;
  const after = past ? it.after : st.after;
  const before = past ? it.p : (st.before ?? it.p);
  const shown = after ?? before;
  return (
    <div class={`cal-acts${after ? ' cal-answered' : ''}`} role="group" aria-label="Sound, Show or Inbox">
      {CAL_ANSWERS.map((a, i) => {
        const inner = (
          <>
            <span class="cal-lab">{CAL_ANSWER_NAME[a]}</span>
            <Bar p={shown[i]} u={it.u[i]} old={after ? before[i] : undefined} />
            {it.you === a && <span class="cal-you">▲</span>}
          </>
        );
        const cls = `cal-act${it.did === a ? ' cal-did' : ''}${mine === a ? ' cal-chosen' : ''}`;
        const title = `${CAL_ANSWER_NAME[a]}: it gave ${Math.round(before[i] * 100)}%${after ? `, now ${Math.round(after[i] * 100)}%` : ''}${it.did === a ? '; what it did' : ''}${it.you === a ? '; what you did' : ''}`;
        return past ? (
          <span class={cls} title={title} data-answer={a}>
            {inner}
          </span>
        ) : (
          <button class={cls} title={title} data-answer={a} data-track={`calibration answer ${a}`} onClick={() => void answerIt(it, a)}>
            {inner}
          </button>
        );
      })}
    </div>
  );
}

function Notice({ it, st, past }: { it: P.CalItem; st: Local; past: boolean }) {
  const when = stamp(it.at);
  const acts = <Acts it={it} st={st} past={past} />;
  if (it.look === 'row') {
    return (
      <div class="cal-n cal-n-row" data-look="row">
        <Pic it={it} size={28} />
        <span class="cal-n-main">
          <b>{it.who}</b>
          <span>{it.text}</span>
        </span>
        <span class="cal-n-when">{when}</span>
        <div class="cal-n-acts">{acts}</div>
      </div>
    );
  }
  return (
    <div class={`cal-n ${it.look === 'toast' ? 'cal-n-toast' : 'cal-n-shade'}`} data-look={it.look}>
      <div class="cal-n-head">
        <Pic it={it} size={16} />
        <span>
          dither · {netName(it.network)} · {when}
          {it.held ? ' · a sound held back' : ''}
        </span>
      </div>
      <div class="cal-n-t">{it.who}</div>
      <div class="cal-n-b">{it.text}</div>
      {acts}
    </div>
  );
}

const sign = (n: number) => (n > 0 ? `+${Math.round(n)}` : n < 0 ? `−${Math.round(-n)}` : '0');

const Card = memo(function Card({ it, st, desk }: { it: P.CalItem; st: Local; desk: boolean }) {
  const ref = useSwipe(it, !desk);
  const past = it.kind === 'past';
  return (
    <article ref={ref} class={`cal-card${past ? ' cal-past' : ''}${desk ? ' cal-card-desk' : ''}`} data-cal-id={it.id} data-kind={it.kind} aria-label={`${it.who}: ${it.text}`}>
      <button class="cal-x" aria-label="Skip" data-track="calibration skip" onClick={() => skip(it)}>
        ×
      </button>
      {past && <div class="cal-past-say">You said {CAL_ANSWER_NAME[it.answer ?? 'show']}; it had given that {Math.round(it.p[idx(it.answer ?? 'show')] * 100)}%. Its guess now:</div>}
      <Notice it={it} st={st} past={past} />
      {past ? (
        <div class="cal-keep">
          <button class="cal-btn" data-settle="keep" data-track="calibration keep" onClick={() => void settle(it, 'keep')}>
            Keep
          </button>
          <button class="cal-btn" data-settle="once" data-track="calibration only once" onClick={() => void settle(it, 'once')}>
            Only that once
          </button>
          <button class="cal-btn" data-settle="undo" data-track="calibration undo answer" onClick={() => void settle(it, 'undo')}>
            Undo
          </button>
        </div>
      ) : (
        st.answer && (
          <details class="cal-drill" open={st.drill} onToggle={(e) => setDrill(it, (e.currentTarget as HTMLDetailsElement).open)}>
            <summary data-track="calibration wrong about">What was it wrong about?</summary>
            <div class="cal-parts">
              {it.parts.map((x) => (
                <button class={`cal-part${st.parts.includes(x.part) ? ' cal-on' : ''}`} data-part={x.part} aria-pressed={st.parts.includes(x.part)} data-track={`calibration part ${x.part}`} onClick={() => void togglePart(it, x.part)}>
                  {CAL_PART_NAME[x.part]}
                  <small>{x.label}</small>
                  <span class="cal-push" title={x.push > 0 ? 'Pushed it louder' : x.push < 0 ? 'Pushed it quieter' : 'Did not move it'}>
                    <i style={{ left: `${x.push < 0 ? 50 + x.push * 50 : 50}%`, right: `${x.push > 0 ? 50 - x.push * 50 : 50}%` }} />
                  </span>
                </button>
              ))}
            </div>
          </details>
        )
      )}
      <details class="cal-det">
        <summary data-track="calibration details">{it.youWhat}</summary>
        <div class="cal-det-body">
          <div class="cal-ctx">{it.context}</div>
          {it.reasons.map((r) => (
            <div class="cal-contrib">
              <span>{r.text}</span>
              <span>{sign(r.by)}</span>
            </div>
          ))}
          {it.conversationId && (
            <button class="link-btn" data-track="calibration open chat" onClick={() => go({ view: 'inbox', conv: it.conversationId!, msg: it.messageId })}>
              Open the chat
            </button>
          )}
        </div>
      </details>
    </article>
  );
});
