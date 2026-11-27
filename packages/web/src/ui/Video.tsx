/**
 * A video in the app's own player (VideoPlayer.tsx, docs/media-kinds.md "Videos"), which is a chunk of its own, loaded
 * the first time a video is drawn. Until it is in (or if it cannot load, offline on an old build), the browser's player
 * at the same size.
 */
import { useEffect, useState } from 'preact/hooks';
import type { VideoProps } from './VideoPlayer.tsx';

type Chunk = typeof import('./VideoPlayer.tsx');
let chunk: Chunk | null = null;
let loading: Promise<Chunk> | null = null;
const load = () =>
  (loading ??= import('./VideoPlayer.tsx').then(
    (c) => (chunk = c),
    (e) => {
      loading = null;
      throw e;
    },
  ));

export function Video(props: VideoProps) {
  const [c, setC] = useState(chunk);
  useEffect(() => {
    if (!c) load().then(setC, () => {});
  }, []);
  if (c) return <c.VideoPlayer {...props} />;
  const w = props.width;
  const h = props.height;
  const scale = w && h ? Math.min(1, 400 / w, 300 / h) : 1;
  return (
    <video
      class={props.class}
      data-att={props.att}
      src={props.src}
      poster={props.poster}
      controls
      preload="metadata"
      playsInline
      autoPlay={props.autoPlay}
      onPlay={props.onPlay}
      aria-label={props.label ?? props.name ?? 'Video'}
      style={w && h ? { display: 'block', maxWidth: '100%', width: `${Math.round(w * scale)}px`, aspectRatio: `${w} / ${h}`, background: '#000', borderRadius: '8px' } : { display: 'block', maxWidth: '400px', maxHeight: '300px' }}
    />
  );
}
