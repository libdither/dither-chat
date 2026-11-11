/**
 * Telegram's signed-in devices, and approving a sign-in on another device by the QR code it shows, so this hub can
 * stand in for the phone (docs/accounts.md, "Approving a Telegram sign-in"). The account actions are dither-accounts'
 * approveLogin, sessions and endSession.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { ago } from '../format.ts';
import { CAMERA_TEXT, type CameraState, type Decoder, readPicture, startCamera } from '../qrscan.ts';
import { api } from '../state.ts';
import { actionError, ARM_MS, type ApprovedSession, isOwnSession, roughlyIn, type SessionInfo, sessionApp, sessionPlace, step, type Step, undoBlockedUntil } from '../tglogin.ts';
import { Modal } from './bits.tsx';
import { Icon } from './icons.tsx';
import { DitherOrb } from './Loader.tsx';

const action = <T,>(a: P.AccountView, name: string, args?: Record<string, unknown>) =>
  api<{ result: T }>(`/api/accounts/${a.id}/action`, { body: { action: name, ...(args ? { args } : {}) } }).then((r) => r.result);

export function TelegramSignIns({ a }: { a: P.AccountView }) {
  const online = a.status === 'online';
  const [list, setList] = useState<SessionInfo[] | null>(null);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  // Only the latest answer counts: another account's, or one overtaken by a refresh, is dropped.
  const seq = useRef(0);
  const load = async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const r = await action<{ sessions: SessionInfo[] }>(a, 'sessions');
      if (n !== seq.current) return;
      setList(r.sessions);
      setListError('');
    } catch (e) {
      if (n === seq.current) setListError(actionError(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  };
  useEffect(() => {
    seq.current++;
    setList(null);
    setListError('');
    setLoading(false);
    if (online) load();
  }, [a.id, online]);
  return (
    <section class="det-section tg-signins">
      <h3>Signed-in devices</h3>
      <p class="det-note">Telegram asks a device that is already signed in to approve each new sign-in. This hub can be that device: on the new one, choose to log in by QR code, then approve it here.</p>
      <div class="btn-row">
        <button class="btn primary" disabled={!online} onClick={() => setApproving(true)}>
          <Icon name="qr" size={15} /> Approve a sign-in
        </button>
        <button class="btn ghost" disabled={!online || loading} onClick={load}>
          {loading ? (
            <>
              <DitherOrb size={14} /> Loading…
            </>
          ) : (
            <>
              <Icon name="refresh" size={14} /> Refresh
            </>
          )}
        </button>
      </div>
      {!online && <p class="det-note tg-offline">The account has to be online for this.</p>}
      {online && listError && <p class="form-error">{listError}</p>}
      {online && list && (
        <ul class="tg-sessions">
          {list.map((s) => (
            <SessionRow key={s.hash} a={a} s={s} onEnded={load} />
          ))}
        </ul>
      )}
      {approving && <ApproveSignIn a={a} blockedUntil={undoBlockedUntil(list)} onClose={() => setApproving(false)} onChanged={load} />}
    </section>
  );
}

function SessionRow({ a, s, onEnded }: { a: P.AccountView; s: SessionInfo; onEnded: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const place = sessionPlace(s);
  const end = async () => {
    setBusy(true);
    setError('');
    try {
      await action(a, 'endSession', { hash: s.hash });
      onEnded();
    } catch (e) {
      setError(actionError(e));
      setAsking(false);
    } finally {
      setBusy(false);
    }
  };
  const own = isOwnSession(s);
  return (
    <li class={`tg-session${own ? ' current' : ''}`} data-hash={s.hash}>
      <div class="tg-session-main">
        <b>{s.device || 'An unnamed device'}</b>
        <span>{sessionApp(s)}</span>
        <span>
          {place ?? 'Place unknown'} · {own ? 'active now' : `active ${ago(s.activeAt)}`}
        </span>
        {error && <span class="form-error">{error}</span>}
      </div>
      {own ? (
        <span class="tg-badge">This hub</span>
      ) : asking ? (
        <div class="tg-session-ask">
          <span>Sign it out?</span>
          <button class="btn danger small" disabled={busy} onClick={end}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
          <button class="btn ghost small" disabled={busy} onClick={() => setAsking(false)}>
            Keep
          </button>
        </div>
      ) : (
        <button class="btn ghost small" onClick={() => setAsking(true)}>
          Sign out
        </button>
      )}
    </li>
  );
}

/** The scanner, the warning, and what was approved. */
function ApproveSignIn({ a, blockedUntil, onClose, onChanged }: { a: P.AccountView; blockedUntil: number | null; onClose: () => void; onChanged: () => void }) {
  const [s, send] = useReducer(step, { at: 'scan' } as Step);
  const approve = async () => {
    if (s.at !== 'confirm' || Date.now() < s.armedAt) return;
    send({ t: 'approve', now: Date.now() });
    try {
      const r = await action<{ session: ApprovedSession }>(a, 'approveLogin', { link: s.link });
      send({ t: 'approved', session: r.session });
      onChanged();
    } catch (e) {
      send({ t: 'failed', error: actionError(e) });
    }
  };
  const endIt = async (session: ApprovedSession) => {
    send({ t: 'ending' });
    try {
      await action(a, 'endSession', { hash: session.hash });
      send({ t: 'ended' });
      onChanged();
    } catch (e) {
      send({ t: 'endFailed', error: actionError(e) });
    }
  };
  return (
    <Modal title="Approve a sign-in" onClose={onClose}>
      <div class="tg-approve" data-step={s.at}>
        {s.at === 'scan' && <Scanner refused={s.refused} onText={(text) => send({ t: 'read', text, now: Date.now() })} />}
        {s.at === 'confirm' && <Confirm armedAt={s.armedAt} blockedUntil={blockedUntil} onApprove={approve} onCancel={() => send({ t: 'again' })} />}
        {s.at === 'approving' && <p class="det-note">Approving…</p>}
        {s.at === 'approved' && <Approved s={s} onEnd={() => endIt(s.session)} onDone={onClose} />}
        {s.at === 'failed' && (
          <>
            <p class="form-error tg-error">{s.error}</p>
            <div class="btn-row">
              <button class="btn primary" onClick={() => send({ t: 'again' })}>
                Scan another code
              </button>
              <button class="btn ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Scanner({ refused, onText }: { refused?: string; onText: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [cam, setCam] = useState<CameraState>('off');
  const [kind, setKind] = useState<Decoder['kind'] | ''>('');
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');
  const [paste, setPaste] = useState('');
  const [pictureNote, setPictureNote] = useState('');
  const got = useRef(onText);
  got.current = onText;
  // The camera runs only while this is on screen: closing, a code read (which leaves this step) or the page hiding stops it.
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
    if (hidden || !video.current) return;
    const stop = startCamera(
      video.current,
      (t) => got.current(t),
      (st, k) => {
        setCam(st);
        if (k) setKind(k);
      },
    );
    return () => {
      stop();
      setCam((c) => (c === 'on' || c === 'starting' ? 'off' : c));
    };
  }, [hidden]);
  const fromPicture = async (file: File | undefined) => {
    if (!file) return;
    setPictureNote('');
    try {
      const texts = await readPicture(file);
      if (!texts.length) setPictureNote('No QR code found in that picture.');
      else onText(texts[0]);
    } catch {
      setPictureNote('That picture could not be read.');
    }
  };
  const problem = CAMERA_TEXT[cam];
  return (
    <div class="tg-scan">
      <div class={`tg-camera ${cam}`} data-camera={cam} data-decoder={kind}>
        <video ref={video} muted playsInline aria-label="Camera" />
        {cam === 'on' && <span class="tg-finder" aria-hidden="true" />}
        {(cam === 'starting' || cam === 'off') && <span class="tg-camera-note">{hidden ? 'The camera is off while the page is hidden.' : 'Starting the camera…'}</span>}
      </div>
      {problem ? <p class="form-error tg-camera-problem">{problem}</p> : <p class="det-note">Point the camera at the QR code the new device shows.</p>}
      {refused && <p class="form-error tg-refused">{refused}</p>}
      <form
        class="tg-paste"
        onSubmit={(e) => {
          e.preventDefault();
          if (paste.trim()) onText(paste);
        }}
      >
        <label class="field-label" for="tg-link">
          Or paste the link
        </label>
        <div class="tg-paste-row">
          <input id="tg-link" class="input" autocomplete="off" spellcheck={false} placeholder="tg://login?token=…" value={paste} onInput={(e) => setPaste((e.target as HTMLInputElement).value)} />
          <button class="btn ghost" type="submit" disabled={!paste.trim()}>
            Next
          </button>
        </div>
      </form>
      <label class="btn ghost tg-picture">
        <Icon name="image" size={15} /> Choose a picture of the code
        <input type="file" accept="image/*" hidden onChange={(e) => fromPicture((e.target as HTMLInputElement).files?.[0])} />
      </label>
      {pictureNote && <p class="form-error">{pictureNote}</p>}
    </div>
  );
}

function Confirm({ armedAt, blockedUntil, onApprove, onCancel }: { armedAt: number; blockedUntil: number | null; onApprove: () => void; onCancel: () => void }) {
  const [armed, setArmed] = useState(Date.now() >= armedAt);
  useEffect(() => {
    if (armed) return;
    const t = setTimeout(() => setArmed(true), Math.max(0, armedAt - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [armedAt]);
  return (
    <div class="tg-confirm">
      <h3>
        <Icon name="alert" size={20} /> Only approve a code your own device is showing you
      </h3>
      <p>
        Approve it only if you started signing in on that device yourself, just now, and it is in front of you. <b>Anyone who gets you to scan their code gets your Telegram account</b>: your chats, your contacts, and the power to sign this hub out.
      </p>
      <p>If someone sent you this code, or asked you to scan it to join something or to verify your account, do not approve it. Telegram does not say which device it is until after you approve.</p>
      {blockedUntil && (
        <p class="tg-no-undo">
          <b>There is no undo for {roughlyIn(blockedUntil - Date.now())}.</b> This hub signed in to Telegram less than a day ago, and Telegram does not let a session that new sign other devices out.
        </p>
      )}
      <div class="btn-row">
        <button class="btn danger" disabled={!armed} onClick={onApprove} title={armed ? undefined : `Ready in ${Math.ceil(ARM_MS / 1000)} s`}>
          Approve the sign-in
        </button>
        <button class="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Approved({ s, onEnd, onDone }: { s: Extract<Step, { at: 'approved' }>; onEnd: () => void; onDone: () => void }) {
  const x = s.session;
  return (
    <div class="tg-approved">
      <p class="tg-approved-head">
        <Icon name={s.ended ? 'check' : 'checks'} size={18} /> {s.ended ? 'Signed out again.' : 'Signed in.'}
      </p>
      <dl class="kv">
        <dt>Device</dt>
        <dd>{x.device || 'An unnamed device'}</dd>
        <dt>App</dt>
        <dd>{sessionApp(x)}</dd>
        <dt>Place</dt>
        <dd>{sessionPlace(x) ?? 'Telegram does not say'}</dd>
      </dl>
      {s.error && <p class="form-error tg-error">{s.error}</p>}
      {s.ended ? (
        <p class="det-note">That device is signed out of your account.</p>
      ) : (
        <p class="det-note">If this is not the device you meant, sign it out now.</p>
      )}
      <div class="btn-row">
        {!s.ended && (
          <button class="btn danger" disabled={s.ending} onClick={onEnd}>
            {s.ending ? 'Signing out…' : "That wasn't me: sign it out"}
          </button>
        )}
        <button class="btn ghost" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
