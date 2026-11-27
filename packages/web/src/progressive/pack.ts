/**
 * A photo, ready to upload so that whatever part of it the hub has is the whole picture (docs/uploads.md "Pictures
 * that sharpen"). A JPEG is reordered into a progressive one by jpegtran in a worker: losslessly, the same pixels and
 * metadata, and usually smaller. One already progressive is kept as it is. Anything else (a PNG, a video, a file),
 * or a JPEG the worker cannot read, goes as it was, a byte at a time as before.
 */
import { jpegLayers, qualityStops, type JpegLayers } from '@dither-chat/protocol';

export interface Packed {
  blob: Blob;
  layers: JpegLayers;
  /** Where its upload pauses for the others' (qualityStops). */
  stops: number[];
}

/** A file is a JPEG by its first bytes, whatever its name or type says. */
async function isJpeg(f: Blob): Promise<boolean> {
  const head = new Uint8Array(await f.slice(0, 3).arrayBuffer());
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

/** The longest a photo may take to make progressive before it goes as it is. */
const PACK_MS = 30_000;

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();

function packer(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./pack.worker.ts', import.meta.url), { type: 'module', name: 'pack' });
  w.onmessage = (e: MessageEvent<{ id: number; bytes?: Uint8Array; error?: string }>) => {
    const p = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    if (e.data.bytes) p?.resolve(e.data.bytes);
    else p?.reject(new Error(e.data.error ?? 'could not pack'));
  };
  w.onerror = () => {
    for (const p of waiting.values()) p.reject(new Error('the packer stopped'));
    waiting.clear();
    worker = null;
  };
  return (worker = w);
}

/** Reorder this JPEG's bytes into a progressive JPEG (jpegtran, in the worker). */
function reorder(bytes: Uint8Array): Promise<Uint8Array> {
  const id = ++seq;
  return new Promise<Uint8Array>((resolve, reject) => {
    const t = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('packing took too long'));
    }, PACK_MS);
    waiting.set(id, {
      resolve: (b) => (clearTimeout(t), resolve(b)),
      reject: (e) => (clearTimeout(t), reject(e)),
    });
    packer().postMessage({ id, bytes }, [bytes.buffer]);
  });
}

/** The photo as it will upload, or null to upload the file as it is. */
export async function pack(file: Blob, run: (b: Uint8Array) => Promise<Uint8Array> = reorder): Promise<Packed | null> {
  try {
    if (!(await isJpeg(file))) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const own = jpegLayers(bytes);
    if (own?.ends.length) return { blob: file, layers: own, stops: qualityStops(file.size, own) };
    const out = await run(bytes);
    const layers = jpegLayers(out);
    // What came back must be a whole progressive JPEG: its last scan ends at the end marker.
    if (!layers?.ends.length || layers.ends.at(-1) !== out.length - 2) return null;
    const blob = new Blob([out as BlobPart], { type: 'image/jpeg' });
    return { blob, layers, stops: qualityStops(blob.size, layers) };
  } catch {
    return null;
  }
}
