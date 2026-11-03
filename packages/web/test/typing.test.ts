import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { TYPING_REFRESH, TYPING_TTL, TypingSender, typingLine, type TypingTarget } from '@dither-chat/protocol';
import { applyTyping, nextExpiry, typersIn, type TypingState } from '../src/typers.ts';

/** A sender on a fake clock and fake timers. */
function harness(enabled = () => true) {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const sent: string[] = [];
  const s = new TypingSender((t, stop) => sent.push(`${stop ? 'stop' : 'start'} ${t.conversationId}${t.accountId ? '@' + t.accountId : ''}`), {
    now: () => now,
    enabled,
    setTimer: (fn, ms) => {
      const id = ++ids;
      timers.push({ at: now + ms, fn, id });
      return id as any;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === (id as any));
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { s, sent, advance };
}

const A: TypingTarget = { conversationId: 'c1', accountId: 'a1' };

describe("the throttle, like Discord's client", () => {
  test('a start at the first keystroke, then again only every TYPING_REFRESH while typing', () => {
    const h = harness();
    h.s.input(A, 'h');
    for (let i = 0; i < 7; i++) {
      h.advance(1000);
      h.s.input(A, 'hello'.slice(0, (i % 5) + 1));
    }
    expect(h.sent).toEqual(['start c1@a1']);
    h.advance(TYPING_REFRESH - 7000);
    h.s.input(A, 'hello there');
    expect(h.sent).toEqual(['start c1@a1', 'start c1@a1']);
  });

  test('a stop on send, on clearing the text, and none without a start', () => {
    const h = harness();
    h.s.stop();
    h.s.input(A, '   ');
    expect(h.sent).toEqual([]);
    h.s.input(A, 'x');
    h.s.stop(); // sent, or blurred
    h.s.stop();
    h.s.input(A, 'y');
    h.s.input(A, ''); // cleared by hand
    expect(h.sent).toEqual(['start c1@a1', 'stop c1@a1', 'start c1@a1', 'stop c1@a1']);
  });

  test('idle for TYPING_TTL is a stop; typing again is a new start', () => {
    const h = harness();
    h.s.input(A, 'x');
    h.advance(TYPING_TTL - 1);
    h.s.input(A, 'xy'); // still typing: the idle clock starts over
    h.advance(TYPING_TTL - 1);
    expect(h.sent).toEqual(['start c1@a1', 'start c1@a1']);
    h.advance(1);
    expect(h.sent.at(-1)).toBe('stop c1@a1');
    h.s.input(A, 'xyz');
    expect(h.sent.at(-1)).toBe('start c1@a1');
  });

  test('another conversation or another send-as account stops the old one first', () => {
    const h = harness();
    h.s.input(A, 'x');
    h.s.input({ conversationId: 'c1', accountId: 'a2' }, 'xy');
    h.s.input({ conversationId: 'c2' }, 'xy');
    expect(h.sent).toEqual(['start c1@a1', 'stop c1@a1', 'start c1@a2', 'stop c1@a2', 'start c2']);
  });

  test('sharing turned off: nothing more goes out, and a start already out is stopped', () => {
    let on = true;
    const h = harness(() => on);
    h.s.input(A, 'x');
    on = false;
    h.s.input(A, 'xy');
    h.advance(TYPING_REFRESH);
    h.s.input(A, 'xyz');
    expect(h.sent).toEqual(['start c1@a1', 'stop c1@a1']);
  });
});

describe('the line, worded as Discord words it', () => {
  const text = (names: string[]) => typingLine(names).map((r) => (r.bold ? `**${r.text}**` : r.text)).join('');
  test('one, two, three, several', () => {
    expect(text([])).toBe('');
    expect(text(['Alice'])).toBe('**Alice** is typing…');
    expect(text(['Alice', 'Bob'])).toBe('**Alice** and **Bob** are typing…');
    expect(text(['Alice', 'Bob', 'Carol'])).toBe('**Alice**, **Bob** and **Carol** are typing…');
    expect(text(['Alice', 'Bob', 'Carol', 'Dan'])).toBe('Several people are typing…');
    expect(text(['Alice', 'Alice'])).toBe('**Alice** is typing…');
  });
});

describe('who is typing, in the app', () => {
  const ev = (identityId: string, extra: Partial<Extract<P.ClientEvent, { t: 'typing' }>> = {}): Extract<P.ClientEvent, { t: 'typing' }> => ({ t: 'typing', conversationId: 'c', identityId, ...extra });

  test('starts last their TTL, a stop ends one, a refresh extends it', () => {
    let st: TypingState = {};
    st = applyTyping(st, ev('a'), 0);
    st = applyTyping(st, ev('b', { ttl: 25_000, name: 'Bea' }), 1000);
    expect(typersIn(st, ['c'], 2000)).toEqual([
      { identityId: 'a', until: TYPING_TTL },
      { identityId: 'b', until: 26_000, name: 'Bea' },
    ]);
    expect(nextExpiry(st, 2000)).toBe(TYPING_TTL);
    expect(typersIn(st, ['c'], TYPING_TTL).map((t) => t.identityId)).toEqual(['b']);
    st = applyTyping(st, ev('a'), 9000); // refreshed before it ran out
    expect(typersIn(st, ['c'], 15_000).map((t) => t.identityId)).toEqual(['b', 'a']);
    st = applyTyping(st, ev('b', { stop: true }), 16_000);
    st = applyTyping(st, ev('a', { stop: true }), 16_000);
    expect(st).toEqual({});
    expect(nextExpiry(st, 16_000)).toBeNull();
  });

  test('you are never among them, and a merged timeline counts each person once', () => {
    let st: TypingState = {};
    st = applyTyping(st, ev('me'), 0, (id) => id === 'me');
    expect(st).toEqual({});
    st = applyTyping(st, { t: 'typing', conversationId: 'c1', identityId: 'x' }, 0);
    st = applyTyping(st, { t: 'typing', conversationId: 'c2', identityId: 'x' }, 0);
    st = applyTyping(st, { t: 'typing', conversationId: 'c2', identityId: 'y' }, 0);
    expect(typersIn(st, ['c1', 'c2'], 1).map((t) => t.identityId)).toEqual(['x', 'y']);
    expect(typersIn(st, ['c3'], 1)).toEqual([]);
  });
});
