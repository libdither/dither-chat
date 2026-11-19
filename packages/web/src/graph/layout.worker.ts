/** Runs the people graph's layout off the page's thread (layout.ts), sending positions back about once a frame. */
import { Layout } from './layout.ts';

export type ToWorker = { t: 'start'; n: number; edges: Uint32Array; pos: Float32Array; fixed?: number; len?: Float32Array; mass?: Float32Array; ties?: Uint32Array } | { t: 'tune'; len: Float32Array; mass: Float32Array } | { t: 'ties'; ties: Uint32Array } | { t: 'heat' } | { t: 'stop' };
export type FromWorker = { t: 'pos'; pos: Float32Array; done: boolean };

const scope = self as unknown as { onmessage: ((e: MessageEvent<ToWorker>) => void) | null; postMessage(m: FromWorker, t: Transferable[]): void };
let layout: Layout | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function run() {
  timer = null;
  if (!layout) return;
  const until = performance.now() + 14;
  do layout.tick();
  while (!layout.done && performance.now() < until);
  const pos = layout.pos.slice();
  scope.postMessage({ t: 'pos', pos, done: layout.done }, [pos.buffer]);
  if (!layout.done) timer = setTimeout(run, 0);
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'start') layout = new Layout({ n: m.n, edges: m.edges, pos: m.pos, fixed: m.fixed, len: m.len, mass: m.mass, ties: m.ties });
  else if (m.t === 'ties') {
    layout?.setTies(m.ties);
    layout?.heat(0.3);
  } else if (m.t === 'tune') {
    layout?.tune(m.len, m.mass);
    layout?.heat(0.25);
  } else if (m.t === 'heat') layout?.heat();
  else if (m.t === 'stop') layout = null;
  if (layout && !timer) timer = setTimeout(run, 0);
};
