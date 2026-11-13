/**
 * Bots and apps on the page (apps.ts, docs/apps.md): outcomes and forms heard from the hub, the words a status line
 * shows, and the composer's send claimed by a picked slash command.
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { commandProblem, modalProblem } from '@dither-chat/protocol';
import { stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { claimSend, claimSends, closeForm, forms, interactions, stateWords } = await import('../src/apps.ts');
const { eventHooks } = (await import('../src/state.ts')) as unknown as { eventHooks: Set<(ev: P.ClientEvent) => void> };

const hear = (ev: P.ClientEvent) => eventHooks.forEach((h) => h(ev));
const outcome = (nonce: string, state: P.InteractionState, error?: string): P.InteractionView => ({ nonce, conversationId: 'cnv_a', messageId: 'msg_a', state, ts: 1, ...(error ? { error } : {}) });

test('outcomes are kept by nonce, the latest state of each', () => {
  hear({ t: 'interaction', interaction: outcome('n1', 'sending') });
  hear({ t: 'interaction', interaction: outcome('n1', 'answered') });
  expect(interactions.value.get('n1')?.state).toBe('answered');
  expect(stateWords(outcome('x', 'sending'))).toBe('Sending…');
  expect(stateWords(outcome('x', 'failed'))).toBe('This interaction failed');
  expect(stateWords(outcome('x', 'failed', 'Unknown interaction'))).toBe('This interaction failed: Unknown interaction');
  expect(stateWords(outcome('x', 'timedOut'))).toBe('No answer came back');
});

test('a form a bot opened waits for the dialog once, and closes', () => {
  const f: P.AppModalView = { id: 'f1', nonce: 'n2', conversationId: 'cnv_a', accountId: 'acc', network: 'discord', app: { id: 'app', name: 'Helper' }, title: 'Ticket', fields: [], at: 1 };
  hear({ t: 'appModal', modal: f });
  hear({ t: 'appModal', modal: f });
  expect(forms.value.map((x) => x.id)).toEqual(['f1']);
  closeForm(f);
  expect(forms.value).toEqual([]);
});

test('a picked command claims the composer’s send; with none picked the text goes', () => {
  let ran = 0;
  claimSends('cnv_a', () => (ran++, true));
  expect(claimSend('cnv_a')).toBe(true);
  expect(claimSend('cnv_b')).toBe(false);
  claimSends('cnv_a', null);
  expect(claimSend('cnv_a')).toBe(false);
  expect(ran).toBe(1);
});

test('form and command checks, as the dialog and the picker apply them', () => {
  const fields: P.ModalFieldFact[] = [
    { kind: 'text', id: 's', label: 'Subject', style: 'short', required: true, minLength: 3 },
    { kind: 'checkboxes', id: 'c', label: 'Areas', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], max: 1 },
    { kind: 'file', id: 'f', label: 'Log' },
  ];
  expect(modalProblem(fields, [])).toBe('Subject is required');
  expect(modalProblem(fields, [{ field: 's', value: 'ab' }])).toBe('Subject needs at least 3 characters');
  expect(modalProblem(fields, [{ field: 's', value: 'abc' }, { field: 'c', values: ['a', 'b'] }])).toBe('Areas: pick at most 1');
  expect(modalProblem(fields, [{ field: 's', value: 'abc' }, { field: 'c', values: ['a'] }])).toBeNull();
  const cmd: P.AppCommandFact = { id: '1', name: 'roll', app: 'a', kind: 'chat', options: [{ name: 'sides', type: 'integer', min: 2 }, { name: 'file', type: 'attachment' }] };
  expect(commandProblem(cmd, [{ name: 'sides', value: 1 }])).toBe('sides is at least 2');
  expect(commandProblem(cmd, [{ name: 'file', value: 'x' }])).toBe('file wants a file: run this command on the network');
  expect(commandProblem(cmd, [])).toBeNull();
});
