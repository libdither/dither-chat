/**
 * When someone is around, on their profile (docs/profile.md "Activity"): their messages over 7, 30 or 90 days as bars,
 * yours mirrored under the axis, their presence as a band below and status changes as marks above (only while those
 * are logged, an adversarial feature), then a weekday-by-hour grid. Inline SVG; hover, a tap or the arrow keys show
 * the numbers, and a table lists them by day.
 */
import type * as P from '@dither-chat/protocol';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { activitySummary, barHours, dayDate, dayTicks, duration, group, heatLevel, hourLabel, RANGES, shareLevel, spanLabel, sumHours } from '../activitychart.ts';
import { netName } from '../model.ts';
import { api } from '../state.ts';
import { openAdversarial } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';

const DAYS_KEY = 'dither.activityDays';
const STATES: P.PresenceState[] = ['online', 'idle', 'dnd', 'offline'];
const STATE_LABEL: Record<P.PresenceState, string> = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline' };
/** The band's height per state, so the states differ by shape as well as colour. */
const BAND_H: Record<P.PresenceState, number> = { online: 10, dnd: 10, idle: 6, offline: 2 };
const WHERE_LABEL: Record<P.ActivityWhere, [string, string]> = { dm: ['DM', 'DMs'], group: ['group', 'groups'], server: ['server', 'servers'] };
/** Heat steps: the hue's share over the card. */
const HEAT = [0, 24, 42, 60, 80, 100];

function savedDays(): number {
  try {
    const d = Number(localStorage.getItem(DAYS_KEY));
    return (RANGES as readonly number[]).includes(d) ? d : 30;
  } catch {
    return 30;
  }
}

/** The page's own zone, so hours are the owner's. */
function zoneQuery(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return `tz=${encodeURIComponent(tz)}`;
  } catch {}
  return `offset=${-new Date().getTimezoneOffset()}`;
}

