/**
 * A sticker, drawn the way its network draws it: a picture at 160 px with no frame around it, or, for Discord's own
 * stickers, a Lottie animation. Those play through lottie-web's light player (SVG only, no expressions, so nothing is
 * evaluated), loaded the first time one comes on screen. An animation moves only while it is in sight, and stays on its
 * first frame for anyone who asked for less motion.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';

/** The mime the Discord extractor gives a Lottie sticker (dither-accounts, extractors/discord/src/map.ts). */
export const LOTTIE_MIME = 'application/x-lottie+json';
export const isLottie = (a: { mime: string | null }) => a.mime === LOTTIE_MIME;

/** A message's attachment shown as a sticker: a Lottie one, or any picture in a sticker message (Signal, WhatsApp, Discord). */
export const isSticker = (m: { kind: P.MessageKind }, a: P.AttachmentView) => isLottie(a) || (m.kind === 'sticker' && a.kind === 'image');

const SIZE = 160;

export function Sticker({ a, index }: { a: P.AttachmentView; index: number }) {
  const name = a.name ?? 'Sticker';
  if (isLottie(a)) return <LottieSticker url={a.url} name={name} index={index} />;
  return <img class="sticker" data-att={index} src={a.url} alt={name} title={name} width={SIZE} height={SIZE} loading="lazy" />;
}

type Lottie = typeof import('lottie-web').default;
let player: Promise<Lottie> | null = null;
const loadPlayer = () => (player ??= import('lottie-web/build/player/lottie_light').then((m) => m.default as Lottie));

/** Each animation's JSON once per page, however many times it is on screen. */
const animations = new Map<string, Promise<unknown>>();
function animationData(url: string): Promise<unknown> {
  let p = animations.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`sticker: ${r.status}`);
      return r.json();
    });
    p.catch(() => animations.delete(url));
    animations.set(url, p);
  }
  return p;
}

function LottieSticker({ url, name, index }: { url: string; name: string; index: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let anim: ReturnType<Lottie['loadAnimation']> | null = null;
    let started = false;
    let visible = false;
    let gone = false;
    const start = async () => {
      started = true;
      try {
        const [lottie, data] = await Promise.all([loadPlayer(), animationData(url)]);
        if (gone) return;
        // lottie-web changes the data it is given: each player gets its own copy.
        anim = lottie.loadAnimation({ container: el, renderer: 'svg', loop: true, autoplay: false, animationData: structuredClone(data) });
        if (still || !visible) anim.goToAndStop(0, true);
        else anim.play();
      } catch {
        if (!gone) setFailed(true);
      }
    };
    const seen = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (!started) {
        if (visible) void start();
        return;
      }
      if (!anim || still) return;
      if (visible) anim.play();
      else anim.pause();
    });
    seen.observe(el);
    return () => {
      gone = true;
      seen.disconnect();
      anim?.destroy();
    };
  }, [url]);
  if (failed) return <span class="sticker sticker-missing" data-att={index}>{name}</span>;
  return <div class="sticker sticker-lottie" data-att={index} ref={box} role="img" aria-label={name} title={name} />;
}
