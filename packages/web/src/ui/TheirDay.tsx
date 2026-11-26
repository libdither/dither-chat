/**
 * Their usual day, on a card by a message's time (docs/profile.md "Their time"): the message's time in their time or
 * yours, where their clock comes from, and a bar of the day, hour by hour, of how often they are around then (and,
 * within it, write), each hour with its 80% range, their usual night shaded with its give-or-take, and the message and
 * now marked. Week shows it
 * by weekday. Set time zone keeps a zone for them when the guess is wrong. A chunk of its own (TheirTime.tsx).
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { createPortal } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { useLayer } from '../phone.ts';
import { clockOffset, forgetClock, myOffset, myZone, wallClock } from '../theirclock.ts';
import { leaveCard, stayCard, type DayCard } from './TheirTime.tsx';
import './theirday.css';

const days = new Map<string, { at: number; v: P.TheirDayView }>();
const KEEP_MS = 5 * 60_000;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LONG_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const W = 296;
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** "9 PM", "12 AM": an hour of the day, as this device writes hours. */
const hourLabel = (h: number) => wallClock(Date.UTC(2000, 0, 1, mod(Math.round(h), 24)), 0).replace(':00', '');
/** "1:10 AM" for minutes after midnight. */
const minuteLabel = (m: number) => wallClock(Date.UTC(2000, 0, 1) + mod(Math.round(m), 1440) * 60_000, 0);
const roughly = (min: number) => (min < 55 ? `${Math.round(min / 5) * 5} min` : `${Math.round(min / 30) / 2} h`);

/** What they did, in the words the card counts it in: one, many. */
const KINDS: [P.TheirActivity, string, string][] = [
  ['messages', 'message', 'messages'],
  ['reactions', 'reaction', 'reactions'],
  ['reads', 'read receipt', 'read receipts'],
  ['presence', 'time online or off', 'times online or off'],
  ['statuses', 'status set', 'statuses set'],
  ['votes', 'poll vote', 'poll votes'],
  ['calls', 'call started', 'calls started'],
];
/** "412 messages, 80 reactions and 30 read receipts". */
function countsLine(counts: P.TheirDayView['counts']): string {
  const parts = KINDS.flatMap(([k, one, many]) => (counts[k] ? [`${counts[k]} ${counts[k] === 1 ? one : many}`] : []));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'nothing');
}
const total = (counts: P.TheirDayView['counts']) => Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);

/** Where their clock comes from, in a line. */
function sourceLine(c: P.TheirClock | null, frame: P.TheirDayView['frame']): string {
  if (!c) return 'Their time zone is not known: what they say on a profile, or enough days of them around, would tell.';
  if (c.source === 'pinned') return `${c.zone}, set by you`;
  if (c.source === 'profile') return `${c.zone}, from their ${NETWORK_META[c.network]?.name ?? c.network} profile`;
  return `Guessed from when they are around (${frame.zone}): ${Math.round(c.sure * 100)}% likely within an hour, from ${c.days} days`;
}

