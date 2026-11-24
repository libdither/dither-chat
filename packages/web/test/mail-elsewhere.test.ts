/** What a person wrote elsewhere as rows (mail/elsewhere.ts): one per thread, open while it waits, as you left it. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { rowOpen, threadRows, toggled } from '../src/mail/elsewhere.ts';

const e = (place: string, ts: number, awaits = false, id = `mml_${place}_${ts}`): P.ElsewhereView => ({ place, placeKind: 'mail-thread', title: place, others: ['Jo Park'], messageId: id, ts, unread: false, awaits });
const chose = (rung: P.Rung, setAt: number): P.PlaceRungView => ({ view: 'person:p', place: 'x', rung, setAt });

test('one row per thread, at its newest message, oldest row first; waiting if any message of it waits', () => {
  const rows = threadRows([e('lease', 100, true), e('moveout', 150), e('lease', 200), e('picnic', 50)]);
  expect(rows.map((r) => [r.place, r.ts, r.waits])).toEqual([
    ['picnic', 50, false],
    ['moveout', 150, false],
    ['lease', 200, true],
  ]);
  expect(rows[2].e.messageId).toBe('mml_lease_200');
  // Pages arrive in any order: the same rows.
  expect(threadRows([e('lease', 200), e('picnic', 50), e('lease', 100, true), e('moveout', 150)])).toEqual(rows);
});

test('a row is open while it waits, unless you chose; a choice older than the row is for the row before it', () => {
  const [waiting] = threadRows([e('a', 100, true)]);
  const [answered] = threadRows([e('b', 100)]);
  expect(rowOpen(null, waiting)).toBe(true);
  expect(rowOpen(null, answered)).toBe(false);
  expect(rowOpen(chose('closed', 120), waiting)).toBe(false);
  expect(rowOpen(chose('open', 120), answered)).toBe(true);
  // Closed yesterday, new mail since: the new row starts open again.
  expect(rowOpen(chose('closed', 90), waiting)).toBe(true);
  // Hidden is not open or closed: the row's own default if it were shown.
  expect(rowOpen(chose('hidden', 120), waiting)).toBe(true);
});

test('a click chooses the other state, or takes the choice back when that is the default', () => {
  const [waiting] = threadRows([e('a', 100, true)]);
  const [answered] = threadRows([e('b', 100)]);
  expect(toggled(true, waiting)).toBe('closed');
  expect(toggled(false, waiting)).toBeNull();
  expect(toggled(false, answered)).toBe('open');
  expect(toggled(true, answered)).toBeNull();
});
