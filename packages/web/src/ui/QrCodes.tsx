/**
 * QR codes in the New box (docs/add.md, "QR codes"): scanning one, which only fills the box as a paste would, and
 * your own code on each account. QrImage also draws a place's invite link (About.tsx).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { netName } from '../model.ts';
import { NUMBER_WARNING, ownCode, qrSvg, readScan, SCAN_CAMERA_TEXT, type ScanResult } from '../qr.ts';
import { type CameraState, type Decoder, readPicture, startCamera } from '../qrscan.ts';
import { db } from '../state.ts';
import { NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';

/** A code, dark on light with its quiet zone whatever the theme. */
export function QrImage({ text, label }: { text: string; label: string }) {
  const svg = useMemo(() => qrSvg(text), [text]);
  return <div class="qr-code" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Put text on the clipboard; where the page may not (plain http), select it for Ctrl+C instead. */
async function copyText(text: string, el: HTMLElement | null): Promise<'copied' | 'selected'> {
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    if (el) getSelection()?.selectAllChildren(el);
    return 'selected';
  }
}

/** A code with its link under it, Copy, and Share where the device has a share sheet. */
export function QrLink({ url, label, title }: { url: string; label: string; title: string }) {
  const [copied, setCopied] = useState<'copied' | 'selected' | null>(null);
  const link = useRef<HTMLElement>(null);
  const canShare = typeof navigator.share === 'function';
  return (
    <div class="qr-card">
      <QrImage text={url} label={label} />
      <code class="qr-link" ref={link}>
        {url}
      </code>
      <div class="btn-row qr-actions">
        <button class="btn ghost small qr-copy" onClick={async () => setCopied(await copyText(url, link.current))}>
          <Icon name={copied === 'copied' ? 'check' : 'copy'} size={13} /> {copied === 'copied' ? 'Copied' : copied === 'selected' ? 'Selected: press Ctrl+C' : 'Copy'}
        </button>
        {canShare && (
          <button class="btn ghost small qr-share" onClick={() => navigator.share({ title, url }).catch(() => {})}>
            <Icon name="share" size={13} /> Share
          </button>
        )}
      </div>
    </div>
  );
}

/** Each account's own code, one at a time; a phone number stays hidden until tapped, every time this opens. */
export function MyCodes() {
  const accounts = [...db.accounts.values()].filter((a) => a.network !== 'email');
  const [pick, setPick] = useState(accounts[0]?.id ?? null);
  const [shown, setShown] = useState<string | null>(null);
  const a = accounts.find((x) => x.id === pick) ?? accounts[0];
  if (!a) return <p class="set-help">Add an account first: each one gets a code here.</p>;
  const me = a.selfIdentityId ? db.identities.get(a.selfIdentityId) : undefined;
  const own = me ? ownCode(a.network, me) : { code: null, notes: [`${a.label} has not said who it is yet, so there is no code to show.`] };
  const code = own.code;
  const hidden = code?.number && shown !== a.id;
  return (
    <div class="qr-mine" data-account={a.id}>
      {accounts.length > 1 && (
        <div class="level-picker qr-accounts">
          {accounts.map((x) => (
            <button class={`chip-btn ${x.id === a.id ? 'on' : ''}`} data-account={x.id} onClick={() => (setPick(x.id), setShown(null))}>
              <NetBadge network={x.network} size={14} /> {x.label}
            </button>
          ))}
        </div>
      )}
      {code && hidden ? (
        <div class="qr-hidden">
          <p class="set-help qr-warning">
            <Icon name="alert" size={13} /> {NUMBER_WARNING}
          </p>
          <button class="btn small qr-reveal" onClick={() => setShown(a.id)}>
            <Icon name="eye" size={13} /> Show my number's code
          </button>
        </div>
      ) : code ? (
        <>
          <QrLink url={code.url} label={`Your ${netName(a.network)} code`} title={`${a.label} on ${netName(a.network)}`} />
          <p class="set-help qr-what">{code.what}</p>
          {code.number && (
            <button class="btn ghost small qr-unreveal" onClick={() => setShown(null)}>
              Hide my number
            </button>
          )}
        </>
      ) : null}
      {own.notes.map((n) => (
        <p class="set-help qr-note">{n}</p>
      ))}
      <p class="set-help qr-foot">A phone's camera opens a code in its app; Scan here reads them too.</p>
    </div>
  );
}

