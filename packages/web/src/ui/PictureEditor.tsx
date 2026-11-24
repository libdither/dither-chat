/**
 * Changing a picture: a group's, a server's, or your own on each network (docs/profile.md, "Changing a picture").
 * The page's big picture opens a menu (pictureMenu); a file chosen, dropped or pasted, a picture from the chat or an
 * earlier one opens the editor, which crops it to the shape the network draws, shows it at the sizes the app uses,
 * and sends nothing until Save. Saved pictures can be put back from the toast. A chunk of its own (PictureEditorLazy.tsx).
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, SELF_LIMITS } from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import './picture.css';
import { api, toast } from '../state.ts';
import { uploadFile } from '../upload.ts';
import { centred, clamp, cover, cropRect, MAX_ZOOM, zoomAbout as zoomAt, type Place } from '../picturecrop.ts';
import { phone } from '../phone.ts';
import { groups, openMenu, type MenuEntry } from './ContextMenu.tsx';
import { Modal } from './bits.tsx';
import { Icon } from './icons.tsx';

/** One place the picture goes: a group or server through one account, or your profile on one network. */
export interface PictureDest {
  key: string;
  network: P.Network;
  /** The network's name, or the account's where several share one. */
  label: string;
  /** Its picture now (a hub media path), for Undo. */
  current: string | null;
  can: boolean;
  reason?: string;
  maxBytes?: number;
}

export interface PictureTarget {
  /** "New picture for Hiking crew". */
  heading: string;
  /** Through which account, who sees it. */
  note?: string;
  square: boolean;
  dests: PictureDest[];
  /** The keys ticked when the editor opens: the network you came from. */
  ticked: string[];
  /** The network lets this picture be taken away. */
  removable: boolean;
  /** A conversation whose pictures can be picked. */
  chatId?: string;
  /** Its change log, for pictures it had before (`…/changes`). */
  historyPath?: string;
  /** Sends one picture (an upload id), or none, to one place; the page redraws with what comes back. */
  set: (key: string, upload: string | null) => Promise<void>;
}

/** What the editor opens on: a file, a picture by its path, or nothing yet (it asks for one). */
export type PictureStart = { file?: Blob; url?: string };

// JPEG XL where the browser shows it: the picture is drawn again as a PNG or JPEG either way.
const TYPES = 'image/png,image/jpeg,image/gif,image/webp,image/jxl';
const isPicture = (f: Blob) => /^image\/(png|jpeg|gif|webp|jxl)$/.test(f.type);
const netName = (n: P.Network) => NETWORK_META[n].name;
const names = (ds: PictureDest[]) => {
  const l = ds.map((d) => d.label);
  return l.length < 2 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
};

/** Asks for a file the way the device does (on a phone, its own chooser offers the camera too). */
function chooseFile(then: (f: Blob) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = TYPES;
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) then(f);
  };
  input.click();
}

