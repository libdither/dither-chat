/** An event's words for its card and its page (ui/events/eventfmt.ts, docs/events.md "The event card"). */
import { expect, test } from 'bun:test';
import { dateBlock, eventWhen, eventWhere, goingLine, rsvpChoices, rsvpWords } from '../src/ui/events/eventfmt.ts';

// 2030-03-15 20:00 UTC: a Friday.
const AT = Date.UTC(2030, 2, 15, 20, 0);

test('the date block is the day in the event’s own zone', () => {
  expect(dateBlock({ start: AT, timeZone: 'UTC' })).toMatchObject({ day: '15' });
  // Already the next morning in Tokyo.
  expect(dateBlock({ start: AT, timeZone: 'Asia/Tokyo' })).toMatchObject({ day: '16' });
});

test('the time is said there, and here only when your clock differs', () => {
  const same = eventWhen({ start: AT, end: AT + 3 * 3_600_000, timeZone: 'UTC' }, 'UTC');
  expect(same.here).toBeNull();
  expect(same.there).toContain('–');
  const away = eventWhen({ start: AT, timeZone: 'Asia/Tokyo' }, 'UTC');
  expect(away.here).toMatch(/your time$/);
  // Another day there than here: the weekday is said.
  expect(away.here).toMatch(/^\S+ /);
  expect(eventWhen({ start: AT }, 'UTC').here).toBeNull();
});

test('where: the place, Online, or the address after you RSVP', () => {
  expect(eventWhere({ place: { name: 'Lantern Hall', city: 'Brightwater' } })).toBe('Lantern Hall, Brightwater');
  expect(eventWhere({ place: { name: 'Lantern Hall, Brightwater', city: 'Brightwater' } })).toBe('Lantern Hall, Brightwater');
  expect(eventWhere({ online: true })).toBe('Online');
  expect(eventWhere({})).toBe('Address shown after you RSVP');
});

test('who is going, as the host shows it', () => {
  expect(goingLine({ going: 42, guestsShown: 'all' })).toBe('42 going');
  expect(goingLine({ guests: ['a', 'b'], guestsShown: 'all' }, 3)).toBe('5 going');
  expect(goingLine({ guestsShown: 'hidden' })).toBe('Guest list hidden by the host');
  expect(goingLine({ going: 9, guestsShown: 'hidden' })).toBe('9 going · guest list hidden');
  expect(goingLine({ going: 12, guestsShown: 'count' })).toBe('12 going');
});

test('your RSVP in words, and each site’s buttons', () => {
  expect(rsvpWords({ hosting: true, rsvp: 'going' })).toBe('Hosting');
  expect(rsvpWords({ rsvp: 'going' })).toBe("You're going");
  expect(rsvpWords({})).toBeNull();
  expect(rsvpChoices('luma').map((c) => c.status)).toEqual(['going', 'interested', 'declined']);
  expect(rsvpChoices('partiful').map((c) => c.status)).toEqual(['going', 'maybe', 'declined']);
});
