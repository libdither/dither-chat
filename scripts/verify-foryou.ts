/**
 * For you (packages/web/src/ui/ForYou.tsx, packages/hub/src/foryou.ts, docs/foryou.md) in a real browser against a
 * fresh demo hub:
 *
 *   - with no chat open, the right pane is For you: single messages from channels, threads and big groups, never a DM
 *     or a small group, never one of yours or one to you;
 *   - opening it, and items sitting on screen, mark nothing read;
 *   - what was on screen reaches the hub as `shown` events with their time on screen, and the served items are logged
 *     with their slot and chance (ids and numbers only);
 *   - clicking an item opens its chat at that message, and back comes to For you with the same snapshot, scrolled
 *     where it was;
 *   - Hide takes an item away and is logged; the "N new" count answers for the snapshot;
 *   - on a phone the For you tab shows it with no badge, an item opens its chat over the tab, and back returns to the
 *     tab; Catch up's old address opens it.
 *
 *   bun packages/hub/src/main.ts --demo --data <fresh dir> --port <port> --web <built web>
 *   bun scripts/verify-foryou.ts http://127.0.0.1:<port> [screenshot dir]
 *
 * A fresh demo hub only, never a real one: it opens chats (which reads them) and writes to the activity log.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const base = process.argv[2];
const shots = process.argv[3];
if (!base) throw new Error('usage: bun scripts/verify-foryou.ts <hub url> [screenshot dir]');
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const get = <T = any>(path: string): Promise<T> => fetch(base + path).then((r) => r.json() as Promise<T>);

const boot0 = await get('/api/bootstrap');
if (!boot0.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub: refusing');
const shapeOf = new Map<string, string>(boot0.conversations.map((c: any) => [c.id, c.shape]));
const unreadOf = (b: any) => new Map<string, number>(b.conversations.map((c: any) => [c.id, c.vantages.reduce((s: number, v: any) => s + v.unread, 0)]));

const { page, close } = await launch();
const shot = async (name: string) => {
  if (!shots) return;
  await page.eval(`document.querySelectorAll('.toast .toast-x').forEach((x) => x.click())`);
  await page.shot(`${shots}/${name}.png`);
};
/** Input now, so the page counts as in use (usage.ts `inUse`). */
const wiggle = async () => {
  for (const x of [400, 420]) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 300 });
};
const items = () =>
  page.eval<{ id: string; pos: number; slot: string; mid: string }[]>(
    `[...document.querySelectorAll('.foryou .fy-item')].map((el) => ({ id: el.dataset.item, pos: Number(el.dataset.pos), slot: el.dataset.slot, mid: el.dataset.item }))`,
  );

