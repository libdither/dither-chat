/**
 * Reading QR codes from the camera or a picture: the browser's own BarcodeDetector where it has one, else jsQR
 * (Apache-2.0), loaded only when a scanner first opens.
 */

type Source = HTMLVideoElement | ImageBitmap;
export interface Decoder {
  kind: 'native' | 'jsqr';
  read(src: Source, width: number, height: number): Promise<string[]>;
}

/** Frames are scaled down to this many pixels on their long side before jsQR looks at them. */
const JSQR_SIDE = 800;

let decoder: Promise<Decoder> | null = null;

export function qrDecoder(): Promise<Decoder> {
  return (decoder ??= makeDecoder().catch((e) => {
    decoder = null;
    throw e;
  }));
}

async function makeDecoder(): Promise<Decoder> {
  const BD = (globalThis as any).BarcodeDetector;
  if (BD) {
    try {
      const formats: string[] = await BD.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const d = new BD({ formats: ['qr_code'] });
        return { kind: 'native', read: async (src) => ((await d.detect(src)) as { rawValue: string }[]).map((c) => c.rawValue) };
      }
    } catch {}
  }
  const mod = await import('jsqr');
  // A webpack UMD build: its default may come wrapped once more, depending on the bundler's interop.
  const jsQR = typeof mod.default === 'function' ? mod.default : (mod.default as unknown as { default: typeof mod.default }).default;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return {
    kind: 'jsqr',
    read: async (src, width, height) => {
      const scale = Math.min(1, JSQR_SIDE / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Light on dark too: some apps draw the code in their dark theme.
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      return code?.data ? [code.data] : [];
    },
  };
}

/** The codes in a picture (a screenshot of the code, say). */
export async function readPicture(file: Blob): Promise<string[]> {
  const [d, bitmap] = await Promise.all([qrDecoder(), createImageBitmap(file)]);
  try {
    return await d.read(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

export type CameraState = 'off' | 'starting' | 'on' | 'denied' | 'none' | 'busy' | 'insecure' | 'error';

/** What to say for a camera that will not start, and that the paste field still works. */
export const CAMERA_TEXT: Partial<Record<CameraState, string>> = {
  denied: "The camera is not allowed here. Allow it for this site in the browser's (or the app's) settings, or paste the link below.",
  none: 'There is no camera here. Paste the link below, or choose a picture of the code.',
  busy: 'Another app is using the camera. Close it and try again, or paste the link below.',
  insecure: 'The camera only works when this page is open over HTTPS. Paste the link below, or choose a picture of the code.',
  error: 'The camera did not start. Paste the link below, or choose a picture of the code.',
};

export function cameraError(e: unknown): CameraState {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'none';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'error';
}

/** How often a camera frame is looked at. */
const FRAME_MS = 200;

/**
 * Show the back camera in `video` and look for codes in it until stopped. `onText` gets every code seen, `onState`
 * how the camera is. stop() turns the camera off: the light goes out.
 */
export function startCamera(video: HTMLVideoElement, onText: (text: string) => void, onState: (s: CameraState, decoder?: Decoder['kind']) => void): () => void {
  let stopped = false;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video.srcObject) video.srcObject = null;
  };
  (async () => {
    if (!navigator.mediaDevices?.getUserMedia) return onState('insecure');
    onState('starting');
    let d: Decoder;
    try {
      [d, stream] = await Promise.all([qrDecoder(), navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })]);
    } catch (e) {
      if (!stopped) onState(cameraError(e));
      return;
    }
    if (stopped) return stream.getTracks().forEach((t) => t.stop());
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
    if (stopped) return;
    onState('on', d.kind);
    const look = async () => {
      if (stopped) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const texts = await d.read(video, video.videoWidth, video.videoHeight).catch(() => [] as string[]);
        if (stopped) return;
        for (const t of texts) onText(t);
      }
      if (!stopped) timer = setTimeout(look, FRAME_MS);
    };
    look();
  })();
  return stop;
}