const dayShort = (firstDay: string, d: number) => dayDate(firstDay, d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const dayLong = (firstDay: string, d: number) => dayDate(firstDay, d).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const weekdayTick = (firstDay: string, d: number) => `${dayDate(firstDay, d).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' })} ${dayDate(firstDay, d).getUTCDate()}`;
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

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

/** A bar with a rounded end away from the baseline: up from y, or down from it. */
function bar(x: number, y: number, w: number, h: number, up: boolean): string {
  const r = Math.min(3, w / 2, h);
  const e = up ? y - h : y + h;
  const s = up ? 1 : -1;
  return `M${x},${y}V${e + s * r}Q${x},${e} ${x + r},${e}H${x + w - r}Q${x + w},${e} ${x + w},${e + s * r}V${y}Z`;
}

/** A floating box of numbers over a chart, kept inside it. */
function Tip({ x, y, width, children }: { x: number; y: number; width: number; children: ComponentChildren }) {
  const left = Math.max(4, Math.min(width - 204, x - 100));
  return (
    <div class="act-tip" style={{ left: `${left}px`, top: `${y}px` }} role="status">
      {children}
    </div>
  );
}

export function ActivityChart({ path, self, statusesKept, presenceKept }: { path: string; self: boolean; statusesKept: boolean; presenceKept: boolean }) {
  const [days, setDays] = useState(savedDays);
  const [v, setV] = useState<P.ActivityChartView | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const shown = useRef(path);
  useEffect(() => {
    let live = true;
    // Another person: start afresh; another range: keep the last one, dimmed, until the new one comes.
    if (shown.current !== path) setV(null);
    shown.current = path;
    setLoading(true);
    api<P.ActivityChartView>(`${path}?days=${days}&${zoneQuery()}`)
      .then(
        (x) => live && (setV(x), setFailed(false)),
        () => live && setFailed(true),
      )
      .finally(() => live && setLoading(false));
    return () => void (live = false);
  }, [path, days, statusesKept, presenceKept]);
  const pick = (d: number) => {
    setDays(d);
    try {
      localStorage.setItem(DAYS_KEY, String(d));
    } catch {}
  };

  return (
    <div class={`act ${loading && v ? 'act-loading' : ''}`}>
      <div class="act-head">
        <div class="seg act-range" role="radiogroup" aria-label="Range">
          {RANGES.map((d) => (
            <button role="radio" aria-checked={days === d} class={`chip-btn ${days === d ? 'on' : ''}`} onClick={() => pick(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      {!v ? (
        failed ? <p class="pf-empty">Could not load their activity.</p> : <Loading />
      ) : (
        <>
          <p class="act-summary">{activitySummary(v, self)}</p>
          <Timeline v={v} self={self} />
          {(!v.presence || !v.statuses) && (
            <p class="act-gate" role="note">
              <Icon name="eyeOff" size={13} />
              <span>
                {!v.presence && !v.statuses
                  ? 'Their presence, as a band under the bars, and their status changes, as marks above them, appear once presence and statuses are turned on in '
                  : !v.presence
                    ? 'Their presence, as a band under the bars, appears once presence is turned on in '
                    : 'Their status changes, as marks above the bars, appear once statuses are turned on in '}
                <button class="link-btn" onClick={openAdversarial}>
                  Settings → Adversarial features
                </button>
                .
              </span>
            </p>
          )}
          <WeekGrid v={v} self={self} />
          <DayTable v={v} self={self} />
        </>
      )}
    </div>
  );
}

function Legend({ v, self }: { v: P.ActivityChartView; self: boolean }) {
  return (
    <div class="act-legend">
      <span>
        <i class="act-key them" />
        {self ? 'You' : 'Them'}
      </span>
      {v.mine && (
        <span>
          <i class="act-key you" />
          You, where they are
        </span>
      )}
      {v.presence &&
        STATES.map((s) => (
          <span>
            <i class={`act-key band ${s}`} />
            {STATE_LABEL[s]}
          </span>
        ))}
      {v.statuses && (
        <span>
          <i class="act-key mark" />
          Status change
        </span>
      )}
    </div>
  );
}

function Timeline({ v, self }: { v: P.ActivityChartView; self: boolean }) {
  const [ref, width] = useWidth();
  const [sel, setSel] = useState<{ bar: number } | { mark: number } | null>(null);
  const g = useMemo(() => {
    const hours = v.days * 24;
    const step = barHours(v.days, Math.max(1, width));
    const theirs = group(sumHours(v.sent, hours), step);
    const mine = v.mine ? group(sumHours(v.mine, hours), step) : null;
    const max = Math.max(1, ...theirs, ...(mine ?? []));
    const MARKS = v.statuses ? 16 : 4;
    const TOP = 72;
    const myMax = mine ? Math.max(0, ...mine) : 0;
    const BOTTOM = myMax ? Math.max(6, Math.round((TOP * myMax) / max)) : 0;
    const BAND = v.presence ? 18 : 0;
    const base = MARKS + TOP;
    const bandY = base + BOTTOM + 4 + 7;
    const height = base + BOTTOM + BAND + 18;
    const presence = new Map((v.presence?.hours ?? []).map((h) => [h[0], h]));
    return { hours, step, theirs, mine, max, MARKS, TOP, BOTTOM, base, bandY, height, presence, n: theirs.length };
  }, [v, width]);
  const slot = width / g.n;
  const gap = slot >= 8 ? 2 : slot >= 4 ? 1 : 0;
  const pxh = width / g.hours;
  const unit = g.step === 24 ? 'day' : g.step === 1 ? 'hour' : `${g.step} hours`;
  const ticks = width ? dayTicks(v.days, width) : [];

  const barAt = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    return Math.max(0, Math.min(g.n - 1, Math.floor((e.clientX - r.left) / slot)));
  };
  const key = (e: KeyboardEvent) => {
    const cur = sel && 'bar' in sel ? sel.bar : Math.floor(v.nowHour / g.step);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setSel({ bar: Math.max(0, Math.min(g.n - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1))) });
    } else if (e.key === 'Escape') setSel(null);
  };

  return (
    <div class="act-timeline" ref={ref}>
      <Legend v={v} self={self} />
      <div class="act-ymax">
        Top line: {g.max} per {unit}
      </div>
      {width > 0 && (
        <div class="act-plot">
          <svg
            width={width}
            height={g.height}
            viewBox={`0 0 ${width} ${g.height}`}
            tabIndex={0}
            role="img"
            aria-label={`Messages per ${unit}. ${activitySummary(v, self)}`}
            onPointerMove={(e) => e.pointerType !== 'touch' && !(e.target as Element).closest('.act-mark-hit') && setSel({ bar: barAt(e) })}
            onPointerDown={(e) => !(e.target as Element).closest('.act-mark-hit') && setSel({ bar: barAt(e) })}
            onPointerLeave={(e) => e.pointerType !== 'touch' && setSel(null)}
            // A tap focuses it too: keep the bar the tap picked.
            onFocus={() => setSel((s) => s ?? { bar: Math.floor(v.nowHour / g.step) })}
            onBlur={() => setSel(null)}
            onKeyDown={key}
          >
            <line class="act-grid" x1={0} x2={width} y1={g.MARKS + 0.5} y2={g.MARKS + 0.5} />
            {sel && 'bar' in sel && <rect class="act-hover" x={sel.bar * slot} y={g.MARKS} width={slot} height={g.TOP + g.BOTTOM + 1} />}
            {g.theirs.map((n, i) => n > 0 && <path class="act-bar them" d={bar(i * slot + gap / 2, g.base, Math.max(1, slot - gap), (n / g.max) * g.TOP, true)} />)}
            {g.mine?.map((n, i) => n > 0 && <path class="act-bar you" d={bar(i * slot + gap / 2, g.base + 1, Math.max(1, slot - gap), (n / g.max) * g.TOP, false)} />)}
            <line class="act-axis" x1={0} x2={width} y1={g.base + 0.5} y2={g.base + 0.5} />
            {v.presence && (
              <g class="act-band">
                <line class="act-track" x1={0} x2={width} y1={g.bandY} y2={g.bandY} />
                {v.presence.stretches.map(([a, b, s]) => (
                  <rect class={`act-pres ${s}`} x={a * pxh} width={Math.max(0.5, (b - a) * pxh)} y={g.bandY - BAND_H[s] / 2} height={BAND_H[s]} />
                ))}
                {/* Do not disturb has a bar through it, as its dot does on Discord. */}
                {v.presence.stretches.map(([a, b, s]) => s === 'dnd' && <rect class="act-notch" x={a * pxh} width={Math.max(0.5, (b - a) * pxh)} y={g.bandY - 1} height={2} />)}
              </g>
            )}
            {v.statuses?.map((s, i) => (
              <g class={`act-mark ${sel && 'mark' in sel && sel.mark === i ? 'on' : ''}`}>
                {sel && 'mark' in sel && sel.mark === i && <line class="act-mark-line" x1={s.hour * pxh} x2={s.hour * pxh} y1={g.MARKS / 2} y2={g.base + g.BOTTOM} />}
                <rect class="act-mark-dot" x={s.hour * pxh - 3.5} y={g.MARKS / 2 - 3.5} width={7} height={7} transform={`rotate(45 ${s.hour * pxh} ${g.MARKS / 2})`} />
                <circle
                  class="act-mark-hit"
                  cx={s.hour * pxh}
                  cy={g.MARKS / 2}
                  r={11}
                  onPointerEnter={(e) => e.pointerType !== 'touch' && setSel({ mark: i })}
                  onPointerDown={(e) => (e.stopPropagation(), setSel({ mark: i }))}
                />
              </g>
            ))}
            {ticks.map((d) => {
              const x = g.step === 24 ? (d + 0.5) * 24 * pxh : d * 24 * pxh + 2;
              const anchor = x < 18 ? 'start' : x > width - 18 ? 'end' : g.step === 24 ? 'middle' : 'start';
              return (
                <text class="act-tick" x={anchor === 'end' ? width : x} y={g.height - 4} text-anchor={anchor}>
                  {v.days <= 7 ? weekdayTick(v.firstDay, d) : dayShort(v.firstDay, d)}
                </text>
              );
            })}
          </svg>
          {sel && 'bar' in sel && (
            <Tip x={(sel.bar + 0.5) * slot} y={g.base + g.BOTTOM + 22} width={width}>
              <BarTip v={v} self={self} bar={sel.bar} step={g.step} presence={g.presence} />
            </Tip>
          )}
          {sel && 'mark' in sel && v.statuses?.[sel.mark] && (
            <Tip x={v.statuses[sel.mark].hour * pxh} y={g.MARKS + 6} width={width}>
              <StatusTip s={v.statuses[sel.mark]} />
            </Tip>
          )}
        </div>
      )}
    </div>
  );
}

function BarTip({ v, self, bar, step, presence }: { v: P.ActivityChartView; self: boolean; bar: number; step: number; presence: Map<number, [number, number, number, number, number]> }) {
  const from = bar * step;
  const to = from + step;
  const sumOf = (s: P.ActivitySeries) => s.hours.slice(from, to).reduce((a, b) => a + b, 0);
  const d = Math.floor(from / 24);
  const when = step === 24 ? dayLong(v.firstDay, d) : `${dayLong(v.firstDay, d)}, ${spanLabel(from % 24, step)}`;
  const theirs = v.sent.map((s) => ({ s, n: sumOf(s) })).filter((x) => x.n);
  const total = theirs.reduce((a, x) => a + x.n, 0);
  const byWhere = new Map<P.ActivityWhere, number>();
  const byNet = new Map<P.Network, number>();
  for (const { s, n } of theirs) {
    byWhere.set(s.where, (byWhere.get(s.where) ?? 0) + n);
    byNet.set(s.network, (byNet.get(s.network) ?? 0) + n);
  }
  const mine = v.mine?.reduce((a, s) => a + sumOf(s), 0);
  const reactions = v.reactions.hours.slice(from, to).reduce((a, b) => a + b, 0);
  const pres = [0, 0, 0, 0];
  for (let h = from; h < to; h++) presence.get(h)?.slice(1).forEach((sec, k) => (pres[k] += sec));
  const marks = (v.statuses ?? []).filter((s) => s.hour >= from && s.hour < to);
  const future = from > v.nowHour;
  return (
    <>
      <div class="act-tip-when">{when}</div>
      {future ? (
        <div class="act-tip-sub">Still to come</div>
      ) : (
        <>
          <div class="act-tip-row">
            <i class="act-key them" />
            <b>{total.toLocaleString('en-US')}</b> from {self ? 'you' : 'them'}
          </div>
          {total > 0 && (
            <div class="act-tip-sub">
              {[...byWhere].map(([w, n]) => `${n} in ${WHERE_LABEL[w][n === 1 ? 0 : 1]}`).join(' · ')}
              {byNet.size > 1 && ` · ${[...byNet].map(([net, n]) => `${netName(net)} ${n}`).join(', ')}`}
            </div>
          )}
          {mine !== undefined && (
            <div class="act-tip-row">
              <i class="act-key you" />
              <b>{mine.toLocaleString('en-US')}</b> from you
            </div>
          )}
          {reactions > 0 && <div class="act-tip-sub">{count(reactions, 'reaction')} on messages from then</div>}
          {v.presence && (
            <div class="act-tip-sub">
              {pres.some((x) => x > 0)
                ? STATES.map((s, k) => (pres[k] >= 60 ? `${STATE_LABEL[s]} ${duration(pres[k])}` : '')).filter(Boolean).join(' · ')
                : 'Presence not known'}
            </div>
          )}
          {marks.map((s) => (
            <div class="act-tip-sub">Status: {statusText(s)}</div>
          ))}
        </>
      )}
    </>
  );
}

const statusText = (s: NonNullable<P.ActivityChartView['statuses']>[number]) => (s.text || s.emoji ? [s.emoji, s.text].filter(Boolean).join(' ') : 'cleared');

function StatusTip({ s }: { s: NonNullable<P.ActivityChartView['statuses']>[number] }) {
  return (
    <>
      <div class="act-tip-when">{new Date(s.at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
      <div class="act-tip-row">
        <i class="act-key mark" />
        <b>{statusText(s)}</b>
      </div>
      <div class="act-tip-sub">Status changed on {netName(s.network)}</div>
    </>
  );
}

type Mode = 'sent' | 'mine' | 'online';
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** When they're around: weekday by hour, their messages, yours, or the share of logged time they were online. */
function WeekGrid({ v, self }: { v: P.ActivityChartView; self: boolean }) {
  const [ref, width] = useWidth();
  const modes: Mode[] = ['sent', ...(v.week.mine ? (['mine'] as const) : []), ...(v.week.known ? (['online'] as const) : [])];
  const [mode, setMode] = useState<Mode>('sent');
  const m: Mode = modes.includes(mode) ? mode : 'sent';
  const [sel, setSel] = useState<number | null>(null);
  const label = width >= 420 ? 30 : 14;
  const cw = (width - label) / 24;
  const ch = Math.max(10, Math.min(18, cw));
  const values = m === 'online' ? null : m === 'mine' ? v.week.mine! : v.week.sent;
  const max = values ? Math.max(0, ...values) : 0;
  const share = (i: number) => (v.week.known?.[i] ? v.week.online![i] / v.week.known[i] : null);
  const level = (i: number) => (values ? heatLevel(values[i], max) : shareLevel(share(i)));
  const height = 7 * ch + 16;
  const at = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const col = Math.floor((e.clientX - r.left - label) / cw);
    const row = Math.floor((e.clientY - r.top) / ch);
    return col >= 0 && col < 24 && row >= 0 && row < 7 ? row * 24 + col : null;
  };
  const tabs: Record<Mode, string> = { sent: self ? 'Your messages' : 'Their messages', mine: 'Yours', online: 'Online' };
  return (
    <div class="act-week" ref={ref}>
      <div class="act-week-head">
        <h4 class="hist-sub">When {self ? 'you’re' : 'they’re'} around</h4>
        {modes.length > 1 && (
          <div class="seg" role="radiogroup" aria-label="Show">
            {modes.map((x) => (
              <button role="radio" aria-checked={m === x} class={`chip-btn small ${m === x ? 'on' : ''}`} onClick={() => setMode(x)}>
                {tabs[x]}
              </button>
            ))}
          </div>
        )}
      </div>
      {width > 0 && (
        <div class="act-plot">
          <svg
            class={`act-heat ${m}`}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${tabs[m]} by weekday and hour, over ${v.days} days`}
            tabIndex={-1}
            onBlur={() => setSel(null)}
            onPointerMove={(e) => e.pointerType !== 'touch' && setSel(at(e))}
            onPointerDown={(e) => setSel(at(e))}
            onPointerLeave={(e) => e.pointerType !== 'touch' && setSel(null)}
          >
            {WEEKDAYS.map((d, row) => (
              <text class="act-tick" x={0} y={row * ch + ch / 2 + 3.5}>
                {label > 20 ? d.slice(0, 3) : d[0]}
              </text>
            ))}
            {Array.from({ length: 168 }, (_, i) => {
              const lv = level(i);
              return <rect class={`act-cell ${lv < 0 ? 'none' : `l${lv}`} ${sel === i ? 'on' : ''}`} x={label + (i % 24) * cw + 1} y={Math.floor(i / 24) * ch + 1} width={Math.max(1, cw - 2)} height={ch - 2} rx={2} />;
            })}
            {[0, 6, 12, 18].map((h) => (
              <text class="act-tick" x={label + h * cw + 1} y={height - 3}>
                {hourLabel(h)}
              </text>
            ))}
          </svg>
          {sel !== null && (
            <Tip x={label + ((sel % 24) + 0.5) * cw} y={(Math.floor(sel / 24) + 1) * ch + 4} width={width}>
              <div class="act-tip-when">
                {WEEKDAYS[Math.floor(sel / 24)]}s, {spanLabel(sel % 24, 1)}
              </div>
              {values ? (
                <div class="act-tip-row">
                  <b>{values[sel].toLocaleString('en-US')}</b> {m === 'mine' ? 'from you' : `from ${self ? 'you' : 'them'}`} in {v.days} days
                </div>
              ) : share(sel) === null ? (
                <div class="act-tip-sub">Presence not logged then</div>
              ) : (
                <div class="act-tip-row">
                  <b>{Math.round(share(sel)! * 100)}%</b> online, of {duration(v.week.known![sel])} logged
                </div>
              )}
            </Tip>
          )}
          <div class="act-scale" aria-hidden="true">
            <span>{m === 'online' ? 'Less' : 'Fewer'}</span>
            {[1, 2, 3, 4, 5].map((lv) => (
              <i class={`act-cell-key l${lv}`} />
            ))}
            <span>More</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The same numbers by day, newest first: the chart's table view. */
function DayTable({ v, self }: { v: P.ActivityChartView; self: boolean }) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => {
    if (!open) return [];
    const hours = v.days * 24;
    const theirs = group(sumHours(v.sent, hours), 24);
    const mine = v.mine ? group(sumHours(v.mine, hours), 24) : null;
    const reacts = group(v.reactions.hours, 24);
    const on = new Array(v.days).fill(0);
    const known = new Array(v.days).fill(0);
    for (const [h, o, i, d, off] of v.presence?.hours ?? []) {
      on[Math.floor(h / 24)] += o + d;
      known[Math.floor(h / 24)] += o + i + d + off;
    }
    const last = Math.floor(v.nowHour / 24);
    return Array.from({ length: last + 1 }, (_, k) => last - k).map((d) => ({ d, theirs: theirs[d], mine: mine?.[d], reacts: reacts[d], online: known[d] ? Math.round((on[d] / known[d]) * 100) : null }));
  }, [v, open]);
  return (
    <details class="act-sub" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <Icon name="chevronRight" size={12} class="act-sub-chevron" />
        Numbers by day
      </summary>
      {open && (
        <div class="act-table-wrap">
          <table class="act-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>{self ? 'You' : 'Them'}</th>
                {v.mine && <th>You</th>}
                <th>Reactions</th>
                {v.presence && <th>Online</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td>{dayLong(v.firstDay, r.d)}</td>
                  <td>{r.theirs}</td>
                  {v.mine && <td>{r.mine}</td>}
                  <td>{r.reacts}</td>
                  {v.presence && <td>{r.online === null ? '–' : `${r.online}%`}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
