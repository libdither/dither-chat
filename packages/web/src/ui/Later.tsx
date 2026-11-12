/**
 * The parts of a long page below its first screen, drawn once the page is idle after it shows, one part per idle
 * moment (slices.ts). Settings drew its 1,600 DOM nodes in one task and laid them out in the next, where a phone shows
 * the first 800 pixels of them (docs/perf.md).
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { inTurn } from '../slices.ts';

const waiting = new Set<() => void>();

/**
 * Draws every part still waiting, now: before going to a section, which may be in one, and which needs the page's
 * whole height below it to come to the top (showSection). Whether any was waiting.
 */
export function drawLater(): boolean {
  const any = waiting.size > 0;
  for (const show of [...waiting]) show();
  return any;
}

export function Later({ children }: { children: ComponentChildren }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (shown) return;
    let cancel = () => {};
    const show = () => {
      waiting.delete(show);
      cancel();
      setShown(true);
    };
    waiting.add(show);
    cancel = inTurn(show);
    return () => {
      waiting.delete(show);
      cancel();
    };
  }, []);
  return shown ? <>{children}</> : null;
}
