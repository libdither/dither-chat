/**
 * dither-desk, the desktop helper (docs/desktop.md).
 *
 *   bun packages/desk/src/main.ts            serve on 127.0.0.1:8475
 *   bun packages/desk/src/main.ts pair [origin]   print a one-time code for Settings → Desktop helper
 *   bun packages/desk/src/main.ts unpair     forget the paired page
 *   bun packages/desk/src/main.ts status     which page it is paired with
 *
 * Environment: DESK_PORT, DESK_CONFIG_DIR, DESK_DOWNLOAD_DIR, DESK_OPEN_CMD (default xdg-open), DESK_GIO_CMD
 * (default gio), DESK_MAX_BYTES. The commands are split on spaces and run without a shell.
 */
import { join } from 'node:path';
import { applicationDirs } from './apps.ts';
import { createDesk, downloadDir, readPaired, startPairing, unpair, validOrigin, VERSION, type DeskConfig } from './desk.ts';

const env = process.env;
const home = env.HOME ?? '';
const argv = (s: string | undefined, d: string) => (s?.trim() || d).split(/\s+/);

const config: DeskConfig = {
  configDir: env.DESK_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'dither-desk'),
  downloadDir: env.DESK_DOWNLOAD_DIR || join(downloadDir(env), 'dither'),
  openCmd: argv(env.DESK_OPEN_CMD, 'xdg-open'),
  gioCmd: argv(env.DESK_GIO_CMD, 'gio'),
  appDirs: applicationDirs(env),
  maxBytes: Number(env.DESK_MAX_BYTES) || 512 * 1024 * 1024,
};
const port = Number(env.DESK_PORT) || 8475;
const [cmd, arg] = process.argv.slice(2);

if (!cmd || cmd === 'serve') {
  const handle = createDesk(config);
  Bun.serve({ hostname: '127.0.0.1', port, fetch: handle });
  const p = readPaired(config);
  console.log(`dither-desk ${VERSION} on http://127.0.0.1:${port}, ${p ? `paired with ${p.origin}` : 'not paired (run: pair)'}; files go to ${config.downloadDir}`);
} else if (cmd === 'pair') {
  if (arg && !validOrigin(arg)) {
    console.error(`not an origin: ${arg} (like https://chat.example.net, no path)`);
    process.exit(2);
  }
  const before = readPaired(config)?.at ?? 0;
  const code = startPairing(config, arg);
  console.log(`Type this code in Settings → Desktop helper${arg ? ` on ${arg}` : ''} within 5 minutes:\n\n    ${code}\n`);
  // Says which page took it, so a page you did not expect shows here.
  for (let i = 0; i < 300; i++) {
    await Bun.sleep(1000);
    const p = readPaired(config);
    if (p && p.at !== before) {
      console.log(`Paired with ${p.origin}.`);
      process.exit(0);
    }
  }
  console.log('The code expired.');
  process.exit(1);
} else if (cmd === 'unpair') {
  unpair(config);
  console.log('Unpaired.');
} else if (cmd === 'status') {
  const p = readPaired(config);
  console.log(p ? `paired with ${p.origin} since ${new Date(p.at).toISOString()}` : 'not paired');
} else {
  console.error('usage: main.ts [serve | pair [origin] | unpair | status]');
  process.exit(2);
}
