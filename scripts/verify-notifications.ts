/**
 * Notification tiers and marks (docs/notifications.md), end to end against a demo hub in headless Chromium: How it
 * sorts' Alerts, Conversations and List, the list by importance, and what fell below it; a mark ticking at once and
 * moving nothing; what the alert model learned from it, with its backtest; the next message in that place alerting
 * because of it, and "Not urgent" on that one; the two marks and the model's answer in a message's bell; forgetting
 * what it learned; a rule on a conversation (Automatic, Always alert, List only, Mute) from its header; and your
 * message's read ticks after its text.
 *
 * Mail (slice 9, docs/mail.md), when the demo hub has its mail account: an answer from someone you write to is a
 * list row, with no notification here; How it sorts lists it with the envelope, and "Less like this" ticks at once
 * and is learned about Sam; the reader's Notification button has that one mark; with Sam set to always alert the
 * next answer is an alert that shows here with the email mark; Email off for this device keeps the one after off it;
 * and chat's policy is the same before any mail mark.
 *
 *   DITHER_MAIL_HOLD_MS=500 bun packages/hub/src/main.ts --demo ...   (sends wait 10 s for Undo otherwise)
 *   bun scripts/verify-notifications.ts http://127.0.0.1:8492 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this marks, sets rules and sends. Nothing leaves
 * it: the demo's mail goes to a fake server, whose people answer by themselves.
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

const put = (path: string, body: unknown) => fetch(`${hub}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: hub }, body: JSON.stringify(body) });

const { page: p, close } = await launch();
/** A mark's button on one message of How it sorts, and whether it is ticked. */
const markOf = (id: string, mark: 'alert' | 'less') => `.model-msg[data-mid="${id}"] [data-mark=${mark}]`;
const ticked = (sel: string) => p.eval<boolean>(`document.querySelector(${JSON.stringify(sel)})?.getAttribute('aria-pressed') === 'true'`);
/** Each section's messages on How it sorts, every line's Why opened so its messages are on the page. */
const lists = async () => {
  for (let i = 0; i < 5; i++) {
    const n = await p.eval<number>(`(() => { const bs = [...document.querySelectorAll('.model-line .model-why-btn:not(.on)')]; bs.forEach((b) => b.click()); return bs.length; })()`);
    if (!n) break;
    await Bun.sleep(150);
  }
  return p.eval<Record<string, string[]>>(`(() => {
    const out = {};
    for (const b of document.querySelectorAll('.board-block')) {
      const h = (b.querySelector(':scope > h3') ?? b.querySelector(':scope > summary'))?.childNodes[1]?.textContent.trim() ?? '';
      out[h] = [...b.querySelectorAll('.model-msg[data-mid]')].map((x) => x.dataset.mid);
    }
    return out;
  })()`);
};

