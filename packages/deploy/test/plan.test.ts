/**
 * The deployer's choices (packages/deploy/src/plan.ts, docs/deploy.md "Deploying itself"): which commit ships, and
 * what the notice says.
 */
import { expect, test } from 'bun:test';
import { type Candidate, deployedNotice, failedNotice, pick, pullsOf, releasesInUse } from '../src/plan.ts';

const c = (sha: string, check: Candidate['check']): Candidate => ({ sha, check });

test('the newest commit that passed CI ships; nothing new is nothing', () => {
  expect(pick([], new Set())).toEqual({ none: 'nothing new' });
  expect(pick([c('ccc', 'success'), c('bbb', 'success')], new Set())).toEqual({ ship: 'ccc' });
  // A newer one still in CI does not hold back one that passed: it follows when its CI is done.
  expect(pick([c('ddd', 'pending'), c('ccc', 'success')], new Set())).toEqual({ ship: 'ccc' });
});

test('nothing passed yet: wait for CI; everything failed: nothing to ship', () => {
  expect(pick([c('ddd', 'pending'), c('ccc', 'failure')], new Set())).toEqual({ wait: "ddd's CI has not finished" });
  expect(pick([c('ddd', 'none')], new Set())).toEqual({ wait: "ddd's CI has not finished" });
  expect(pick([c('ddd', 'failure'), c('ccc', 'failure')], new Set())).toEqual({ none: 'no new commit passed CI' });
});

test('a commit that failed here is never tried again; an older one that passed is not shipped over it', () => {
  // ccc broke the hub and was rolled back; bbb is what runs (not in the list). Nothing ships until a newer one passes.
  expect(pick([c('ccc', 'success')], new Set(['ccc']))).toEqual({ none: 'every new commit failed here before' });
  expect(pick([c('ddd', 'pending'), c('ccc', 'success')], new Set(['ccc']))).toEqual({ wait: "ddd's CI has not finished" });
  expect(pick([c('ddd', 'success'), c('ccc', 'success')], new Set(['ccc']))).toEqual({ ship: 'ddd' });
});

test('a pull request labelled hold-deploy holds itself and everything after it; what came before still ships', () => {
  // ddd is #170 (held); eee came after it. ccc, before it, passed.
  const list = [c('eee', 'success'), { ...c('ddd', 'success'), held: 170 }, c('ccc', 'success')];
  expect(pick(list, new Set())).toEqual({ ship: 'ccc' });
  expect(pick(list.slice(0, 2), new Set())).toEqual({ none: '#170 has the hold-deploy label', held: 170 });
});

test("the notice names each pull request that came with a deploy, oldest first, and counts the rest", () => {
  const subjects = [
    'Chats: a quiet "last message on Signal" at the end of the message box\'s line when a message would go another way; a click sends through that route (#163)',
    'Merge main into net-gaps: the @ picker beside every gaps package',
    'Chats: where you came from guesses the route only when they are there: from a DM with someone else (#162)',
  ];
  expect(pullsOf(subjects).map((p) => p.number)).toEqual([162, 163]);
  expect(deployedNotice('dither-chat', 'a14daa9b42e7aaaa', subjects)).toEqual({
    title: 'Deployed dither-chat a14daa9',
    body: [
      '#162 Chats: where you came from guesses the route only when they are there',
      // Clipped to 90 characters.
      '#163 Chats: a quiet "last message on Signal" at the end of the message box\'s line when a messa…',
      '1 other commit',
    ].join('\n'),
  });
  expect(deployedNotice('dither-chat', 'a14daa9', []).body).toBe('No new commits on its branch.');
});

test('a failed deploy says what was tried, why, what runs now, and that it will not be tried again', () => {
  const n = failedNotice('dither-chat', 'f4190cc2cf3c', 'timed out after 300 s waiting for the hub to log "startup: ready"', 'a14daa9b42e7', true);
  expect(n.title).toBe('Rolled back dither-chat from f4190cc');
  expect(n.body).toContain('dither-chat runs a14daa9 again.');
  expect(n.body).toContain('will not try f4190cc again');
  expect(failedNotice('dither-accounts', 'aaaaaaa', 'bun install failed', 'bbbbbbb', false).title).toBe('Did not deploy dither-accounts aaaaaaa');
  expect(failedNotice('dither-chat', 'aaaaaaa', 'x', null, true).body).toContain('may be down');
});

test("a release a running process uses is kept: its working directory or a path on its command line is in it", () => {
  const rel = '/srv/deploy/accounts/releases';
  const used = releasesInUse(rel + '/', [
    // The manager, run from the current release.
    { cwd: `${rel}/ccc`, cmdline: ['bun', 'packages/manager/src/main.ts'] },
    // An extractor that outlived the manager's restarts: started many deploys ago, from its own release.
    { cwd: `${rel}/aaa`, cmdline: ['bun', `${rel}/aaa/extractors/telegram/src/main.ts`] },
    { cwd: '/tmp', cmdline: ['bun', `${rel}/bbb/extractors/discord/src/main.ts`] },
    // Not a release: the folder itself, a release being built, another app's, nothing.
    { cwd: rel, cmdline: [] },
    { cwd: `${rel}/.new-ddd`, cmdline: [] },
    { cwd: '/srv/deploy/chat/releases/eee', cmdline: [`${rel}x/fff`] },
    { cwd: null, cmdline: [] },
  ]);
  expect([...used].sort()).toEqual(['aaa', 'bbb', 'ccc']);
});
