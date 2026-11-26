/**
 * Opening a chat, step by step (waits.ts): the steps an open goes through, the line's share for each, and what the row
 * over the message box says once it is slow, the hub's step or the network's.
 */
import { describe, expect, test } from 'bun:test';
import { barSpan, usualMs, waitDone, waitLine, waitOn, waits, type Wait } from '../src/waits.ts';

describe('waitOn / waitDone', () => {
  test('steps follow on in one open, and it ends', () => {
    waitOn('c:a', 'link', { network: 'whatsapp', steps: ['link', 'hub', 'network'] }, 1000);
    waitOn('c:a', 'hub', {}, 1300);
    const w = waits.value.get('c:a')!;
    expect(w).toMatchObject({ step: 'hub', network: 'whatsapp', at: 1300, began: 1000, steps: ['link', 'hub', 'network'] });
    waitOn('c:a', 'network', {}, 1500);
    expect(waits.value.get('c:a')!.step).toBe('network');
    waitDone('c:a', true, 1700);
    expect(waits.value.has('c:a')).toBe(false);
  });

  test('a step not planned for joins the end', () => {
    waitOn('c:b', 'hub', { steps: ['hub'] }, 0);
    waitOn('c:b', 'network', { network: 'matrix' }, 10);
    expect(waits.value.get('c:b')!.steps).toEqual(['hub', 'network']);
    waitDone('c:b', false);
  });

  test('usual times come from what was kept, by network for the network step', () => {
    for (let i = 0; i < 5; i++) {
      waitOn('c:u', 'hub', { network: 'zulip', steps: ['hub', 'network'] }, 0);
      waitOn('c:u', 'network', {}, 100);
      waitDone('c:u', true, 100 + 700 + i);
    }
    expect(usualMs('network', 'zulip')).toBe(702);
    expect(usualMs('network', 'telegram')).toBe(400);
  });
});

const wait = (o: Partial<Wait>): Wait => ({ step: 'hub', at: 0, began: 0, steps: ['hub', 'network'], network: 'signal', ...o });

describe('barSpan', () => {
  test('each step as wide as its usual time; within one, most of its width', () => {
    // Read here: the opens above kept times of their own for the hub's step.
    const h = usualMs('hub');
    const n = usualMs('network', 'signal');
    expect(n).toBe(400);
    const a = barSpan(wait({}));
    expect(a.from).toBe(0);
    expect(a.to).toBeCloseTo((0.85 * h) / (h + n));
    const b = barSpan(wait({ step: 'network' }));
    expect(b.from).toBeCloseTo(h / (h + n));
    expect(b.to).toBeCloseTo((h + 0.85 * n) / (h + n));
    expect(b.ms).toBe(1000);
  });
});

describe('waitLine', () => {
  test('nothing for the first 1.5 s', () => {
    expect(waitLine(wait({}), 1400)).toBeNull();
  });

  test("says whose step it is, the hub's or the network's, and calls it slow well past its usual time", () => {
    expect(waitLine(wait({}), 1600)).toMatchObject({ text: 'Waiting on your hub · 2 s', slow: false });
    const net = waitLine(wait({ step: 'network', at: 1000, network: 'discord' }), 5000)!;
    expect(net.text).toBe('Waiting on Discord · 4 s, usually 0.4 s');
    expect(net.slow).toBe(true);
    expect(net.why).toContain('Discord');
    expect(waitLine(wait({ step: 'link', steps: ['link', 'hub'] }), 2000, { restarting: true })!.text).toStartWith('Waiting for the hub to restart');
  });
});