/**
 * The camera, a picture chosen, pasted or dropped. A code the New box reads goes to onLink, which only fills the box;
 * anything else is shown here as text. A link pasted as text goes to onLink as it is.
 */
export function ScanCode({ onLink }: { onLink: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [cam, setCam] = useState<CameraState>('off');
  const [kind, setKind] = useState<Decoder['kind'] | ''>('');
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');
  const [other, setOther] = useState<Extract<ScanResult, { kind: 'other' }> | null>(null);
  const [note, setNote] = useState('');
  const seen = useRef((raw: string) => {});
  seen.current = (raw: string) => {
    const r = readScan(raw);
    if (r.kind === 'reading') onLink(r.text);
    else setOther(r);
  };
  const link = useRef(onLink);
  link.current = onLink;
  const fromPicture = async (file: Blob | null | undefined) => {
    if (!file) return;
    setNote('');
    try {
      const texts = await readPicture(file);
      if (!texts.length) setNote('No QR code found in that picture.');
      else seen.current(texts[0]);
    } catch {
      setNote('That picture could not be read.');
    }
  };
  // The camera runs only while this is on screen and looking: closing, a code read or the page hiding stops it.
  useEffect(() => {
    const vis = () => setHidden(document.visibilityState === 'hidden');
    const gone = () => setHidden(true);
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', gone);
    window.addEventListener('pageshow', vis);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pagehide', gone);
      window.removeEventListener('pageshow', vis);
    };
  }, []);
  useEffect(() => {
    if (hidden || other || !video.current) return;
    const stop = startCamera(
      video.current,
      (t) => seen.current(t),
      (st, k) => {
        setCam(st);
        if (k) setKind(k);
      },
    );
    return () => {
      stop();
      setCam((c) => (c === 'on' || c === 'starting' ? 'off' : c));
    };
  }, [hidden, !!other]);
  // A picture pasted anywhere while this is open (a screenshot of a code); pasted text is a paste into the box.
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (!file && !text) return;
      e.preventDefault();
      if (file) void fromPicture(file);
      else link.current(text!);
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, []);
  if (other) {
    return (
      <div class="qr-scan qr-other">
        <p class="set-help qr-other-line">
          <Icon name="info" size={13} /> This code isn't an invite or a profile link
        </p>
        <pre class="qr-other-text">{other.text.slice(0, 2000)}</pre>
        {other.hint && <p class="set-help qr-other-hint">{other.hint}</p>}
        <div class="btn-row">
          <button class="btn small qr-again" onClick={() => setOther(null)}>
            Scan another
          </button>
        </div>
      </div>
    );
  }
  const problem = SCAN_CAMERA_TEXT[cam];
  return (
    <div
      class="qr-scan"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void fromPicture(e.dataTransfer?.files?.[0]);
      }}
    >
      {/* The camera looks like the Telegram sign-in scanner's (TelegramSignIns.tsx). */}
      <div class={`tg-camera qr-camera ${cam}`} data-camera={cam} data-decoder={kind}>
        <video ref={video} muted playsInline aria-label="Camera" />
        {cam === 'on' && <span class="tg-finder" aria-hidden="true" />}
        {(cam === 'starting' || cam === 'off') && <span class="tg-camera-note">{hidden ? 'The camera is off while the page is hidden.' : 'Starting the camera…'}</span>}
      </div>
      {problem ? <p class="set-help qr-camera-problem">{problem}</p> : <p class="set-help">Point the camera at a code: an invite, a group link, or someone's profile code.</p>}
      <label class="btn ghost small qr-picture">
        <Icon name="image" size={14} /> Choose a picture of the code
        <input
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            void fromPicture(input.files?.[0]).finally(() => (input.value = ''));
          }}
        />
      </label>
      <p class="set-help qr-paste-hint">Or paste or drop a picture of it here. A scan only fills the box: nothing is joined or sent.</p>
      {note && (
        <p class="new-message-error qr-picture-note" role="alert">
          <Icon name="alert" size={13} /> {note}
        </p>
      )}
    </div>
  );
}
