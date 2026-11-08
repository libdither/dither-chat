import { expect, test } from 'bun:test';
import { actionError, ARM_MS, isOwnSession, loginLink, NOT_A_SIGN_IN, roughlyIn, type SessionInfo, sessionApp, sessionPlace, step, type Step, undoBlockedUntil } from '../src/tglogin.ts';

const TOKEN = 'xHkT1UCz1_k09XuDTCA_JjJ0AggmR_xE2AjkpD-X7t0';
const LINK = `tg://login?token=${TOKEN}`;

test('only tg://login?token= links are sign-in codes', () => {
  expect(loginLink(LINK)).toBe(LINK);
  expect(loginLink(`  ${LINK}\n`)).toBe(LINK);
  expect(loginLink(`TG://Login?token=${TOKEN}`)).toBe(LINK);
  // Anything after the token stays behind.
  expect(loginLink(`${LINK}&x=1`)).toBe(LINK);
  expect(loginLink(`tg://login?token=${TOKEN}%3D`)).toBe(`${LINK}=`);
  for (const bad of [
    '',
    TOKEN,
    `https://t.me/login?token=${TOKEN}`,
    `tg://resolve?domain=someone`,
    `tg://login?code=${TOKEN}`,
    `tg://login?x=1&token=${TOKEN}`,
    'tg://login?token=',
    'tg://login?token=short',
    `tg://login?token=${TOKEN}+/`,
    `tg://login?token=${TOKEN} more`,
    `tg://login?token=%E0%A4%A`,
    `xtg://login?token=${TOKEN}`,
    `tg://login?token=${'A'.repeat(1500)}`,
  ])
    expect(loginLink(bad)).toBeNull();
});

test('a session in words', () => {
  expect(sessionPlace({ country: 'Netherlands', region: 'Utrecht' })).toBe('Utrecht, Netherlands');
  expect(sessionPlace({ country: 'Germany', region: null })).toBe('Germany');
  expect(sessionPlace({ country: null, region: ' ' })).toBeNull();
  expect(sessionApp({ app: 'Telegram Web', appVersion: '2.2 K', platform: 'Web' })).toBe('Telegram Web 2.2 K · Web');
  expect(sessionApp({ app: '', appVersion: '', platform: '' })).toBe('An unnamed app');
  expect(actionError(new Error('action failed: That code has expired'))).toBe('That code has expired');
  expect(actionError(new Error('That code has expired'))).toBe('That code has expired');
});

const session = { hash: '8261569863840352993', device: 'Chrome 131, Linux', platform: 'Web', app: 'Telegram Web', appVersion: '2.2 K', country: 'Netherlands', region: 'Utrecht', createdAt: 1 };

test('a read code leads to the warning, never straight to approving', () => {
  let s: Step = { at: 'scan' };
  s = step(s, { t: 'read', text: 'https://example.com', now: 1000 });
  expect(s).toEqual({ at: 'scan', refused: NOT_A_SIGN_IN });
  s = step(s, { t: 'read', text: LINK, now: 1000 });
  expect(s).toEqual({ at: 'confirm', link: LINK, armedAt: 1000 + ARM_MS });
  // More reads from the same camera change nothing.
  expect(step(s, { t: 'read', text: `tg://login?token=${'B'.repeat(43)}`, now: 1100 })).toBe(s);
  // A press before it is armed (a tap meant for the step before) does nothing.
  expect(step(s, { t: 'approve', now: 1000 + ARM_MS - 1 })).toBe(s);
  // The answer to a request never sent does nothing either.
  expect(step(s, { t: 'approved', session })).toBe(s);
  s = step(s, { t: 'approve', now: 1000 + ARM_MS });
  expect(s).toEqual({ at: 'approving', link: LINK });
  expect(step(s, { t: 'approve', now: 9999 })).toBe(s);
  expect(step(s, { t: 'failed', error: 'That code has expired: show a new one on the other device' })).toEqual({ at: 'failed', error: 'That code has expired: show a new one on the other device' });
  s = step(s, { t: 'approved', session });
  expect(s).toEqual({ at: 'approved', session });
});

test('signing the approved session out again', () => {
  let s: Step = { at: 'approved', session };
  s = step(s, { t: 'ending' });
  expect(s).toEqual({ at: 'approved', session, ending: true, error: undefined });
  expect(step(s, { t: 'ending' })).toBe(s);
  const failed = step(s, { t: 'endFailed', error: 'Telegram does not let a session that is less than a day old end other sessions' });
  expect(failed).toEqual({ at: 'approved', session, ending: false, error: 'Telegram does not let a session that is less than a day old end other sessions' });
  s = step(step(failed, { t: 'ending' }), { t: 'ended' });
  expect(s).toEqual({ at: 'approved', session, ending: false, ended: true, error: undefined });
  expect(step(s, { t: 'ending' })).toBe(s);
  expect(step(s, { t: 'again' })).toEqual({ at: 'scan' });
});

test("the undo is blocked while this account's own session is under a day old", () => {
  const H = 3_600_000;
  const now = 100 * 24 * H;
  const row = (hash: string, current: boolean, createdAt: number): SessionInfo => ({ ...session, hash, current, createdAt, activeAt: now });
  // Telegram's ids are 64-bit: a negative one, kept as the string it came as.
  const others = [row('-4783920175539012345', false, now - H), row('1290348756102938475', false, now - 40 * 24 * H)];
  expect(undoBlockedUntil([row('0', true, now - 3 * H), ...others], now)).toBe(now + 21 * H);
  expect(roughlyIn(21 * H)).toBe('about 21 hours');
  expect(roughlyIn(H)).toBe('about 1 hour');
  expect(roughlyIn(20 * 60_000)).toBe('under an hour');
  expect(undoBlockedUntil([row('0', true, now - 25 * H), ...others], now)).toBeNull();
  // Another young session does not count, nor does a list not loaded.
  expect(undoBlockedUntil(others, now)).toBeNull();
  expect(undoBlockedUntil(null, now)).toBeNull();
  expect(isOwnSession(row('0', true, 0))).toBe(true);
  expect(isOwnSession({ hash: '0', current: false })).toBe(true);
  expect(isOwnSession(others[0])).toBe(false);
});
