/**
 * Attaching on a phone, as Signal does it (docs/uploads.md, "On a phone"): the composer's + opens a sheet with
 * Photos & videos and File; the camera button in the box opens a full-screen camera; and photos and videos, picked
 * or taken, open a send screen with them large, a strip of thumbnails, and a caption that is the message's text.
 * The files are the composer's own (ComposerFiles.tsx): each starts uploading as it is attached, so send is quick.
 *
 * Signal's sheet also shows a grid of recent photos. That would need the Android app to read every photo on the
 * phone; the system's photo picker stands in for it, and needs no permission.
 */
import { createPortal } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { baseType, clockOf, HOLD_MS, nextCamera, photoName, recorderType, videoName, type Cam } from '../camera.ts';
import { bytes } from '../format.ts';
import { useLayer } from '../phone.ts';
import { statusOf, Thumb, type Attached } from './ComposerFiles.tsx';
import { useGrow } from './grow.ts';
import { Icon } from './icons.tsx';
import { Sheet } from './Sheet.tsx';

// ------------------------------------------------------------------ the + sheet

export function AttachSheet({ onPhotos, onFile, onClose, limit }: { onPhotos: () => void; onFile: () => void; onClose: () => void; limit: string }) {
  // The picker opens from the tap itself, which a browser asks of it; the sheet goes as it opens.
  const pick = (open: () => void) => () => {
    open();
    onClose();
  };
  return (
    <Sheet onClose={onClose} label="Attach" class="attach-sheet">
      <div class="cm-sheet-title">Attach</div>
      <div class="sheet-actions" data-track-area="attach">
        <button class="sheet-action attach-action" data-track="photos" onClick={pick(onPhotos)}>
          <Icon name="image" size={22} />
          <span>
            Photos & videos
            <small>From your gallery, several at once</small>
          </span>
        </button>
        <button class="sheet-action attach-action" data-track="file" onClick={pick(onFile)}>
          <Icon name="file" size={22} />
          <span>
            File
            <small>Any kind, {limit}</small>
          </span>
        </button>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ the camera

/**
 * The rear camera first, full screen: tap the shutter for a photo, hold it for a video, flip, torch where the camera
 * has one, the gallery instead, close. Where the browser has no camera API, or it is refused, `onFallback` asks the system's camera
 * through a file input instead: at once while the tap that opened this still counts as one, else from a button.
 */
export function CameraView({ onShot, onFallback, onGallery, onClose }: { onShot: (f: File) => void; onFallback: () => void; onGallery: () => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [deviceId, setDeviceId] = useState<string | undefined>();
  const [cams, setCams] = useState<Cam[]>([]);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [recordingAt, setRecordingAt] = useState<number | null>(null);
  const [, tick] = useState(0);
  const [flash, setFlash] = useState(0);
  const [recordAs] = useState(() => (typeof MediaRecorder !== 'undefined' ? recorderType((t) => MediaRecorder.isTypeSupported(t)) : undefined));
  const recorder = useRef<MediaRecorder | null>(null);
  const press = useRef({ down: false, held: false, timer: 0 as ReturnType<typeof setTimeout> | 0 });
  const closed = useRef(false);
  const close = () => {
    closed.current = true;
    recorder.current?.stop();
    onClose();
  };
  useLayer(close);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  useEffect(() => {
    let live = true;
    let got: MediaStream | null = null;
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    navigator.mediaDevices
      .getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size } })
      .then(async (s) => {
        if (!live) return s.getTracks().forEach((t) => t.stop());
        got = s;
        setStream(s);
        const track = s.getVideoTracks()[0];
        const caps: any = track?.getCapabilities?.() ?? {};
        setTorch(caps.torch ? false : null);
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        if (live) setCams(devs.map((d) => ({ id: d.deviceId, facing: ((d as any).getCapabilities?.().facingMode as string[] | undefined) ?? [] })));
      })
      .catch((e: DOMException) => {
        if (!live) return;
        // Still within the tap that opened the camera: the system's camera can open from it.
        if ((navigator as any).userActivation?.isActive) {
          closed.current = true;
          onFallback();
          return onClose();
        }
        setFailed(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'The camera is not allowed here.' : e?.name === 'NotReadableError' ? 'Another app is using the camera.' : 'No camera could be opened.');
      });
    return () => {
      live = false;
      got?.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId]);
  useLayoutEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream]);
  useEffect(() => {
    if (recordingAt === null) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [recordingAt]);

  const track = stream?.getVideoTracks()[0];
  const settings: MediaTrackSettings = track?.getSettings?.() ?? {};
  const mirrored = settings.facingMode === 'user';
  const next = nextCamera(cams, settings.deviceId);

  const shoot = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    setFlash((n) => n + 1);
    c.toBlob((b) => b && !closed.current && onShot(new File([b], photoName(new Date()), { type: 'image/jpeg' })), 'image/jpeg', 0.9);
  };
  /** Held: a video, with sound where the microphone is allowed, until the finger lifts. */
  const record = async () => {
    const type = recordAs;
    if (!type || !stream) return;
    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {}
    if (!press.current.down || closed.current) return mic?.getTracks().forEach((t) => t.stop());
    const rec = new MediaRecorder(new MediaStream([...stream.getVideoTracks(), ...(mic?.getAudioTracks() ?? [])]), { mimeType: type, videoBitsPerSecond: 2_500_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      mic?.getTracks().forEach((t) => t.stop());
      recorder.current = null;
      setRecordingAt(null);
      if (!closed.current && chunks.length) onShot(new File([new Blob(chunks, { type: baseType(type) })], videoName(new Date(), type), { type: baseType(type) }));
    };
    rec.start(250);
    recorder.current = rec;
    setRecordingAt(Date.now());
  };
  const down = (e: PointerEvent) => {
    // Without a recorder a hold is a tap: a photo.
    if (e.button || !recordAs) return;
    press.current = {
      down: true,
      held: false,
      timer: setTimeout(() => {
        press.current.held = true;
        void record();
      }, HOLD_MS),
    };
  };
  const up = () => {
    press.current.down = false;
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = 0;
    if (recorder.current?.state === 'recording') recorder.current.stop();
  };

  return createPortal(
    <div class="cam" role="dialog" aria-modal="true" aria-label="Camera" data-track-area="camera">
      <video ref={video} class={`cam-video ${mirrored ? 'mirrored' : ''}`} autoplay muted playsInline />
      {flash > 0 && <div key={flash} class="cam-flash" aria-hidden="true" />}
      <div class="cam-top">
        <button class="cam-btn" data-track="close" onClick={close} aria-label="Close the camera">
          <Icon name="x" size={24} />
        </button>
        {recordingAt !== null && (
          <span class="cam-rec" role="status">
            <span class="cam-rec-dot" /> {clockOf(Date.now() - recordingAt)}
          </span>
        )}
        {torch !== null && (
          <button
            class={`cam-btn ${torch ? 'on' : ''}`}
            data-track="torch"
            aria-pressed={torch}
            aria-label={torch ? 'Turn the torch off' : 'Turn the torch on'}
            onClick={() => {
              const on = !torch;
              track?.applyConstraints({ advanced: [{ torch: on } as any] }).then(() => setTorch(on), () => setTorch(null));
            }}
          >
            <Icon name={torch ? 'zap' : 'zapOff'} size={22} />
          </button>
        )}
      </div>
      {failed && (
        <div class="cam-failed" role="alert">
          <p>{failed}</p>
          <button
            class="btn"
            data-track="system camera"
            onClick={() => {
              closed.current = true;
              onFallback();
              onClose();
            }}
          >
            <Icon name="camera" size={16} /> Use the phone's camera app
          </button>
        </div>
      )}
      <div class="cam-bottom">
        <span class="cam-hint">{stream && !failed ? (recordingAt !== null ? 'Let go to stop' : recordAs ? 'Tap for a photo, hold for a video' : 'Tap for a photo') : ''}</span>
        <div class="cam-controls">
          {/* As in Signal: the gallery beside the shutter. */}
          <button
            class="cam-btn cam-side"
            data-track="photos"
            aria-label="Pick photos or videos instead"
            disabled={recordingAt !== null}
            onClick={() => {
              closed.current = true;
              onGallery();
              onClose();
            }}
          >
            <Icon name="image" size={22} />
          </button>
          <button
            class={`cam-shutter ${recordingAt !== null ? 'recording' : ''}`}
            data-track="shutter"
            aria-label={recordAs ? 'Take a photo (hold for a video)' : 'Take a photo'}
            disabled={!stream}
            onPointerDown={down}
            onPointerUp={up}
            onPointerCancel={up}
            onPointerLeave={up}
            onContextMenu={(e) => e.preventDefault()}
            onClick={() => {
              // A hold made a video (or tried to): no photo as well.
              if (press.current.held) return void (press.current.held = false);
              shoot();
            }}
          />
          {next ? (
            <button class="cam-btn cam-side" data-track="flip" aria-label="Switch camera" disabled={recordingAt !== null} onClick={() => setDeviceId(next)}>
              <Icon name="switchCamera" size={24} />
            </button>
          ) : (
            <span class="cam-side" />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ the send screen

/**
 * Photos and videos large before they go: a strip of thumbnails when there are several, each with a remove; a
 * caption, which is the message's text; send; and × back to the composer with everything still attached.
 */
export function SendScreen(props: {
  files: Attached[];
  remove: (key: number) => void;
  text: string;
  onText: (v: string) => void;
  canSend: boolean;
  sendTitle?: string;
  onSend: () => void;
  onAddMore: () => void;
  onClose: () => void;
  enterSends: () => boolean;
}) {
  const { files, remove, text, onText, onSend, onClose } = props;
  const [at, setAt] = useState(0);
  const caption = useRef<HTMLTextAreaElement>(null);
  useLayer(onClose);
  useGrow(caption, text);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  // The last one removed: back to the composer, as Signal does.
  useEffect(() => {
    if (!files.length) onClose();
  }, [files.length]);
  const i = Math.min(at, files.length - 1);
  const cur = files[i];
  if (!cur) return null;
  const { status, why, pct } = statusOf(cur);
  const name = cur.file.name || 'file';
  const isVideo = cur.file.type.startsWith('video/');
  return createPortal(
    <div class="send-screen" role="dialog" aria-modal="true" aria-label="Send photos and videos" data-track-area="send screen">
      <div class="ss-bar">
        <button class="icon-btn" data-track="back" onClick={onClose} aria-label="Back to the message">
          <Icon name="x" size={22} />
        </button>
        <span class="ss-title">{files.length > 1 ? `${i + 1} of ${files.length}` : name}</span>
      </div>
      <div class="ss-stage">
        {cur.url ? isVideo ? <video key={cur.key} class="ss-media" src={cur.url} controls playsInline /> : <img key={cur.key} class="ss-media" src={cur.url} alt={name} /> : (
          <div class="ss-file">
            <Icon name="file" size={48} />
            <span>{name}</span>
            <small>{bytes(cur.file.size)}</small>
          </div>
        )}
        {why && (
          <div class="ss-why" role="alert">
            {why}
            {status === 'failed' && (
              <button class="btn small" onClick={() => cur.job!.retry()}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>
      <div class="ss-foot">
        <div class="ss-strip">
          {files.length > 1 &&
            files.map((f, k) => <StripThumb key={f.key} f={f} on={k === i} pick={() => setAt(k)} remove={() => remove(f.key)} />)}
          <button class="ss-add" data-track="add more" onClick={props.onAddMore} aria-label="Add photos or videos">
            <Icon name="plus" size={20} />
          </button>
          {status === 'uploading' && files.length === 1 && (
            <span class="upload-bar ss-one-bar" role="progressbar" aria-label={`Uploading ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <span style={{ width: `${pct}%` }} />
            </span>
          )}
        </div>
        <div class="ss-compose">
          <div class="ss-caption">
            <textarea
              ref={caption}
              rows={1}
              value={text}
              data-track="caption"
              placeholder="Add a message"
              onInput={(e) => onText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && props.enterSends()) {
                  e.preventDefault();
                  if (props.canSend) onSend();
                }
              }}
            />
          </div>
          <button class="send-btn" data-track="send" disabled={!props.canSend} onClick={onSend} aria-label="Send" title={props.sendTitle}>
            <Icon name="send" size={18} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StripThumb({ f, on, pick, remove }: { f: Attached; on: boolean; pick: () => void; remove: () => void }) {
  const { status, pct } = statusOf(f);
  const name = f.file.name || 'file';
  return (
    <div class={`ss-thumb ${on ? 'on' : ''} ${status}`} data-status={status}>
      <button class="ss-pick" data-track="thumbnail" onClick={pick} aria-label={`Show ${name}`} aria-current={on}>
        <Thumb f={f} size={20} />
        {f.file.type.startsWith('video/') && <Icon name="play" size={12} class="ss-video-mark" />}
      </button>
      <button class="ss-remove" data-track="remove" onClick={remove} aria-label={status === 'uploading' ? `Cancel uploading ${name}` : `Remove ${name}`}>
        <Icon name="x" size={11} />
      </button>
      {status === 'uploading' && (
        <span class="ss-progress" role="progressbar" aria-label={`Uploading ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
    </div>
  );
}
