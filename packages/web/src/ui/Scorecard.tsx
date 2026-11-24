/**
 * The scorecard on How it sorts (docs/scorecard.md): how the notification and inbox models did, day by day, one small
 * line chart per question, each with one y-axis. Hover, a tap or the arrow keys show a day's numbers and how many
 * they are of; a table lists them all. A chunk of its own, loaded when How it sorts opens.
 */
import { formatScore, SCORE_CHARTS, scoreTrend, type ModelScoresView, type ScoreChart, type ScoreKind, type ScoreMetric } from '@dither-chat/protocol/scorecard';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { api } from '../state.ts';
import { Icon } from './icons.tsx';
import './scorecard.css';

const DAYS = 60;
const H = 132;
const PAD = { top: 8, right: 8, bottom: 20, left: 34 };

const dayLabel = (d: string, long = false) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(long ? { weekday: 'short' } : {}) });

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

/** The y-axis: shares and ranks 0 to 1, an AUC from a coin toss (or lower, if a day was) to 1, a count or hours from 0. */
function domain(c: ScoreChart, v: ModelScoresView): [number, number] {
  const kind = c.metrics[0].kind;
  const vals = c.metrics.flatMap((m) => v.metrics[m.key]?.v ?? []).filter((x): x is number => x !== null);
  if (kind === 'count' || kind === 'hours') return [0, Math.max(2, ...vals.map((x) => Math.ceil(x)))];
  if (kind === 'auc') return [Math.min(0.5, ...vals.map((x) => Math.floor(x * 10) / 10)), 1];
  // A Brier score: from 0 (perfect) to a coin toss's 0.25, or higher if a day was worse.
  if (kind === 'brier') return [0, Math.max(0.25, ...vals.map((x) => Math.ceil(x * 20) / 20))];
  return [0, 1];
}

function ticks(kind: ScoreKind, lo: number, hi: number): number[] {
  if (kind === 'count' || kind === 'hours') {
    const step = Math.max(1, Math.ceil(hi / 3));
    const out: number[] = [];
    for (let t = 0; t <= hi; t += step) out.push(t);
    return out;
  }
  if (kind === 'brier') return [0, hi / 2, hi];
  return kind === 'auc' ? [lo, (lo + 1) / 2, 1] : [0, 0.5, 1];
}

