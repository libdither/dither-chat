/**
 * The demo world's friends in other time zones (DITHER_DEMO_SCENARIO=clocks, docs/profile.md "Their time"): a
 * made-up Discord group whose people have written and reacted for six weeks on their own local days, so the hub can
 * guess their clocks from when they are around. Discord states no zone, so each is a guess. Everyone and everything here is made up.
 */
import type * as P from '@dither-chat/protocol';
import { HOUR, offsetAt } from './activitychart.ts';
import type { AccountRow } from './store.ts';
import type { InprocAdapter } from './supervisor.ts';

export const DEMO_CLOCKS_ACCOUNT = { id: 'acc_demo-clocks', network: 'discord' as const, label: 'abroad', color: '#5865F2' };

/** On only in its scenario: the default world's counts are what the tests and perf baselines expect. */
export const demoClocksOn = () => (process.env.DITHER_DEMO_SCENARIO ?? '').split(',').includes('clocks');

const DAY = 24 * HOUR;
const MIN = 60_000;

/** A small seeded random number generator (mulberry32): the same world every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How someone keeps their day: their zone, when they usually get up and go to bed (local hours), and how much they write. */
export interface Rhythm {
  zone: string;
  wake: number;
  sleep: number;
  /** Messages on a day they write. */
  perDay: number;
  /** The chance they write at all on a given day. */
  active: number;
  /** Only from this local hour on (someone who writes in the evenings), else from when they get up. */
  from?: number;
}

/** Normal-ish noise: the mean of three uniforms, scaled to about one standard deviation of `sd`. */
const noise = (r: () => number, sd: number) => (r() + r() + r() - 1.5) * 2 * sd;

/**
 * Message times, oldest first, for `days` days before `now` of someone keeping `rhythm`: each day they write, they get
 * up and go to bed within about 40 minutes of their usual times (an hour later at weekends) and write in bursts between,
 * the first soon after getting up and the last a little before bed.
 */
export function rhythmTimes(rhythm: Rhythm, days: number, now: number, seed: number): number[] {
  const r = seeded(seed);
  const out: number[] = [];
  const zone = { tz: rhythm.zone };
  for (let d = days; d >= 1; d--) {
    if (r() > rhythm.active) continue;
    // The day's local midnight, as an instant: their local date d days ago.
    const noon = now - d * DAY;
    const off = offsetAt(zone, noon);
    const midnight = Math.floor((noon + off) / DAY) * DAY - off;
    const weekday = new Date(midnight + off + 12 * HOUR).getUTCDay();
    const late = weekday === 0 || weekday === 6 ? 1 : 0;
    const wake = (Math.max(rhythm.wake, rhythm.from ?? 0) + late + noise(r, 0.7)) * HOUR;
    let sleep = (rhythm.sleep + late + noise(r, 0.8)) * HOUR;
    if (sleep <= wake) sleep += DAY;
    const bursts = 2 + Math.floor(r() * 4);
    for (let b = 0; b < bursts; b++) {
      // The first burst within an hour of getting up, the last within an hour of bed, the rest any time between.
      const at = b === 0 ? r() * HOUR : b === bursts - 1 ? sleep - wake - HOUR * (0.2 + r() * 0.8) : r() * (sleep - wake);
      let t = midnight + wake + at;
      const n = Math.max(1, Math.round((rhythm.perDay / bursts) * (0.5 + r())));
      for (let i = 0; i < n; i++) {
        t += (0.3 + r() * 3) * MIN;
        if (t < now - MIN) out.push(Math.round(t));
      }
    }
  }
  return out.sort((a, b) => a - b);
}

interface Friend {
  id: string;
  name: string;
  rhythm: Rhythm;
}

const FRIENDS: Friend[] = [
  { id: 'clocks-mika', name: 'Mika Sato', rhythm: { zone: 'Asia/Tokyo', wake: 7.5, sleep: 24.5, perDay: 9, active: 0.8 } },
  { id: 'clocks-lena', name: 'Lena Vogt', rhythm: { zone: 'Europe/Berlin', wake: 7, sleep: 23, perDay: 7, active: 0.75 } },
  { id: 'clocks-sam', name: 'Sam Reyes', rhythm: { zone: 'America/Chicago', wake: 8, sleep: 24, perDay: 8, active: 0.8 } },
];
const SELF = { id: 'clocks-you', name: 'You' };
const GROUP = 'clocks-group-1';

