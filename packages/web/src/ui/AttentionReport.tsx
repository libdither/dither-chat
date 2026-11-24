/**
 * Your attention (docs/scorecard.md, "The weekly report"): what notifications cost over the last two weeks, and the
 * people side. Sounds each day as bars (hover, a tap or the arrow keys show a day), the people waiting on a reply
 * from you, how long they wait, how many people you talk with, at most one person you are drifting from, and the
 * looks that found nothing. Counts as they are: there is no budget to hold them to. A chunk of its own, loaded when the
 * page opens (HowItSorts.tsx AttentionPaneLazy), from Settings → Notifications and How it sorts.
 */
import type { AttentionReport, Pair } from '@dither-chat/protocol/scorecard';
import { formatScore } from '@dither-chat/protocol/scorecard';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { ago, fullTime } from '../format.ts';
import { convTitle, identityName } from '../model.ts';
import { api, db, go, rev } from '../state.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import { HeadOrb } from './Offline.tsx';
import './attention.css';

const H = 150;
const PAD = { top: 10, right: 6, bottom: 22, left: 28 };
const WEEK = 7 * 86_400_000;

const dayLabel = (d: string, long = false) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(long ? { weekday: 'short' } : {}) });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (v: number | null, digits = 1) => (v === null ? '–' : Number.isInteger(v) ? String(v) : v.toFixed(digits));
const hours = (v: number | null) => formatScore('hours', v);
const pct = (v: number | null) => formatScore('share', v);

/** A value with last week's beside it, faint. */
function Was({ p, fmt }: { p: Pair; fmt: (v: number | null) => string }) {
  return (
    <>
      <b>{fmt(p.recent)}</b>
      {p.before !== null && <span class="at-was"> (last week {fmt(p.before)})</span>}
    </>
  );
}

/** Container width, followed as it changes. */
function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}