function Chart({ c, v }: { c: ScoreChart; v: ModelScoresView }) {
  const [ref, width] = useWidth();
  const [sel, setSel] = useState<number | null>(null);
  const days = v.days;
  const [lo, hi] = domain(c, v);
  const kind = c.metrics[0].kind;
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const x = (i: number) => PAD.left + (days.length <= 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (val: number) => PAD.top + (1 - (val - lo) / (hi - lo || 1)) * (H - PAD.top - PAD.bottom);
  const shown = c.metrics.filter((m) => v.metrics[m.key]?.v.some((x) => x !== null));
  const pick = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    const px = clientX - r.left;
    const i = days.length <= 1 ? 0 : Math.round(((px - PAD.left) / plotW) * (days.length - 1));
    setSel(Math.max(0, Math.min(days.length - 1, i)));
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const d = e.key === 'ArrowLeft' ? -1 : 1;
    setSel((s) => Math.max(0, Math.min(days.length - 1, (s ?? days.length - 1) + (s === null ? 0 : d))));
  };
  /** A line, broken where a day has nothing. */
  const path = (m: ScoreMetric) => {
    const vs = v.metrics[m.key]?.v ?? [];
    let d = '';
    let pen = false;
    vs.forEach((val, i) => {
      if (val === null) return void (pen = false);
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(val).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  /** Days with a value but none beside them: a line cannot show them, a dot does. */
  const lone = (m: ScoreMetric) => (v.metrics[m.key]?.v ?? []).flatMap((val, i, a) => (val !== null && (a[i - 1] ?? null) === null && (a[i + 1] ?? null) === null ? [i] : []));
  const tipLeft = sel === null ? 0 : Math.max(0, Math.min(width - 196, x(sel) - 98));
  const label = `${c.title}: ${shown.map((m) => `${m.label} ${formatScore(m.kind, scoreTrend(v, m).recent.value)} over the last 7 days`).join(', ')}`;
  return (
    <div class="sc-chart" data-chart={c.id}>
      <h4>{c.title}</h4>
      <p class="muted sc-about">{c.about}</p>
      {shown.length === 0 ? (
        <p class="muted sc-none">Nothing to score yet.</p>
      ) : (
        <>
          <div class="sc-legend">
            {shown.map((m) => {
              const t = scoreTrend(v, m);
              const slot = c.metrics.indexOf(m) + 1;
              return (
                <span key={m.key} class="sc-legend-item" data-metric={m.key} title={`Last 7 days, against the 7 before (${t.recent.n} against ${t.before.n})`}>
                  <i class={`sc-key s${slot}`} />
                  {m.label} <b>{formatScore(m.kind, t.recent.value)}</b>
                  {t.before.value !== null && <span class="sc-was"> (was {formatScore(m.kind, t.before.value)})</span>}
                </span>
              );
            })}
          </div>
          <div class="sc-plot" ref={ref}>
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
                {ticks(kind, lo, hi).map((t) => (
                  <g key={t}>
                    <line class="sc-grid" x1={PAD.left} x2={width - PAD.right} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} />
                    <text class="sc-tick" x={PAD.left - 5} y={y(t) + 3.5} text-anchor="end">
                      {formatScore(kind, t)}
                    </text>
                  </g>
                ))}
                {days.length > 0 &&
                  [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])].map((i) => (
                    <text key={i} class="sc-tick" x={x(i)} y={H - 5} text-anchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}>
                      {dayLabel(days[i])}
                    </text>
                  ))}
                {sel !== null && <line class="sc-cross" x1={x(sel)} x2={x(sel)} y1={PAD.top} y2={H - PAD.bottom} />}
                {shown.map((m) => {
                  const slot = c.metrics.indexOf(m) + 1;
                  return (
                    <g key={m.key} class={`sc-series s${slot}`}>
                      <path class="sc-line" d={path(m)} />
                      {lone(m).map((i) => (
                        <circle key={i} class="sc-dot" cx={x(i)} cy={y(v.metrics[m.key].v[i]!)} r={3} />
                      ))}
                      {sel !== null && v.metrics[m.key].v[sel] !== null && <circle class="sc-dot on" cx={x(sel)} cy={y(v.metrics[m.key].v[sel]!)} r={4} />}
                    </g>
                  );
                })}
              </svg>
            )}
            {sel !== null && (
              <div class="sc-tip" style={{ left: `${tipLeft}px` }} role="status">
                <span class="sc-tip-when">{dayLabel(days[sel], true)}</span>
                {shown.map((m) => {
                  const s = v.metrics[m.key];
                  return (
                    <span key={m.key} class="sc-tip-row">
                      <i class={`sc-key s${c.metrics.indexOf(m) + 1}`} />
                      {m.label} <b>{formatScore(m.kind, s.v[sel])}</b>
                      <span class="sc-n">of {s.n[sel].toLocaleString('en-US')}</span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Every number, by day, newest first. */
function Table({ v }: { v: ModelScoresView }) {
  const metrics = SCORE_CHARTS.flatMap((c) => c.metrics.map((m) => ({ c, m })));
  return (
    <details class="sc-table">
      <summary data-track="scorecard: as a table">As a table</summary>
      <div class="sc-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              {metrics.map(({ c, m }) => (
                <th key={m.key} title={c.title}>
                  {c.title}: {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v.days
              .map((d, i) => [d, i] as const)
              .reverse()
              .map(([d, i]) => (
                <tr key={d}>
                  <th>{dayLabel(d)}</th>
                  {metrics.map(({ m }) => {
                    const s = v.metrics[m.key];
                    return <td key={m.key}>{s && (s.v[i] !== null || s.n[i]) ? `${formatScore(m.kind, s.v[i])} (${s.n[i]})` : ''}</td>;
                  })}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function Scorecard() {
  const [v, setV] = useState<ModelScoresView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<ModelScoresView>(`/api/model/scores?days=${DAYS}`).then(setV, () => setFailed(true));
  }, []);
  return (
    <div class="board-block scorecard" data-scorecard>
      <h3>
        <Icon name="activity" size={15} /> How well it is doing
      </h3>
      <p class="muted">
        Each day is scored a day after it ends, against what you did afterwards: whether you opened what it notified you about, and whether what it ranked higher was what you went to. “Learning nothing” is
        where every message starts before anything is learned, scored on the same messages. Beside each line, its last 7 days, and the 7 before in brackets.
      </p>
      {failed && <p class="muted">Could not load the scores.</p>}
      {v && v.days.length === 0 && <p class="muted">Nothing scored yet: a day is scored a day after it ends.</p>}
      {v && v.days.length > 0 && (
        <>
          {SCORE_CHARTS.map((c) => (
            <Chart key={c.id} c={c} v={v} />
          ))}
          <Table v={v} />
        </>
      )}
    </div>
  );
}
