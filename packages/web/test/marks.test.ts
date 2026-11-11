/** src/marks.ts: the two toggles on a decision, and the one function that posts a mark and applies the hub's answer. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { alertToggle, isTier, lessToggle, oldVote, sendMark, withMarks, type MarkAnswer, type MarkDeps } from '../src/marks.ts';

const triage = (decision: P.TriageDecision, marks?: P.TriageMarks, feedback: P.NotifyTier | null = null): P.TriageView => ({ decision, score: 0.5, reasons: [], decidedBy: 'model', feedback, ...(marks ? { marks } : {}) });

/** The hub and the page's state, stood in for: what was posted, and every set of marks put on the message in turn. */
function deps(answer: MarkAnswer | Error | null = {}) {
  const posted: { path: string; body: unknown }[] = [];
  const applied: { id: string; marks: P.TriageMarks }[] = [];
  const learned: P.TriagePolicyView[] = [];
  const failed: string[] = [];
  /** What was on the message when the hub was asked: the mark shows before the answer. */
  let shownAtPost: P.TriageMarks | undefined;
  const d: MarkDeps = {
    post: async (path, body) => {
      posted.push({ path, body });
      shownAtPost = applied.at(-1)?.marks;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    apply: (id, marks) => void applied.push({ id, marks }),
    learned: (p) => void learned.push(p),
    failed: (e) => void failed.push(e.message),
  };
  return { d, posted, applied, learned, failed, shownAtPost: () => shownAtPost };
}

test('"Should have alerted" off an alert, "Alert was wrong" on one; a ticked one takes the mark back', () => {
  for (const d of ['quiet', 'digest', 'drop'] as const) {
    expect(alertToggle(triage(d))).toEqual({ label: 'Should have alerted', on: false, send: true });
    expect(alertToggle(triage(d, { alert: true }))).toEqual({ label: 'Should have alerted', on: true, send: null });
    // Marked wrong while it was an alert, then held: not ticked as "should have alerted".
    expect(alertToggle(triage(d, { alert: false })).on).toBe(false);
  }
  expect(alertToggle(triage('push'))).toEqual({ label: 'Alert was wrong', on: false, send: false });
  expect(alertToggle(triage('push', { alert: false }))).toEqual({ label: 'Alert was wrong', on: true, send: null });
  // "Should have alerted" on a message that then did alert is not "the alert was wrong".
  expect(alertToggle(triage('push', { alert: true }))).toEqual({ label: 'Alert was wrong', on: false, send: false });
});

test('"Less like this" is ticked by its mark alone, and a click on a ticked one takes it back', () => {
  expect(lessToggle(triage('digest'))).toEqual({ label: 'Less like this', on: false, send: true });
  expect(lessToggle(triage('digest', { less: true }))).toEqual({ label: 'Less like this', on: true, send: false });
  expect(lessToggle(triage('push', { alert: false }))).toEqual({ label: 'Less like this', on: false, send: true });
});

test('a change sets the keys it names and leaves the other; null and less: false take a mark back', () => {
  expect(withMarks(null, { alert: true })).toEqual({ alert: true });
  expect(withMarks({ alert: true }, { less: true })).toEqual({ alert: true, less: true });
  expect(withMarks({ alert: true, less: true }, { alert: null })).toEqual({ less: true });
  expect(withMarks({ alert: false, less: true }, { less: false })).toEqual({ alert: false });
  expect(withMarks({ less: true }, { less: null })).toEqual({});
  expect(withMarks({ alert: true }, { alert: false })).toEqual({ alert: false });
  expect(withMarks(undefined, {})).toEqual({});
});

test('only a tier can be marked: never a silenced place', () => {
  expect(['push', 'quiet', 'digest', 'drop'].map((d) => isTier(d as P.TriageDecision))).toEqual([true, true, true, true]);
  expect(isTier('silent')).toBe(false);
  expect(isTier(null)).toBe(false);
});

test('a mark is posted to the message, shown at once, and the marks in the answer are what stays', async () => {
  const policy = { votes: 1 } as P.TriagePolicyView;
  const h = deps({ marks: { alert: true, less: true }, policy });
  await sendMark({ id: 'msg_1', triage: triage('quiet', { less: true }) }, { alert: true }, h.d);
  expect(h.posted).toEqual([{ path: '/api/messages/msg_1/feedback', body: { alert: true } }]);
  // Before the hub answered, the message already carried the mark beside the one it had.
  expect(h.shownAtPost()).toEqual({ alert: true, less: true });
  expect(h.applied).toEqual([
    { id: 'msg_1', marks: { alert: true, less: true } },
    { id: 'msg_1', marks: { alert: true, less: true } },
  ]);
  expect(h.learned).toEqual([policy]);
  expect(h.failed).toEqual([]);
});

test("the hub's marks win over what was shown", async () => {
  // The hub keeps one alert mark: here it answers without the "less" the page still showed.
  const h = deps({ marks: { alert: false } });
  await sendMark({ id: 'msg_1', triage: triage('push', { less: true }) }, { alert: false }, h.d);
  expect(h.posted[0].body).toEqual({ alert: false });
  expect(h.applied.map((a) => a.marks)).toEqual([{ alert: false, less: true }, { alert: false }]);
  expect(h.learned).toEqual([]);
});

test('taking a mark back sends null for the alert, false for less', async () => {
  const a = deps({ marks: {} });
  await sendMark({ id: 'msg_1', triage: triage('quiet', { alert: true }) }, { alert: null }, a.d);
  expect(a.posted).toEqual([{ path: '/api/messages/msg_1/feedback', body: { alert: null } }]);
  expect(a.applied.map((x) => x.marks)).toEqual([{}, {}]);
  const l = deps({ marks: { alert: true } });
  await sendMark({ id: 'msg_1', triage: triage('quiet', { alert: true, less: true }) }, { less: false }, l.d);
  expect(l.posted).toEqual([{ path: '/api/messages/msg_1/feedback', body: { less: false } }]);
  expect(l.applied.map((x) => x.marks)).toEqual([{ alert: true }, { alert: true }]);
});

test('a refusal puts the old marks back and says why', async () => {
  const h = deps(new Error('This place is silenced: change its notification setting instead'));
  await sendMark({ id: 'msg_1', triage: triage('digest', { less: true }) }, { alert: true }, h.d);
  expect(h.applied.map((a) => a.marks)).toEqual([{ alert: true, less: true }, { less: true }]);
  expect(h.failed).toEqual(['This place is silenced: change its notification setting instead']);
  expect(h.learned).toEqual([]);
});

test('an answer without marks (a hub with no learning) keeps what was shown', async () => {
  const h = deps({});
  await sendMark({ id: 'msg_1', triage: triage('drop') }, { less: true }, h.d);
  expect(h.applied.map((a) => a.marks)).toEqual([{ less: true }]);
  const none = deps(null);
  await sendMark({ id: 'msg_1', triage: triage('drop') }, { less: true }, none.d);
  expect(none.applied.map((a) => a.marks)).toEqual([{ less: true }]);
  expect(none.failed).toEqual([]);
});

test('mail goes to its own route with only "less", true or false; an alert mark on mail sends nothing', async () => {
  const on = deps({ marks: { less: true } });
  await sendMark({ id: 'mml_1', triage: triage('digest') }, { less: true }, on.d);
  expect(on.posted).toEqual([{ path: '/api/mail/triage/mml_1/vote', body: { less: true } }]);
  expect(on.applied.map((a) => a.marks)).toEqual([{ less: true }, { less: true }]);
  const off = deps({ marks: {} });
  await sendMark({ id: 'mml_1', triage: triage('digest', { less: true }) }, { less: false }, off.d);
  expect(off.posted).toEqual([{ path: '/api/mail/triage/mml_1/vote', body: { less: false } }]);
  expect(off.applied.map((a) => a.marks)).toEqual([{}, {}]);
  const alert = deps({});
  await sendMark({ id: 'mml_1', triage: triage('digest') }, { alert: true }, alert.d);
  expect(alert.posted).toEqual([]);
  expect(alert.applied).toEqual([]);
});

test('nothing is sent for a silenced place, or for a message triage never decided on', async () => {
  const h = deps({});
  await sendMark({ id: 'msg_1', triage: triage('silent') }, { alert: true }, h.d);
  await sendMark({ id: 'msg_2', triage: null }, { less: true }, h.d);
  await sendMark({ id: 'msg_3' }, { less: true }, h.d);
  expect(h.posted).toEqual([]);
  expect(h.applied).toEqual([]);
});

test('a vote from before the tiers is said by its old name, and never for mail\'s "Less like this"', () => {
  expect(oldVote(triage('digest', undefined, 'push'))).toBe('Voted Important before the tiers');
  expect(oldVote(triage('digest', undefined, 'quiet'))).toBe('Voted Active before the tiers');
  expect(oldVote(triage('digest', undefined, 'digest'))).toBe('Voted Digest before the tiers');
  expect(oldVote(triage('digest', undefined, 'drop'))).toBe('Voted Not interesting before the tiers');
  expect(oldVote(triage('digest'))).toBe(null);
  // Mail keeps "Less like this" in the old vote's field: it is the tick, not history.
  expect(oldVote(triage('digest', { less: true }, 'drop'))).toBe(null);
  expect(oldVote(triage('digest', { less: true }, 'push'))).toBe('Voted Important before the tiers');
});