/** Sounds each day, as bars: hover, a tap or the arrow keys show the day's count and its sounds an hour at a computer. */
function SoundBars({ r }: { r: AttentionReport }) {
  const [ref, width] = useWidth();
  const [sel, setSel] = useState<number | null>(null);
  const n = r.days.length;
  const vals = r.sounds.map((v) => v ?? 0);
  const top = Math.max(4, ...vals);
  const step = Math.max(1, Math.ceil(top / 4));
  const hi = step * Math.ceil(top / step);
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const slot = plotW / Math.max(1, n);
  const barW = Math.max(4, Math.min(34, slot * 0.68));
  const x = (i: number) => PAD.left + slot * i + slot / 2;
  const y = (v: number) => PAD.top + (1 - v / hi) * (H - PAD.top - PAD.bottom);
  const pick = (clientX: number, el: Element) => {
    const px = clientX - el.getBoundingClientRect().left;
    setSel(Math.max(0, Math.min(n - 1, Math.floor((px - PAD.left) / slot))));
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const d = e.key === 'ArrowLeft' ? -1 : 1;
    setSel((s) => Math.max(0, Math.min(n - 1, s === null ? n - 1 : s + d)));
  };
  const ticks: number[] = [];
  for (let t = 0; t <= hi; t += step) ticks.push(t);
  const tipLeft = sel === null ? 0 : Math.max(0, Math.min(width - 180, x(sel) - 90));
  const label = `Sounds each day, last ${plural(n, 'day')}: ${r.days.map((d, i) => `${dayLabel(d)} ${r.sounds[i] ?? 'not scored'}`).join(', ')}`;
  return (
    <div class="at-plot" ref={ref} data-chart="sounds">
      {width > 0 && (
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={label}
          tabIndex={0}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setSel(null)}
          onKeyDown={key}
          onBlur={() => setSel(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line class="at-grid" x1={PAD.left} x2={width - PAD.right} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} />
              <text class="at-tick" x={PAD.left - 6} y={y(t) + 3.5} text-anchor="end">
                {t}
              </text>
            </g>
          ))}
          {r.days.map((d, i) => {
            const v = r.sounds[i];
            const h = v === null ? 0 : Math.max(v > 0 ? 2 : 0, y(0) - y(v));
            return (
              <g key={d} class={`at-bar ${sel === i ? 'on' : ''} ${v === null ? 'none' : ''}`}>
                {v !== null && <rect x={x(i) - barW / 2} y={y(0) - h} width={barW} height={h} rx={Math.min(4, barW / 4)} />}
                {(i === 0 || i === n - 1 || (n > 8 && i === Math.floor((n - 1) / 2))) && (
                  <text class="at-tick" x={x(i)} y={H - 6} text-anchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
                    {dayLabel(d)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {sel !== null && (
        <div class="at-tip" style={{ left: `${tipLeft}px` }} role="status">
          <span class="at-tip-when">{dayLabel(r.days[sel], true)}</span>
          <span>{r.sounds[sel] === null ? 'Not scored' : <b>{plural(r.sounds[sel]!, 'sound')}</b>}</span>
          {r.soundsComputerHour[sel] !== null && <span class="at-tip-sub">{num(r.soundsComputerHour[sel], 2)} an hour while at a computer</span>}
        </div>
      )}
    </div>
  );
}

/** Someone waiting on a reply from you: their chat's picture and name, and since when. */
function Waiting({ w }: { w: AttentionReport['waiting'][number] }) {
  const c = db.conversations.get(w.conversationId);
  if (!c) return null;
  const person = c.peerPersonId ? db.persons.get(c.peerPersonId) : undefined;
  const name = convTitle(c);
  return (
    <button class="at-row" data-track="your attention: open a chat waiting on you" title={`Waiting since ${fullTime(w.since)}`} onClick={() => go({ view: 'inbox', conv: c.id })}>
      <Avatar id={c.peerPersonId ?? c.id} name={name} url={person?.avatar ?? c.avatar} size={30} square={c.shape !== 'direct'} network={c.network} accountIds={c.vantages.map((v) => v.accountId)} />
      <span class="at-row-name">{name}</span>
      <span class="at-row-age">{ago(w.since)}</span>
      <Icon name="chevronRight" size={14} />
    </button>
  );
}

/** The one person you are drifting from this week, if any: their name, how long since you talked, their chat. */
function Drifting({ d }: { d: NonNullable<AttentionReport['drifting']> }) {
  const person = d.personId ? db.persons.get(d.personId) : undefined;
  const ident = db.identities.get(d.identityId);
  const name = person?.name ?? identityName(d.identityId);
  const weeks = Math.floor((Date.now() - d.lastAt) / WEEK);
  return (
    <div class="at-drift" data-drifting>
      <Avatar id={d.personId ?? d.identityId} name={name} url={person?.avatar ?? ident?.avatar} size={30} />
      <span class="at-drift-text">
        <b>{name}</b>
        <small>
          Last talk {weeks >= 2 ? `${weeks} weeks ago` : ago(d.lastAt)}; you wrote in {d.weeks} of the 12 weeks before
        </small>
      </span>
      {d.conversationId && (
        <button class="btn ghost small" data-track="your attention: open the drifting chat" onClick={() => go({ view: 'inbox', conv: d.conversationId! })}>
          Open chat
        </button>
      )}
    </div>
  );
}

export function AttentionPane({ onBack }: { onBack?: () => void }) {
  rev.value;
  const [r, setR] = useState<AttentionReport | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<AttentionReport>('/api/attention/report').then(setR, () => setFailed(true));
  }, []);
  return (
    <section class="pane board attention-page" aria-label="Your attention" data-track-area="your attention">
      <header class="conv-head">
        {onBack && (
          <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
            <Icon name="back" />
          </button>
        )}
        <span class="conv-head-icon model-icon">
          <Icon name="activity" size={18} />
        </span>
        <div class="conv-head-text">
          <h2>Your attention</h2>
          <div class="conv-head-sub">
            <span class="muted-label">Sounds, replies and people, over two weeks</span>
          </div>
        </div>
        <HeadOrb />
      </header>
      <div class="board-scroll">
        {failed && <p class="muted">Could not load the report. Check the connection to the hub, then try again.</p>}
        {!r && !failed && <p class="muted">Loading…</p>}
        {r && <Report r={r} />}
      </div>
    </section>
  );
}

function Report({ r }: { r: AttentionReport }) {
  const w = r.week;
  const others = r.waitingTotal - r.waiting.length;
  return (
    <>
      <p class="model-intro">
        How often something interrupted you, and how the people who write to you are doing. Each day is counted a day after it ends; beside each number, the week before it.
        {r.pending ? ` ${dayLabel(r.pending, true)} is still being counted.` : ''}
      </p>
      <div class="at-tiles">
        <div class="at-tile" data-tile="sounds">
          <span class="at-tile-label">Sounds a day</span>
          <span class="at-tile-value">{num(w.sounds.recent)}</span>
          <span class="at-tile-sub">{w.sounds.before !== null ? `last week ${num(w.sounds.before)}` : 'the last 7 days'}</span>
        </div>
        <div class="at-tile" data-tile="wait">
          <span class="at-tile-label">Median wait for your reply</span>
          <span class="at-tile-value">{hours(w.wait.recent)}</span>
          <span class="at-tile-sub">{w.wait.before !== null ? `last week ${hours(w.wait.before)}` : 'the last 7 days'}</span>
        </div>
        <div class="at-tile" data-tile="checks">
          <span class="at-tile-label">Opened with nothing new</span>
          <span class="at-tile-value">{num(w.checks.recent)}</span>
          <span class="at-tile-sub">{w.checks.before !== null ? `last week ${num(w.checks.before)}` : 'times in 7 days'}</span>
        </div>
      </div>

      <div class="board-block" data-block="sounds">
        <h3>
          <Icon name="bell" size={15} /> Sounds each day
        </h3>
        <p class="muted">Notifications that sounded on a device: an alert that starts a burst, a call ringing, the summary after quiet hours. Updates to a row already showing are silent.</p>
        {r.days.length === 0 ? <p class="muted">Nothing counted yet: a day is counted a day after it ends.</p> : <SoundBars r={r} />}
        <p class="at-line" data-line="stale">
          Sent while you were reading that chat on a computer: <Was p={w.stale} fmt={pct} />
        </p>
      </div>

      <div class="board-block" data-block="waiting">
        <h3>
          <Icon name="reply" size={15} /> People waiting on you
        </h3>
        {r.waiting.length === 0 ? (
          <p class="muted">Nobody: you have answered everyone who wrote to you in the last 30 days.</p>
        ) : (
          <div class="at-rows">
            {r.waiting.map((x) => (
              <Waiting key={x.conversationId} w={x} />
            ))}
            {others > 0 && <p class="at-more">and {plural(others, 'more chat')}</p>}
          </div>
        )}
        <p class="at-line" data-line="wait">
          Median wait for a reply from you: <Was p={w.wait} fmt={hours} />
          {w.waitP90.recent !== null && <span class="at-was">; 9 in 10 within {hours(w.waitP90.recent)}</span>}
        </p>
        <p class="at-line" data-line="owed">
          Waiting more than 3 days: <Was p={w.owed3d} fmt={(v) => num(v)} />
        </p>
      </div>

      <div class="board-block" data-block="people">
        <h3>
          <Icon name="users" size={15} /> Who you talk with
        </h3>
        <p class="at-line" data-line="breadth">
          People you wrote to in 30 days: <b>{num(w.breadth.recent)}</b>
          {w.breadth.before !== null && <span class="at-was"> (the 30 days before: {num(w.breadth.before)})</span>}
        </p>
        {r.drifting ? <Drifting d={r.drifting} /> : <p class="at-line at-was">No one you used to talk with every few weeks has gone quiet.</p>}
        <p class="at-line" data-line="checks">
          Opened the app with nothing new: <Was p={w.checks} fmt={(v) => (v === null ? '–' : plural(v, 'time'))} />
        </p>
        <p class="at-line" data-line="stale-shown">
          Notifications you tapped or swiped after reading their chat on a computer: <Was p={w.staleShown} fmt={(v) => num(v)} />
        </p>
      </div>
      <p class="at-line at-foot">
        <button class="link-btn" data-track="your attention: how it sorts" onClick={() => go({ view: 'model' })}>
          Day by day, with the rest of the scorecard, on How it sorts
        </button>
      </p>
    </>
  );
}
