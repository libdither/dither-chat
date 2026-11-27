/**
 * What a send's files have come to, in words, under its pending copy (docs/uploads.md "How it looks"): packing,
 * sending with how much and how long, or, with the link lost, what the hub has of each picture and when it sends
 * them as they are (Settings → Sending). Pure, so it is tested without a page.
 */
import type * as P from '@dither-chat/protocol';
import { atLeast, CUT_QUALITIES, cutQuality, seesEnd, type CutQuality, type JpegLayers } from '@dither-chat/protocol';

export interface FileState {
  status: 'packing' | 'uploading' | 'done' | 'failed' | 'cancelled';
  /** What the hub has. */
  sent: number;
  size: number;
  /** A progressive photo's layers (pack.ts); none for anything else. */
  layers?: JpegLayers | null;
  /** When the hub last said how much it has. */
  at?: number;
}

/** The last layer the hub sees whole in what it has (seesEnd): what it would send, and what the tile shows. */
export function hubCut(f: FileState): number {
  if (f.sent >= f.size) return f.size;
  let keep = 0;
  for (const e of f.layers?.ends ?? []) if (seesEnd(e, f.sent)) keep = e;
  return keep;
}

/** How good what the hub has of it is: a photo by its layers, anything else only once it is all there. */
export function hubQuality(f: FileState): CutQuality | null {
  if (f.sent >= f.size || f.status === 'done') return 'full';
  if (!f.layers) return null;
  return cutQuality(hubCut(f), f.size, f.layers);
}

const worse = (a: CutQuality, b: CutQuality) => (CUT_QUALITIES.indexOf(a) < CUT_QUALITIES.indexOf(b) ? a : b);
const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const secs = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

interface LineInput {
  files: FileState[];
  online: boolean;
  /** The hub has the send and waits for its files (sendqueue.ts, files still coming). */
  held: boolean;
  /** Settings → Sending, once read. */
  cut: P.CutSettings | null;
  now: number;
  /** When this send began uploading, and how much the hub had then: for how long is left. */
  began?: { at: number; sent: number };
}

/** The line, or null when there is nothing to say beyond the pending copy's own note. */
export function sendLine(x: LineInput): { text: string; amber?: boolean } | null {
  const going = x.files.filter((f) => f.status !== 'cancelled');
  if (!going.length || going.every((f) => f.status === 'done')) return null;
  const total = going.reduce((n, f) => n + f.size, 0);
  const sent = going.reduce((n, f) => n + Math.min(f.sent, f.size), 0);
  if (!x.online) {
    if (!x.held) return null;
    const qs = going.map(hubQuality);
    const n = going.length;
    const has = qs.every(Boolean) ? `${n > 1 ? `all ${n}, ` : ''}at least ${(qs as CutQuality[]).reduce(worse)}` : `${qs.filter(Boolean).length} of ${n}`;
    const last = Math.max(...going.map((f) => f.at ?? 0));
    const when = !x.cut
      ? 'it carries on when this phone is back'
      : x.cut.afterMs === null
        ? 'the hub waits for this phone'
        : !qs.every((q) => atLeast(q, x.cut!.atLeast))
          ? `waits: not all ${x.cut.atLeast} yet`
          : last + x.cut.afterMs > x.now
            ? `sends as is in ${clock(last + x.cut.afterMs - x.now)}`
            : 'sending as is';
    return { text: `Link lost · the hub has ${has} · ${when}`, amber: true };
  }
  if (going.some((f) => f.status === 'packing') && sent === 0) return { text: 'Packing…' };
  let left = '';
  if (x.began && x.now - x.began.at > 2000 && sent > x.began.sent) {
    const rate = (sent - x.began.sent) / (x.now - x.began.at);
    left = ` · about ${secs((total - sent) / rate)} left`;
  }
  return { text: `Sending · ${mb(sent)} of ${mb(total)}${left}` };
}
