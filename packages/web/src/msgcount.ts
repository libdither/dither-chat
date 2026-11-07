/**
 * How many messages someone posted in a server, worded no surer than the hub's estimate (hub msgcount.ts,
 * docs/profile.md): what was seen is exact, an estimate is rounded and always comes with its range.
 */
import type * as P from '@dither-chat/protocol';

/** Two significant figures past 100, down or up, so an estimate does not look more exact than it is. */
function sig(n: number, dir: 'floor' | 'ceil' | 'round' = 'round'): number {
  if (n < 100) return Math[dir](n);
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math[dir](n / step) * step;
}
const num = (n: number) => n.toLocaleString('en-US');
function pct(f: number): string {
  const p = f * 100;
  return p > 0 && p < 1 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

/**
 * "≥120 seen; ~1,400 estimated, 900–2,100" (with a "+" when some are in channels with no estimate), "≥120 seen (total
 * unknown)", or "120 messages (all held)".
 */
export function countText(e: P.MessageCountEstimate): string {
  if (e.method === 'complete') return `${num(e.observed)} message${e.observed === 1 ? '' : 's'} (all held)`;
  if (e.estimate === undefined || e.low === undefined || e.high === undefined) return `≥${num(e.observed)} seen (total unknown)`;
  const low = Math.max(e.observed, sig(e.low, 'floor'));
  const high = e.high <= e.low ? low : Math.max(low, sig(e.high, 'ceil'));
  const est = Math.min(high, Math.max(low, sig(e.estimate)));
  // Some of theirs are in channels with no estimate: the top is not a ceiling.
  const more = e.unestimated ? '+' : '';
  if (low === high) return `≥${num(e.observed)} seen; ~${num(est)} estimated${more ? ' or more' : ''}`;
  return `≥${num(e.observed)} seen; ~${num(est)} estimated, ${num(low)}–${num(high)}${more}`;
}

/** The longer why, for a tooltip: their share with its interval, what the total rests on, as of when. */
export function countTitle(e: P.MessageCountEstimate, when: (ts: number) => string): string {
  const out = [
    `${num(e.observed)} of the ${num(e.captured)} messages the hub holds here are theirs: ${pct(e.shareLow)}–${pct(e.shareHigh)} of what is posted here, at 95%.`,
  ];
  if (e.reason) out.push(e.reason);
  if (e.total && e.method !== 'complete') out.push(`The server's own total: ~${num(sig(e.total.estimate))} (${num(sig(e.total.low, 'floor'))}–${num(sig(e.total.high, 'ceil'))}).`);
  out.push(`From stored messages only${e.asOf ? `, as of ${when(e.asOf)}` : ''}; never asked of the network.`);
  return out.join(' ');
}
