/**
 * The Triage board's counts and words (packages/web/src/board.ts, docs/notifications.md#voting), in a real browser
 * against a demo hub:
 *
 *   - the badge on the inbox button is the Important list's unread messages plus accounts that need you, and the
 *     board's own counts are the lengths of its lists;
 *   - a vote moves a card between lists, and every count, the badge included, moves with it; voting it back puts them back;
 *   - the same on the phone's Triage tab;
 *   - levels are named Important / Active / Digest everywhere, and the chance bars are marked at the hub's thresholds.
 *
 *   bun scripts/verify-triage.ts http://127.0.0.1:8731
 *
 * Run it against a demo hub, never a real one: it votes.
 */
import { launch } from './browser.ts';

const base = process.argv[2];
if (!base) throw new Error('usage: bun scripts/verify-triage.ts <hub url>');

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

const { page, close } = await launch();
await page.size(1200, 800);

/** Everything the board and the badges say, and what the lists hold. */
const state = () =>
  page.eval<any>(`(() => {
    const n = (k) => Number(document.querySelector('[data-count=' + k + '] b')?.textContent ?? NaN);
    const unread = Number((document.querySelector('[data-count=important]')?.textContent.match(/(\\d+) unread/) ?? [0, 0])[1]);
    const block = (title) => [...document.querySelectorAll('.board-block')].find((b) => b.querySelector('h3')?.textContent.trim() === title);
    const ids = (b) => (b ? [...b.querySelectorAll('.ping')].map((p) => p.dataset.mid) : []);
    const shownAll = (b) => !b?.querySelector(':scope > button.btn');
    const imp = block('Important');
    const badge = (sel) => Number(document.querySelector(sel)?.textContent ?? 0);
    return {
      important: n('important'), unread, active: n('active'), digest: n('digest'), attention: n('attention'),
      rail: badge('.rail-item:has(.rail-logo) .rail-count .count'),
      tab: badge('.tabbar .tab:nth-child(2) .tab-badge'),
      lists: { important: ids(imp), active: ids(block('Active')), digest: ids(block('Digest')) },
      unreadCards: imp ? [...imp.querySelectorAll('.ping.unread')].map((p) => p.dataset.mid) : [],
      allShown: { important: shownAll(imp), active: shownAll(block('Active')) },
    };
  })()`);

const agree = (s: any, where: string, badge: number) => {
  check(`${where}: the badge is the Important list unread plus accounts that need you`, badge === s.unread + s.attention, { badge, unread: s.unread, attention: s.attention });
  if (s.allShown.important) {
    check(`${where}: the Important count is the list's length`, s.important === s.lists.important.length, [s.important, s.lists.important.length]);
    check(`${where}: …and its unread are the unread cards`, s.unread === s.unreadCards.length, [s.unread, s.unreadCards.length]);
  }
  if (s.allShown.active) check(`${where}: the Active count is the list's length`, s.active === s.lists.active.length, [s.active, s.lists.active.length]);
};

try {
  await page.goto(`${base}/#/triage`);
  await page.until(`!!document.querySelector('.board .board-stats') && performance.getEntriesByName('dither:fresh').length > 0`, 20000);
  await Bun.sleep(1500);
  const before = await state();
  console.log(`      the board: ${before.important} important (${before.unread} unread), ${before.active} active, ${before.digest} in digest, ${before.attention} need you`);
  agree(before, 'at first', before.rail);
  if (!before.unreadCards.length) throw new Error('no unread Important message on this demo hub to vote on');

  // ------------------------------------------------------------------ a vote moves everything together

  const mid = before.unreadCards[0];
  await page.eval(`document.querySelector('.ping[data-mid="${mid}"] .tier-vote button:last-child').click()`);
  await page.until(`!!document.querySelector('[data-count=active]') && Number(document.querySelector('[data-count=active] b').textContent) === ${before.active + 1}`, 5000).catch(() => {});
  const down = await state();
  check('voted down: the card moved from Important to Active', !down.lists.important.includes(mid) && down.lists.active.includes(mid));
  check('…Important one fewer, Active one more', down.important === before.important - 1 && down.active === before.active + 1, [down.important, down.active]);
  check('…one fewer unread, and the badge with it', down.unread === before.unread - 1 && down.rail === before.rail - 1, { unread: down.unread, badge: down.rail });
  agree(down, 'after the vote', down.rail);
  const stored = (await hub('/api/inbox')).items.find((i: any) => i.message.id === mid)?.message.triage.feedback;
  check('…and the hub has the vote', stored === 'quiet', stored);

  await page.eval(`document.querySelector('.ping[data-mid="${mid}"] .tier-vote button:first-child').click()`);
  await page.until(`Number(document.querySelector('[data-count=important] b').textContent) === ${before.important}`, 5000).catch(() => {});
  const up = await state();
  check('voted back up: every count as it was', up.important === before.important && up.active === before.active && up.unread === before.unread && up.rail === before.rail, { before: [before.important, before.active, before.unread, before.rail], now: [up.important, up.active, up.unread, up.rail] });

  // ------------------------------------------------------------------ the phone's Triage tab

  await page.size(400, 820, true);
  await Bun.sleep(800);
  const phone = await state();
  agree(phone, 'on a phone', phone.tab);

  // ------------------------------------------------------------------ the words, and the thresholds

  await page.size(1200, 800);
  const words = await page.eval<string[]>(`[...document.querySelectorAll('.board .factor-weight, .board-block h3')].map((e) => e.textContent.trim())`);
  check('the board names no level Ping or Notify', !words.some((w) => /\b(Ping|Notify)\b/.test(w)), words);
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
