/**
 * Notification levels and votes (docs/notifications.md), end to end against a demo hub in headless Chromium: the
 * Triage board's Important, Active and Digest lists, the digest by how much each matters, and what fell below it; a
 * vote moving a message between them at once; what the model learned from it, with its backtest; the next message in
 * that place landing where the vote said; the level picker and the model's chances in a message's menu; forgetting
 * what it learned; and your message's read ticks after its text.
 *
 * Mail (slice 9, docs/mail.md), when the demo hub has its mail account: an answer from someone you write to arrives
 * as an Important notification with the email mark; the board lists it with the envelope and a vote moves it at once;
 * what was learned names Sam; the reader's Notification button offers the four levels; Email off for this device
 * keeps the next one off it; and chat's policy is the same before any mail vote.
 *
 *   DITHER_MAIL_HOLD_MS=500 bun packages/hub/src/main.ts --demo ...   (sends wait 10 s for Undo otherwise)
 *   bun scripts/verify-notifications.ts http://127.0.0.1:8492 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this votes and sends. Nothing leaves it: the demo's
 * mail goes to a fake server, whose people answer by themselves.
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
  if (boot.mail?.accounts?.length) await mail();
  else console.log('skip mail (this hub has no mail account)');
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
/** Mail's notifications, end to end on the demo's fake mail account (its people answer what you send them). */
async function mail() {
  const put = (path: string, body: unknown) => fetch(`${hub}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: hub }, body: JSON.stringify(body) });
  const toasts = () => p.eval<{ title: string; body: string; badge: string | null }[]>(`[...document.querySelectorAll('.toast.notify')].map((t) => ({ title: t.querySelector('b')?.textContent ?? '', body: t.textContent ?? '', badge: t.querySelector('.avatar .net-badge')?.getAttribute('title') ?? null }))`);
  const policyBefore = await get('/api/triage/policy');
  const threads = (await get('/api/mail/threads?list=v:inbox:*')).threads as any[];
  const dinner = threads.find((t) => /Dinner on Friday/.test(t.subject));
  check(!!dinner, 'the demo has Sam’s dinner thread', threads.map((t) => t.subject));
  if (!dinner) return;
  /** Answer the thread's latest message from Sam; Sam answers back a few seconds later. */
  const answer = async (text: string) => {
    const detail = await get(`/api/mail/threads/${dinner.id}`);
    const last = [...detail.messages].reverse().find((m: any) => m.addressed !== 'self');
    const start = await get(`/api/mail/compose?kind=reply&message=${last.id}`);
    const r = await post('/api/mail/send', { ...start.draft, text, clientId: crypto.randomUUID(), draftKey: start.draftKey });
    check(r.ok, `answered Sam: “${text}”`, r.ok ? '' : await r.text());
    return new Set<string>(detail.messages.map((m: any) => m.id as string));
  };
  const answerFromSam = async (before: Set<string>) => {
    for (let i = 0; i < 80; i++) {
      await Bun.sleep(250);
      const items = (await get('/api/mail/triage')).items as any[];
      const hit = items.find((x) => x.threadId === dinner.id && !before.has(x.id));
      if (hit) return hit;
    }
    return null;
  };

  await p.goto(`${hub}/#/triage`);
  await p.until(`!!document.querySelector('.board-block')`, 15000);
  await p.eval(`document.querySelectorAll('.toast.notify .toast-x').forEach((x) => x.click())`);
  const seen1 = await answer('See you there!');
  const got = await answerFromSam(seen1);
  check(got?.triage.decision === 'push' && got.from.email === 'sam@rivera.example', 'Sam’s answer is Important: you write to Sam, and Sam wrote to you', got?.triage);
  await p.until(`[...document.querySelectorAll('.toast.notify')].some((t) => t.textContent.includes('Sam Rivera'))`, 8000).catch(() => {});
  const t1 = (await toasts()).filter((t) => t.body.includes('Sam Rivera'));
  check(t1.length === 1 && /Dinner on Friday\? — /.test(t1[0].body) && t1[0].badge === 'Email', 'it shows here: the sender, “subject — text”, the email mark', t1);
  await p.until(`!!document.querySelector('[data-mid="${got?.id}"]')`, 8000).catch(() => {});
  let l = await lists();
  check(!!got && l['Important']?.includes(got.id), 'the board lists it under Important', l['Important']?.slice(0, 5));
  const card = await p.eval<string>(`document.querySelector('[data-mid="${got?.id}"]')?.innerText ?? ''`);
  check(card.includes('by email') && card.includes('Dinner on Friday'), 'its card says by email, with the subject', card.split('\n').slice(0, 4));
  if (shots) await p.shot(`${shots}/notif-05-mail-board.png`);

  // Chat's policy is as it was: nothing about mail yet.
  check(JSON.stringify(policyBefore.factors) === JSON.stringify((await get('/api/triage/policy')).factors), 'chat’s policy is unchanged by mail that came without a vote');

  // A vote down from the board: Active at once, and learned, about Sam.
  await p.eval(`document.querySelector('[data-mid="${got?.id}"] .tier-vote button:last-child').click()`);
  await Bun.sleep(200);
  l = await lists();
  check(!!got && l['Active']?.includes(got.id) && !l['Important']?.includes(got.id), 'voting it down moves it to Active at once');
  await Bun.sleep(800);
  const policy = await get('/api/triage/policy');
  check(policy.votes === policyBefore.votes + 1, 'the vote counts with chat’s', { before: policyBefore.votes, after: policy.votes });
  check(policy.factors.some((f: any) => f.head === 'ping' && f.weight < 0 && /Sam Rivera|Dinner on Friday/.test(f.text)), 'learned: less likely to ping, about Sam or that mail', policy.factors.slice(0, 4).map((f: any) => `${f.head} ${f.weight} ${f.text}`));

  // The reader's Notification button.
  await p.goto(`${hub}/#/mail/t/${dinner.id}`);
  await p.until(`!!document.querySelector('.mail-msg.open')`, 15000);
  await Bun.sleep(400);
  const opened = await p.eval<boolean>(`(() => { const b = [...document.querySelectorAll('.mail-msg-actions button')].filter((x) => x.textContent.includes('Notification')).at(-1); if (!b) return false; b.click(); return true; })()`);
  await Bun.sleep(300);
  const picker = opened ? await p.eval<string[]>(`[...document.querySelectorAll('.triage-pop .tier-picker button')].map((b) => b.textContent.trim())`) : [];
  check(picker.join() === 'Important,Active,Digest,Not interesting', 'the reader’s Notification button offers the four levels', picker);
  const on = opened ? await p.eval<string>(`document.querySelector('.triage-pop .tier-picker button[aria-checked="true"]')?.textContent.trim() ?? ''`) : '';
  check(on === 'Active', 'with your vote marked', on);
  if (shots) await p.shot(`${shots}/notif-06-mail-reader.png`);
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

  // Email off for this device: the next answer shows nothing here.
  const device = await p.eval<string>(`localStorage.getItem('dither-chat:device') ?? ''`);
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('[data-device-net="email"]')`, 15000).catch(() => {});
  check(await p.eval<boolean>(`!!document.querySelector('[data-device-net="email"]')`), 'Settings lists Email for each device');
  if (shots) await p.shot(`${shots}/notif-07-device-email.png`);
  check((await put('/api/devices/rules', { device, scope: 'network', target: 'email', level: 'none' })).ok, 'Email off on this device');
  await p.goto(`${hub}/#/triage`);
  await p.until(`!!document.querySelector('.board-block')`, 15000);
  await p.eval(`document.querySelectorAll('.toast.notify .toast-x').forEach((x) => x.click())`);
  const seen2 = await answer('Booked a table too, just in case.');
  const got2 = await answerFromSam(seen2);
  check(!!got2 && ['push', 'quiet'].includes(got2.triage.decision), 'Sam answers again, and it notifies', got2?.triage.decision);
  await Bun.sleep(1500);
  check(!(await toasts()).some((t) => t.body.includes('Sam Rivera')), 'but not on this device');
  check((await put('/api/devices/rules', { device, scope: 'network', target: 'email', level: null })).ok, 'Email back on');

  // On a phone and in the light theme: the mail card and Email's device row fit.
  for (const [w, h, mobile, name] of [[390, 844, true, 'dither-light'], [390, 844, true, 'dither-dark'], [1280, 900, false, 'dither-light']] as const) {
    await p.size(w, h, mobile);
    await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: ${JSON.stringify(name)} }))`);
    await p.goto(`${hub}/#/triage`);
    await p.eval(`location.reload()`).catch(() => {});
    await Bun.sleep(800);
    await p.until(`!!document.querySelector('[data-mail]')`, 15000).catch(() => {});
    const tag = `${w}px ${name}`;
    const fit = await p.eval<{ card: boolean; subject: string }>(`(() => { const el = document.querySelector('[data-mail]'); if (!el) return { card: false, subject: '' }; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { card: r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1, subject: getComputedStyle(el.querySelector('.ping-subject')).color }; })()`);
    check(fit.card, `${tag}: the board’s mail card fits`, fit);
    if (shots) await p.shot(`${shots}/notif-08-mail-${w}-${name}.png`);
    await p.goto(`${hub}/#/settings`);
    await p.until(`!!document.querySelector('[data-device-net="email"]')`, 15000).catch(() => {});
    const row = await p.eval<boolean>(`(() => { const el = document.querySelector('[data-device-net="email"]'); if (!el) return false; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1 && document.scrollingElement.scrollWidth <= innerWidth + 1; })()`);
    check(row, `${tag}: Email’s device row fits`);
    if (shots) await p.shot(`${shots}/notif-09-device-${w}-${name}.png`);
  }
  await p.size(1280, 900);
}

console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
