/**
 * A photo or video attached in the composer, in a box over the chat (docs/uploads.md "Look before it goes"): a chunk
 * of its own, with its stylesheet, loaded the first time a tile is clicked (ComposerFiles.tsx).
 */
import { createPortal } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { bytes } from '../format.ts';
import { useLayer } from '../phone.ts';
import { statusOf, type Attached } from './ComposerFiles.tsx';
import { Icon } from './icons.tsx';
import './peek.css';

/**
 * A photo or video attached, in a box over the chat as other files open on a computer, not full screen: as large as
 * the window lets it be and never past its own size, with its name, type, pixels and size; arrows (and ← →) to the
 * others attached; a click on a photo the box shrank shows it at its own pixels to scroll about, and another click
 * fits it again; Remove; ×, Escape or a click beside the box closes it.
 */
export function Peek({ files, start, remove, onClose }: { files: Attached[]; start: number; remove: (key: number) => void; onClose: () => void }) {
  const media = files.filter((f) => f.url);
  const [key, setKey] = useState(start);
  const [px, setPx] = useState<{ w: number; h: number; shrunk: boolean } | null>(null);
  const [full, setFull] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  // A click beside the box closes it, but not the end of a drag that began inside it.
  const pressedOutside = useRef(false);
  const i = media.findIndex((f) => f.key === key);
  const f = media[i];
  const go = (to: Attached | undefined) => {
    if (!to) return;
    setKey(to.key);
    setPx(null);
    setFull(false);
  };
  useLayer(onClose);
  useEffect(() => card.current?.focus(), []);
  useEffect(() => {
    if (!f) onClose();
  }, [f]);
  useLayoutEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (e.preventDefault(), onClose());
      if (e.key === 'ArrowLeft') go(media[i - 1]);
      if (e.key === 'ArrowRight') go(media[i + 1]);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [i, media.length]);
  if (!f) return null;
  const { status, why, pct } = statusOf(f);
  const name = f.file.name || 'file';
  const video = f.file.type.startsWith('video/');
  const facts = [f.file.type.split('/')[1]?.toUpperCase(), px && `${px.w}×${px.h}`, bytes(f.file.size), media.length > 1 && `${i + 1} of ${media.length}`].filter(Boolean).join(' · ');
  const drop = () => {
    // The next one shows, else the one before; the last one gone, the box goes too.
    go(media[i + 1] ?? media[i - 1]);
    remove(f.key);
  };
  return createPortal(
    <div class="peek-layer" data-track-area="attached" onPointerDown={(e) => (pressedOutside.current = e.target === e.currentTarget)} onClick={(e) => pressedOutside.current && e.target === e.currentTarget && onClose()}>
      <div class="peek-card" ref={card} tabIndex={-1} role="dialog" aria-modal="true" aria-label={name}>
        <div class="peek-bar">
          <span class="peek-name">
            <b title={name}>{name}</b>
            <small>{facts}</small>
          </span>
          <button class="btn ghost small" data-track="remove" onClick={drop}>
            <Icon name="trash" size={14} /> Remove
          </button>
          <button class="icon-btn" data-track="close" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="x" size={20} />
          </button>
        </div>
        <div class="peek-view">
          <div class={`peek-stage ${full ? 'full' : ''}`}>
            {video ? (
              <video key={f.key} class="peek-media" src={f.url!} controls autoplay playsInline onLoadedMetadata={(e) => setPx({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight, shrunk: false })} />
            ) : (
              <img
                key={f.key}
                class={`peek-media ${px?.shrunk ? 'shrunk' : ''}`}
                src={f.url!}
                alt={name}
                draggable={false}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  setPx({ w: el.naturalWidth, h: el.naturalHeight, shrunk: el.naturalWidth > el.clientWidth + 1 || el.naturalHeight > el.clientHeight + 1 });
                }}
                onClick={() => px?.shrunk && setFull(!full)}
                title={px?.shrunk ? (full ? 'Fit it to the box' : 'Show it at its own size') : undefined}
              />
            )}
          </div>
          {i > 0 && (
            <button class="peek-nav prev" data-track="previous" onClick={() => go(media[i - 1])} aria-label="Previous">
              <Icon name="back" size={20} />
            </button>
          )}
          {i < media.length - 1 && (
            <button class="peek-nav next" data-track="next" onClick={() => go(media[i + 1])} aria-label="Next">
              <Icon name="chevronRight" size={20} />
            </button>
          )}
        </div>
        {why ? (
          <div class="peek-why" role="alert">
            {why}
            {status === 'failed' && (
              <button class="btn small" onClick={() => f.job!.retry()}>
                Retry
              </button>
            )}
          </div>
        ) : (
          status === 'uploading' && (
            <span class="upload-bar peek-progress" role="progressbar" aria-label={`Uploading ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <span style={{ width: `${pct}%` }} />
            </span>
          )
        )}
      </div>
    </div>,
    document.body,
  );
}
