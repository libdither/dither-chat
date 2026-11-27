/**
 * The words beside "Inbox" (statusline.ts, docs/sync.md "What the inbox says"): nothing while all is well or quick, a
 * countdown while offline or a hub restarts, then a short "up to date" line.
 */
import { describe, expect, test } from 'bun:test';
import { statusLine, statusLive, type StatusInput } from '../src/statusline.ts';

const T = 1_700_000_000_000;
const base: StatusInput = { now: T, connected: true, offline: false, catching: null, caught: null, restarting: null, nextTry: null, from: null };
const at = (o: Partial<StatusInput>) => statusLine({ ...base, ...o });

describe('statusLine', () => {
  test('all well: nothing, and no clock ticking', () => {
    expect(at({})).toBeNull();
    expect(statusLive(base)).toBe(false);
  });

  test('a catch-up says nothing for its first 180 ms, then "Catching up…"', () => {
    expect(at({ catching: T - 100 })).toBeNull();
    expect(at({ catching: T - 200 })).toMatchObject({ icon: 'turn', title: 'Catching up…' });
  });

  test('a finished catch-up: how many came, for a moment, only if the wait showed', () => {
    expect(at({ caught: { at: T - 500, took: 600, fresh: 14 } })).toMatchObject({ icon: 'done', title: '14 new', more: 'up to date' });
    expect(at({ caught: { at: T - 500, took: 600, fresh: 0 } })).toMatchObject({ title: 'Up to date' });
    expect(at({ caught: { at: T - 500, took: 90, fresh: 3 } })).toBeNull();
    expect(at({ caught: { at: T - 2000, took: 600, fresh: 3 } })).toBeNull();
  });

  test('offline: since when, and the next try counted down; the copy kept says "saved"', () => {
    const l = at({ connected: false, offline: true, nextTry: T + 2400, from: { at: T - 60_000, saved: false } })!;
    expect(l).toMatchObject({ icon: 'offline', title: 'Offline', tap: true, amber: true, more: 'next try 2 s' });
    expect(l.aside).toMatch(/^since \d/);
    const saved = at({ connected: false, offline: true, nextTry: null, from: { at: T - 60_000, saved: true } })!;
    expect(saved.aside).toMatch(/^saved \d/);
    expect(saved.more).toBe('trying…');
    expect(at({ connected: false, offline: true, nextTry: null, from: null })!.aside).toBeUndefined();
  });

  test('a hub restarting: back in about its usual time, then over it, then caught up as "Hub updated"', () => {
    const r = { at: T - 3000, usualMs: 9000 };
    expect(at({ connected: false, restarting: r })).toMatchObject({ icon: 'turn', title: 'Hub restarting', more: 'back in about 6 s' });
    expect(at({ connected: false, restarting: { at: T - 12_000, usualMs: 9000 } })!.more).toBe('12 s · longer than usual');
    expect(at({ connected: false, restarting: { at: T - 4000 } })!.more).toBe('4 s');
    // Offline is not said while a restart is waited on.
    expect(at({ connected: false, offline: true, restarting: r })!.title).toBe('Hub restarting');
    expect(at({ catching: T - 50, restarting: r })).toMatchObject({ title: 'Catching up…', more: 'hub restarted' });
    expect(at({ caught: { at: T - 2500, took: 40, fresh: 0, after: 'updated' } })).toMatchObject({ title: 'Hub updated', more: 'up to date' });
    expect(at({ caught: { at: T - 100, took: 40, fresh: 0, after: 'restarted' } })!.title).toBe('Hub restarted');
    expect(at({ caught: { at: T - 100, took: 40, fresh: 5, after: 'app' } })!.title).toBe('New version');
  });
});
