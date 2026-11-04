/**
 * Notification levels and votes (docs/notifications.md), end to end against a demo hub in headless Chromium: the
 * Triage board's Important, Active and Digest lists; a vote moving a message between them at once; a rule learned
 * from votes, shown with its backtest; the next message in that place landing where the votes said; the level picker
 * in a message's menu; and dropping a rule.
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
  if (shots) await p.shot(`${shots}/notif-01-board.png`);

  // Vote an Important DM message down: it moves to Active at once.
  const first = l['Important'].find((id) => pushed.some((m: any) => m.id === id));
  check(!!first, 'an Important message on the board', first);
  await p.eval(`document.querySelector('[data-mid="${first}"] .tier-vote button:last-child').click()`);
  await Bun.sleep(150);
  l = await lists();
  check(l['Active'].includes(first) && !l['Important'].includes(first), 'voting it down moves it to Active at once');
  await Bun.sleep(800);
  const policy = await get('/api/triage/policy');
  check(policy.votes === 1 && policy.rules.length >= 1 && policy.rules[0].level === 'quiet', 'a rule learned from the vote', policy.rules.map((r: any) => r.text));
  check(policy.errors === 0 && policy.baseline === 1, 'its backtest: right where triage alone was wrong', { errors: policy.errors, baseline: policy.baseline });
  const learned = await p.eval<string>(`document.querySelector('.learned')?.innerText ?? ''`);
  check(learned.includes(policy.rules[0].text) && /1 vote/.test(learned), 'the board shows the rule and the vote count', learned.split('\n').slice(0, 3));
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
    check(picker.join() === 'Important,Active,Digest', 'a message’s pill offers the three levels', picker);
  } else console.log('skip the pill (no triaged message in view)');

  // Dropping the rule.
  const key = policy.rules[0].key;
  const dropped = await (await post(`/api/triage/rules/${encodeURIComponent(key)}`, { rejected: true })).json();
  check(!dropped.rules.some((r: any) => r.key === key) && dropped.rejected.some((r: any) => r.key === key), 'a dropped rule is gone and listed as dropped');
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
