/**
 * A run of pictures (docs/pictures.md): one person's pictures sent one after another, drawn the way its chat says
 * (arrange.ts pictureLayout). One picture is drawn in its own shape (pictures.ts fitPicture); several as a mosaic,
 * rows, six and +N, folded after the first, or small. A click opens the viewer on all of them. Each tile keeps its
 * message and place (data-msg, data-att), so its menu is its own message's (Timeline.tsx). A run of two or more can
 * be switched to another way where it is (ui/PictureSwitch.tsx): the rail beside it, or a pinch on a phone.
 */
import { signal } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { PictureLayout } from '@dither-chat/protocol';
import type { ComponentChildren } from 'preact';
import { fitPicture, mosaicRows, tileAspect, type PictureRef } from '../pictures.ts';
import { viewer, type ViewerImage } from '../viewer.ts';
import { AttachmentNote } from './MessageExtras.tsx';
import { AltBadge, Veil, veiled } from './rich/parts.tsx';
import { measurers, Morph, PictureRail, pinchHandlers, setUnfolded, switchOf, unfolded } from './PictureSwitch.tsx';

/** A plain click opens the viewer; a middle or modified click still opens the file in a tab. */
export function openViewer(e: MouseEvent, images: ViewerImage[], index: number) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  viewer.value = { images, index };
}

/** Sizes read off pictures that came without one, by URL, once they loaded; a new one draws those pictures again. */
const natural = new Map<string, [number, number]>();
const naturalRev = signal(0);

function sizeOf(p: PictureRef): [number, number] | null {
  const w = p.a.width ?? p.a.info?.width;
  const h = p.a.height ?? p.a.info?.height;
  if (w && h) return [w, h];
  naturalRev.value;
  return natural.get(p.a.url) ?? null;
}

function measured(p: PictureRef, e: Event) {
  const img = e.currentTarget as HTMLImageElement;
  if (natural.has(p.a.url) || !img.naturalWidth || !img.naturalHeight || ((p.a.width ?? p.a.info?.width) && (p.a.height ?? p.a.info?.height))) return;
  natural.set(p.a.url, [img.naturalWidth, img.naturalHeight]);
  naturalRev.value++;
}

const aspectOf = (p: PictureRef) => {
  const s = sizeOf(p);
  return s ? s[0] / s[1] : 4 / 3;
};

const images = (pics: PictureRef[]): ViewerImage[] =>
  pics.map((p) => {
    const s = sizeOf(p);
    return { url: p.a.url, name: p.a.name, width: s?.[0] ?? null, height: s?.[1] ?? null };
  });

function Tile({ p, all, index, cls, style, top, over, children }: { p: PictureRef; all: PictureRef[]; index: number; cls: string; style?: Record<string, string>; top?: boolean; over?: number; children?: ComponentChildren }) {
  const img = <img src={p.a.url} alt={p.a.alt ?? p.a.name ?? ''} loading="lazy" decoding="async" class={top ? 'top' : undefined} onLoad={(e) => measured(p, e)} />;
  return (
    <a class={`pic ${cls}`} data-i={index} data-att={p.i} data-msg={p.m.id} href={p.a.url} target="_blank" rel="noreferrer" title={p.a.caption} style={style} onClick={(e) => openViewer(e, images(all), index)}>
      {veiled(p.a) ? <Veil a={p.a}>{img}</Veil> : img}
      <AltBadge alt={p.a.alt} />
      {over ? <span class="pic-more">+{over}</span> : null}
      {children}
    </a>
  );
}

/** A picture on its own, in its own shape: long ones show their top, and one with no size waits to load. */
function One({ all, index }: { all: PictureRef[]; index: number }) {
  const p = all[index];
  const size = sizeOf(p);
  if (!size) return <Tile p={p} all={all} index={index} cls="pic-one pic-wait" />;
  const box = fitPicture(size[0], size[1]);
  return (
    <Tile p={p} all={all} index={index} cls={`pic-one${box.crop === 'long' ? ' pic-long' : ''}`} style={{ width: `${box.w}px`, aspectRatio: `${box.w} / ${box.h}` }} top={box.crop === 'long'}>
      {box.crop === 'long' && <span class="pic-pill">Long picture</span>}
    </Tile>
  );
}