/** A picture the hub serves, as a file to crop and send again. */
async function fetchPicture(url: string): Promise<Blob> {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('That picture is no longer there.');
  const b = await r.blob();
  if (!/^image\//.test(b.type)) throw new Error('That is not a picture any more.');
  return b;
}

/** Sends a picture (or none) to each place and says how it went, with Undo putting back what each had. */
async function send(target: PictureTarget, dests: PictureDest[], file: Blob | null): Promise<boolean> {
  const done: PictureDest[] = [];
  const failed: string[] = [];
  for (const d of dests) {
    try {
      if (file) {
        if (d.maxBytes && file.size > d.maxBytes) throw new Error(`${d.label} takes pictures up to ${Math.round(d.maxBytes / 1024 / 1024)} MB`);
        const up = await uploadFile(file, file.type === 'image/jpeg' ? 'picture.jpg' : file.type === 'image/gif' ? 'picture.gif' : 'picture.png', file.type);
        await target.set(d.key, up.id);
      } else await target.set(d.key, null);
      done.push(d);
    } catch (e) {
      failed.push(`${d.label}: ${(e as Error).message}`);
    }
  }
  if (failed.length) toast({ kind: 'error', title: done.length ? `Not changed on ${failed.length === 1 ? failed[0]!.split(':')[0] : `${failed.length} networks`}` : 'Could not change the picture', body: failed.join('\n') });
  if (done.length) {
    const where = dests.length > 1 || target.dests.length > 1 ? ` on ${names(done)}` : '';
    // Undo puts back each picture it had, or takes the new one away where it had none and the network allows that.
    const back = done.filter((d) => d.current || target.removable);
    toast(
      {
        kind: 'info',
        title: file ? `Picture changed${where}` : `Picture removed${where}`,
        body: '',
        ...(back.length ? { actionLabel: 'Undo', action: () => void undo(target, back) } : {}),
      },
      8000,
    );
  }
  return done.length > 0;
}

async function undo(target: PictureTarget, ds: PictureDest[]) {
  const failed: string[] = [];
  for (const d of ds) {
    try {
      if (d.current) {
        const b = await fetchPicture(d.current);
        const up = await uploadFile(b, 'picture', b.type);
        await target.set(d.key, up.id);
      } else await target.set(d.key, null);
    } catch (e) {
      failed.push(`${d.label}: ${(e as Error).message}`);
    }
  }
  if (failed.length) toast({ kind: 'error', title: 'Could not put the picture back', body: failed.join('\n') });
  else toast({ kind: 'info', title: 'Picture put back', body: '' }, 3000);
}

/** The menu the big picture opens. */
export function pictureMenu(e: MouseEvent, target: PictureTarget, open: (s: PictureStart) => void) {
  const can = target.dests.filter((d) => d.can);
  const had = target.dests.some((d) => d.current);
  const items: MenuEntry[] = groups(
    [
      { label: 'Upload a Picture…', icon: 'image', track: 'picture: upload', run: () => chooseFile((file) => open({ file })) },
      !!target.chatId && { label: 'From This Chat’s Pictures…', icon: 'media', track: 'picture: from chat', run: () => open({}) },
      !!target.historyPath && had && { label: 'An Earlier Picture…', icon: 'clock', track: 'picture: earlier', run: () => open({}) },
    ],
    [
      target.removable &&
        had && {
          label: 'Remove Picture',
          icon: 'trash',
          danger: true,
          track: 'picture: remove',
          run: () => {
            const ds = can.filter((d) => target.ticked.includes(d.key) && d.current);
            if (ds.length && confirm(`Remove the picture${target.dests.length > 1 ? ` on ${names(ds)}` : ''}? Everyone there sees it go.`)) void send(target, ds, null);
          },
        },
    ],
  );
  openMenu({ x: e.clientX, y: e.clientY }, { items, label: 'Picture', head: <div class="cm-sheet-title">Picture</div>, track: 'picture menu' }, e.currentTarget);
}

/** A file dropped anywhere on the page, or pasted where nothing is being typed, opens the editor. */
export function PictureDrop({ open }: { open: (s: PictureStart) => void }) {
  const [over, setOver] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    let depth = 0;
    const files = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => files(e) && (depth++, setOver(true));
    const leave = (e: DragEvent) => files(e) && --depth <= 0 && ((depth = 0), setOver(false));
    const overFn = (e: DragEvent) => files(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const f = [...(e.dataTransfer?.files ?? [])].find(isPicture);
      if (f) openRef.current({ file: f });
      else toast({ kind: 'error', title: 'Not a picture', body: 'A PNG, JPEG, GIF or WebP image.' });
    };
    const paste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const f = [...(e.clipboardData?.files ?? [])].find(isPicture);
      if (f) (e.preventDefault(), openRef.current({ file: f }));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, []);
  return over ? (
    <div class="pic-drop" aria-hidden="true">
      <span>
        <Icon name="image" size={22} /> Drop to use as the picture
      </span>
    </div>
  ) : null;
}

interface Loaded {
  blob: Blob;
  src: string;
  w: number;
  h: number;
}

function load(blob: Blob): Promise<Loaded> {
  const src = URL.createObjectURL(blob);
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res({ blob, src, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => (URL.revokeObjectURL(src), rej(new Error('That picture could not be read.')));
    img.src = src;
  });
}

