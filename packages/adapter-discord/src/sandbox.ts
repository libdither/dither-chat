/**
 * Per-account sandbox: a private Xvfb display, a NON-headless Chromium running the
 * real Discord web client with a persistent profile and our unpacked extension,
 * and an x11vnc server on a Unix socket in the account's directory (and on no TCP
 * port) so the hub can proxy a live view.
 *
 * Deliberately NOT automation: no Playwright/Puppeteer, no --enable-automation, no
 * --remote-debugging-port, no --headless. It is an ordinary browser window that
 * happens to run on a virtual display, so navigator.webdriver stays false and the
 * client behaves exactly as it would on the user's desktop.
 *
 * Isolation today is per-process: each account gets its own display, profile and
 * extension copy. Wrapping each sandbox in a podman container (one more boundary,
 * shared nothing) is the obvious follow-up but not needed to run.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Subprocess } from 'bun';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_SRC = join(HERE, 'extension');
const LAB_SRC = join(HERE, 'lab');

export interface SandboxOptions {
  accountDir: string;
  display: number; //    X display number, e.g. 91 -> :91
  width: number;
  height: number;
  wsUrl: string; //      ws://127.0.0.1:<adapterPort>/
  token: string; //      per-account WebSocket token
  startUrl: string; //   e.g. https://discord.com/app
  noSandbox?: boolean; // set if the chromium suid sandbox is unavailable
  lab?: boolean; //       call lab only: the lab probe and commands go into the hook (scripts/call-lab.ts)
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

interface Bins {
  xvfb: string;
  x11vnc: string;
  chromium: string;
}

const CHROMIUM_CANDIDATES = [`/etc/profiles/per-user/${process.env.USER}/bin/chromium`, '/run/current-system/sw/bin/chromium'];

/** Resolve a binary: env override -> PATH -> known candidates -> nix build. */
function resolveBin(name: 'Xvfb' | 'x11vnc' | 'chromium', envVar: string, nixAttr: string, candidates: string[], log: SandboxOptions['log']): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  for (const c of candidates) if (existsSync(c)) return c;
  log('info', `resolving ${name} via nix build nixpkgs#${nixAttr}`);
  const out = spawnSync('nix', ['build', `nixpkgs#${nixAttr}`, '--no-link', '--print-out-paths'], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`cannot find ${name}: set ${envVar}, put it on PATH, or make nix available (${out.stderr?.slice(0, 200)})`);
  const store = out.stdout.trim().split('\n').pop()!.trim();
  const bin = join(store, 'bin', name);
  if (!existsSync(bin)) throw new Error(`nix built ${nixAttr} but ${bin} is missing`);
  return bin;
}

export function resolveBins(log: SandboxOptions['log']): Bins {
  return {
    xvfb: resolveBin('Xvfb', 'XVFB_BIN', 'xvfb', [], log),
    x11vnc: resolveBin('x11vnc', 'X11VNC_BIN', 'x11vnc', [], log),
    chromium: resolveBin('chromium', 'CHROMIUM_BIN', 'chromium', CHROMIUM_CANDIDATES, log),
  };
}

/**
 * Xvfb has no GL of its own, so left alone Chromium runs with WebGL off, which no ordinary desktop
 * browser does. Point it at the machine's GPU directly, or at its software renderer if there is none.
 */
function gpuFlags(): string[] {
  let render = false;
  try {
    render = readdirSync('/dev/dri').some((n) => n.startsWith('renderD'));
  } catch {
    /* no /dev/dri at all */
  }
  if (render) return ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan'];
  return ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
}

export class Sandbox {
  private procs: { name: string; proc: Subprocess }[] = [];
  private stopped = false;
  readonly profileDir: string;
  readonly extensionDir: string;
  /** The live view: x11vnc's Unix socket (vnc.sock in the account directory). */
  readonly vncSocket: string;

  constructor(private opts: SandboxOptions) {
    this.profileDir = join(opts.accountDir, 'profile');
    this.extensionDir = join(opts.accountDir, 'extension');
    this.vncSocket = vncSocketPath(opts.accountDir);
  }

