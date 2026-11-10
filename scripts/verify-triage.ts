/**
 * How it sorts (packages/web/src/ui/HowItSorts.tsx, packages/web/src/board.ts, docs/notifications.md#voting), its
 * counts and words, in a real browser against a demo hub:
 *
 *   - one line per conversation at each level, its messages under Why; the counts at the top are the lists' lengths,
 *     said plainly, and no "need you" among them;
 *   - the badge on the inbox button is the Important list's unread messages plus accounts that need you;
 *   - a line's vote moves its newest message to the next level at once, and every count, the badge included, moves
 *     with it; voting it back puts them back;
 *   - the same on a phone, reached from Catch up's header;
 *   - levels are named Important / Active / Digest everywhere, and the chance bars are marked at the hub's thresholds.
 *
 *   bun scripts/verify-triage.ts http://127.0.0.1:8731 [screenshot dir]
 *
 * Run it against a demo hub, never a real one: it votes.
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

const boot = await hub('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const attention = boot.accounts.filter((a: any) => a.attention).length;

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

/** Everything the page and the badges say, and what the lists hold. */
const state = async () => {
  await page.eval(`document.querySelector('details.below') && (document.querySelector('details.below').open = true)`);
  await Bun.sleep(100);
  await openAll();
  return page.eval<any>(`(() => {
    const n = (k) => Number(document.querySelector('[data-count=' + k + '] b')?.textContent ?? NaN);
    const unread = Number((document.querySelector('[data-count=important]')?.textContent.match(/(\\d+) unread/) ?? [0, 0])[1]);
    const block = (title) => [...document.querySelectorAll('.board-block')].find((b) => b.querySelector('h3')?.textContent.trim() === title);
    const ids = (b) => (b ? [...b.querySelectorAll('.model-msg[data-mid]')].map((p) => p.dataset.mid) : []);
    const lines = (b) => (b ? [...b.querySelectorAll('.model-line')].map((l) => l.dataset.line) : []);
    const shownAll = (b) => !b?.querySelector(':scope > button.btn') && !b?.querySelector('.model-why > .model-msgs > .link-btn');
    const imp = block('Important');
    const badge = (sel) => Number(document.querySelector(sel)?.textContent ?? 0);
    return {
      important: n('important'), unread, active: n('active'), digest: n('digest'),
      rail: badge('.rail-item:has(.rail-logo) .rail-count .count'),
      tab: badge('.tabbar .tab:nth-child(2) .tab-badge'),
      lists: { important: ids(imp), active: ids(block('Active')), digest: ids(block('Digest')) },
      lines: { important: lines(imp), active: lines(block('Active')), digest: lines(block('Digest')) },
      unreadCards: imp ? [...imp.querySelectorAll('.model-msg.unread')].map((p) => p.dataset.mid) : [],
      allShown: { important: shownAll(imp), active: shownAll(block('Active')) },
      words: document.querySelector('.model-page')?.innerText ?? '',
    };
  })()`);
};

const agree = (s: any, where: string, badge: number) => {
  check(`${where}: the badge is the Important list unread plus accounts that need you`, badge === s.unread + attention, { badge, unread: s.unread, attention });
  if (s.allShown.important) {
    check(`${where}: the Important count is the list's length`, s.important === s.lists.important.length, [s.important, s.lists.important.length]);
    check(`${where}: …and its unread are the unread messages`, s.unread === s.unreadCards.length, [s.unread, s.unreadCards.length]);
  }
  if (s.allShown.active) check(`${where}: the Active count is the list's length`, s.active === s.lists.active.length, [s.active, s.lists.active.length]);
  for (const l of ['important', 'active', 'digest']) check(`${where}: ${l}, one line per conversation`, new Set(s.lines[l]).size === s.lines[l].length, s.lines[l].length);
};

