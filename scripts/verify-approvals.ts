/**
 * Approvals (docs/approvals.md), end to end against a demo hub in headless Chromium, with real input: dither-ask asks
 * (an asker's token, waiting with --keys from `dither-ask keys`), the request shows as a notice whose card has the
 * body, the payload and the actions; a click on an action that needs a signature goes to the demo's laptop signer,
 * which signs, and dither-ask exits 0 with the answer verified and the message passed back; Deny from the page exits
 * 77. Then the card at a phone's width.
 *
 *   bun scripts/verify-approvals.ts http://127.0.0.1:8497 <the demo hub's data dir> [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this adds an asker and answers requests.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, type Page } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8497';
const data = process.argv[3];
const shots = process.argv[4];
if (!data) throw new Error('usage: verify-approvals.ts <hub> <data dir> [shots dir]');
if (shots) mkdirSync(shots, { recursive: true });
const root = join(import.meta.dir, '..');
const tmp = mkdtempSync(join(tmpdir(), 'verify-approvals-'));
/** Titles of this run's own, so an earlier run's notices on the same hub are not taken for them. */
const run = Math.random().toString(36).slice(2, 7);
const T1 = `Deploy to host-a paused (${run})`;
const T2 = `Switch host-a to a dirty build (${run})`;

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

// An asker, and the devices' keys as dither-ask gets them.
const add = Bun.spawnSync(['bun', 'packages/hub/src/cli.ts', 'asker', 'add', 'verify', '--out', join(tmp, 'token'), '--data', data], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
check(add.exitCode === 0, 'an asker token was made', add.stderr.toString().trim());
const env = { ...process.env, DITHER_ASK_URL: hub, DITHER_ASK_TOKEN_FILE: join(tmp, 'token') };
const ask = (args: string[]) => Bun.spawn(['bun', 'packages/approvals/src/cli.ts', ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
const keys = ask(['keys']);
const keysText = await new Response(keys.stdout).text();
check((await keys.exited) === 0 && keysText.includes('dev_DemoLaptop desk'), 'dither-ask keys lists the demo laptop', keysText.split('\n').filter((l) => l.startsWith('dev_')));
writeFileSync(join(tmp, 'keys'), keysText);

/** A click with real input at the middle of `sel`. */
async function click(p: Page, sel: string) {
  const r = await p.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error(`nothing at ${sel}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
}
async function type(p: Page, sel: string, text: string) {
  await click(p, sel);
  await p.send('Input.insertText', { text });
}

writeFileSync(join(tmp, 'body'), 'nixos-deploy paused on host-a:\n  check failed: unit foo.service did not come back\n  rolled back to 1a2b3c4d\n');
writeFileSync(join(tmp, 'payload'), 'dither-deploy-v1\nhost host-a\ncommit 1111111111111111111111111111111111111111\nstate failed\n');
const first = ask(['request', '--kind', 'deploy', '--title', T1, '--body-file', join(tmp, 'body'), '--payload-file', join(tmp, 'payload'), '--action', 'resume:signed=Resume', '--action', 'hold:any=Hold', '--wait', '60', '--keys', join(tmp, 'keys')]);

const { page: p, close } = await launch();
try {
  await p.size(1280, 900);
  await p.goto(`${hub}/#/notices`);
  await p.until(`[...document.querySelectorAll('.notice-card')].some((c) => c.textContent.includes(${JSON.stringify(T1)}))`, 15000);
  const card = `[data-notice="${await p.eval<string>(`[...document.querySelectorAll('.notice-card')].find((c) => c.textContent.includes(${JSON.stringify(T1)})).dataset.notice`)}"]`;
  check((await p.eval<string>(`document.querySelector('${card} .notice-where').textContent`)).startsWith('Approval · verify'), 'it is a notice from Approval, by its asker');
  await click(p, `${card} .notice-head`);
  await p.until(`!!document.querySelector('${card} .approval-card .approval-actions')`, 10000);
  const buttons = await p.eval<string[]>(`[...document.querySelectorAll('${card} .approval-actions button')].map((b) => b.dataset.act)`);
  check(buttons.join() === 'resume,hold,deny', 'its actions, deny last', buttons);
  check((await p.eval<string>(`document.querySelector('${card} .approval-body').textContent`)).includes('rolled back'), 'the body shows');
  if (shots) await p.shot(join(shots, 'approval-desktop.png'));
  await type(p, `${card} .approval-message`, 'go, then look at foo');
  await click(p, `${card} [data-act="resume"]`);
  await p.until(`!!document.querySelector('${card} .approval-outcome')`, 15000);
  const outcome = await p.eval<string>(`document.querySelector('${card} .approval-outcome').textContent`);
  check(/Resume, on Demo laptop, signed/.test(outcome) && outcome.includes('go, then look at foo'), 'the laptop signer signed it, and the card says so', outcome);
  if (shots) await p.shot(join(shots, 'approval-answered.png'));
  const code = await first.exited;
  const j = JSON.parse(await new Response(first.stdout).text());
  check(code === 0 && j.action === 'resume' && j.verified === true && j.message === 'go, then look at foo', 'dither-ask: exit 0, verified, with the message', { code, action: j.action, verified: j.verified, message: j.message });

  // Deny from the page.
  const second = ask(['request', '--kind', 'rebuild', '--title', T2, '--wait', '60', '--keys', join(tmp, 'keys')]);
  await p.until(`[...document.querySelectorAll('.notice-card')].some((c) => c.textContent.includes(${JSON.stringify(T2)}))`, 15000).catch(async () => {
    await p.goto(`${hub}/#/notices`);
    await p.until(`[...document.querySelectorAll('.notice-card')].some((c) => c.textContent.includes(${JSON.stringify(T2)}))`, 15000);
  });
  const card2 = `[data-notice="${await p.eval<string>(`[...document.querySelectorAll('.notice-card')].find((c) => c.textContent.includes(${JSON.stringify(T2)})).dataset.notice`)}"]`;
  await click(p, `${card2} .notice-head`);
  await p.until(`!!document.querySelector('${card2} [data-act="deny"]')`, 10000);
  await p.size(390, 844, true);
  if (shots) await p.shot(join(shots, 'approval-phone.png'));
  await click(p, `${card2} [data-act="deny"]`);
  check((await second.exited) === 77, 'Deny on the page: dither-ask exits 77');
  check(!p.errors.length, 'no errors on the page', p.errors);
} finally {
  await close();
}
console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