try {
  // ------------------------------------------------------------------ the pane, on a computer

  await page.size(1400, 900);
  await page.goto(`${base}/#/inbox`);
  await page.until(`!!document.querySelector('.foryou .fy-item')`, 20000);
  await Bun.sleep(1500);
  const first = await page.eval<{ epoch: string; n: number }>(`({ epoch: document.querySelector('.foryou .fy-item').dataset.item.split('.')[0], n: document.querySelectorAll('.foryou .fy-item').length })`);
  check('with no chat open, the right pane is For you, with items', first.n > 0, first.n);
  if (shots) await shot('desk-foryou');

  const served = await get(`/api/foryou?epoch=${first.epoch}&limit=50`);
  const convs = served.items.map((i: any) => i.message.conversationId);
  const shapes: string[] = [...new Set<string>(convs.map((c: string) => shapeOf.get(c) ?? '?'))];
  check('items are single messages from channels, threads and big groups, never a DM', shapes.every((s) => s === 'channel' || s === 'thread' || s === 'group'), shapes);
  const selfIds = new Set(boot0.accounts.map((a: any) => a.selfIdentityId).filter(Boolean));
  check('…never yours, never to you', served.items.every((i: any) => !selfIds.has(i.message.authorId) && !i.message.mentionsSelf));
  check('…one per burst, each with its burst counted', served.items.every((i: any) => i.burst.count >= 1));
  check('the same snapshot answers the page and the hub', served.epoch === first.epoch && served.items.length >= first.n, { served: served.items.length, shown: first.n });

  // Sit on it a while, in use.
  for (let i = 0; i < 4; i++) {
    await wiggle();
    await Bun.sleep(700);
  }
  await page.eval(`document.querySelector('.foryou-scroll').scrollTop = 220; document.querySelector('.foryou-scroll').dispatchEvent(new Event('scroll'))`);
  await wiggle();
  await Bun.sleep(2500);
  const unreadAfter = unreadOf(await get('/api/bootstrap'));
  const before = unreadOf(boot0);
  const changed = [...new Set(convs)].filter((c) => (before.get(c as string) ?? 0) !== (unreadAfter.get(c as string) ?? 0));
  check('opening For you, and items on screen, mark nothing read', !changed.length, changed);
  const s1 = await get('/api/foryou/stats');
  check('what was on screen reached the hub as shown, with its time', s1.shown > 0 && s1.served >= first.n, s1);

  // ------------------------------------------------------------------ open one, and back

  const target = await page.eval<{ id: string; mid: string; conv: string; top: number } | null>(`(() => {
    const el = [...document.querySelectorAll('.foryou .fy-item')].find((e) => e.getBoundingClientRect().top > 120);
    return el ? { id: el.dataset.item, top: document.querySelector('.foryou-scroll').scrollTop } : null;
  })()`);
  const it = served.items.find((i: any) => i.id === target?.id);
  check('an item to open', !!it);
  if (it) {
    await page.eval(`document.querySelector('.foryou [data-item="${it.id}"] .fy-text, .foryou [data-item="${it.id}"] .fy-author').click()`);
    await page.until(`location.hash.includes('${encodeURIComponent(it.message.conversationId)}')`, 8000).catch(() => {});
    await page.until(`!!document.getElementById('m-${it.message.id}')`, 8000).catch(() => {});
    await Bun.sleep(1200);
    const at = await page.eval<{ hash: string; there: boolean; inView: boolean }>(`(() => {
      const m = document.getElementById('m-${it.message.id}');
      const r = m?.getBoundingClientRect();
      return { hash: location.hash, there: !!m, inView: !!r && r.bottom > 0 && r.top < innerHeight };
    })()`);
    check('clicking an item opens its chat at that message, in context', at.hash.includes(`m=${encodeURIComponent(it.message.id)}`) && at.there && at.inView, at);
    if (shots) await shot('desk-foryou-opened');
    await page.eval('history.back()');
    await page.until(`!!document.querySelector('.foryou .fy-item')`, 8000).catch(() => {});
    await Bun.sleep(600);
    const back = await page.eval<{ hash: string; epoch: string; top: number }>(
      `({ hash: location.hash, epoch: document.querySelector('.foryou .fy-item')?.dataset.item.split('.')[0], top: document.querySelector('.foryou-scroll').scrollTop })`,
    );
    check('back returns to For you: the same snapshot, scrolled where it was', back.hash === '#/inbox' && back.epoch === first.epoch && Math.abs(back.top - (target?.top ?? 0)) < 4, { ...back, was: target?.top });
    const s2 = await get('/api/foryou/stats');
    check('the click is logged against a shown item', s2.clicked >= 1, s2);
  }

  // ------------------------------------------------------------------ hide, and "N new"

  const all0 = await items();
  const gone = all0[all0.length - 1];
  await page.eval(`document.querySelector('.foryou [data-item="${gone.id}"] [data-track="hide"]').click()`);
  await Bun.sleep(1500);
  check('Hide takes an item away', !(await items()).some((x) => x.id === gone.id));
  const fresh = await get(`/api/foryou/fresh?epoch=${first.epoch}`);
  check('"N new" answers for the snapshot', fresh.known === true && typeof fresh.fresh === 'number', fresh);
  const unknown = await get(`/api/foryou/fresh?epoch=nope`);
  check('…and says when the hub no longer has it', unknown.known === false);

  // ------------------------------------------------------------------ the phone's tab

  await page.size(390, 844, true);
  await page.goto(`${base}/#/inbox`);
  await Bun.sleep(1500);
  const tab = await page.eval<{ badge: boolean; old: boolean } | null>(
    `(() => { const t = [...document.querySelectorAll('.tabbar .tab')].find((b) => b.textContent.includes('For you')); return t ? { badge: !!t.querySelector('.tab-badge'), old: [...document.querySelectorAll('.tabbar .tab')].some((b) => b.textContent.includes('Catch up')) } : null; })()`,
  );
  check('the phone has a For you tab, with no badge, and no Catch up tab', !!tab && !tab.badge && !tab.old, tab);
  await page.eval(`[...document.querySelectorAll('.tabbar .tab')].find((b) => b.textContent.includes('For you')).click()`);
  await page.until(`location.hash === '#/foryou' && !!document.querySelector('.foryou .fy-item')`, 8000).catch(() => {});
  await Bun.sleep(800);
  const ph = await page.eval<{ hash: string; items: number; overflow: boolean; active: boolean }>(
    `({ hash: location.hash, items: document.querySelectorAll('.foryou .fy-item').length, overflow: document.querySelector('.foryou-scroll').scrollWidth > document.querySelector('.foryou-scroll').clientWidth + 1, active: !!document.querySelector('.tabbar .tab.active')?.textContent.includes('For you') })`,
  );
  check('the tab opens For you on #/foryou', ph.hash === '#/foryou' && ph.items > 0 && ph.active, ph);
  check('…and nothing runs off the side', !ph.overflow);
  if (shots) {
    await page.eval(`document.querySelector('.foryou-scroll').scrollTop = 0`);
    await Bun.sleep(300);
    await shot('phone-foryou');
  }
  const pi = (await items())[0];
  await page.eval(`document.querySelector('.foryou [data-item="${pi.id}"] .fy-author').click()`);
  await page.until(`location.hash.startsWith('#/inbox/c/')`, 8000).catch(() => {});
  await Bun.sleep(1000);
  check('an item opens its chat over the tab', (await page.eval<string>('location.hash')).includes('?m='));
  await page.eval(`document.querySelector('.pane .icon-btn.back')?.click()`);
  await page.until(`location.hash === '#/foryou'`, 6000).catch(() => {});
  await Bun.sleep(800);
  check("…and the chat's back button returns to the tab", (await page.eval<string>('location.hash')) === '#/foryou' && (await page.eval<boolean>(`!!document.querySelector('.foryou .fy-item')`)), await page.eval<string>('location.hash'));
  await page.goto(`${base}/#/triage`);
  await page.until(`location.hash === '#/foryou'`, 6000).catch(() => {});
  check("Catch up's old address opens For you", (await page.eval<string>('location.hash')) === '#/foryou' || !!(await page.eval<boolean>(`!!document.querySelector('.foryou')`)));
  const errs = page.errors.filter((e) => !/favicon|ERR_|net::/.test(e));
  check('no errors on the page', !errs.length, errs.slice(0, 3));
} finally {
  await close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
