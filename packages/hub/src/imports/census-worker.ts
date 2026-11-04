/**
 * Runs a backup census off the hub's event loop: stretching the passphrase alone is 250 000 SHA-512 rounds,
 * and a census reads the whole file. Posts { progress } now and then, then { census } or { error, badPassphrase }.
 */
import { BadPassphrase, censusLegacy } from './signal-backup.ts';

declare const self: Worker;

self.onmessage = (e: MessageEvent<{ path: string; passphrase: string }>) => {
  try {
    const census = censusLegacy(e.data.path, e.data.passphrase, (pos, total) => postMessage({ progress: pos / total }));
    postMessage({ census });
  } catch (err: any) {
    postMessage({ error: String(err?.message ?? err), badPassphrase: err instanceof BadPassphrase });
  }
};