try {
  await page.goto(`${base}/#/model`);
  await page.until(`!!document.querySelector('.model-page .model-stats') && !!document.querySelector('.model-line') && performance.getEntriesByName('dither:fresh').length > 0`, 20000);
  await Bun.sleep(1500);
  const before = await state();
  console.log(`      the page: ${before.important} important (${before.unread} unread) in ${before.lines.important.length} lines, ${before.active} active, ${before.digest} in digest`);
  agree(before, 'at first', before.rail);
  check('the counts say what they count, and none is "need you"', /buzzed you/.test(before.words) && /silent notifications/.test(before.words) && /waited for the digest/.test(before.words) && !/need you/i.test(before.words));
  check('a conversation with several Important messages is one line', before.lines.important.length < before.lists.important.length, [before.lines.important.length, before.lists.important.length]);
  if (!before.unreadCards.length) throw new Error('no unread Important message on this demo hub to vote on');

  // ------------------------------------------------------------------ a line's vote moves its newest message

  const line = await page.eval<{ key: string; newest: string }>(`(() => {
    const imp = [...document.querySelectorAll('.board-block')].find((b) => b.querySelector('h3')?.textContent.trim() === 'Important');
    const l = [...imp.querySelectorAll('.model-line')].find((x) => x.querySelector('.model-msg.unread'));
    return { key: l.dataset.line, newest: [...l.querySelectorAll('.model-msg')].map((m) => m.dataset.mid)[0] };
  })()`);
  const why = await page.eval<{ reasons: string[]; dupes: boolean }>(`(() => {
    const l = document.querySelector('.model-line[data-line="${line.key}"]');
    const rs = [...l.querySelectorAll('.model-reasons .reason')].map((r) => r.firstChild.textContent);
    return { reasons: rs, dupes: new Set(rs).size !== rs.length };
  })()`);
  check("Why lists the line's reasons once each", why.reasons.length > 0 && !why.dupes, why.reasons);
  await page.eval(`document.querySelector('.board-block .model-line[data-line="${line.key}"] .model-vote .tier-vote button:last-child').click()`);
  await page.until(`Number(document.querySelector('[data-count=active] b').textContent) === ${before.active + 1}`, 5000).catch(() => {});
  const down = await state();
  check("voted a line down: its newest message moved from Important to Active", !down.lists.important.includes(line.newest) && down.lists.active.includes(line.newest), line);
  check('…the conversation has a line in Active', down.lines.active.includes(line.key));
  check('…Important one fewer, Active one more', down.important === before.important - 1 && down.active === before.active + 1, [down.important, down.active]);
  const wasUnread = before.unreadCards.includes(line.newest);
  check('…the unread and the badge with it', down.unread === before.unread - (wasUnread ? 1 : 0) && down.rail === before.rail - (wasUnread ? 1 : 0), { unread: down.unread, badge: down.rail });
  agree(down, 'after the vote', down.rail);
  const stored = (await hub('/api/inbox')).items.find((i: any) => i.message.id === line.newest)?.message.triage.feedback;
  check('…and the hub has the vote, on that message', stored === 'quiet', stored);

  await page.eval(`document.querySelector('.model-msg[data-mid="${line.newest}"] .tier-vote button:first-child').click()`);
  await page.until(`Number(document.querySelector('[data-count=important] b').textContent) === ${before.important}`, 5000).catch(() => {});
  const up = await state();
  check("voted back up from the message's own arrows: every count as it was", up.important === before.important && up.active === before.active && up.unread === before.unread && up.rail === before.rail, { before: [before.important, before.active, before.unread, before.rail], now: [up.important, up.active, up.unread, up.rail] });

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
  }

  // ------------------------------------------------------------------ on a phone, from Catch up

  await page.size(400, 820, true);
  await page.goto(`${base}/#/triage`);
  await page.until(`!!document.querySelector('.catchup-head')`, 10000);
  await Bun.sleep(800);
  await page.eval(`[...document.querySelectorAll('.catchup-head .btn')].find((b) => b.textContent.includes('How it sorts')).click()`);
  await page.until(`location.hash === '#/model' && !!document.querySelector('.model-line')`, 8000).catch(() => {});
  await Bun.sleep(800);
  const phone = await state();
  check('on a phone, How it sorts opens from Catch up', (await page.eval<string>('location.hash')) === '#/model');
  agree(phone, 'on a phone', phone.rail);
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

  // ------------------------------------------------------------------ the words, and the thresholds

  await page.size(1200, 800);
  await page.goto(`${base}/#/model`);
  await page.until(`!!document.querySelector('.model-line')`, 10000);
  const words = await page.eval<string[]>(`[...document.querySelectorAll('.model-page .factor-weight, .board-block h3')].map((e) => e.textContent.trim())`);
  check('the page names no level Ping or Notify', !words.some((w) => /\b(Ping|Notify)\b/.test(w)), words);
  const policy = await hub('/api/triage/policy');
  const withProbs = (await hub('/api/inbox')).items.map((i: any) => i.message).find((m: any) => m.triage?.probs && m.authorId);
  if (withProbs) {
    await page.goto(`${base}/#/inbox/c/${withProbs.conversationId}?m=${withProbs.id}`);
    await page.until(`!!document.querySelector('#m-${withProbs.id} [aria-label^="Notification:"]')`, 15000);
    await page.eval(`document.querySelector('#m-${withProbs.id} [aria-label^="Notification:"]').click()`);
    await page.until(`!!document.querySelector('.triage-chances')`, 5000);
    const bars = await page.eval<{ label: string; at: number }[]>(`[...document.querySelectorAll('.triage-chance')].map((e) => ({ label: e.querySelector('span').textContent, at: parseFloat(e.querySelector('.triage-bar i').style.left) / 100 }))`);
    check('the chance bars are named Important, Active, Digest', bars.map((b) => b.label).join() === 'Important,Active,Digest', bars.map((b) => b.label));
    const t = policy.thresholds;
    check("…each marked at the hub's own threshold", bars.length === 3 && [t.ping, t.active, t.interesting].every((v: number, i: number) => Math.abs(bars[i].at - v) < 1e-6), { bars: bars.map((b) => b.at), hub: t });
  } else console.log('      no message with chances on this hub: the bars are not checked');

  const errors = page.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|WebSocket connection/.test(e));
  check('no script errors', !errors.length, errors);
} finally {
  await close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
