/**
 * Unpacks an uploaded zip off the hub's event loop (zip.ts). In: { zip, outDir, maxBytes }.
 * Out: { progress } now and then (0..1 of the zip read), then { done, files, bytes } or { error }.
 */
import { statSync } from 'node:fs';
import { cleanRelPath } from '../uploads.ts';
import { unzip } from './zip.ts';

declare const self: Worker;

self.onmessage = async (e: MessageEvent<{ zip: string; outDir: string; maxBytes: number }>) => {
  try {
    const size = statSync(e.data.zip).size || 1;
    let last = 0;
    const r = await unzip(e.data.zip, e.data.outDir, {
      clean: cleanRelPath,
      maxBytes: e.data.maxBytes,
      onBytes: (n) => {
        if (n - last > 16 << 20) postMessage({ progress: n / size }), (last = n);
      },
    });
    postMessage({ done: true, ...r });
  } catch (err: any) {
    postMessage({ error: String(err?.message ?? err) });
  }
};
