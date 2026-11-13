/**
 * The sticker picker and the voice recorder (docs/media-kinds.md), in the chunk MediaParts.tsx: ComposerMedia.tsx loads it the
 * first time either is pressed. The picker asks the hub for one page of packs when it opens and the next only when
 * asked; the recorder asks for the microphone only when it opens.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { VOICE_MAX_SECONDS, waveformBase64 } from '@dither-chat/protocol';
import { useLayer } from '../phone.ts';
import { api } from '../state.ts';
import { bars, clock, loudness, voiceType, webmToOgg } from '../voicerec.ts';
import { Icon } from './icons.tsx';
import { Sheet } from './Sheet.tsx';

const isSheet = () => matchMedia('(max-width: 820px), (pointer: coarse)').matches;

// ------------------------------------------------------------------ stickers

export function StickerPicker({ conversationId, accountId, anchor, onPick, onClose, draw }: {
  conversationId: string;
  accountId?: string;
  anchor: DOMRect;
  onPick: (s: P.StickerView) => void;
  onClose: () => void;
  /** Draws one sticker (Sticker.tsx, passed in so this chunk does not pull the timeline's sticker code apart). */
  draw: (s: P.StickerView) => any;
}) {
  const [page, setPage] = useState<P.StickerPageView | null>(null);
  const [tab, setTab] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const sheet = isSheet();
  const fetchPage = async (cursor?: string) => {
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams({ ...(accountId ? { account: accountId } : {}), ...(cursor ? { cursor } : {}) });
      const r = await api<P.StickerPageView>(`/api/conversations/${conversationId}/stickers?${q}`);
      setPage((before) => (before && cursor ? { ...r, packs: [...before.packs, ...r.packs] } : r));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => void fetchPage(), [conversationId, accountId]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || sheet) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, anchor.right - w))}px`;
    el.style.top = `${anchor.top - 8 >= h ? anchor.top - h - 6 : Math.min(innerHeight - h - 8, anchor.bottom + 6)}px`;
  });
  const install = async () => {
    if (!page?.accountId || !link.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ pack: P.StickerPackView }>(`/api/accounts/${page.accountId}/stickers`, { body: { uri: link.trim() } });
      setPage({ ...page, packs: [r.pack, ...page.packs.filter((p) => p.id !== r.pack.id)] });
      setTab(0);
      setLink('');
    } catch (e) {
      setError(`Not installed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const packs = page?.packs ?? [];
  const pack = packs[Math.min(tab, packs.length - 1)];
  const body = (
    <div class="sticker-picker-body" data-track-area="sticker picker">
      {packs.length > 0 && (
        <div class="sticker-tabs" role="tablist">
          {packs.map((p, i) => (
            <button role="tab" aria-selected={p === pack} class={`sticker-tab ${p === pack ? 'on' : ''}`} title={p.name} aria-label={p.name} onClick={() => setTab(i)}>
              {p.cover ? <img src={p.cover} alt="" width={28} height={28} /> : <Icon name="sticker" size={18} />}
            </button>
          ))}
          {page?.next && (
            <button class="sticker-tab more" disabled={busy} data-track="more sticker packs" title="More packs" aria-label="More packs" onClick={() => void fetchPage(page.next!)}>
              <Icon name="plus" size={16} />
            </button>
          )}
        </div>
      )}
      {pack && <div class="sticker-pack-name">{pack.name}</div>}
      <div class="sticker-grid">
        {pack?.stickers.map((s) => (
          <button class="sticker-choice" data-track="send sticker" title={s.name} aria-label={`Send ${s.name}`} onClick={() => onPick(s)}>
            {draw(s)}
          </button>
        ))}
      </div>
      {busy && !packs.length && <div class="sticker-note">Asking for your stickers…</div>}
      {!busy && page && !packs.length && <div class="sticker-note">{page.note ?? 'No stickers you can send here.'}</div>}
      {packs.length > 0 && page?.note && <div class="sticker-note small">{page.note}</div>}
      {error && <div class="sticker-note error">{error}</div>}
      {page?.canInstall && (
        <form
          class="sticker-install"
          onSubmit={(e) => {
            e.preventDefault();
            void install();
          }}
        >
          <input type="url" inputMode="url" placeholder="Paste a signal.art sticker link" value={link} onInput={(e) => setLink((e.target as HTMLInputElement).value)} aria-label="Sticker pack link" />
          <button class="btn" type="submit" disabled={busy || !link.trim()} data-track="install sticker pack">
            Install
          </button>
        </form>
      )}
    </div>
  );
  if (sheet)
    return (
      <Sheet onClose={onClose} label="Stickers" class="sticker-picker" tall>
        {body}
      </Sheet>
    );
  return <Layer box={box} onClose={onClose} label="Stickers">{body}</Layer>;
}