/** Rows of tiles cropped to share each row's height (pictures.ts mosaicRows); `over` on the last: how many more. */
function Mosaic({ all, count, over }: { all: PictureRef[]; count: number; over?: number }) {
  const rows = mosaicRows(count);
  let at = 0;
  return (
    <div class="pics-mosaic">
      {rows.map((k) => {
        const from = at;
        at += k;
        return (
          <div class="pics-row">
            {all.slice(from, from + k).map((p, j) => {
              const own = aspectOf(p);
              const a = tileAspect(own, k).toFixed(3);
              const index = from + j;
              return <Tile p={p} all={all} index={index} cls="pic-tile" style={{ flex: `${a} 1 0`, aspectRatio: a }} top={own < 0.8} over={over && index === count - 1 ? over : 0} />;
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Every picture whole, in rows of one height that fill the width (the last row as it comes). */
function Rows({ all }: { all: PictureRef[] }) {
  return (
    <div class="pics-rows">
      {all.map((p, index) => {
        const own = aspectOf(p);
        return <Tile p={p} all={all} index={index} cls="pic-tile" style={{ '--a': Math.min(3.5, Math.max(0.45, own)).toFixed(3) }} top={own < 0.45} />;
      })}
    </div>
  );
}

function Small({ all }: { all: PictureRef[] }) {
  return (
    <div class="pics-small">
      {all.map((p, index) => (
        <Tile p={p} all={all} index={index} cls="pic-small" style={{ aspectRatio: Math.min(1.8, Math.max(0.6, aspectOf(p))).toFixed(3) }} top={aspectOf(p) < 0.6} />
      ))}
    </div>
  );
}

/** A run drawn one way: what goes in its block, and whether the block takes the column's width. */
function drawRun(pics: PictureRef[], layout: PictureLayout, runKey: string, open: boolean): { body: ComponentChildren; wide: boolean } {
  const n = pics.length;
  if (layout === 'small') return { body: <Small all={pics} />, wide: false };
  if (n === 1)
    return {
      body: (
        <>
          <One all={pics} index={0} />
          <AttachmentNote a={pics[0].a} />
        </>
      ),
      wide: false,
    };
  if (layout === 'rows') return { body: <Rows all={pics} />, wide: true };
  if (layout === 'fold' && !open)
    return {
      body: (
        <>
          <One all={pics} index={0} />
          <button class="pics-fold" data-track="pictures: unfold" onClick={() => setUnfolded(runKey, true)}>
            <span class="pics-fold-thumbs">
              {pics.slice(1, 9).map((p, j) => (
                <img src={p.a.url} alt="" loading="lazy" decoding="async" data-i={j + 1} class={veiled(p.a) ? 'veiled' : undefined} />
              ))}
            </span>
            <span>Show {n - 1} more</span>
          </button>
        </>
      ),
      wide: false,
    };
  if (layout === 'six' && n > 6) return { body: <Mosaic all={pics} count={6} over={n - 6} />, wide: true };
  return {
    body: (
      <>
        <Mosaic all={pics} count={n} />
        {open && (
          <button class="pics-unfold" data-track="pictures: fold" onClick={() => setUnfolded(runKey, false)}>
            Fold
          </button>
        )}
      </>
    ),
    wide: true,
  };
}

/**
 * The pictures of one message, or of a run of them (`runKey`: its first message's id), drawn as `layout` says.
 * `anchors`: messages of the run drawn only by this block, so a jump to one of them lands here. `convId`: the chat a
 * switch saves to; with `rail`, the computer's rail of ways stands in the gutter left of a run of two or more. While
 * a slide or a pinch is under way (switchOf), the run is drawn between two ways over it (Morph).
 */
export function Pictures({ pics, layout, runKey, anchors, convId, rail }: { pics: PictureRef[]; layout: PictureLayout; runKey: string; anchors?: string[]; convId?: string; rail?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const n = pics.length;
  const switchable = n > 1 && !!convId;
  const sliding = switchable && !rail ? switchOf(runKey).value : null;
  // The switch measures every way from here when a slide starts (PictureSwitch.tsx measureRun).
  useLayoutEffect(() => {
    if (!switchable) return;
    measurers.set(runKey, { host: () => host.current, pics, runKey, draw: drawRun });
    return () => void (measurers.get(runKey)?.pics === pics && measurers.delete(runKey));
  });
  const anchorEls = anchors?.map((id) => <span class="pic-anchor" id={`m-${id}`} />);
  const pinch = switchable && !rail ? pinchHandlers(runKey, convId!, layout) : undefined;
  const { body, wide } = drawRun(pics, layout, runKey, layout === 'fold' && unfolded.value.has(runKey));
  // While sliding, the run as it is stays where it was, out of sight (the fingers' touches still go to its pictures),
  // and the drawing between two ways takes its place.
  return (
    <div class={`pics${wide || sliding ? ' wide' : ''}${pinch ? ' pics-pinch' : ''}${sliding ? ' pics-sliding' : ''}`} ref={host} {...pinch}>
      {anchorEls}
      {body}
      {switchable && rail && <PictureRail layout={layout} convId={convId!} runKey={runKey} />}
      {sliding && <Morph pics={pics} geo={sliding.geo} g={sliding.g} />}
    </div>
  );
}
