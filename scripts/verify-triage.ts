/**
 * How it sorts (packages/web/src/ui/HowItSorts.tsx, packages/web/src/board.ts, docs/notifications.md), its counts and
 * words, in a real browser against a demo hub:
 *
 *   - four sections in this order: Alerts, Conversations, List, Below the list; one line per conversation in each,
 *     with its importance and the two marks, its messages under Why; the counts at the top are the sections'
 *     lengths, said plainly, and no "need you" among them;
 *   - the badge on the inbox button is the unread alerts and the unread Conversation messages plus accounts that need
 *     you; the list does not count;
 *   - a mark on a line ticks at once on its newest message, the hub has it, and nothing moves: every count and the
 *     badge stay; a click on the ticked mark takes it back. On an alert the mark reads "Alert was wrong";
 *   - the same on a phone, reached from Catch up's header;
 *   - tiers are named Alert, Conversation and List everywhere, with no level name from before them; what it learned
 *     says the two bars, the list's level with its preview, and the marks;
 *   - a message's bell says its tier, its importance, and the local model's answer against the hub's bar;
 *   - Settings: the list's slider shows the level and the preview for the step under the thumb, and saves it.
 *
 *   DITHER_DEMO_CHATTER=0 bun packages/hub/src/main.ts --demo --data <fresh dir> --port <port> --web <built web>
 *   bun scripts/verify-triage.ts http://127.0.0.1:<port> [screenshot dir]
 *
 * Run it against a demo hub, never a real one: it marks, and sets the list's level (and sets it back).
 * DITHER_DEMO_CHATTER=0 keeps the demo's background chatter from adding messages while this checks that a mark
 * moves none.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const base = process.argv[2];
const shots = process.argv[3];
if (!base) throw new Error('usage: bun scripts/verify-triage.ts <hub url> [screenshot dir]');
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const hub = async <T = any>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
};
/** A message's marks as the hub has them. */
const marksOf = async (id: string) => (await hub('/api/inbox')).items.find((i: any) => i.message.id === id)?.message.triage.marks ?? {};

