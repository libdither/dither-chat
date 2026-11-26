/**
 * Opening a chat (docs/sync.md "Opening a chat"): what this device kept shows at once, and a 2 px line over the message
 * box fills while the rest comes, step by step (waits.ts). Nothing shows for the first 180 ms, which is most opens. Past
 * 1.5 s the row over the box says which step is slow, the hub's or the network's, and how long it usually takes. Out of
 * reach of the hub it shows nothing: the row says "Offline" already (Offline.tsx).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { restarting } from '../state.ts';
import { barSpan, SAY_MS, waitLine, waits, type Wait } from '../waits.ts';
import { offline } from './Offline.tsx';

/** A wait shorter than this shows no line (styles.css starts it then). */
const QUIET_MS = 180;

/** The line over the message box: drawn while `tkey` opens, a moment after it begins. */
export function OpenBar({ tkey }: { tkey?: string }) {
  const w = tkey ? waits.value.get(tkey) : undefined;
  const off = offline.value;
  const [last, setLast] = useState<Wait | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const anim = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (w) setLast(w);
  }, [w]);
  // The line moves on the compositor (Web Animations), so a chat being drawn does not stop it.
  const move = (to: number, ms: number, easing: string) => {
    const e = el.current;
    if (!e || typeof e.animate !== 'function') return null;
    try {
      anim.current?.commitStyles();
    } catch {}
    anim.current?.cancel();
    const a = e.animate([{ transform: `scaleX(${to})` }], { duration: ms, easing, fill: 'forwards' });
    anim.current = a;
    return a;
  };
  useLayoutEffect(() => {
    if (!w) return;
    const s = barSpan(w);
    el.current?.parentElement?.classList.remove('done');
    // A new open starts from where its done steps end.
    if (!last || last.began !== w.began) el.current?.style.setProperty('transform', `scaleX(${s.from})`);
    move(s.to, s.ms, 'cubic-bezier(0.15, 0.7, 0.3, 1)');
  }, [w?.step, w?.began]);
  // Done: it fills and fades, or, done before it was ever shown, just goes.
  useLayoutEffect(() => {
    if (w || !last) return;
    if (Date.now() - last.began < QUIET_MS) return setLast(null);
    const a = move(1, 140, 'ease-out');
    const end = () => setLast(null);
    if (!a) return end();
    el.current?.parentElement?.classList.add('done');
    const t = setTimeout(end, 380);
    return () => clearTimeout(t);
  }, [w]);
  if (off || !(w ?? last)) return null;
  return (
    <div class="open-bar" aria-hidden="true">
      <div class="open-bar-fill" ref={el} />
    </div>
  );
}

/** The row over the box's words about an open, while it is slow enough to say (Typing.tsx). */
export function OpenNote({ tkey }: { tkey?: string }) {
  const w = tkey ? waits.value.get(tkey) : undefined;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!w) return;
    const wait = Math.max(0, w.began + SAY_MS - Date.now());
    let iv: ReturnType<typeof setInterval> | undefined;
    const t = setTimeout(() => {
      setNow(Date.now());
      iv = setInterval(() => setNow(Date.now()), 500);
    }, wait);
    return () => (clearTimeout(t), clearInterval(iv));
  }, [w?.began]);
  if (!w || offline.value) return null;
  void now;
  const line = waitLine(w, Date.now(), { restarting: !!restarting.value });
  if (!line) return null;
  return (
    <span class={`open-note ${line.slow ? 'slow' : ''}`} role="status" title={line.why}>
      {line.text}
    </span>
  );
}