/** The part in the frame, as a square file: at most 1024 pixels, JPEG for photos, PNG for anything that may be clear. */
async function crop(p: Loaded, frame: number, at: Place): Promise<Blob> {
  const { sx, sy, side, out } = cropRect(p, frame, at);
  const img = new Image();
  img.src = p.src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = out;
  const g = c.getContext('2d')!;
  const jpeg = p.blob.type === 'image/jpeg';
  if (jpeg) (g.fillStyle = '#fff'), g.fillRect(0, 0, out, out);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, sx, sy, side, side, 0, 0, out, out);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('The picture could not be made'))), jpeg ? 'image/jpeg' : 'image/png', 0.92));
}

/** The picture as the frame shows it, at another size. */
function Shown({ p, frame, at, size, square }: { p: Loaded; frame: number; at: Place; size: number; square: boolean }) {
  const k = size / frame;
  const s = cover(p, frame) * at.zoom * k;
  return (
    <span class={`pic-shown ${square ? 'square' : ''}`} style={{ width: `${size}px`, height: `${size}px` }}>
      <img src={p.src} alt="" style={{ width: `${p.w * s}px`, height: `${p.h * s}px`, left: `${at.x * k}px`, top: `${at.y * k}px` }} />
    </span>
  );
}

/** Pictures to pick from: this chat's, the ones it had before, your pictures on your other networks. */
function usePicks(target: PictureTarget): { chat: string[]; earlier: string[] } {
  const [chat, setChat] = useState<string[]>([]);
  const [earlier, setEarlier] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    if (target.chatId)
      api<P.SearchPage>(`/api/search?q=${encodeURIComponent(`in:${target.chatId} has:image`)}`).then(
        (r) => {
          const urls = r.hits.flatMap((h) => h.message.attachments.filter((a) => a.kind === 'image' && !a.spoiler && !a.explicit).map((a) => a.url));
          if (live) setChat([...new Set(urls)].slice(0, 12));
        },
        () => {},
      );
    if (target.historyPath)
      api<{ changes: P.ChangeView[] }>(`${target.historyPath}${target.historyPath.includes('?') ? '&' : '?'}fields=avatar`).then(
        (r) => {
          const now = new Set(target.dests.map((d) => d.current));
          const urls = r.changes.flatMap((c) => [c.new, c.old]).filter((u): u is string => typeof u === 'string' && !now.has(u));
          if (live) setEarlier([...new Set(urls)].slice(0, 12));
        },
        () => {},
      );
    return () => void (live = false);
  }, [target.chatId, target.historyPath]);
  return { chat, earlier };
}