export function TheirDay({ card, onClose }: { card: DayCard; onClose: () => void }) {
  const [frame, setFrame] = useState(card.frame);
  const [week, setWeek] = useState(false);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [v, setV] = useState(() => days.get(card.identityId)?.v ?? null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const fetchDay = (force = false) => {
    const k = days.get(card.identityId);
    if (!force && k && Date.now() - k.at < KEEP_MS) return setV(k.v);
    api<P.TheirDayView>(`/api/people/${card.identityId}/day?tz=${encodeURIComponent(myZone())}`).then(
      (d) => {
        days.set(card.identityId, { at: Date.now(), v: d });
        setV(d);
      },
      () => setFailed(true),
    );
  };
  useLayoutEffect(() => {
    setFrame(card.frame);
    fetchDay();
  }, [card.identityId, card.ts, card.frame]);

  // Beside the time: below it, or above where the window has no room below.
  useLayoutEffect(() => {
    if (!box.current || !card.el.isConnected) return;
    const r = card.el.getBoundingClientRect();
    const b = box.current.getBoundingClientRect();
    let x = Math.max(8, Math.min(innerWidth - b.width - 8, r.left - 12));
    let y = r.bottom + 6;
    if (y + b.height > innerHeight - 8) y = Math.max(8, r.top - b.height - 6);
    setPos({ x, y });
  }, [card.el, v, week, zoneOpen, frame]);

  // Escape closes it: a card opened by a click is a layer (back closes it too); one shown by pointing listens itself.
  useLayoutEffect(() => {
    if (card.pinned) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [card.pinned]);
  // A click elsewhere closes one opened by a click.
  useLayoutEffect(() => {
    if (!card.pinned) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !card.el.contains(t)) onClose();
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [card.pinned, card.el]);

  const theirs = !!v?.frame.theirs;
  const shown = theirs ? frame : 'yours';
  const now = Date.now();
  // The hours come in the frame the hub chose; drawn in the other, they slide by the difference now.
  const target = v ? (shown === 'theirs' ? v.frame.offsetNow : myOffset(now)) : 0;
  const shift = v ? (target - (v.frame.theirs ? v.frame.offsetNow : myOffset(now))) / 60 : 0;
  const atOffset = (ts: number) => (shown === 'theirs' && v?.clock ? (clockOffset(v.clock, ts) ?? target) : myOffset(ts));
  const minutesAt = (ts: number) => mod(Math.floor((ts + atOffset(ts) * 60_000) / 60_000), 1440);
  const who = shown === 'theirs' ? `for ${card.name}` : 'for you';

  const setZone = (zone: string | null) => {
    api(`/api/people/${card.identityId}/zone`, { method: 'PUT', body: { zone } }).then(() => {
      forgetClock(card.identityId);
      days.delete(card.identityId);
      setZoneOpen(false);
      fetchDay(true);
    }, () => setFailed(true));
  };

  return createPortal(
    <div
      ref={box}
      class={`their-day ${pos ? 'shown' : ''}`}
      role="dialog"
      aria-label={`When ${card.name} is usually around`}
      style={pos ? { left: `${pos.x}px`, top: `${pos.y}px` } : { left: '-9999px', top: '-9999px' }}
      onPointerEnter={stayCard}
      onPointerLeave={leaveCard}
    >
      {card.pinned && <Layer onClose={onClose} />}
      <div class="td-head">
        <div class="td-when">
          <b>{wallClock(card.ts, atOffset(card.ts), true)}</b> <span>{who}</span>
        </div>
        {theirs && (
          <div class="td-frames" role="group" aria-label="Show in">
            <button type="button" class={shown === 'theirs' ? 'on' : ''} aria-pressed={shown === 'theirs'} onClick={() => setFrame('theirs')}>
              Their time
            </button>
            <button type="button" class={shown === 'yours' ? 'on' : ''} aria-pressed={shown === 'yours'} onClick={() => setFrame('yours')}>
              Your time
            </button>
          </div>
        )}
      </div>
      {!v ? (
        <div class="td-line">{failed ? 'Could not reach the hub.' : 'Working out their day…'}</div>
      ) : (
        <>
          <div class="td-line">{sourceLine(v.clock, v.frame)}</div>
          {total(v.counts) < 10 ? (
            <div class="td-line">Too little from them in the last {v.days} days to show their day.</div>
          ) : (
            <>
              <DayBar v={v} shift={shift} msgAt={minutesAt(card.ts)} nowAt={minutesAt(now)} />
              <div class="td-key">
                <span>
                  <i class="k-msg" /> this message
                </span>
                <span>
                  <i class="k-now" /> now
                </span>
                {v.quiet && (
                  <span>
                    <i class="k-night" /> usually quiet
                  </span>
                )}
              </div>
              <div class="td-line">
                {v.quiet
                  ? `Usually quiet ${minuteLabel(v.quiet.from + shift * 60)} to ${minuteLabel(v.quiet.to + shift * 60)}, give or take ${roughly((v.quiet.fromSpread + v.quiet.toSpread) / 2)} (${v.quiet.nights} nights)`
                  : 'Not enough nights yet to say when they are usually quiet.'}
              </div>
              <div class="td-line td-dim">
                From {countsLine(v.counts)} over {v.days} days. A bar is the share of days they were around in that hour, its solid part the days they wrote; its line, the likely range.
              </div>
              {week && <WeekGrid v={v} shift={shift} />}
            </>
          )}
          <div class="td-actions">
            {total(v.counts) >= 10 && (
              <button type="button" class="link-btn" aria-expanded={week} onClick={() => setWeek(!week)}>
                {week ? 'Hide week' : 'Week'}
              </button>
            )}
            <button type="button" class="link-btn" aria-expanded={zoneOpen} onClick={() => setZoneOpen(!zoneOpen)}>
              {v.clock?.source === 'pinned' ? 'Change time zone' : 'Set time zone'}
            </button>
            {zoneOpen && <ZonePick current={v.clock && v.clock.source !== 'rhythm' ? v.clock.zone : null} pinned={v.clock?.source === 'pinned'} onPick={setZone} />}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

/** A card opened by a click or a tap: back and Escape close it. */
function Layer({ onClose }: { onClose: () => void }) {
  useLayer(onClose);
  return null;
}

/**
 * The day as a bar: hours along it, how often they are around in each (a column, its range a line) and how often they
 * write (the column's solid part), their night shaded.
 */
function DayBar({ v, shift, msgAt, nowAt }: { v: P.TheirDayView; shift: number; msgAt: number; nowAt: number }) {
  const H = 44;
  const x = (h: number) => (mod(h, 24) / 24) * W;
  const top = Math.max(10, ...v.hours.map((h) => h[2]));
  const y = (p: number) => H - (p / top) * (H - 4);
  const cw = W / 24;
  const q = v.quiet;
  // A stretch of the day (in hours) as one or two rects, split where it wraps past midnight.
  const span = (from: number, to: number, cls: string, key: string) => {
    const a = mod(from, 24);
    const len = mod(to - from, 24);
    const parts = a + len <= 24 ? [[a, len]] : [[a, 24 - a], [0, a + len - 24]];
    return parts.map(([s, l], i) => <rect key={`${key}${i}`} class={cls} x={(s / 24) * W} y={0} width={(l / 24) * W} height={H} />);
  };
  return (
    <svg class="td-bar" viewBox={`0 0 ${W} ${H + 14}`} width={W} height={H + 14} role="img" aria-label="Their usual day, hour by hour">
      <rect class="td-track" x={0} y={0} width={W} height={H} rx={4} />
      {q && span((q.from - q.fromSpread) / 60 + shift, (q.to + q.toSpread) / 60 + shift, 'td-night-edge', 'e')}
      {q && span((q.from + q.fromSpread) / 60 + shift, (q.to - q.toSpread) / 60 + shift, 'td-night', 'n')}
      {v.hours.map(([p, lo, hi, wrote], h) => {
        const at = x(h + shift);
        return (
          <g key={h}>
            <title>{`${hourLabel(h + shift)}: around on ${p}% of days (likely ${lo}–${hi}%), wrote on ${wrote}%`}</title>
            <rect class="td-col" x={at + 1} y={y(p)} width={cw - 2} height={H - y(p)} />
            {wrote > 0 && <rect class="td-wrote" x={at + 1} y={y(wrote)} width={cw - 2} height={H - y(wrote)} />}
            <line class="td-range" x1={at + cw / 2} x2={at + cw / 2} y1={y(hi)} y2={y(lo)} />
          </g>
        );
      })}
      <line class="td-now" x1={(nowAt / 1440) * W} x2={(nowAt / 1440) * W} y1={0} y2={H} />
      <line class="td-msg" x1={(msgAt / 1440) * W} x2={(msgAt / 1440) * W} y1={0} y2={H} />
      {[0, 6, 12, 18].map((h) => (
        <text key={h} class="td-tick" x={(h / 24) * W + 1} y={H + 11}>
          {hourLabel(h)}
        </text>
      ))}
    </svg>
  );
}

/** By weekday: a row a day, Monday first, each hour's cell as strong as how often they are around then. */
function WeekGrid({ v, shift }: { v: P.TheirDayView; shift: number }) {
  const rowH = 13;
  const cw = W / 24;
  const top = Math.max(10, ...v.week.map((c) => c[0]));
  const L = 30;
  return (
    <svg class="td-week" viewBox={`0 0 ${W + L} ${rowH * 7}`} width={W + L} height={rowH * 7} role="img" aria-label="Their usual week, by weekday and hour">
      {WEEKDAYS.map((d, i) => (
        <text key={d} class="td-tick" x={0} y={i * rowH + 10}>
          {d}
        </text>
      ))}
      {v.week.flatMap(([p, lo, hi], i) => {
        // Hour i of the week, slid into the frame shown: it may land on the day before or after, round the week.
        const at = mod(i + shift, 168);
        const row = Math.floor(at / 24);
        const col = at - row * 24;
        const n = v.weekDays[Math.floor(i / 24)];
        const label = `${LONG_WEEKDAYS[row]} ${hourLabel(col)}: around on ${Math.round((p / 100) * n)} of ${n} ${LONG_WEEKDAYS[row]}s (likely ${lo}–${hi}%)`;
        const draw = (c: number, r: number, k: string) => (
          <rect key={k} class="td-cell" x={L + c * cw + 0.5} y={r * rowH + 1} width={cw - 1} height={rowH - 2} style={{ opacity: p ? 0.15 + (0.85 * p) / top : 0.06 }}>
            <title>{label}</title>
          </rect>
        );
        // A cell slid by part of an hour straddles two places; drawn at its start, wrapping at the week's end.
        return [draw(col, row, `${i}`), ...(col + 1 > 24 ? [draw(col - 24, mod(row + 1, 7), `${i}w`)] : [])];
      })}
    </svg>
  );
}

/** A zone for them by hand: every zone this browser knows, or back to what they say or what is guessed. */
function ZonePick({ current, pinned, onPick }: { current: string | null; pinned: boolean; onPick: (zone: string | null) => void }) {
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return (
    <div class="td-zone">
      <select aria-label="Their time zone" value={current ?? ''} onChange={(e) => (e.currentTarget.value ? onPick(e.currentTarget.value) : undefined)}>
        <option value="">Pick a time zone…</option>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      {pinned && (
        <button type="button" class="link-btn" onClick={() => onPick(null)}>
          Use what they say, or the guess
        </button>
      )}
    </div>
  );
}
