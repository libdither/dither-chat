/**
 * Requests waiting on you (docs/add.md "Requests"), end to end against a demo hub in headless Chromium: the inbox's
 * Requests row counts the demo's five; profile buttons on the requester (Accept, Decline) and on a stranger (Add
 * friend, then "Request sent", still so after a reload), and none where no account can; the Requests view groups a
 * card per request and a link to one focuses it; accepting the Matrix invite lands in the room; the Signal message
 * request opens read-only, the bar in place of the composer, with no read receipt sent to the network, and accepting
 * brings the composer; declining the Discord friend request takes its card away, and the row with it; and the view
 * on a phone.
 *
 *   bun scripts/verify-requests.ts http://127.0.0.1:8810 [/tmp/shots]
 * It answers the demo's requests: point it at a fresh demo hub (--demo) with its own data dir.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8810';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const bootstrap = () => fetch(`${hub}/api/bootstrap`).then((r) => r.json()) as Promise<any>;
const boot = await bootstrap();
if (!boot.accounts.length || !boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const SIG = 'acc_demo-signal';
const DMAIN = 'acc_demo-discord-main';
const DALT = 'acc_demo-discord-alt';

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const action = (account: string, name: string, args?: unknown) =>
  fetch(`${hub}/api/accounts/${account}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, args }) }).then((r) => r.json()) as Promise<any>;

const { page: p, close } = await launch();
const click = async (sel: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const text = (sel: string) => p.eval<string>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText).join(' | ')`);
const has = (sel: string) => p.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const hash = () => p.eval<string>('decodeURIComponent(location.hash)');
const shot = async (name: string) => shots && (await p.shot(join(shots, `${name}.png`)));
const open = async (h: string, ready: string) => {
  await p.goto(`${hub}/${h}`);
  await p.until(`!!document.querySelector(${JSON.stringify(ready)})`, 20000);
};
// The networks have answered: nothing on the profile is still asking.
const settled = () => p.until(`!!document.querySelector('.profile-page .pf-hero') && !document.querySelector('.pf-asking')`, 10000);
const card = (kind: string) => `.request-card[data-kind="${kind}"]`;

const discord = (handle: string) => boot.identities.find((i: any) => i.network === 'discord' && i.handle === handle);
const nova = discord('nova.wav');
// Discord people seen in servers, no person here: strangers.
const selves = new Set(boot.accounts.map((a: any) => a.selfIdentityId));
const [tim, bea] = boot.identities.filter((i: any) => i.network === 'discord' && !i.personId && !selves.has(i.id) && i.handle && i.id !== nova?.id).sort((a: any, b: any) => a.handle.localeCompare(b.handle));
const held = boot.requests?.find((r: any) => r.kind === 'message');
// The alt account's two requests Discord flagged (verify-people-links.ts answers them).
const flagged = boot.requests?.filter((r: any) => r.warning).length ?? 0;
if (!nova || !tim || !bea || !held?.target?.id) throw new Error('the demo world lacks its requesters and strangers');

try {
  await p.size(1280, 820);
  await open('#/inbox', '.side-new');

  // 1. The inbox's Requests row: one row, with the count.
  check(boot.requests.length === 5 && flagged === 2, 'the demo has five requests, two of them flagged', boot.requests.map((r: any) => r.kind));
  await p.until(`!!document.querySelector('.requests-row')`, 5000);
  check((await text('.requests-row .requests-count')) === '5', 'the inbox has a Requests row with 5', await text('.requests-row'));
  check((await text('.requests-row .row-preview')).includes('Nova'), 'it says who asked', await text('.requests-row .row-preview'));
  const rows = await p.eval<string[]>(`[...document.querySelectorAll('.sidebar .side-scroll [data-row]')].map((el) => el.dataset.row)`);
  check(!rows.includes(held.target.id), 'the message request is not a row of its own');
  await shot('requests-01-inbox');
  await open('#/people', '.sidebar .row');
  check(!(await text('.sidebar')).includes('Jamie'), 'nor among People');

  // 2. Profile buttons. The requester: Accept and Decline. A stranger: Add friend, then "Request sent".
  await open(`#/i/${nova.id}`, '.profile-page');
  await settled();
  check((await has('.pf-action[data-action="accept"]')) && (await has('.pf-action[data-action="decline"]')), 'on the requester: Accept and Decline', await text('.pf-action'));
  check((await text('.pf-tag')).includes('Wants to be friends'), 'and the tag says they asked', await text('.pf-tag'));
  await shot('requests-02-requester');
  await open(`#/i/${tim.id}`, '.profile-page');
  await settled();
  check(await has('.pf-action[data-action="friend"]'), 'on a stranger: Add friend', await text('.pf-action'));
  await click('.pf-action[data-action="friend"]');
  // The hero's tag and Connections say it (docs/profile.md "Connections"), not a button.
  await p.until(`!!document.querySelector('.pf-tag[data-kind="requested"]')`, 8000);
  check((await text('.pf-tag[data-kind="requested"]')).includes('Request sent') && !(await has('.pf-action[data-action="friend"]')), 'Add friend becomes "Request sent"', await text('.pf-tag'));
  await p.eval('location.reload()').catch(() => {});
  await Bun.sleep(600);
  await p.until(`!!document.querySelector('.profile-page')`, 20000);
  await settled();
  check((await text('.pf-tag[data-kind="requested"]')).includes('Request sent') && (await text('.pf-standing')).includes('Friend request sent on Discord'), 'and still so after a reload', await text('.pf-tag'));
  await shot('requests-03-sent');
  // Without the connect capability on either Discord account: no button at all.
  await action(DMAIN, 'capabilities', { without: ['connect'] });
  await action(DALT, 'capabilities', { without: ['connect'] });
  await Bun.sleep(400);
  await open(`#/i/${bea.id}`, '.profile-page');
  await settled();
  check(!(await has('.pf-action[data-action="friend"]')), 'no Add friend where no account can', await text('.pf-action'));
  await action(DMAIN, 'capabilities', {});
  await action(DALT, 'capabilities', {});
  await Bun.sleep(400);

  // 3. On a phone: the Requests view is a full-screen list of the same cards.
  await p.size(390, 844, true);
  await open('#/inbox', '.side-new');
  await p.until(`!!document.querySelector('.requests-row')`, 5000);
  await click('.requests-row');
  await p.until(`location.hash.startsWith('#/requests') && document.querySelectorAll('.request-card').length === 5`, 8000);
  const fit = await p.eval<{ w: number; scroll: number; pane: number }>(
    `(() => ({ w: innerWidth, scroll: document.documentElement.scrollWidth, pane: document.querySelector('.requests-pane').getBoundingClientRect().width }))()`,
  );
  check(fit.scroll <= fit.w + 1 && fit.pane >= fit.w - 1, 'on a phone it is a full-screen list that fits', fit);
  await shot('requests-04-phone');
  await p.size(1280, 820);

  // 4. The Requests view: grouped, one card each, and a link to one focuses it.
  const invite = boot.requests.find((r: any) => r.kind === 'invite');
  await open(`#/requests/${invite.id}`, '.request-card');
  const groups = await p.eval<string[]>(`[...document.querySelectorAll('.requests-group h3')].map((h) => h.textContent.trim())`);
  check(groups.length === 3 && groups[0].startsWith('Friend requests') && groups[1].startsWith('Invites') && groups[2].startsWith('Message requests'), 'grouped by kind', groups);
  const inv = await text(card('invite'));
  check(inv.includes('Jules') && inv.includes('invited you to Nix Hackathon 2026') && inv.includes('23 members') && inv.includes('Matrix'), 'the invite card: who, the room, its members, the network', inv);
  check(await has(`${card('invite')}.focused`), 'a link to a request focuses its card');
  const nova1 = `.request-card[data-request="${boot.requests.find((r: any) => r.from === nova.id).id}"]`;
  check((await text(`${nova1} [data-answer]`)) === 'Accept | Decline | Block | Message', 'the buttons the request offers, and Message', await text(`${nova1} [data-answer]`));
  check((await text(card('message'))).includes('got your number from the climbing gym list'), 'the message request shows what they wrote');
  await shot('requests-05-view');

  // 5. Accept the Matrix invite: it lands in the room.
  await click(`${card('invite')} [data-answer="accept"]`);
  await p.until(`location.hash.includes('/c/')`, 8000);
  const room = (await bootstrap()).conversations.find((c: any) => c.name === 'Nix Hackathon 2026');
  check(room && (await hash()).includes(room.id), 'accepting the invite lands in the room', await hash());
  await p.until(`!!document.querySelector('.composer')`, 8000);
  await p.until(`document.querySelector('.timeline-scroll')?.innerText.includes('welcome!')`, 8000).catch(() => {});
  check((await text('.timeline-scroll')).includes('welcome! we are picking a date this week'), 'with what was said there');

  // 6. The Signal message request: read-only, nothing told to Signal, then Accept brings the composer.
  await open('#/requests', '.request-card');
  await click(`${card('message')} .request-read`);
  await p.until(`!!document.querySelector('.request-bar')`, 8000);
  check((await hash()).includes(held.target.id), 'Read what they wrote opens the conversation', await hash());
  check(!(await has('.composer')) && (await text('.request-bar')).includes('until you accept'), 'read-only: the request bar stands in for the composer', await text('.request-bar'));
  await p.until(`document.querySelector('.timeline-scroll')?.innerText.includes('are you still selling the 9.8 rope?')`, 8000).catch(() => {});
  check((await text('.timeline-scroll')).includes('are you still selling the 9.8 rope?'), 'what they wrote is there to read');
  await shot('requests-06-held');
  // The page marks it read here as it does any conversation; the hub keeps that from Signal.
  await Bun.sleep(1500);
  const after = (await bootstrap()).conversations.find((c: any) => c.id === held.target.id);
  const reads = (await action(SIG, 'readLog')).result?.reads ?? [];
  check(after?.vantages?.every((v: any) => !v.unread), 'read here', after?.vantages);
  check(Array.isArray(reads) && !reads.length, 'and no read receipt went to Signal', reads);
  await click('.request-bar [data-answer="accept"]');
  await p.until(`!!document.querySelector('.composer') && !document.querySelector('.request-bar')`, 8000);
  check(true, 'accepting brings the composer');

  // 7. Decline the Discord friend requests: their cards go, and the row with the last one.
  await open('#/requests', '.request-card');
  check((await p.eval<number>(`document.querySelectorAll('.request-card').length`)) === 3, 'three requests left: the friend requests');
  for (let left = 3; left > 0; left--) {
    await click(`${card('friend')} [data-answer="decline"]`);
    await p.until(`document.querySelectorAll('.request-card').length === ${left - 1}`, 8000);
  }
  check((await text('.requests-pane')).includes('Nothing waiting on you'), 'declined, their cards are gone');
  check(!(await has('.requests-row')) && !(await bootstrap()).requests.length, 'and the Requests row with it');
  await shot('requests-07-empty');

  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log('all passed');