try {
  await p.size(1280, 900);
  // Conversation messages in DMs: a DM is people talking with you, and in the demo the other side answers.
  const shape = new Map(boot.conversations.map((c: any) => [c.id, c.shape]));
  const inbox = await get('/api/inbox');
  const talking = inbox.items.map((i: any) => i.message).filter((m: any) => m.triage?.decision === 'quiet' && shape.get(m.conversationId) === 'direct' && m.triage.judge !== undefined);
  check(talking.length > 0, 'the demo world has Conversation messages in DMs, read by the local model', talking.length);
  const urgent = inbox.items.map((i: any) => i.message).filter((m: any) => m.triage?.decision === 'push' && m.triage.judge !== undefined);
  check(urgent.length > 0 && urgent.every((m: any) => /Reads as urgent/.test(m.triage.reasons[0])), 'and an alert: an urgent message in a DM', urgent.map((m: any) => m.triage.reasons[0]));

  await p.goto(`${hub}/#/model`);
  await p.until(`!!document.querySelector('.board-block .model-line')`, 15000);
  await Bun.sleep(600);
  let l = await lists();
  const heads = Object.keys(l);
  check(heads.join() === 'Alerts,Conversations,List,Below the list,What it learned from your marks', 'How it sorts lists Alerts, Conversations, List and Below the list, then what it learned', heads);
  // Lines on the list go by their first message, the most important first; within a line, the same.
  const scores = await p.eval<number[]>(`(() => { const b = document.querySelector('.board-block[data-tier=digest]'); return [...b.querySelectorAll('.model-line')].map((x) => x.querySelector('.model-msg[data-mid]')?.dataset.mid); })()`).then(
    async (ids) => ids.map((id) => inbox.items.find((i: any) => i.message.id === id)?.message.triage.score ?? -1),
  );
  check(scores.length > 1 && scores.every((x, i) => i === 0 || x <= scores[i - 1] || x === -1), 'the list, the most important first', scores.slice(0, 8));
  check(await p.eval<boolean>(`!!document.querySelector('details.below summary')`), 'what fell below the list, the most important of it');
  if (shots) await p.shot(`${shots}/notif-01-board.png`);

  // Mark a Conversation DM message "Should have alerted": ticked at once, and it stays where it is.
  const first = l['Conversations'].find((id) => talking.some((m: any) => m.id === id));
  check(!!first, 'a Conversation message from a DM on How it sorts', first);
  await p.eval(`document.querySelector(${JSON.stringify(markOf(first!, 'alert'))}).click()`);
  await Bun.sleep(150);
  l = await lists();
  check((await ticked(markOf(first!, 'alert'))) && l['Conversations'].includes(first!) && !l['Alerts'].includes(first!), 'marking it "Should have alerted" ticks it at once, and it stays under Conversations');
  await Bun.sleep(800);
  const policy = await get('/api/triage/policy');
  const top = policy.factors[0];
  check(policy.votes === 1 && top?.head === 'alert' && top.weight > 0 && top.text.startsWith('In your DM with'), 'learned from the mark: more likely to alert in that DM', policy.factors.slice(0, 3).map((f: any) => `${f.head} ${f.weight} ${f.text}`));
  check(policy.errors === 0 && policy.baseline === 1, 'its backtest: right where its starting chances alone were wrong', { errors: policy.errors, baseline: policy.baseline });
  const learned = await p.eval<string>(`document.querySelector('.learned')?.innerText ?? ''`);
  check(learned.includes(top.text) && /1 mark; the model gets 0 of them wrong, 1 without what it learned/.test(learned), 'How it sorts shows what it learned and the marks', learned.split('\n').slice(0, 8));
  const group = await p.eval<string>(`[...document.querySelectorAll('.learned .learned-group')].find((g) => g.textContent.includes(${JSON.stringify(top.text)}))?.querySelector('h4')?.textContent ?? ''`);
  check(group === 'More likely to alert:', '…under "More likely to alert"', group);
  if (shots) await p.shot(`${shots}/notif-02-marked.png`);

  // The next message there alerts because of the mark: answer them, and the demo answers back.
  const conv = talking.find((m: any) => m.id === first).conversationId;
  const before = new Set((await get('/api/inbox')).items.map((x: any) => x.message.id));
  await p.eval(`document.querySelectorAll('.toast.notify .toast-x').forEach((x) => x.click())`);
  check((await post(`/api/conversations/${conv}/send`, { body: 'ok, noted' })).ok, 'answered that DM');
  let next: any = null;
  for (let i = 0; i < 60 && !next; i++) {
    await Bun.sleep(250);
    next = (await get('/api/inbox')).items.map((x: any) => x.message).find((m: any) => m.conversationId === conv && !before.has(m.id) && m.triage);
  }
  check(next?.triage?.decision === 'push' && next.triage.decidedBy === 'learned' && next.triage.reasons[0] === 'Alert, learned from your marks (was Conversation)', 'their answer is an alert, learned from your mark', next?.triage);
  await p.until(`document.querySelectorAll('.toast.notify').length > 0`, 8000).catch(() => {});
  check((await p.eval<number>(`document.querySelectorAll('.toast.notify').length`)) === 1, 'the alert shows here, once');
  await p.until(`!!document.querySelector('.board-block[data-tier=push] .model-msg[data-mid="${next?.id}"]') || !!document.querySelector('.board-block[data-tier=push] .model-line[data-line="${conv}"]')`, 8000).catch(() => {});
  l = await lists();
  check(!!next && l['Alerts'].includes(next.id), 'and How it sorts lists it under Alerts', l['Alerts']);

  // "Not urgent", as the notification's button says it: the alert was wrong.
  const wrong = await post(`/api/messages/${next?.id}/feedback`, { alert: false });
  check(wrong.ok && (await wrong.json()).marks?.alert === false, '"Not urgent" from the notification marks the alert wrong');
  await p.until(`document.querySelector(${JSON.stringify(markOf(next?.id, 'alert'))})?.getAttribute('aria-pressed') === 'true'`, 8000).catch(() => {});
  check((await ticked(markOf(next?.id, 'alert'))) && (await p.eval<string>(`document.querySelector(${JSON.stringify(markOf(next?.id, 'alert'))})?.getAttribute('aria-label') ?? ''`)) === 'Alert was wrong', 'How it sorts shows it ticked, as "Alert was wrong"');
  // A list row or a Conversation never shows here: a message that only reaches those tiers raises nothing.
  await p.eval(`document.querySelectorAll('.toast.notify .toast-x').forEach((x) => x.click())`);
  const other = talking.find((m: any) => m.conversationId !== conv);
  if (other) {
    const seen = new Set((await get('/api/inbox')).items.map((x: any) => x.message.id));
    check((await post(`/api/conversations/${other.conversationId}/send`, { body: 'sounds good' })).ok, 'answered another DM');
    let quiet: any = null;
    for (let i = 0; i < 60 && !quiet; i++) {
      await Bun.sleep(250);
      quiet = (await get('/api/inbox')).items.map((x: any) => x.message).find((m: any) => m.conversationId === other.conversationId && !seen.has(m.id) && m.triage);
    }
    check(quiet?.triage?.decision === 'quiet', 'their answer is a Conversation', quiet?.triage);
    await p.until(`!!document.querySelector('.board-block[data-tier=quiet] .model-line[data-line="${other.conversationId}"]')`, 8000).catch(() => {});
    await Bun.sleep(1200);
    check((await p.eval<number>(`document.querySelectorAll('.toast.notify').length`)) === 0, 'and shows nothing here: only an alert does');
  }

  // The bell on a message: its tier, the model's answer, and the two marks.
  await p.goto(`${hub}/#/inbox/c/${conv}?m=${first}`);
  await p.until(`!!document.querySelector('#m-${first} [aria-label^="Notification"]')`, 15000);
  await Bun.sleep(400);
  await p.eval(`document.querySelector('#m-${first} [aria-label^="Notification"]').click()`);
  await p.until(`!!document.querySelector('.triage-pop')`, 5000).catch(() => {});
  await p.until(`/the bar here/.test(document.querySelector('.triage-pop [data-judge]')?.textContent ?? '')`, 5000).catch(() => {});
  const bell = await p.eval<{ title: string; marks: { text: string; on: boolean }[]; judge: string; importance: string }>(
    `(() => { const pop = document.querySelector('.triage-pop'); return { title: pop?.querySelector('.menu-title')?.textContent ?? '', marks: [...(pop?.querySelectorAll('[data-mark]') ?? [])].map((b) => ({ text: b.textContent.trim(), on: b.getAttribute('aria-pressed') === 'true' })), judge: pop?.querySelector('[data-judge]')?.textContent ?? '', importance: pop?.querySelector('[data-importance]')?.textContent ?? '' }; })()`,
  );
  check(bell.title.startsWith('Conversation:'), 'a message’s bell names its tier', bell.title);
  check(bell.marks.map((m) => m.text).join() === 'Should have alerted,Less like this', '…offers the two marks', bell.marks);
  check(bell.marks[0]?.on === true && bell.marks[1]?.on === false, '…with yours ticked', bell.marks);
  const said = talking.find((m: any) => m.id === first).triage;
  check(bell.judge === `The local model's answer: ${said.judge} (the bar here is ${policy.bars.direct})` && bell.importance.startsWith(`Importance ${Math.round(said.score * 100)}%`), '…and says its importance and the local model’s answer against the bar for a DM', [bell.importance, bell.judge]);
  check(!(await p.eval<boolean>(`!!document.querySelector('.triage-pop .tier-picker, .triage-pop .triage-chance')`)), '…with no level picker and no three chances');
  if (shots) await p.shot(`${shots}/notif-03-bell.png`);
  await p.eval(`document.querySelector('.cm')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await Bun.sleep(200);

  // A rule on the conversation, from its header: Automatic, Always alert, List only, Mute.
  await p.eval(`document.querySelector('.conv-head .hdr-btn.level').click()`);
  await p.until(`!!document.querySelector('.level-menu')`, 5000).catch(() => {});
  const choices = await p.eval<{ name: string; on: boolean }[]>(`[...document.querySelectorAll('.level-menu .menu-item')].map((b) => ({ name: b.querySelector('b').textContent.trim(), on: b.classList.contains('on') }))`);
  check(choices.map((c) => c.name).join() === 'Automatic,Always alert,List only,Mute' && choices[0].on && choices.filter((c) => c.on).length === 1, 'the header’s menu offers Automatic, Always alert, List only and Mute, with Automatic chosen', choices);
  const auto = await p.eval<string>(`document.querySelector('.level-menu .menu-item small')?.textContent ?? ''`);
  check(/^Conversations and alerts are worked out for you\. Now: \w+ notifies every message here$/.test(auto), '…Automatic says what it does, and under it what the network does here', auto);
  if (shots) await p.shot(`${shots}/notif-03-rule.png`);
  await p.eval(`[...document.querySelectorAll('.level-menu .menu-item')].find((b) => b.querySelector('b').textContent.trim() === 'List only').click()`);
  const ruleNow = async () => (await get('/api/bootstrap')).rules.find((r: any) => r.scope === 'conversation' && r.target === conv)?.level ?? null;
  let rule: string | null = null;
  for (let i = 0; i < 20 && rule !== 'digest'; i++) {
    await Bun.sleep(150);
    rule = await ruleNow();
  }
  await p.until(`document.querySelector('.conv-head .hdr-btn.level')?.textContent.trim() === 'List only'`, 5000).catch(() => {});
  check(rule === 'digest' && (await p.eval<string>(`document.querySelector('.conv-head .hdr-btn.level')?.textContent.trim() ?? ''`)) === 'List only', 'List only sets the rule on the hub, and the header says so', rule);
  await p.eval(`document.querySelector('.conv-head .hdr-btn.level').click()`);
  await p.until(`!!document.querySelector('.level-menu')`, 5000).catch(() => {});
  await p.eval(`[...document.querySelectorAll('.level-menu .menu-item')].find((b) => b.querySelector('b').textContent.trim() === 'Automatic').click()`);
  for (let i = 0; i < 20 && rule !== null; i++) {
    await Bun.sleep(150);
    rule = await ruleNow();
  }
  await p.until(`document.querySelector('.conv-head .hdr-btn.level')?.textContent.trim() === 'Automatic'`, 5000).catch(() => {});
  check(rule === null && (await p.eval<string>(`document.querySelector('.conv-head .hdr-btn.level')?.textContent.trim() ?? ''`)) === 'Automatic', 'Automatic takes the rule away again', rule);
  check(!(await put('/api/rules', { scope: 'conversation', target: conv, level: 'mentions' })).ok && !(await put('/api/rules', { scope: 'conversation', target: conv, level: 'smart' })).ok, 'the hub takes no level from before the tiers');

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

  await p.goto(`${hub}/#/model`);
  await p.until(`!!document.querySelector('.board-block')`, 15000);
  await p.eval(`document.querySelectorAll('.toast.notify .toast-x').forEach((x) => x.click())`);
  const seen1 = await answer('See you there!');
  const got = await answerFromSam(seen1);
  check(got?.triage.decision === 'digest' && got.from.email === 'sam@rivera.example', 'Sam’s answer is on the list: you write to Sam, and Sam wrote to you', got?.triage);
  await p.until(`!!document.querySelector('.model-line[data-line="${dinner.id}"]')`, 8000).catch(() => {});
  let l = await lists();
  check(!!got && l['List']?.includes(got.id), 'How it sorts lists it under List', l['List']?.slice(0, 5));
  const card = await p.eval<string>(`document.querySelector('.model-line[data-line="${dinner.id}"]')?.innerText ?? ''`);
  check(card.includes('by email') && card.includes('Dinner on Friday'), 'its line says by email, with the subject', card.split('\n').slice(0, 4));
  await Bun.sleep(1200);
  check(!(await toasts()).some((t) => t.body.includes('Sam Rivera')), 'a list row shows nothing here: only an alert does');
  if (shots) await p.shot(`${shots}/notif-05-mail-board.png`);

  // Chat's policy is as it was: nothing about mail yet.
  check(JSON.stringify(policyBefore.factors) === JSON.stringify((await get('/api/triage/policy')).factors), 'chat’s policy is unchanged by mail that came without a mark');

  // "Less like this" from How it sorts, the one mark mail takes: ticked at once, and learned, about Sam.
  check(!!got && !(await p.eval<boolean>(`!!document.querySelector(${JSON.stringify(markOf(got?.id, 'alert'))})`)) && (await p.eval<boolean>(`!!document.querySelector(${JSON.stringify(markOf(got?.id, 'less'))})`)), 'mail has "Less like this" and no alert mark');
  await p.eval(`document.querySelector(${JSON.stringify(markOf(got?.id, 'less'))}).click()`);
  await Bun.sleep(200);
  l = await lists();
  check(!!got && (await ticked(markOf(got.id, 'less'))) && l['List']?.includes(got.id), 'marking it "Less like this" ticks it at once, and it stays on the list');
  await Bun.sleep(800);
  const policy = await get('/api/triage/policy');
  check(policy.votes === policyBefore.votes + 1, 'the mark counts with chat’s', { before: policyBefore.votes, after: policy.votes });
  check(policy.factors.some((f: any) => f.head === 'important' && f.weight < 0 && /Sam Rivera|Dinner on Friday/.test(f.text)), 'learned: less important, about Sam or that mail', policy.factors.slice(0, 4).map((f: any) => `${f.head} ${f.weight} ${f.text}`));
  const lessGroup = await p.eval<string[]>(`[...document.querySelectorAll('.learned .learned-group[data-head=important][data-dir=down]')].map((g) => g.querySelector('h4').textContent + ' ' + [...g.querySelectorAll('.rule-text')].map((r) => r.textContent).join(' | '))`);
  check(lessGroup.length === 1 && lessGroup[0].startsWith('Less important:') && /Sam Rivera|Dinner on Friday/.test(lessGroup[0]), 'How it sorts says so under "Less important"', lessGroup);
  check((await get('/api/mail/triage')).items.find((x: any) => x.id === got?.id)?.triage.marks?.less === true, 'and the hub has the mark on that mail');

  // The reader's Notification button.
  await p.goto(`${hub}/#/mail/t/${dinner.id}`);
  await p.until(`!!document.querySelector('.mail-msg.open')`, 15000);
  await Bun.sleep(400);
  const opened = await p.eval<boolean>(`(() => { const b = [...document.querySelectorAll('.mail-msg-actions button')].filter((x) => x.textContent.includes('Notification')).at(-1); if (!b) return false; b.click(); return true; })()`);
  await Bun.sleep(300);
  const pop = opened
    ? await p.eval<{ title: string; marks: { text: string; on: boolean }[]; old: boolean }>(
        `(() => { const pop = document.querySelector('.triage-pop'); return { title: pop?.querySelector('.menu-title')?.textContent ?? '', marks: [...(pop?.querySelectorAll('[data-mark]') ?? [])].map((b) => ({ text: b.textContent.trim(), on: b.getAttribute('aria-pressed') === 'true' })), old: !!pop?.querySelector('[data-old-vote]') }; })()`,
      )
    : { title: '', marks: [], old: false };
  check(pop.title.startsWith('List:'), 'the reader’s Notification button names the tier', pop.title);
  check(pop.marks.map((m) => m.text).join() === 'Less like this', '…and offers the one mark mail takes', pop.marks);
  check(pop.marks[0]?.on === true && !pop.old, '…ticked, and not said again as a vote from before the tiers', pop);
  if (shots) await p.shot(`${shots}/notif-06-mail-reader.png`);
  await p.eval(`document.querySelector('.cm')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  // Sam set to always alert: the next answer is an alert, and an alert shows here.
  check((await put('/api/rules', { scope: 'person', target: got?.from.personId, level: 'all' })).ok, 'Sam set to always alert');
  await p.goto(`${hub}/#/model`);
  await p.until(`!!document.querySelector('.board-block')`, 15000);
  await p.eval(`document.querySelectorAll('.toast.notify .toast-x').forEach((x) => x.click())`);
  const seenA = await answer('Shall I bring anything?');
  const alerted = await answerFromSam(seenA);
  check(alerted?.triage.decision === 'push' && /always alert/.test(alerted.triage.reasons.join(' ')), 'Sam’s next answer is an alert: Sam is set to always alert', alerted?.triage);
  await p.until(`[...document.querySelectorAll('.toast.notify')].some((t) => t.textContent.includes('Sam Rivera'))`, 8000).catch(() => {});
  const t1 = (await toasts()).filter((t) => t.body.includes('Sam Rivera'));
  check(t1.length === 1 && /Dinner on Friday\? — /.test(t1[0].body) && t1[0].badge === 'Email', 'it shows here: the sender, “subject — text”, the email mark', t1);
  await p.until(`!!document.querySelector('.board-block[data-tier=push] .model-line[data-line="${dinner.id}"]')`, 8000).catch(() => {});
  l = await lists();
  check(!!alerted && l['Alerts']?.includes(alerted.id), 'How it sorts lists it under Alerts', l['Alerts']?.slice(0, 5));

  // Email off for this device: the next answer shows nothing here.
  const device = await p.eval<string>(`localStorage.getItem('dither-chat:device') ?? ''`);
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('[data-device-net="email"]')`, 15000).catch(() => {});
  check(await p.eval<boolean>(`!!document.querySelector('[data-device-net="email"]')`), 'Settings lists Email for each device');
  if (shots) await p.shot(`${shots}/notif-07-device-email.png`);
  check((await put('/api/devices/rules', { device, scope: 'network', target: 'email', level: 'none' })).ok, 'Email off on this device');
  await p.goto(`${hub}/#/model`);
  await p.until(`!!document.querySelector('.board-block')`, 15000);
  await p.eval(`document.querySelectorAll('.toast.notify .toast-x').forEach((x) => x.click())`);
  const seen2 = await answer('Booked a table too, just in case.');
  const got2 = await answerFromSam(seen2);
  check(got2?.triage.decision === 'push', 'Sam answers again, and it is an alert', got2?.triage.decision);
  await Bun.sleep(1500);
  check(!(await toasts()).some((t) => t.body.includes('Sam Rivera')), 'but not on this device');
  check((await put('/api/devices/rules', { device, scope: 'network', target: 'email', level: null })).ok, 'Email back on');

  // On a phone and in the light theme: the mail line and Email's device row fit.
  for (const [w, h, mobile, name] of [[390, 844, true, 'dither-light'], [390, 844, true, 'dither-dark'], [1280, 900, false, 'dither-light']] as const) {
    await p.size(w, h, mobile);
    await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: ${JSON.stringify(name)} }))`);
    await p.goto(`${hub}/#/model`);
    await p.eval(`location.reload()`).catch(() => {});
    await Bun.sleep(800);
    await p.until(`!!document.querySelector('.model-line[data-mail]')`, 15000).catch(() => {});
    const tag = `${w}px ${name}`;
    const fit = await p.eval<{ card: boolean; subject: string }>(`(() => { const el = document.querySelector('.model-line[data-mail]'); if (!el) return { card: false, subject: '' }; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { card: r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1, subject: getComputedStyle(el.querySelector('.model-where')).color }; })()`);
    check(fit.card, `${tag}: How it sorts' mail line fits`, fit);
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
