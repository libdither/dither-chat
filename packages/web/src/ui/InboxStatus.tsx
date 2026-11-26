/**
 * What the app is doing with the hub, in the room the "Inbox" title leaves (docs/sync.md "What the inbox says"): nothing
 * while all is well. A catch-up that takes longer than a moment says "Catching up…", then how many new messages it
 * brought; out of reach, the logo's amber orb, since when, and when it tries again (a tap tries now); a hub restarting,
 * which it said before it stopped, when it is likely back; then "Hub updated" or "Hub restarted". Never a bar over the
 * list, never a screen in the way.
 */
import { useEffect, useState } from 'preact/hooks';
import { catchingUp, caught, connected, nextTry, offlineFrom, restarting, tryNow } from '../state.ts';
import { Icon } from './icons.tsx';
import { DitherOrb } from './Loader.tsx';
import { offline, OfflineOrb } from './Offline.tsx';
import { statusLive, statusLine, type StatusInput, type StatusLine } from '../statusline.ts';

export function InboxStatus() {
  const [now, setNow] = useState(Date.now);
  const input: StatusInput = {
    now,
    connected: connected.value,
    offline: offline.value,
    catching: catchingUp.value,
    caught: caught.value,
    restarting: restarting.value,
    nextTry: nextTry.value,
    from: offlineFrom(),
  };
  // A quarter second: the countdown's seconds, the 180 ms before "Catching up…", and the done line's end.
  const ticking = statusLive({ ...input, now: Date.now() });
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [ticking]);
  const line = statusLine(input);
  const [trying, setTrying] = useState(false);
  // The slot is always there, so what comes into it is read out; the countdown in it is not, every second.
  return (
    <span class="inbox-status-slot" role="status">
      {line && <Line line={line} trying={trying} setTrying={setTrying} />}
    </span>
  );
}

function Line({ line, trying, setTrying }: { line: StatusLine; trying: boolean; setTrying: (v: boolean) => void }) {
  const body = (
    <>
      <span class="inbox-status-icon" aria-hidden="true">
        {line.icon === 'offline' ? <OfflineOrb size={14} /> : line.icon === 'turn' ? <DitherOrb size={14} class="status-orb" /> : <Icon name="check" size={14} />}
      </span>
      <span class="inbox-status-text">
        <span class="inbox-status-title">{trying ? 'Trying your hub…' : line.title}</span>
        {line.more && !trying && (
          <span class="inbox-status-more" aria-hidden="true">
            {line.aside && <span class="inbox-status-aside">{line.aside} · </span>}
            {line.more}
          </span>
        )}
      </span>
    </>
  );
  const cls = `inbox-status ${line.amber ? 'amber' : ''} ${line.icon === 'done' ? 'done' : ''}`;
  if (!line.tap) return <span class={cls}>{body}</span>;
  return (
    <button
      class={cls}
      data-track="inbox status: try now"
      title="Try the hub now"
      disabled={trying}
      onClick={async () => {
        setTrying(true);
        await tryNow();
        setTrying(false);
      }}
    >
      {body}
    </button>
  );
}
