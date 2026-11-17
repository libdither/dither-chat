/**
 * The panel's Photos (docs/uploads.md "The panel"): in the Android app the phone's gallery itself, newest first, by
 * album, the camera first; a tap picks (numbered), again takes it back. Elsewhere, or before the gallery is allowed:
 * the camera, the system's photo picker, and the pictures your chats already hold.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { askMediaAccess, device, listMedia, mediaFile, thumbUrl, asFile, type DeviceAlbum, type DeviceMedia } from '../../device.ts';
import { Menu } from '../bits.tsx';
import { Icon } from '../icons.tsx';
import { useHubFiles } from './hubfiles.ts';
import type { PanelCtx, Picks } from './Panel.tsx';
import { PanelHead, PickMark } from './parts.tsx';

interface Props {
  ctx: PanelCtx;
  picks: Picks;
  full: boolean;
  setFull: (f: boolean) => void;
}

export function PhotosTab(p: Props) {
  const d = device();
  return d && d.media !== 'none' ? <Gallery {...p} access={d.media} /> : <NoGallery {...p} canAsk={!!d} />;
}

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function CameraTile({ ctx }: { ctx: PanelCtx }) {
  return (
    <button class="kp-tile kp-cam" data-track="camera" aria-label="Take a photo or video" onClick={ctx.openCamera}>
      <Icon name="camera" size={24} />
    </button>
  );
}

function Head({ ctx, picks, full, setFull, children }: Props & { children?: ComponentChildren }) {
  return (
    <PanelHead full={full} setFull={setFull}>
      {children}
      <span class="kp-grow" />
      {ctx.viewOnce && (
        <button class={`kp-chip ${ctx.viewOnce.on ? 'on' : ''}`} data-track="view once" aria-pressed={ctx.viewOnce.on} onClick={() => ctx.viewOnce!.set(!ctx.viewOnce!.on)}>
          <Icon name="eyeOff" size={13} /> View once
        </button>
      )}
      {picks.count > 0 && (
        <button class="kp-link" data-track="open large" onClick={ctx.openLarge}>
          Open large
        </button>
      )}
      {!full && (
        <button class="icon-btn" data-track="all photos" aria-label="To the whole screen" onClick={() => setFull(true)}>
          <Icon name="chevronUp" size={18} />
        </button>
      )}
    </PanelHead>
  );
}

function Gallery(p: Props & { access: 'all' | 'partial' }) {
  const { ctx, picks } = p;
  const [album, setAlbum] = useState<DeviceAlbum | null>(null);
  const [albums, setAlbums] = useState<DeviceAlbum[]>([]);
  const [items, setItems] = useState<DeviceMedia[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const busy = useRef(false);
  const load = async (before: string | null, into: DeviceMedia[]) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await listMedia({ album: album?.id, before, limit: 60 });
      setItems([...into, ...r.items]);
      setNext(r.next);
      if (r.albums) setAlbums(r.albums);
      setFailed(null);
    } catch (e: any) {
      setFailed(String(e?.message ?? e));
    } finally {
      busy.current = false;
    }
  };
  useEffect(() => {
    setItems([]);
    void load(null, []);
  }, [album?.id, p.access]);
  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    if (next && el.scrollTop + el.clientHeight > el.scrollHeight - 400) void load(next, items);
  };
  return (
    <>
      <Head {...p}>
        <Menu
          trigger={(toggle) => (
            <button class="kp-album" data-track="album" onClick={toggle}>
              {album?.name ?? 'Recent'} <Icon name="chevronDown" size={13} />
            </button>
          )}
        >
          {(close) => (
            <div class="level-menu">
              {[null, ...albums].map((a) => (
                <button
                  class={`menu-item ${(a?.id ?? null) === (album?.id ?? null) ? 'on' : ''}`}
                  data-track="album (pick)"
                  onClick={() => {
                    setAlbum(a);
                    close();
                  }}
                >
                  {a ? (
                    <>
                      <img class="kp-album-cover" src={thumbUrl(a.cover)} alt="" /> {a.name} <span class="plus-note">{a.count}</span>
                    </>
                  ) : (
                    'Recent'
                  )}
                </button>
              ))}
            </div>
          )}
        </Menu>
      </Head>
      {p.access === 'partial' && (
        <div class="kp-note">
          Showing the photos you allowed.{' '}
          <button class="kp-link" data-track="photos access (change)" onClick={askMediaAccess}>
            Change
          </button>
        </div>
      )}
      <div class="kp-scroll" onScroll={onScroll}>
        <div class="kp-grid">
          <CameraTile ctx={ctx} />
          {items.map((m) => {
            const n = picks.at(`dev:${m.id}`);
            return (
              <button class={`kp-tile ${n ? 'on' : ''}`} data-track="photo" aria-label={m.name} aria-pressed={!!n} onClick={() => picks.toggle(`dev:${m.id}`, () => mediaFile(m))}>
                <img src={thumbUrl(m.id)} alt="" loading="lazy" decoding="async" />
                {m.kind === 'video' && <span class="kp-dur">{duration(m.ms)}</span>}
                <PickMark n={n} />
              </button>
            );
          })}
        </div>
        {failed && <div class="kp-note">{failed}</div>}
        {!failed && !items.length && !busy.current && <div class="kp-empty">No photos or videos here yet.</div>}
      </div>
    </>
  );
}

/** No gallery to show: in a browser, an older app, or before it was allowed. */
function NoGallery(p: Props & { canAsk: boolean }) {
  const { ctx, picks } = p;
  const hub = useHubFiles('has:image', ['image']);
  return (
    <>
      <Head {...p} />
      <div class="kp-scroll">
        {p.canAsk && (
          <div class="kp-ask">
            <b>Show your recent photos here?</b>
            <span>dither-chat asks Android once. "Selected photos" works too: then only those show.</span>
            <button class="kp-btn" data-track="photos access" onClick={askMediaAccess}>
              Allow
            </button>
          </div>
        )}
        <div class="kp-grid">
          <CameraTile ctx={ctx} />
          <button class="kp-tile kp-cam" data-track="gallery" onClick={ctx.pickPhotos}>
            <Icon name="image" size={22} />
            <span>Gallery…</span>
          </button>
        </div>
        {hub.items.length > 0 && <div class="kp-sec">In your chats</div>}
        <div class="kp-grid">
          {hub.items.map((f) => {
            const n = picks.at(f.id);
            return (
              <button class={`kp-tile ${n ? 'on' : ''}`} data-track="chat photo" aria-pressed={!!n} onClick={() => picks.toggle(f.id, () => asFile(f.att.url, f.att.name ?? 'photo.jpg', f.att.mime))}>
                <img src={f.att.url} alt="" loading="lazy" decoding="async" />
                <PickMark n={n} />
              </button>
            );
          })}
        </div>
        {hub.more && (
          <button class="kp-more" data-track="more photos" onClick={hub.more}>
            More
          </button>
        )}
      </div>
    </>
  );
}
