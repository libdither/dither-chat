/**
 * Notification levels and votes (docs/notifications.md), end to end against a demo hub in headless Chromium: the
 * Triage board's Important, Active and Digest lists, the digest by how much each matters, and what fell below it; a
 * vote moving a message between them at once; what the model learned from it, with its backtest; the next message in
 * that place landing where the vote said; the level picker and the model's chances in a message's menu; forgetting
 * what it learned; and your message's read ticks after its text.
 *
 *   bun scripts/verify-notifications.ts http://127.0.0.1:8492 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this votes and sends.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8492';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const get = (path: string) => fetch(`${hub}${path}`).then((r) => r.json()) as Promise<any>;
const post = (path: string, body: unknown) => fetch(`${hub}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: hub }, body: JSON.stringify(body) });

const boot = await get('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const lists = () =>
  p.eval<Record<string, string[]>>(`(() => {
    const out = {};
    for (const b of document.querySelectorAll('.board-block')) {
      const h = b.querySelector('h3')?.textContent.trim() ?? '';
      out[h] = [...b.querySelectorAll('[data-mid]')].map((x) => x.dataset.mid);
    }
    return out;
  })()`);

try {
  await p.size(1280, 900);
  // Important DM messages: a DM notifies on everything, and in the demo the other side answers.
  const shape = new Map(boot.conversations.map((c: any) => [c.id, c.shape]));
  const inbox = await get('/api/inbox');
  const pushed = inbox.items.map((i: any) => i.message).filter((m: any) => m.triage?.decision === 'push' && shape.get(m.conversationId) === 'direct');
  check(pushed.length > 0, 'the demo world has Important DM messages', pushed.length);

  await p.goto(`${hub}/#/triage`);
  await p.until(`!!document.querySelector('.board-block .ping')`, 15000);
  await Bun.sleep(600);
  let l = await lists();
  const heads = Object.keys(l);
  check(['Important', 'Active', 'Digest'].every((h) => heads.includes(h)), 'the board lists Important, Active and Digest', heads);
  const scores = await p.eval<number[]>(`(() => { const b = [...document.querySelectorAll('.board-block')].find((x) => x.querySelector('h3')?.textContent.trim() === 'Digest'); return [...b.querySelectorAll('[data-mid]')].map((x) => x.dataset.mid); })()`).then(
    async (ids) => ids.map((id) => inbox.items.find((i: any) => i.message.id === id)?.message.triage.score ?? -1),
  );
  check(scores.length > 1 && scores.every((x, i) => i === 0 || x <= scores[i - 1] || x === -1), 'the digest, what matters most first', scores.slice(0, 8));
  check(await p.eval<boolean>(`!!document.querySelector('details.below summary')`), 'what fell below the digest, to vote up');
  if (shots) await p.shot(`${shots}/notif-01-board.png`);

  // Vote an Important DM message down: it moves to Active at once.
  const first = l['Important'].find((id) => pushed.some((m: any) => m.id === id));
  check(!!first, 'an Important message on the board', first);
  await p.eval(`document.querySelector('[data-mid="${first}"] .tier-vote button:last-child').click()`);
  await Bun.sleep(150);
  l = await lists();
  check(l['Active'].includes(first!) && !l['Important'].includes(first!), 'voting it down moves it to Active at once');
  await Bun.sleep(800);
  const policy = await get('/api/triage/policy');
  const top = policy.factors[0];
  check(policy.votes === 1 && top?.head === 'ping' && top.weight < 0 && top.text.startsWith('In your DM with'), 'learned from the vote: less likely to ping in that DM', policy.factors.slice(0, 3).map((f: any) => `${f.head} ${f.weight} ${f.text}`));
  check(policy.errors === 0 && policy.baseline === 1, 'its backtest: right where the networks alone were wrong', { errors: policy.errors, baseline: policy.baseline });
  const learned = await p.eval<string>(`document.querySelector('.learned')?.innerText ?? ''`);
  check(learned.includes(top.text) && /1 vote/.test(learned), 'the board shows what it learned and the vote count', learned.split('\n').slice(0, 6));
  if (shots) await p.shot(`${shots}/notif-02-voted.png`);

  // The next message there lands where the vote said: answer them, and the demo answers back.
  const conv = pushed.find((m: any) => m.id === first).conversationId;
  const before = new Set((await get('/api/inbox')).items.map((x: any) => x.message.id));
  check((await post(`/api/conversations/${conv}/send`, { body: 'ok, noted' })).ok, 'answered that DM');
  let next: any = null;
  for (let i = 0; i < 60 && !next; i++) {
    await Bun.sleep(250);
    next = (await get('/api/inbox')).items.map((x: any) => x.message).find((m: any) => m.conversationId === conv && !before.has(m.id) && m.triage);
  }
  check(next?.triage?.decision === 'quiet' && next.triage.decidedBy === 'learned', 'their answer is Active, learned from your vote', next?.triage);

  // Up again from the notification's point of view: the API takes a vote relative to where it is now.
  const up = await post(`/api/messages/${first}/feedback`, { vote: 'up' });
  check(up.ok && (await up.json()).feedback === 'push', 'a vote up from the notification puts it back to Important');

  // The menu's level picker.
  await p.goto(`${hub}/#/inbox/c/${conv}`);
  await p.until(`document.querySelectorAll('.msg').length > 0`, 15000);
  await Bun.sleep(400);
  const pill = await p.eval<boolean>(`(() => { const b = [...document.querySelectorAll('.msg-actions button[aria-label^="Notification"]')].at(-1); if (!b) return false; b.click(); return true; })()`);
  if (pill) {
    await Bun.sleep(300);
    const picker = await p.eval<string[]>(`[...document.querySelectorAll('.triage-pop .tier-picker button')].map((b) => b.textContent.trim())`);
    check(picker.join() === 'Important,Active,Digest,Not interesting', 'a message’s pill offers the four levels', picker);
    const chances = await p.eval<string[]>(`[...document.querySelectorAll('.triage-pop .triage-chance > span:first-child')].map((b) => b.textContent.trim())`);
    check(chances.join() === 'Important,Active,Digest', 'and the model’s three chances', chances);
    if (shots) await p.shot(`${shots}/notif-03-pill.png`);
  } else console.log('skip the pill (no triaged message in view)');

  // Forgetting what it learned.
  const key = top.key;
  const forgot = await (await post(`/api/triage/factors/${encodeURIComponent(key)}`, { rejected: true })).json();
  check(!forgot.factors.some((r: any) => r.key === key) && forgot.rejected.some((r: any) => r.key === key), 'what it forgot is gone and listed as forgotten');

  // Read ticks: after the text of your message, not by your name.
  const climb = boot.conversations.find((c: any) => c.name === 'Climbing crew 🧗')?.id;
  await p.goto(`${hub}/#/inbox/c/${climb}`);
  await p.until(`!!document.querySelector('.msg-ticks')`, 15000);
  const where = await p.eval<{ head: number; body: number }>(`({ head: document.querySelectorAll('.msg-head .msg-ticks').length, body: document.querySelectorAll('.msg-body .msg-ticks').length })`);
  check(where.head === 0 && where.body > 0, 'read ticks sit after the text, not by the name', where);
  if (shots) await p.shot(`${shots}/notif-04-ticks.png`);
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