export function PictureEditor({ target, start, onClose }: { target: PictureTarget; start: PictureStart; onClose: () => void }) {
  const frame = phone.value ? Math.min(300, Math.round(window.innerWidth - 64)) : 260;
  const [pic, setPic] = useState<Loaded | null>(null);
  const [at, setAt] = useState<Place>({ zoom: 1, x: 0, y: 0 });
  const [ticked, setTicked] = useState<string[]>(() => target.ticked.filter((k) => target.dests.some((d) => d.key === k && d.can)));
  const [asIs, setAsIs] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(start.url ?? null);
  const picks = usePicks(target);
  const others = target.dests.map((d) => d.current).filter((u): u is string => !!u);

  const use = async (blob: Blob | Promise<Blob>, url: string | null = null) => {
    setError(null);
    setBusy('loading');
    try {
      const b = await blob;
      if (!isPicture(b)) throw new Error('A picture is a PNG, JPEG, GIF, WebP or JPEG XL image.');
      const p = await load(b);
      setPic((old) => (old && URL.revokeObjectURL(old.src), p));
      setAt(centred(p, frame));
      setAsIs(false);
      setFrom(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    if (start.file) void use(start.file);
    else if (start.url) void use(fetchPicture(start.url), start.url);
    return () => setPic((old) => (old && URL.revokeObjectURL(old.src), null));
  }, []);

  // Dragging with a finger or the mouse moves it; two fingers or the wheel zoom about their middle.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ at: Place; mid: { x: number; y: number }; dist: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const zoomAbout = (base: Place, zoom: number, cx: number, cy: number): Place => (pic ? zoomAt(pic, frame, base, zoom, cx, cy) : base);
  const local = (e: PointerEvent | WheelEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startGesture = () => {
    const ps = [...pointers.current.values()];
    const mid = ps.length > 1 ? { x: (ps[0]!.x + ps[1]!.x) / 2, y: (ps[0]!.y + ps[1]!.y) / 2 } : ps[0]!;
    const dist = ps.length > 1 ? Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y) : 0;
    gesture.current = { at, mid, dist };
  };
  const down = (e: PointerEvent) => {
    if (!pic || asIs) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    startGesture();
  };
  const move = (e: PointerEvent) => {
    if (!pic || !pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, local(e));
    const g = gesture.current;
    const ps = [...pointers.current.values()];
    if (ps.length > 1 && g.dist) {
      const mid = { x: (ps[0]!.x + ps[1]!.x) / 2, y: (ps[0]!.y + ps[1]!.y) / 2 };
      const z = zoomAbout(g.at, g.at.zoom * (Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y) / g.dist), g.mid.x, g.mid.y);
      setAt(clamp(pic, frame, { ...z, x: z.x + mid.x - g.mid.x, y: z.y + mid.y - g.mid.y }));
    } else setAt(clamp(pic, frame, { ...g.at, x: g.at.x + ps[0]!.x - g.mid.x, y: g.at.y + ps[0]!.y - g.mid.y }));
  };
  const up = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) startGesture();
    else gesture.current = null;
  };
  const wheel = (e: WheelEvent) => {
    if (!pic || asIs) return;
    e.preventDefault();
    const c = local(e);
    setAt((a) => zoomAbout(a, a.zoom * Math.exp(-e.deltaY / 400), c.x, c.y));
  };
  const key = (e: KeyboardEvent) => {
    if (!pic || asIs) return;
    const step = e.shiftKey ? 40 : 10;
    const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (d) (e.preventDefault(), setAt((a) => clamp(pic, frame, { ...a, x: a.x + d[0]!, y: a.y + d[1]! })));
    else if (e.key === '+' || e.key === '=') (e.preventDefault(), setAt((a) => zoomAbout(a, a.zoom * 1.15, frame / 2, frame / 2)));
    else if (e.key === '-') (e.preventDefault(), setAt((a) => zoomAbout(a, a.zoom / 1.15, frame / 2, frame / 2)));
  };
  // The wheel's default (scrolling the page) has to be stopped, which a passive listener can't.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  // A file dropped on the editor, or pasted while it is open, replaces the one in it.
  const dropHere = (e: DragEvent) => {
    const f = [...(e.dataTransfer?.files ?? [])].find(isPicture);
    if (f) (e.preventDefault(), e.stopPropagation(), void use(f));
  };
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find(isPicture);
      if (f) (e.preventDefault(), void use(f));
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, []);

  const dests = target.dests.filter((d) => d.can && ticked.includes(d.key));
  const gif = pic?.blob.type === 'image/gif';
  const save = async () => {
    if (!pic || !dests.length) return;
    setBusy('saving');
    setError(null);
    try {
      const file = asIs ? pic.blob : await crop(pic, frame, at);
      if (await send(target, dests, file)) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = () => {
    const ds = dests.filter((d) => d.current);
    if (!ds.length || !confirm(`Remove the picture${target.dests.length > 1 ? ` on ${names(ds)}` : ''}? Everyone there sees it go.`)) return;
    setBusy('saving');
    void send(target, ds, null).then((ok) => (setBusy(null), ok && onClose()));
  };

  const thumbs = (title: string, urls: string[]) =>
    urls.length > 0 && (
      <div class="pic-picks">
        <div class="pic-label">{title}</div>
        <div class="pic-thumbs">
          {urls.map((u) => (
            <button class={`pic-thumb ${from === u ? 'on' : ''}`} disabled={!!busy} onClick={() => void use(fetchPicture(u), u)} aria-label={title}>
              <img src={u} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <Modal title={target.heading} onClose={onClose} wide>
      <div class="pic-editor" onDragOver={(e) => e.preventDefault()} onDrop={dropHere}>
        {target.note && <p class="pic-note">{target.note}</p>}
        <div class="pic-body">
          <div class="pic-crop-col">
            <div
              ref={box}
              class={`pic-crop ${pic ? '' : 'empty'} ${asIs ? 'as-is' : ''}`}
              style={{ width: `${frame}px`, height: `${frame}px` }}
              tabIndex={pic ? 0 : -1}
              role={pic ? 'application' : undefined}
              aria-label={pic ? 'The picture: drag to move it, the wheel or + and − to zoom, arrows to nudge' : undefined}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onKeyDown={key}
            >
              {pic ? (
                <>
                  <img class="pic-img" src={pic.src} alt="" draggable={false} style={{ width: `${pic.w * cover(pic, frame) * at.zoom}px`, height: `${pic.h * cover(pic, frame) * at.zoom}px`, left: `${at.x}px`, top: `${at.y}px` }} />
                  <span class={`pic-mask ${target.square ? 'square' : ''}`} />
                </>
              ) : (
                <button class="pic-empty" disabled={!!busy} onClick={() => chooseFile((f) => void use(f))}>
                  <Icon name="image" size={28} />
                  <b>{busy === 'loading' ? 'Opening…' : 'Upload a picture'}</b>
                  <small>{phone.value ? 'or pick one below' : 'or drop or paste one here, or pick one below'}</small>
                </button>
              )}
            </div>
            {pic && !asIs && (
              <label class="pic-zoom">
                <Icon name="search" size={13} />
                <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={at.zoom} aria-label="Zoom" onInput={(e) => setAt((a) => zoomAbout(a, Number((e.target as HTMLInputElement).value), frame / 2, frame / 2))} />
                <span>{phone.value ? 'Pinch to zoom · drag to move' : 'Drag to move'}</span>
              </label>
            )}
            {gif && (
              <label class="pic-asis">
                <input type="checkbox" checked={asIs} onChange={(e) => setAsIs((e.target as HTMLInputElement).checked)} />
                Send the GIF as it is, so it keeps moving (not cropped)
              </label>
            )}
          </div>
          <div class="pic-side">
            {pic && (
              <div>
                <div class="pic-label">As it shows</div>
                <div class="pic-sizes">
                  {[64, 40, 22].map((s) => (
                    <Shown p={pic} frame={frame} at={asIs ? centred(pic, frame) : at} size={s} square={target.square} />
                  ))}
                </div>
              </div>
            )}
            <div class="pic-sources">
              <button class="btn ghost small" disabled={!!busy} onClick={() => chooseFile((f) => void use(f))}>
                <Icon name="image" size={13} /> {pic ? 'Another picture…' : 'Upload…'}
              </button>
            </div>
            {target.dests.length > 1 && (
              <div class="pic-dests">
                <div class="pic-label">Use it on</div>
                {target.dests.map((d) => (
                  <label class={`pic-dest ${d.can ? '' : 'off'}`} title={d.reason}>
                    <input type="checkbox" disabled={!d.can} checked={d.can && ticked.includes(d.key)} onChange={(e) => setTicked((t) => ((e.target as HTMLInputElement).checked ? [...t, d.key] : t.filter((k) => k !== d.key)))} />
                    <span class="pic-dot" style={{ background: NETWORK_META[d.network].color }} />
                    {d.label}
                    {(d.reason || d.maxBytes) && <small>{d.reason ?? `up to ${Math.round(d.maxBytes! / 1024 / 1024)} MB`}</small>}
                  </label>
                ))}
              </div>
            )}
            {thumbs('From this chat', picks.chat)}
            {thumbs(target.dests.length > 1 ? 'Your pictures now' : '', target.dests.length > 1 ? [...new Set(others)] : [])}
            {thumbs('Earlier pictures', picks.earlier)}
          </div>
        </div>
        {error && (
          <p class="pic-error" role="alert">
            {error}
          </p>
        )}
        <div class="pic-foot">
          {target.removable && dests.some((d) => d.current) && (
            <button class="btn ghost small danger" disabled={!!busy} onClick={remove}>
              Remove picture
            </button>
          )}
          <span class="pic-gap" />
          <button class="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={!pic || !dests.length || !!busy} onClick={() => void save()}>
            {busy === 'saving' ? 'Saving…' : target.dests.length > 1 ? `Save to ${dests.length === 1 ? dests[0]!.label : dests.length}` : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Your own picture on each network the page lists (its About says `editable` holds `avatar`). */
export function selfTarget(o: {
  ids: P.IdentityView[];
  abouts: Record<string, P.PersonAboutView>;
  came?: string;
  picture: string | null;
  historyPath: string;
  onSaved: (a: P.PersonAboutView) => void;
}): PictureTarget | null {
  const ids = o.ids.filter((i) => o.abouts[i.id]?.editable?.includes('avatar'));
  if (!ids.length) return null;
  // Where two of your accounts share a network, each is named by its handle.
  const shared = (n: P.Network) => ids.filter((i) => i.network === n).length > 1;
  const dests: PictureDest[] = ids.map((i) => ({
    key: i.id,
    network: i.network,
    label: shared(i.network) ? `${netName(i.network)} (${i.handle ?? i.displayName ?? i.nativeId})` : netName(i.network),
    current: o.abouts[i.id]?.avatar ?? i.avatar ?? null,
    can: true,
    ...(SELF_LIMITS[i.network]?.avatarBytes ? { maxBytes: SELF_LIMITS[i.network]!.avatarBytes } : {}),
  }));
  // The network you came from: the account the page was opened by, else the one whose picture it shows, else the first.
  const came = dests.find((d) => d.key === o.came) ?? dests.find((d) => d.current && d.current === o.picture) ?? dests[0]!;
  return {
    heading: 'Your new picture',
    note: dests.length > 1 ? 'Tick each network it goes to; each draws it in its own shape.' : `Everyone on ${dests[0]!.label} sees it.`,
    square: false,
    dests,
    ticked: [came.key],
    removable: true,
    historyPath: o.historyPath,
    set: async (key, upload) => o.onSaved(await api<P.PersonAboutView>(`/api/identities/${key}/about`, { method: 'PUT', body: { avatar: upload } })),
  };
}

/**
 * A group's or a server's picture, through the account whose view the page shows: a group's own picture call where
 * the account has one (which can also take it away), else the About change (docs/group-settings.md).
 */
export function placeTarget(o: { kind: 'conversation' | 'space'; id: string; name: string; network: P.Network; view: P.AboutView; current: string | null; viaGroup: boolean; square: boolean; onDone: (v: P.AboutView) => void }): PictureTarget {
  const acct = o.view.accountId ? { accountId: o.view.accountId } : {};
  const net = netName(o.network);
  const noun = (o.view.noun ?? 'group').toLowerCase();
  return {
    heading: `New picture for ${o.name}`,
    note: `Sent through your ${net} account; everyone in the ${noun} sees it change.`,
    square: o.square,
    dests: [{ key: o.view.accountId ?? '', network: o.network, label: net, current: o.current, can: true }],
    ticked: [o.view.accountId ?? ''],
    removable: o.viaGroup,
    ...(o.kind === 'conversation' ? { chatId: o.id } : {}),
    historyPath: `/api/${o.kind === 'space' ? 'spaces' : 'conversations'}/${o.id}/changes`,
    set: async (_key, upload) => {
      if (o.viaGroup) o.onDone(await api<P.AboutView>(`/api/conversations/${o.id}/picture`, { body: { upload, ...acct } }));
      else if (upload) o.onDone(await api<P.AboutView>(`/api/${o.kind === 'space' ? 'spaces' : 'conversations'}/${o.id}/about`, { body: { change: { key: 'avatar', value: upload }, ...acct } }));
      else throw new Error(`${net} keeps a picture here once it has one`);
    },
  };
}
