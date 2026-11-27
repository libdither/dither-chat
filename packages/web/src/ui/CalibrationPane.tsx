/**
 * Notification calibration (docs/notifications.md, "The calibration feed"): the one or two notifications a day most
 * worth asking about, each as it looked, with three answers, Sound, Show and Inbox. Under each answer a bar: its fill is
 * the chance the model gave it, the whisker how unsure it was, ▲ what you did, and the underlined answer what was done.
 * Each card carries a small picture of what the mistake may have cost (a sound missed, a sound not wanted, a silent
 * mix-up; the longer, the dearer). Answering draws the chances again, after the answer, over a dashed line at the old
 * one; "What was it wrong about?" routes the answer to parts of it (the person, the chat, the topic, how long it could
 * wait, the moment, the delivery). A past answer that surprised the model comes back once (Keep, Only that once, Undo).
 * Until the model has learned from enough answers and marks given in place, there is nothing to ask, and it says how far
 * along it is.
 *
 * One column of cards, on a phone and a computer. × or a swipe skips (Undo on the toast). On a computer: 1–3 answer
 * the chosen card, x skips it, j and k move, w opens what it was wrong about.
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
/** The card the keys act on (computer). */
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

const setDrill = (it: P.CalItem, open: boolean) => stOf(it.id).drill !== open && setSt(it.id, (s) => ({ ...s, drill: open }));

/** The cards on the page, in their order: most worth asking first. */
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
  const ask = items.filter((i) => !stOf(i.id).answer).length;
  const onPhone = phone.value;
  const cur = onPhone ? null : (items.find((i) => i.id === chosen.value) ?? items[0] ?? null);

  // 1–3 answer, x skips, j and k move, w opens what it was wrong about; never while typing or under a menu.
  useLayoutEffect(() => {
    if (onPhone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select, [contenteditable], .cm, .sheet-layer, .modal-backdrop, .switcher-back')) return;
      if (document.querySelector('.cm, .sheet-layer, .modal-backdrop, .switcher-back, .viewer')) return;
      const all = shownItems(calFeed.value);
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
        requestAnimationFrame(() => document.querySelector(`.cal-scroll [data-cal-id="${CSS.escape(to.id)}"]`)?.scrollIntoView({ block: 'nearest' }));
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
      ) : !items.length ? (
        <div class="requests-scroll cal-scroll">
          <Waiting fitted={v.fitted} />
          <How />
        </div>
      ) : (
        <div class={`requests-scroll cal-scroll${onPhone ? ' cal-phone' : ' cal-wide'}`}>
          <Legend />
          {items.map((it) => (
            <Card key={it.id} it={it} st={local.value.get(it.id) ?? NONE} desk={!onPhone} sel={it.id === cur?.id} />
          ))}
          {!onPhone && (
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
          )}
          <How />
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
        <u>Show</u> what was done
      </span>
      <span>- - - its guess before</span>
    </div>
  );
}

/** Nothing to ask: still learning from what you say in place, or nothing that cost you anything lately. */
function Waiting({ fitted }: { fitted: P.CalFeedView['fitted'] }) {
  const learning = fitted.signals < fitted.need;
  return (
    <Empty icon="bell" title={learning ? 'Learning from your marks first' : 'Nothing to ask'}>
      {learning ? (
        <>
          It asks here once it has learned from {fitted.need} answers and marks given where you saw a message: Louder, Quieter, Less like this, Should have alerted, a notification's buttons.
          <span class="cal-fit" role="img" aria-label={`${fitted.signals} of ${fitted.need}`}>
            <i style={{ width: `${Math.round((100 * Math.min(fitted.signals, fitted.need)) / fitted.need)}%` }} />
          </span>
        </>
      ) : (
        <>At most two a day, and only a notification that likely cost you something: a sound you needed and did not get, or one you did not want.</>
      )}
    </Empty>
  );
}

function How() {
  return (
    <details class="cal-how">
      <summary data-track="calibration how">How it picks what to ask</summary>
      <p>Only notifications that reached a device, and sounds it held back. What you did: a tap (within 10 minutes Sound, later Show), a reply within 5 minutes (Sound), a swipe (Inbox), or your answer or mark. Opening the chat later does not count.</p>
      <div class="cal-formula">
        regret = cost(what it said, what you did) × (1 − its chance of what you did)
        <br />
        worth asking = regret, halving every day
      </div>
      <p>A missed sound costs 1, an unwanted one 0.5–0.6, a silent mix-up 0.1–0.15.</p>
      <p>Nothing until it has learned from 20 of your answers and marks; then at most two a day over 0.3. A surprising answer comes back once.</p>
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

/** What the mistake may have cost, as a picture: a bell struck through (a sound missed), a ringing bell (a sound not wanted), a quiet row (a silent mix-up); the bar, how dear. */
function Cost({ it }: { it: P.CalItem }) {
  if (!it.cost) return null;
  const w = Math.round(Math.max(0.06, Math.min(1, it.regret)) * 100);
  const say = { missed: 'A sound you needed', unwanted: 'A sound you did not want', mixup: 'A silent mix-up' }[it.cost];
  return (
    <span class={`cal-cost cal-cost-${it.cost}`} role="img" aria-label={`${say}: cost ${Math.round(it.regret * 100)} of 100`} data-cost={it.cost}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        {it.cost === 'mixup' ? (
          <rect x="2" y="5" width="12" height="6" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
        ) : (
          <>
            <path d="M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1.2 1.2H3.3z" fill="currentColor" />
            <circle cx="8" cy="13.6" r="1.2" fill="currentColor" />
            {it.cost === 'missed' ? <path d="M2 2l12 12" stroke="var(--bg-raised)" stroke-width="3" /> : <path d="M2.2 5.5a6 6 0 0 1 1.6-3M13.8 5.5a6 6 0 0 0-1.6-3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />}
            {it.cost === 'missed' && <path d="M2 2l12 12" stroke="currentColor" stroke-width="1.5" />}
          </>
        )}
      </svg>
      <span class="cal-cost-bar">
        <i style={{ width: `${w}%` }} />
      </span>
    </span>
  );
}

const Card = memo(function Card({ it, st, desk, sel }: { it: P.CalItem; st: Local; desk: boolean; sel?: boolean }) {
  const ref = useSwipe(it, !desk);
  const past = it.kind === 'past';
  return (
    <article
      ref={ref}
      class={`cal-card${past ? ' cal-past' : ''}${desk ? ' cal-card-desk' : ''}${desk && sel ? ' cal-sel' : ''}`}
      data-cal-id={it.id}
      data-kind={it.kind}
      aria-label={`${it.who}: ${it.text}`}
      data-track={desk ? 'calibration choose card' : undefined}
      onClick={desk ? () => chosen.value !== it.id && (chosen.value = it.id) : undefined}
    >
      <button class="cal-x" aria-label="Skip" data-track="calibration skip" onClick={(e) => (e.stopPropagation(), skip(it))}>
        ×
      </button>
      <Cost it={it} />
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
