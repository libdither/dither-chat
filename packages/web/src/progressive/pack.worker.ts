/**
 * Makes a JPEG progressive off the page's thread (pack.ts): jpegtran -progressive -copy all, the same pixels and the
 * same metadata, reordered so any first part of the file is the whole picture, coarse to fine. The module is
 * compiled once, at the first photo.
 */
import { runWasi } from './wasi.ts';

let mod: Promise<WebAssembly.Module> | null = null;

self.onmessage = async (e: MessageEvent<{ id: number; bytes: Uint8Array }>) => {
  const { id, bytes } = e.data;
  try {
    mod ??= WebAssembly.compileStreaming(fetch(new URL('./jpegtran.wasm', import.meta.url)));
    const r = runWasi(await mod, ['jpegtran', '-progressive', '-copy', 'all'], bytes);
    if (r.code !== 0 || !r.stdout.length) throw new Error(r.stderr.trim() || `jpegtran exited ${r.code}`);
    (self as unknown as Worker).postMessage({ id, bytes: r.stdout }, [r.stdout.buffer]);
  } catch (err) {
    mod = null;
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
