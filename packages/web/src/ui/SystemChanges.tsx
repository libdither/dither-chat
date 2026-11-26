/**
 * What a line like "Sam updated the group." changed (docs/history.md "What a line changed"), on any network: the
 * chat's own History rows from around the line (GET /api/messages/:id/changes), in a card beside it. Pointing at the
 * line shows the card while the pointer stays on the line or the card; a click or tap keeps it open until Escape,
 * back, or a click elsewhere. Loaded the first time a line is pointed at (Timeline.tsx SystemChangesLazy).
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { loadChanges, retention } from '../history.ts';
import { useLayer } from '../phone.ts';
import { Change } from './HistoryCard.tsx';
import './SystemChanges.css';

/** Each line's changes, once asked: a card that opens again draws at once. */
const asked = new Map<string, Promise<P.ChangeView[]>>();
const changesOf = (id: string) => {
  let p = asked.get(id);
  if (!p) {
    p = loadChanges(`/api/messages/${id}/changes`).then((c) => [...c].reverse());
    p.catch(() => asked.delete(id));
    asked.set(id, p);
  }
  return p;
};

/** While pinned, Escape and back close it. */
function Pinned({ onClose }: { onClose: () => void }) {
  useLayer(onClose);
  useLayoutEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), onClose());
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, []);
  return null;
}

export function SystemChanges({ m, anchor, pinned, onClose, onEnter, onLeave }: { m: P.MessageView; anchor: DOMRect; pinned: boolean; onClose: () => void; onEnter: () => void; onLeave: () => void }) {
  const [changes, setChanges] = useState<P.ChangeView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    changesOf(m.id).then(
      (c) => live && setChanges(c),
      () => live && setFailed(true),
    );
    return () => void (live = false);
  }, [m.id]);
  // Below the line, or above it where there is no room, inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, anchor.left))}px`;
    el.style.top = `${anchor.bottom + 6 + h <= innerHeight - 8 ? anchor.bottom + 6 : Math.max(8, anchor.top - h - 6)}px`;
  });
  // A click elsewhere or scrolling the list by hand closes a pinned card (a message arriving scrolls it too, and
  // leaves it open); a pointed-at one goes when the pointer leaves.
  useEffect(() => {
    if (!pinned) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(`#m-${CSS.escape(m.id)}`) && onClose();
    const scroll = (e: Event) => !box.current?.contains(e.target as Node) && onClose();
    document.addEventListener('pointerdown', down, true);
    for (const ev of ['wheel', 'touchmove']) document.addEventListener(ev, scroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', down, true);
      for (const ev of ['wheel', 'touchmove']) document.removeEventListener(ev, scroll, true);
    };
  }, [pinned]);

  const empty = changes?.length === 0 || failed;
  // Pointing at a line that brought nothing kept shows nothing; asking by a click says so.
  if (!pinned && (!changes || empty)) return null;
  if (pinned && !changes && !failed) return <Pinned onClose={onClose} />;
  return (
    <div ref={box} class="sys-changes" role={pinned ? 'dialog' : 'tooltip'} aria-label="What changed" onPointerEnter={onEnter} onPointerLeave={onLeave}>
      {pinned && <Pinned onClose={onClose} />}
      <h4>What changed</h4>
      {empty ? (
        <p class="sys-changes-none">
          {failed ? 'Could not ask the hub.' : retention.value.changes ? 'Nothing was seen changing then. The network may not have said, or the hub was not running.' : 'Changes are not kept. Turn on History in Settings to see them here next time.'}
        </p>
      ) : (
        <ol class="hist-list">
          {changes!.map((c) => (
            <Change key={c.id} c={c} network={m.network} expanded />
          ))}
        </ol>
      )}
    </div>
  );
}
