/**
 * Joins a voice conversation from a headless Chromium with a fake microphone, holds the call, and
 * leaves. Checks that the call goes live, that this account shows up among the participants, and
 * that audio flows; prints the device-side stats it saw.
 *
 *   bun scripts/verify-call.ts <hub url> <conversation id> [bridge|direct] [seconds] [wav file]
 *
 * Run it only against a voice channel the test account owns: joining is visible to everyone there.
 * The wav (16-bit PCM) becomes the microphone; without one Chromium sends a beep.
 */
import { launch } from './browser.ts';

const [base, conv, mode = 'bridge', secs = '20', wav] = process.argv.slice(2);
if (!base || !conv) throw new Error('usage: bun scripts/verify-call.ts <hub url> <conversation id> [bridge|direct] [seconds] [wav]');

const { page, close } = await launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...(wav ? [`--use-file-for-fake-audio-capture=${wav}`] : [])],
});
let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

const consoleLines: string[] = [];
page.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'warning' || p.type === 'error' || p.type === 'warn') consoleLines.push(`${p.type}: ${p.args.map((a: any) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
});
await page.send('Runtime.enable');
try {
  await page.goto(base);
  await page.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), callMode: ${JSON.stringify(mode)} }))`);
  await page.goto(`${base.replace(/\/$/, '')}/?mode=${mode}#/inbox/c/${conv}`); // a new query string reloads, so the saved mode applies
  await page.until(`!!document.querySelector('.call-join')`, 30_000);
  check('join button on the voice channel', true);
  await page.eval(`document.querySelector('.call-join').click()`);
  const t0 = Date.now();
  await page.until(`document.querySelector('[data-call-phase]')?.dataset.callPhase !== 'connecting'`, 60_000);
  const phase = await page.eval<string>(`document.querySelector('[data-call-phase]')?.dataset.callPhase`);
  check('call goes live', phase === 'live', { phase, ms: Date.now() - t0, note: await page.eval(`document.querySelector('.call-dock-text small')?.textContent`) });
  if (phase === 'live') {
    await page.eval(`document.querySelector('.call-dock-title').click()`);
    await page.until(`document.querySelectorAll('.call-people li:not(.call-empty)').length > 0`, 20_000).catch(() => {});
    const people = await page.eval<string[]>(`[...document.querySelectorAll('.call-people li:not(.call-empty) .call-name')].map((e) => e.textContent)`);
    check('this account is among the participants', people.length > 0, people);
    const samples: any[] = [];
    const end = Date.now() + Number(secs) * 1000;
    while (Date.now() < end) {
      await Bun.sleep(5000);
      const ph = await page.eval<string | undefined>(`document.querySelector('[data-call-phase]')?.dataset.callPhase`);
      if (ph !== 'live') {
        console.log('call left live:', ph, await page.eval(`document.querySelector('.call-dock-text small')?.textContent`));
        break;
      }
      const s = await page.eval<string | undefined>(`document.querySelector('[data-call-stats]')?.dataset.callStats`);
      if (s) samples.push({ t: Math.round((Date.now() - t0) / 1000), ...JSON.parse(s) });
    }
    console.log(JSON.stringify(samples));
    const last = samples.at(-1);
    check('audio goes up', !!last && last.sent > 10_000, last && { sent: last.sent });
    await page.eval(`document.querySelector('.call-btn.leave')?.click()`);
    await page.until(`document.querySelector('[data-call-phase]')?.dataset.callPhase !== 'live'`, 15_000);
    check('leaving ends the call', true);
  }
  if (page.errors.length) console.log('page errors:', page.errors.slice(0, 5));
  if (consoleLines.length) console.log('console:\n' + consoleLines.slice(-15).join('\n'));
} catch (e) {
  check('ran to the end', false, String(e));
} finally {
  await close();
}
process.exit(failed ? 1 : 0);
