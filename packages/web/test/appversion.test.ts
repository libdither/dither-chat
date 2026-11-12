import { expect, test } from 'bun:test';
import { takesClear } from '../src/appversion.ts';

test('the Android app takes a clear push from 0.7; an unknown or older version does not', () => {
  for (const v of ['0.7.0', '0.12.0', '0.12.1', '1.0.0']) expect(takesClear(v)).toBe(true);
  for (const v of ['0.6.1', '0.1.0', '', 'dev', null, undefined]) expect(takesClear(v)).toBe(false);
});