function Layer({ box, onClose, label, children }: { box: { current: HTMLDivElement | null }; onClose: () => void; label: string; children: any }) {
  useLayer(onClose);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);
  return (
    <div class="ep-layer" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sticker-picker" ref={box} role="dialog" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/** Install the pack a signal.art link names, through an account that can (a link's menu, ui/menus.tsx). */
export async function installPack(accountId: string, uri: string): Promise<P.StickerPackView> {
  return (await api<{ pack: P.StickerPackView }>(`/api/accounts/${accountId}/stickers`, { body: { uri } })).pack;
}

// ------------------------------------------------------------------ voice messages

type Rec = { state: 'asking' } | { state: 'refused'; why: string } | { state: 'recording'; seconds: number } | { state: 'done'; file: File; seconds: number; url: string };

const BARS = 40;
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

export function VoiceRecorder({ voice, onSend, onClose }: { voice: boolean; onSend: (file: File, out: P.VoiceOut | null) => void; onClose: () => void }) {
  const [rec, setRec] = useState<Rec>({ state: 'asking' });
  const [points, setPoints] = useState<number[]>([]);
  const [playing, setPlaying] = useState(false);
  const live = useRef<{ stream?: MediaStream; recorder?: MediaRecorder; ctx?: AudioContext; timer?: ReturnType<typeof setInterval>; chunks: Blob[]; points: number[]; started: number; sendNow: boolean }>({ chunks: [], points: [], started: 0, sendNow: false });
  const audio = useRef<HTMLAudioElement>(null);
  useLayer(onClose);

  const release = () => {
    const l = live.current;
    clearInterval(l.timer);
    l.stream?.getTracks().forEach((t) => t.stop());
    void l.ctx?.close().catch(() => {});
    l.stream = undefined;
    l.ctx = undefined;
  };

  const finish = async (blob: Blob, seconds: number) => {
    const l = live.current;
    let file: File;
    const type = blob.type.split(';')[0];
    // Discord takes voice messages as Ogg Opus; a WebM recording is the same audio in another wrapper.
    const ogg = type === 'audio/webm' ? webmToOgg(new Uint8Array(await blob.arrayBuffer())) : null;
    if (ogg) file = new File([ogg as Uint8Array<ArrayBuffer>], `voice-message-${stamp()}.ogg`, { type: 'audio/ogg' });
    else file = new File([blob], `voice-message-${stamp()}.${type === 'audio/ogg' ? 'ogg' : type === 'audio/mp4' ? 'm4a' : 'webm'}`, { type: type || 'audio/webm' });
    if (l.sendNow) return send(file, seconds);
    setRec({ state: 'done', file, seconds, url: URL.createObjectURL(file) });
  };

  const send = (file: File, seconds: number) => onSend(file, voice ? { seconds: Math.max(0.1, seconds), waveform: waveformBase64(live.current.points) } : null);

  useEffect(() => {
    let gone = false;
    (async () => {
      const type = typeof MediaRecorder === 'undefined' ? undefined : voiceType((t) => MediaRecorder.isTypeSupported(t));
      if (!navigator.mediaDevices?.getUserMedia || !type) return setRec({ state: 'refused', why: 'This browser cannot record sound.' });
      let stream: MediaStream;
      try {
        // Asked here, on the first press, and never before.
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e) {
        return setRec({ state: 'refused', why: (e as Error).name === 'NotAllowedError' ? 'The microphone was not allowed. Allow it for this app in your browser or phone settings, then try again.' : `The microphone did not start: ${(e as Error).message}` });
      }
      if (gone) return stream.getTracks().forEach((t) => t.stop());
      const l = live.current;
      l.stream = stream;
      const recorder = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 32_000 });
      l.recorder = recorder;
      recorder.ondataavailable = (e) => e.data.size && l.chunks.push(e.data);
      recorder.onstop = () => {
        const seconds = (performance.now() - l.started) / 1000;
        release();
        if (!gone) void finish(new Blob(l.chunks, { type: recorder.mimeType || type }), seconds);
      };
      // Loudness a tenth of a second at a time: the waveform Discord shows, and the bars here.
      try {
        const ctx = new AudioContext();
        l.ctx = ctx;
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        l.timer = setInterval(() => {
          an.getFloatTimeDomainData(buf);
          l.points.push(loudness(buf));
          const seconds = (performance.now() - l.started) / 1000;
          setPoints([...l.points]);
          setRec({ state: 'recording', seconds });
          if (seconds >= VOICE_MAX_SECONDS) recorder.stop();
        }, 100);
      } catch {
        l.timer = setInterval(() => setRec({ state: 'recording', seconds: (performance.now() - l.started) / 1000 }), 250);
      }
      l.started = performance.now();
      recorder.start(1000);
      setRec({ state: 'recording', seconds: 0 });
    })();
    return () => {
      gone = true;
      const r = live.current.recorder;
      if (r && r.state !== 'inactive') r.stop();
      release();
    };
  }, []);
  useEffect(() => () => void (rec.state === 'done' && URL.revokeObjectURL(rec.url)), [rec]);

  const stop = (sendNow: boolean) => {
    live.current.sendNow = sendNow;
    const r = live.current.recorder;
    if (r && r.state !== 'inactive') r.stop();
  };
  const shown = bars(points, BARS);
  return (
    <div class="voice-rec" role="group" aria-label="Voice message" data-track-area="voice recorder">
      <button class="icon-btn" data-track="cancel recording" aria-label="Throw it away" title="Throw it away" onClick={onClose}>
        <Icon name="trash" size={18} />
      </button>
      {rec.state === 'asking' && <span class="voice-rec-note">Asking for the microphone…</span>}
      {rec.state === 'refused' && <span class="voice-rec-note error">{rec.why}</span>}
      {(rec.state === 'recording' || rec.state === 'done') && (
        <>
          {rec.state === 'recording' ? (
            <span class="voice-rec-dot" aria-hidden="true" />
          ) : (
            <button
              class="icon-btn"
              data-track="play recording"
              aria-label={playing ? 'Pause' : 'Play'}
              onClick={() => {
                const a = audio.current;
                if (!a) return;
                if (a.paused) void a.play();
                else a.pause();
              }}
            >
              <Icon name={playing ? 'pause' : 'play'} size={16} />
            </button>
          )}
          <div class="voice-rec-bars" aria-hidden="true">
            {shown.map((v) => (
              <i style={{ height: `${Math.max(8, v * 100)}%` }} />
            ))}
          </div>
          <span class="voice-rec-time">{clock(rec.seconds)}</span>
          {rec.state === 'done' && <audio ref={audio} src={rec.url} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />}
          {rec.state === 'recording' && (
            <button class="icon-btn" data-track="stop recording" aria-label="Stop and listen" title="Stop and listen" onClick={() => stop(false)}>
              <Icon name="stop" size={16} />
            </button>
          )}
        </>
      )}
      <button
        class="send-btn"
        data-track="send recording"
        aria-label={voice ? 'Send voice message' : 'Send recording'}
        disabled={rec.state !== 'recording' && rec.state !== 'done'}
        onClick={() => (rec.state === 'done' ? send(rec.file, rec.seconds) : stop(true))}
      >
        <Icon name="send" size={17} />
      </button>
    </div>
  );
}