const boot = await hub('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const attention = boot.accounts.filter((a: any) => a.attention).length;
const TIERS = ['push', 'quiet', 'digest', 'drop'] as const;
type Tier = (typeof TIERS)[number];

const { page, close } = await launch();
await page.size(1200, 800);

/** Open every line's Why, so each message is on the page. */
const openAll = async () => {
  for (let i = 0; i < 5; i++) {
    const n = await page.eval<number>(`(() => { const bs = [...document.querySelectorAll('.model-line .model-why-btn:not(.on)')]; bs.forEach((b) => b.click()); return bs.length; })()`);
    if (!n) return;
    await Bun.sleep(150);
  }
};

/** Everything the page and the badges say, and what the sections hold. */
const state = async () => {
  await page.eval(`document.querySelector('details.below') && (document.querySelector('details.below').open = true)`);
  await Bun.sleep(100);
  await openAll();
  return page.eval<any>(`(() => {
    const n = (k) => Number(document.querySelector('[data-count=' + k + '] b')?.textContent ?? NaN);
    const unread = (k) => Number((document.querySelector('[data-count=' + k + ']')?.textContent.match(/(\\d+) unread/) ?? [0, 0])[1]);
    const block = (tier) => document.querySelector('.board-block[data-tier=' + tier + ']');
    const ids = (b) => (b ? [...b.querySelectorAll('.model-msg[data-mid]')].map((p) => p.dataset.mid) : []);
    const lines = (b) => (b ? [...b.querySelectorAll('.model-line')].map((l) => l.dataset.line) : []);
    const unreadCards = (b) => (b ? [...b.querySelectorAll('.model-msg.unread')].map((p) => p.dataset.mid) : []);
    const shownAll = (b) => !b?.querySelector(':scope > button.btn') && !b?.querySelector('.model-why > .model-msgs > .link-btn');
    const badge = (sel) => Number(document.querySelector(sel)?.textContent ?? 0);
    const tiers = ['push', 'quiet', 'digest', 'drop'];
    const by = (f) => Object.fromEntries(tiers.map((t) => [t, f(block(t))]));
    return {
      alerts: n('alerts'), alertsUnread: unread('alerts'), conversations: n('conversations'), conversationsUnread: unread('conversations'), list: n('list'),
      rail: badge('.rail-item:has(.rail-logo) .rail-count .count'),
      tab: badge('.tabbar .tab:nth-child(2) .tab-badge'),
      heads: [...document.querySelectorAll('.board-block[data-tier]')].map((b) => (b.querySelector(':scope > h3') ?? b.querySelector(':scope > summary')).childNodes[1].textContent.trim()),
      lists: by(ids), lines: by(lines), unreadCards: by(unreadCards), allShown: by(shownAll),
      // Every line has its importance and its marks: both for chat, "Less like this" alone for mail.
      bare: [...document.querySelectorAll('.board-block[data-tier] .model-line')].filter((l) => !l.querySelector('.model-line-row [data-importance]') || !l.querySelector('.model-line-row [data-mark=less]') || (!l.dataset.mail && !l.querySelector('.model-line-row [data-mark=alert]'))).map((l) => l.dataset.line),
      words: [...document.querySelectorAll('.model-intro, .model-stats, .board-block > h3, .board-block > summary, .board-block > p.muted, .learned > p')].map((e) => e.innerText).join('\\n'),
    };
  })()`);
};

const agree = (s: any, where: string, badge: number) => {
  check(`${where}: the badge is the unread alerts and Conversation messages plus accounts that need you`, badge === s.alertsUnread + s.conversationsUnread + attention, { badge, alerts: s.alertsUnread, conversations: s.conversationsUnread, attention });
  if (s.allShown.push) {
    check(`${where}: the alerts count is the section's length`, s.alerts === s.lists.push.length, [s.alerts, s.lists.push.length]);
    check(`${where}: …and its unread are the unread messages`, s.alertsUnread === s.unreadCards.push.length, [s.alertsUnread, s.unreadCards.push.length]);
  }
  if (s.allShown.quiet) {
    check(`${where}: the Conversations count is the section's length`, s.conversations === s.lists.quiet.length, [s.conversations, s.lists.quiet.length]);
    check(`${where}: …and its unread are the unread messages`, s.conversationsUnread === s.unreadCards.quiet.length, [s.conversationsUnread, s.unreadCards.quiet.length]);
  }
  if (s.allShown.digest) check(`${where}: the list's count is the section's length`, s.list === s.lists.digest.length, [s.list, s.lists.digest.length]);
  for (const t of TIERS) check(`${where}: ${t}, one line per conversation`, new Set(s.lines[t]).size === s.lines[t].length, s.lines[t].length);
};

/** A mark's button: on a line (its row) or on one message under Why. */
const lineMark = (tier: Tier, key: string, mark: 'alert' | 'less') => `.board-block[data-tier=${tier}] .model-line[data-line="${key}"] .model-line-row [data-mark=${mark}]`;
const msgMark = (id: string, mark: 'alert' | 'less') => `.model-msg[data-mid="${id}"] [data-mark=${mark}]`;
const pressed = (sel: string) => page.eval<boolean>(`document.querySelector(${JSON.stringify(sel)})?.getAttribute('aria-pressed') === 'true'`);
const click = (sel: string) => page.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
const until = (expr: string) => page.until(expr, 5000).catch(() => {});
/** The first line in a tier (one with an unread message, if asked) and its newest message. */
const lineIn = (tier: Tier, unread = false) =>
  page.eval<{ key: string; newest: string } | null>(`(() => {
    const ls = [...document.querySelectorAll('.board-block[data-tier=${tier}] .model-line:not([data-mail])')];
    const l = ${unread} ? ls.find((x) => x.querySelector('.model-msg.unread')) : ls[0];
    return l ? { key: l.dataset.line, newest: [...l.querySelectorAll('.model-msg')].map((m) => m.dataset.mid)[0] } : null;
  })()`);
const counts = (s: any) => [s.alerts, s.alertsUnread, s.conversations, s.conversationsUnread, s.list, s.rail];
/**
 * The tiers where a message that was on the page left or changed place. One that came since is not a move: the
 * demo's mail is still being read when the page opens, and a newsletter lands below the list a little later.
 */
const moved = (a: any, b: any) => {
  const was = new Set(TIERS.flatMap((t) => a.lists[t]));
  return TIERS.filter((t) => JSON.stringify(a.lists[t]) !== JSON.stringify(b.lists[t].filter((id: string) => was.has(id))));
};
const same = (a: any, b: any) => JSON.stringify(counts(a)) === JSON.stringify(counts(b)) && !moved(a, b).length;

try {
  await page.goto(`${base}/#/model`);
  await page.until(`!!document.querySelector('.model-page .model-stats') && !!document.querySelector('.model-line') && performance.getEntriesByName('dither:fresh').length > 0`, 20000);
  await Bun.sleep(1500);
  const before = await state();
  console.log(`      the page: ${before.alerts} alerts (${before.alertsUnread} unread) in ${before.lines.push.length} lines, ${before.conversations} in conversations (${before.conversationsUnread} unread), ${before.list} on the list, ${before.lists.drop.length} below it`);
  check('four sections in order: Alerts, Conversations, List, Below the list', before.heads.join() === 'Alerts,Conversations,List,Below the list', before.heads);
  agree(before, 'at first', before.rail);
  check('the counts say what they count, and none is "need you"', /\d+ alerts?\b/.test(before.words) && /messages? in conversations/.test(before.words) && /on the list/.test(before.words) && !/need you/i.test(before.words));
  check('every line has its importance and its marks', before.bare.length === 0, before.bare);
  check('a conversation with several messages in one tier is one line', before.lines.quiet.length < before.lists.quiet.length, [before.lines.quiet.length, before.lists.quiet.length]);
  check('the list counts for nothing in the badge', before.list > 0 && before.rail === before.alertsUnread + before.conversationsUnread + attention, { list: before.list, badge: before.rail });
  const policy0 = await hub('/api/triage/policy');

  // ------------------------------------------------------------------ a line's mark is on its newest message, and moves nothing

  const line = await lineIn('quiet', true);
  if (!line) throw new Error('no unread Conversation message on this demo hub to mark');
  const why = await page.eval<{ reasons: string[]; dupes: boolean }>(`(() => {
    const l = document.querySelector('.board-block[data-tier=quiet] .model-line[data-line="${line.key}"]');
    const rs = [...l.querySelectorAll('.model-reasons .reason')].map((r) => r.firstChild.textContent);
    return { reasons: rs, dupes: new Set(rs).size !== rs.length };
  })()`);
  check("Why lists the line's reasons once each", why.reasons.length > 0 && !why.dupes, why.reasons);
  check('on a Conversation the alert mark reads "Should have alerted", not ticked', (await page.eval<string>(`document.querySelector(${JSON.stringify(lineMark('quiet', line.key, 'alert'))}).getAttribute('aria-label')`)) === 'Should have alerted' && !(await pressed(lineMark('quiet', line.key, 'alert'))));
  await click(lineMark('quiet', line.key, 'alert'));
  await until(`document.querySelector(${JSON.stringify(lineMark('quiet', line.key, 'alert'))})?.getAttribute('aria-pressed') === 'true'`);
  check('marked a line "Should have alerted": ticked at once, on the line and on its newest message', (await pressed(lineMark('quiet', line.key, 'alert'))) && (await pressed(msgMark(line.newest, 'alert'))), line);
  await Bun.sleep(600);
  const marked = await state();
  check('…and nothing moved: every count, every section and the badge as they were', same(before, marked), { before: counts(before), now: counts(marked) });
  agree(marked, 'after the mark', marked.rail);
  check('…the hub has the mark, on that message', (await marksOf(line.newest)).alert === true, await marksOf(line.newest));
  const policy1 = await hub('/api/triage/policy');
  check('…and counts it', policy1.votes === policy0.votes + 1, { before: policy0.votes, after: policy1.votes });
  const learnedNow = await page.eval<string>(`document.querySelector('.learned [data-learned=marks]')?.innerText ?? ''`);
  check('…what it learned says so: the marks, how many the model gets wrong, and how many without what it learned', learnedNow.includes(`${policy1.votes} mark${policy1.votes === 1 ? '' : 's'}; the model gets ${policy1.errors} of them wrong, ${policy1.baseline} without what it learned.`), learnedNow);
  check('…and "Less like this" on it is still not ticked', !(await pressed(msgMark(line.newest, 'less'))));

  await click(msgMark(line.newest, 'alert'));
  await until(`document.querySelector(${JSON.stringify(msgMark(line.newest, 'alert'))})?.getAttribute('aria-pressed') === 'false'`);
  await Bun.sleep(400);
  check("a click on the ticked mark, from the message's own buttons, takes it back", !(await pressed(msgMark(line.newest, 'alert'))) && !(await pressed(lineMark('quiet', line.key, 'alert'))) && (await marksOf(line.newest)).alert === undefined, await marksOf(line.newest));

  // "Less like this", on the list.
  const listed = await lineIn('digest');
  if (listed) {
    await click(lineMark('digest', listed.key, 'less'));
    await until(`document.querySelector(${JSON.stringify(lineMark('digest', listed.key, 'less'))})?.getAttribute('aria-pressed') === 'true'`);
    await Bun.sleep(400);
    check('"Less like this" on a list line: ticked, and the hub has it', (await pressed(msgMark(listed.newest, 'less'))) && (await marksOf(listed.newest)).less === true, await marksOf(listed.newest));
    check('…beside it "Should have alerted" stays as it was', !(await pressed(msgMark(listed.newest, 'alert'))));
    const less = await state();
    check('…and it stays on the list', less.lists.digest.includes(listed.newest) && same(before, less), counts(less));
    await click(lineMark('digest', listed.key, 'less'));
    await until(`document.querySelector(${JSON.stringify(lineMark('digest', listed.key, 'less'))})?.getAttribute('aria-pressed') === 'false'`);
    await Bun.sleep(400);
    check('…a second click takes it back', !(await pressed(msgMark(listed.newest, 'less'))) && (await marksOf(listed.newest)).less === undefined, await marksOf(listed.newest));
  } else console.log('      nothing on the list on this hub: "Less like this" is not checked');

  // On an alert the mark is "Alert was wrong".
  const alerted = await lineIn('push');
  if (alerted) {
    const label = await page.eval<string>(`document.querySelector(${JSON.stringify(lineMark('push', alerted.key, 'alert'))}).getAttribute('aria-label')`);
    check('on an alert the mark reads "Alert was wrong"', label === 'Alert was wrong', label);
    await click(lineMark('push', alerted.key, 'alert'));
    await until(`document.querySelector(${JSON.stringify(lineMark('push', alerted.key, 'alert'))})?.getAttribute('aria-pressed') === 'true'`);
    await Bun.sleep(400);
    check('…ticked, the hub has "the alert was wrong", and it stays under Alerts', (await pressed(msgMark(alerted.newest, 'alert'))) && (await marksOf(alerted.newest)).alert === false && (await state()).lists.push.includes(alerted.newest), await marksOf(alerted.newest));
    await click(msgMark(alerted.newest, 'alert'));
    await until(`document.querySelector(${JSON.stringify(msgMark(alerted.newest, 'alert'))})?.getAttribute('aria-pressed') === 'false'`);
    await Bun.sleep(400);
    check('…and a second click takes it back', (await marksOf(alerted.newest)).alert === undefined, await marksOf(alerted.newest));
  } else console.log('      no alert on this hub: "Alert was wrong" is not checked');
  const back = await state();
  check('with every mark taken back, every count and every section is as it was', same(before, back), { before: counts(before), now: counts(back), moved: moved(before, back).map((t) => [t, before.lists[t], back.lists[t]]) });

  // ------------------------------------------------------------------ what it learned stays at the bottom

  check('what it learned is at the bottom', await page.eval<boolean>(`(() => { const l = document.querySelector('.model-page .learned'); return !!l && !l.nextElementSibling; })()`));
  if (shots) {
    await page.size(1400, 900);
    await page.goto(`${base}/#/model`);
    await page.eval('location.reload()');
    await Bun.sleep(500);
    await page.until(`!!document.querySelector('.model-line')`, 10000);
    await Bun.sleep(600);
    const k = await page.eval<string>(`(() => { const ls = [...document.querySelectorAll('.board-block .model-line')]; const l = ls.find((x) => /^[2-9]|^\\d\\d/.test(x.querySelector('.model-line-sub').textContent)) ?? ls[0]; l.querySelector('.model-why-btn').click(); return l.dataset.line; })()`);
    await Bun.sleep(300);
    await page.eval(`document.querySelector('.model-line[data-line="${k}"]').scrollIntoView({ block: 'center' })`);
    await page.shot(`${shots}/desk-model-why.png`);
    await page.eval(`document.querySelector('.model-page .learned').scrollIntoView({ block: 'start' })`);
    await Bun.sleep(200);
    await page.shot(`${shots}/desk-model-learned.png`);
  }

  // ------------------------------------------------------------------ on a phone, from Catch up

  await page.size(400, 820, true);
  await page.goto(`${base}/#/triage`);
  await page.until(`!!document.querySelector('.catchup-head')`, 10000);
  await Bun.sleep(800);
  const tags = await page.eval<string[]>(`[...new Set([...document.querySelectorAll('.cu-card .tier-chip')].map((e) => e.textContent.trim()))]`);
  check("Catch up's cards are tagged with tier names only", tags.length > 0 && tags.every((t) => ['Alert', 'Conversation', 'List'].includes(t)), tags);
  await page.eval(`[...document.querySelectorAll('.catchup-head .btn')].find((b) => b.textContent.includes('How it sorts')).click()`);
  await page.until(`location.hash === '#/model' && !!document.querySelector('.model-line')`, 8000).catch(() => {});
  await Bun.sleep(800);
  const phone = await state();
  check('on a phone, How it sorts opens from Catch up', (await page.eval<string>('location.hash')) === '#/model');
  agree(phone, 'on a phone', phone.tab);
  check('…with every line its importance and its marks', phone.bare.length === 0, phone.bare);
  check('…and nothing runs off the side', await page.eval<boolean>(`document.querySelector('.model-page .board-scroll').scrollWidth <= document.querySelector('.model-page .board-scroll').clientWidth + 1`));
  if (shots) {
    await page.size(390, 844, true);
    await page.goto(`${base}/#/model`);
    await page.eval('location.reload()');
    await Bun.sleep(500);
    await page.until(`!!document.querySelector('.model-line')`, 10000);
    await Bun.sleep(600);
    await page.eval(`(() => { const l = [...document.querySelectorAll('.board-block .model-line')].find((x) => /^[2-9]/.test(x.querySelector('.model-line-sub').textContent)) ?? document.querySelector('.model-line'); l.querySelector('.model-why-btn').click(); l.scrollIntoView({ block: 'start' }); })()`);
    await Bun.sleep(300);
    await page.shot(`${shots}/phone-model-why.png`);
  }
  await page.eval(`document.querySelector('.model-page .icon-btn.back').click()`);
  await Bun.sleep(600);
  check('…and its back button goes back to Catch up', (await page.eval<string>('location.hash')) === '#/triage', await page.eval<string>('location.hash'));

  // ------------------------------------------------------------------ the words, and what it learned

  await page.size(1200, 800);
  await page.goto(`${base}/#/model`);
  await page.until(`!!document.querySelector('.model-line') && !!document.querySelector('.learned')`, 10000);
  await Bun.sleep(400);
  const said = await state();
  check('the page names no level from before the tiers', !/\b(Important|Active|Digest|Not interesting|Ping|Notify|votes?|voted?)\b/.test(said.words), said.words.match(/\b(Important|Active|Digest|Not interesting|Ping|Notify|votes?|voted?)\b/g) ?? '');
  check('…and says nothing of three chances, thresholds, a prompt or exploring', !/three chances|threshold|prompt|explor/i.test(said.words));
  const policy = await hub('/api/triage/policy');
  const learned = await page.eval<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('.learned [data-learned]')].map((e) => [e.dataset.learned, e.innerText]))`);
  check('what it learned says the two bars alerts start at', learned.bars?.includes(`Alerts start when the local model's answer reaches ${policy.bars.direct} in DMs and messages about you, ${policy.bars.other} in chats you take part in`), learned.bars);
  const level = policy.thresholds.important;
  const row = policy.preview.find((x: any) => Math.round(x.level * 10) === Math.round(level * 10));
  const perDay = row ? `about ${row.perDay < 3 ? row.perDay : Math.round(row.perDay)} ${row.perDay === 1 ? 'chat' : 'chats'} a day at this level (last week)` : null;
  check("…the list's level, with how many chats a day it held last week", learned.list?.includes(`an importance of ${Math.round(level * 100)}%`) && (!perDay || learned.list.includes(perDay)), learned.list);
  const shadow = await hub('/api/triage/shadow');
  const shadowLine = await page.eval<string>(`document.querySelector('.learned .shadow-line')?.innerText ?? ''`);
  check(
    shadow.decided ? 'the candidate model: what it would have put on the list, where what was, and how many the same' : 'no line about the candidate model while it has decided nothing',
    shadow.decided ? shadowLine.includes(`The candidate model would have put ${shadow.shadow} message${shadow.shadow === 1 ? '' : 's'} on the list where ${shadow.live} ${shadow.live === 1 ? 'was' : 'were'} (${shadow.both} the same) over the last `) : shadowLine === '',
    shadowLine || shadow,
  );

  // ------------------------------------------------------------------ a message's bell

  const inbox = (await hub('/api/inbox')).items.map((i: any) => i.message);
  const shape = new Map(boot.conversations.map((c: any) => [c.id, c.shape]));
  const alertedMsg = inbox.find((m: any) => m.triage?.decision === 'push' && typeof m.triage.judge === 'number');
  const groupMsg = inbox.find((m: any) => m.triage?.decision === 'quiet' && typeof m.triage.judge === 'number' && shape.get(m.conversationId) !== 'direct' && !m.triage.reasons.includes('About you'));
  for (const [m, tier, bar] of [
    // An alert's first reason says the bar the hub held it to.
    [alertedMsg, 'Alert', Number(alertedMsg?.triage.reasons.join(' ').match(/against a bar of ([\d.]+)/)?.[1])],
    [groupMsg, 'Conversation', policy.bars.other],
  ] as const) {
    if (!m) {
      console.log(`      no ${tier} message with the local model's answer on this hub: its bell is not checked`);
      continue;
    }
    await page.goto(`${base}/#/inbox/c/${m.conversationId}?m=${m.id}`);
    await page.until(`!!document.querySelector('#m-${m.id} [aria-label^="Notification:"]')`, 15000);
    check(`a ${tier}'s bell is named for its tier`, (await page.eval<string>(`document.querySelector('#m-${m.id} [aria-label^="Notification:"]').getAttribute('aria-label')`)) === `Notification: ${tier}`);
    await page.eval(`document.querySelector('#m-${m.id} [aria-label^="Notification:"]').click()`);
    await page.until(`!!document.querySelector('.triage-pop [data-judge]')`, 5000).catch(() => {});
    await page.until(`/the bar here/.test(document.querySelector('.triage-pop [data-judge]')?.textContent ?? '')`, 5000).catch(() => {});
    const bell = await page.eval<{ title: string; importance: string; judge: string; marks: string[] }>(`(() => { const p = document.querySelector('.triage-pop'); return { title: p?.querySelector('.menu-title')?.textContent ?? '', importance: p?.querySelector('[data-importance]')?.textContent ?? '', judge: p?.querySelector('[data-judge]')?.textContent ?? '', marks: [...(p?.querySelectorAll('[data-mark]') ?? [])].map((b) => b.textContent.trim()) }; })()`);
    check(`…it opens on the tier's name and why`, bell.title.startsWith(`${tier}:`), bell.title);
    check('…its importance as a percentage', bell.importance.startsWith(`Importance ${Math.round(m.triage.score * 100)}%`), bell.importance);
    check("…the local model's answer, against the hub's bar for it", bell.judge === `The local model's answer: ${m.triage.judge} (the bar here is ${bar})`, bell.judge);
    check('…and the two marks, by name', bell.marks.join() === `${tier === 'Alert' ? 'Alert was wrong' : 'Should have alerted'},Less like this`, bell.marks);
    if (shots) await page.shot(`${shots}/desk-bell-${tier.toLowerCase()}.png`);
    await page.eval(`document.querySelector('.cm')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await Bun.sleep(200);
  }

  // ------------------------------------------------------------------ Settings: the phone's list

  await page.goto(`${base}/#/settings`);
  await page.until(`!!document.querySelector('#set-list input[type=range]')`, 10000);
  await Bun.sleep(300);
  const settings = await page.eval<string>(`document.querySelector('#set-notifications').innerText`);
  check('Settings explains the three tiers in a sentence', /Alerts sound; conversations are people talking with you, silent; the list is everything else that is important enough, silent, the most important first\./.test(settings));
  check('…and has no level picker for everything or a network, and no daily digest', !(await page.eval<boolean>(`!!document.querySelector('#set-defaults, #daily-digest')`)) && !/daily digest|Smart triage|Default notifications|All of (Discord|Signal|Matrix)/i.test(await page.eval<string>(`document.querySelector('.settings-scroll').innerText`)));
  const list = () => page.eval<{ value: string; level: string; preview: string }>(`({ value: document.querySelector('#set-list input[type=range]').value, level: document.querySelector('#set-list [data-list-level]').textContent.trim(), preview: document.querySelector('#set-list [data-list-preview]').textContent.trim() })`);
  const previewAt = (l: number) => {
    const r = policy.preview.find((x: any) => Math.round(x.level * 10) === Math.round(l * 10));
    return r ? `about ${r.perDay < 3 ? r.perDay : Math.round(r.perDay)} ${r.perDay === 1 ? 'chat' : 'chats'} a day at this level (last week)` : '';
  };
  let l = await list();
  check("the list's slider is at the hub's level, as a percentage, with last week's chats a day", l.value === String(Math.round(level * 10)) && l.level === `${Math.round(level * 100)}%` && l.preview === previewAt(level), l);
  const range = await page.eval<{ min: string; max: string; step: string }>(`(() => { const r = document.querySelector('#set-list input[type=range]'); return { min: r.min, max: r.max, step: r.step }; })()`);
  check('…over the levels 0.1 to 0.9 in steps of 0.1', range.min === '1' && range.max === '9' && range.step === '1', range);
  const other = Math.round(level * 10) === 3 ? 0.4 : 0.3;
  const slide = (to: number, ev: 'input' | 'change') => page.eval(`(() => { const r = document.querySelector('#set-list input[type=range]'); r.value = ${JSON.stringify(String(Math.round(to * 10)))}; r.dispatchEvent(new Event(${JSON.stringify(ev)}, { bubbles: true })); })()`);
  await slide(other, 'input');
  await Bun.sleep(200);
  l = await list();
  check('under the thumb: that level and its own preview, before anything is saved', l.level === `${Math.round(other * 100)}%` && l.preview === previewAt(other) && (await hub('/api/triage/policy')).thresholds.important === level, l);
  await slide(other, 'change');
  let saved = level;
  for (let i = 0; i < 20 && saved !== other; i++) {
    await Bun.sleep(150);
    saved = (await hub('/api/triage/policy')).thresholds.important;
  }
  l = await list();
  check('let go, it is saved on the hub and stays shown', saved === other && l.level === `${Math.round(other * 100)}%` && l.value === String(Math.round(other * 10)), { saved, l });
  if (shots) await page.shot(`${shots}/desk-settings-list.png`);
  await slide(level, 'input');
  await slide(level, 'change');
  for (let i = 0; i < 20 && saved !== level; i++) {
    await Bun.sleep(150);
    saved = (await hub('/api/triage/policy')).thresholds.important;
  }
  check('…and set back', saved === level, saved);

  const errors = page.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|WebSocket connection/.test(e));
  check('no script errors', !errors.length, errors);
} finally {
  await close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