  /** Copy the extension template and stamp this account's config into it. */
  private prepareExtension() {
    mkdirSync(this.profileDir, { recursive: true });
    // Fresh copy each start so template edits take effect; profile (the login) persists.
    rmSync(this.extensionDir, { recursive: true, force: true });
    cpSync(EXTENSION_SRC, this.extensionDir, { recursive: true });
    writeFileSync(
      join(this.extensionDir, 'config.json'),
      JSON.stringify({ wsUrl: this.opts.wsUrl, token: this.opts.token }, null, 2),
      { mode: 0o600 },
    );
    // Call lab sandboxes only (scripts/call-lab.ts): the probe and the lab commands go inside the hook.
    if (this.opts.lab) {
      const hook = join(this.extensionDir, 'hook.js');
      const lab = ['probe.js', 'lab.js'].map((f) => readFileSync(join(LAB_SRC, f), 'utf8')).join('\n');
      writeFileSync(hook, readFileSync(hook, 'utf8').replace('/*@dither-lab@*/', () => lab));
    }
  }

  /** Chromium must not offer to keep a password typed into the live view: this profile runs on --password-store=basic. */
  private disablePasswordManager() {
    const path = join(this.profileDir, 'Default', 'Preferences');
    const prefs = readConfigFile<Record<string, any>>(path, {});
    prefs.credentials_enable_service = false;
    prefs.profile = { ...prefs.profile, password_manager_enabled: false };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(prefs));
  }

  private spawn(name: string, cmd: string[], env?: Record<string, string>): Subprocess {
    this.opts.log('debug', `spawn ${name}`, cmd.join(' '));
    const proc = Bun.spawn(cmd, {
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (_p, code, signal) => {
        if (!this.stopped) this.opts.log('warn', `${name} exited`, { code, signal });
      },
    });
    this.procs.push({ name, proc });
    // Drain output into the adapter log at debug level.
    for (const stream of [proc.stdout, proc.stderr]) {
      (async () => {
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = dec.decode(value).trim();
          if (text) this.opts.log('debug', `[${name}] ${text.slice(0, 400)}`);
        }
      })().catch(() => {});
    }
    return proc;
  }

  async start(): Promise<Bins> {
    const bins = resolveBins(this.opts.log);
    this.prepareExtension();
    this.disablePasswordManager();
    const d = `:${this.opts.display}`;
    const { width, height } = this.opts;

    // 1. Virtual display.
    // -dpi 96: Xvfb defaults to 100, and Chromium scales itself to match, which makes its window
    // wider and taller than the display and the page cut off at the edges.
    this.spawn('Xvfb', [bins.xvfb, d, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-nocursor', '-dpi', '96']);
    await this.waitForDisplay(d, 8000);

    // 2. The browser (ordinary window, persistent profile, our extension).
    const flags = [
      `--user-data-dir=${this.profileDir}`,
      `--load-extension=${this.extensionDir}`,
      // newer Chromium gates --load-extension behind this feature switch
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-crash-reporter',
      '--noerrdialogs',
      '--disable-infobars',
      `--window-size=${width},${height}`,
      '--window-position=0,0',
      // Calls: the client's audio feeds the bridge without anyone clicking first.
      '--autoplay-policy=no-user-gesture-required',
    ];
    flags.push(...gpuFlags());
    if (this.opts.noSandbox) flags.push('--no-sandbox');
    this.spawn('chromium', [bins.chromium, ...flags, this.opts.startUrl], { DISPLAY: d });

    // 3. Live view: VNC on the account's own Unix socket and no TCP port, no password (the hub carries it, behind its
    // login). -forever so it survives client disconnects; -shared for multiple viewers.
    prepareVncSocket(this.vncSocket);
    const vnc = this.spawn('x11vnc', x11vncArgs(bins.x11vnc, d, this.vncSocket));
    await waitForVncSocket(this.vncSocket, vnc, 10_000);

    this.opts.log('info', `sandbox up: display ${d}, vnc on ${this.vncSocket}`, { chromium: bins.chromium });
    return bins;
  }

  /** Poll for the X socket so Chromium/x11vnc never race the display. */
  private async waitForDisplay(display: string, timeoutMs: number) {
    const sock = `/tmp/.X11-unix/X${display.slice(1)}`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(sock)) return;
      await Bun.sleep(100);
    }
    throw new Error(`Xvfb display ${display} did not come up within ${timeoutMs}ms`);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    // Kill in reverse-ish order: browser and vnc first, display last.
    const order = ['chromium', 'x11vnc', 'Xvfb'];
    for (const name of order) {
      for (const p of this.procs.filter((x) => x.name === name)) {
        try {
          p.proc.kill('SIGTERM');
        } catch {}
      }
    }
    // Give them a moment, then hard-kill anything still alive.
    const killer = setTimeout(() => {
      for (const p of this.procs) {
        try {
          p.proc.kill('SIGKILL');
        } catch {}
      }
    }, 4000);
    await Promise.all(this.procs.map((p) => p.proc.exited.catch(() => {})));
    clearTimeout(killer);
    this.procs = [];
    rmSync(this.vncSocket, { force: true });
    this.opts.log('info', 'sandbox stopped');
  }

  /** True while the Chromium process is alive. */
  get browserAlive(): boolean {
    const c = this.procs.find((p) => p.name === 'chromium');
    return !!c && c.proc.exitCode === null;
  }
}

