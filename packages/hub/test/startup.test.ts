import { expect, test } from 'bun:test';
import { StartupTrace, stepTimer } from '../src/startup.ts';

test('the startup line: each phase from the end of the one before, and the whole from the process start', () => {
  let now = 0;
  const clock = () => now;
  const trace = new StartupTrace(clock);
  now = 120;
  trace.mark('code');
  const store = stepTimer(clock);
  now = 125;
  store.step('db open');
  now = 1125;
  store.step('migrations');
  trace.add(store.out);
  now = 2400;
  trace.mark('adapters');
  expect(trace.line()).toBe('startup: ready in 2.4 s (code 120 ms, db open 5 ms, migrations 1000 ms, adapters 1275 ms)');
});