const REACTIONS = ['👍', '😂', '❤️', '👀', '🎉'];
const LINES = ['ok', 'ha', 'nice', 'same', 'on my way', 'did anyone try the new build?', 'sending the photos now', 'brb', 'good morning!', 'night all', 'that works for me', 'which day?', 'lol', 'checking', 'done', 'pushed the fix', 'any plans this weekend?', 'coffee first', 'sounds good'];

export class DemoClocks implements InprocAdapter {
  private emit!: (ev: P.AdapterEvent) => void;
  private sent = 0;

  constructor(
    private acc: AccountRow,
    _dir: string,
  ) {}

  start(emit: (ev: P.AdapterEvent) => void) {
    this.emit = emit;
    const now = JSON.parse(this.acc.config || '{}').epoch ?? Date.now();
    emit({ t: 'hello', network: 'discord', version: 'demo', capabilities: ['send', 'history', 'markRead', 'profile'] });
    emit({ t: 'status', status: 'online', self: { nativeId: SELF.id, displayName: SELF.name, isSelf: true } });
    for (const f of FRIENDS) emit({ t: 'identity', identity: { nativeId: f.id, displayName: f.name, contact: true } });
    const msgs = FRIENDS.flatMap((f, i) => rhythmTimes(f.rhythm, 42, now, 17 + i).map((ts) => ({ ts, who: f.id }))).sort((a, b) => a.ts - b.ts);
    emit({ t: 'conversation', conversation: { nativeId: GROUP, shape: 'group', name: 'Across time zones', participants: [SELF.id, ...FRIENDS.map((f) => f.id)], lastMessageAt: msgs.at(-1)?.ts ?? now } });
    msgs.forEach((m, i) => emit({ t: 'message', live: false, message: { nativeId: `clocks-${i}`, conversation: GROUP, author: m.who, ts: m.ts, body: LINES[(i * 7) % LINES.length] } }));
    // Reactions on days and at hours they don't write too, to the newest message before from someone else.
    FRIENDS.forEach((f, i) => {
      let k = 0;
      let next = 0;
      for (const ts of rhythmTimes({ ...f.rhythm, perDay: 3, active: 0.6 }, 42, now, 41 + i)) {
        while (next < msgs.length && msgs[next].ts < ts) next++;
        let j = next - 1;
        while (j >= 0 && msgs[j].who === f.id) j--;
        if (j >= 0) emit({ t: 'reaction', conversation: GROUP, message: `clocks-${j}`, author: f.id, key: REACTIONS[k++ % REACTIONS.length], ts });
      }
    });
    emit({ t: 'read', conversation: GROUP, upToTs: msgs.at(-1)?.ts ?? now, unread: 0, mentions: 0 });
  }

  command(cmd: P.AdapterCommand) {
    const reply = (result?: unknown) => 'id' in cmd && this.emit({ t: 'reply', id: cmd.id, ok: true, result });
    switch (cmd.t) {
      case 'send': {
        const nativeId = `clocks-sent-${++this.sent}`;
        this.emit({ t: 'message', live: true, message: { nativeId, conversation: cmd.conversation, author: SELF.id, ts: Date.now(), body: cmd.body } });
        return reply({ nativeId });
      }
      case 'profile': {
        const f = FRIENDS.find((x) => x.id === cmd.who);
        return reply(f ? ({ displayName: f.name } satisfies P.PersonAbout) : {});
      }
      case 'history':
        return reply({ count: 0, done: true } satisfies P.HistoryResult);
      case 'markRead':
        return reply({});
      default:
        if ('id' in cmd) this.emit({ t: 'reply', id: cmd.id, ok: false, error: 'the demo account cannot do that' });
    }
  }

  stop() {}
}