/** Read the display from config/env, else derive a stable slot in :91-:99. Its live view is a socket, not a port. */
export function pickDisplay(accountId: string, config: Record<string, any>): { display: number } {
  const envD = process.env.DITHER_DISPLAY ? Number(process.env.DITHER_DISPLAY) : undefined;
  if (config.display || envD) return { display: Number(config.display ?? envD) };
  // derive from account id hash into 91..99
  let hc = 0;
  for (const ch of accountId) hc = (hc * 31 + ch.charCodeAt(0)) >>> 0;
  return { display: 91 + (hc % 9) };
}

// ------------------------------------------------------------------ live view
// x11vnc on a Unix socket in the account's own directory and on no TCP port (dither-accounts'
// packages/browser/src/vnc.ts, where each flag is explained). A VNC without a password on 127.0.0.1
// let in every local process and any web page in a browser here (libvncserver takes a WebSocket
// upgrade on its port from any Origin). x11vnc 0.9.17: -rfbport 0 alone still leaves [::]:5900, hence
// -rfbportv6 -1 and -no6; -localhost would turn the socket's clients away.

/** A Unix socket's path is at most 107 bytes (sun_path, less its NUL). */
const SOCKET_PATH_MAX = 107;

/** vnc.sock in the account directory, or one named for it in the runtime directory when that path is too long. */
export function vncSocketPath(dir: string): string {
  const own = join(resolve(dir), 'vnc.sock');
  if (Buffer.byteLength(own) <= SOCKET_PATH_MAX) return own;
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && existsSync(runtime) ? join(runtime, 'dither-vnc') : join(tmpdir(), `dither-vnc-${process.getuid?.() ?? 'user'}`);
  return join(base, `${createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 16)}.sock`);
}

export function x11vncArgs(x11vnc: string, display: string, socket: string): string[] {
  return [x11vnc, '-display', display, '-unixsock', socket, '-rfbport', '0', '-rfbportv6', '-1', '-no6', '-nopw', '-forever', '-shared', '-noxdamage', '-quiet'];
}

/** The socket's directory 0700 and this user's own; a socket left from an earlier run removed. */
function prepareVncSocket(socket: string) {
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) throw new Error(`the live view's socket path is too long (${socket})`);
  const dir = dirname(socket);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) throw new Error(`the live view's directory ${dir} is not this user's own`);
  if (st.mode & 0o077) chmodSync(dir, 0o700);
  rmSync(socket, { force: true });
}

/** Wait until x11vnc listens on the socket, then make it 0600; fail at once if x11vnc gave up. */
async function waitForVncSocket(socket: string, x11vnc: Subprocess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (x11vnc.exitCode !== null) throw new Error(`x11vnc exited (${x11vnc.exitCode}) before its live view socket came up`);
    try {
      if (lstatSync(socket).isSocket()) {
        chmodSync(socket, 0o600);
        return;
      }
    } catch {
      // not there yet
    }
    await Bun.sleep(50);
  }
  throw new Error(`x11vnc's live view socket did not come up within ${timeoutMs}ms`);
}

export function readConfigFile<T = any>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
  } catch {
    return fallback;
  }
}
