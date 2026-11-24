import { expect, test } from 'bun:test';
import { bareSubject } from '../src/mail.ts';

test('a shown subject drops stacked reply and forward prefixes', () => {
  expect(bareSubject('Re: Lease renewal')).toBe('Lease renewal');
  expect(bareSubject('RE: Fwd: re[2]: Lease renewal ')).toBe('Lease renewal');
  expect(bareSubject('AW: Termin')).toBe('Termin');
  expect(bareSubject('Lease renewal')).toBe('Lease renewal');
  expect(bareSubject('Rebooking: Friday')).toBe('Rebooking: Friday');
  expect(bareSubject('')).toBe('');
});
