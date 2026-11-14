/**
 * An account's page (docs/accounts.md, "One list"): what it does here, then a section per part (its chats, its mail,
 * its notices), its controls and removing it. A chunk of its own: Accounts.tsx loads it the first time one opens.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { accountRow } from '../accountrows.ts';
import { ago } from '../format.ts';
import { netName } from '../model.ts';
import { qrSvg } from '../qr.ts';
import { api, db, go, mailRev, rev, toast } from '../state.ts';
import { dropLayer, pushLayer } from '../phone.ts';
import { FeatureStrip, KindBadge } from './AccountFeatures.tsx';
import { Icon } from './icons.tsx';
import { ImportsSection } from './Imports.tsx';
import { TelegramSignIns } from './TelegramSignIns.tsx';
import { MailAccountSection } from './mail/MailAccounts.tsx';
import { Loading } from './Loader.tsx';
import { LiveView, STATUS } from './Accounts.tsx';
import { StoriesSetting } from './StoriesSetting.tsx';

/** What the network wants done, your status there, folders and sessions (AccountSelf.tsx): a chunk of its own. */
type SelfParts = typeof import('./AccountSelf.tsx');
const selfParts = signal<SelfParts | null>(null);
let selfLoading: Promise<unknown> | null = null;
const loadSelf = () => (selfLoading ??= import('./AccountSelf.tsx').then((m) => (selfParts.value = m), () => (selfLoading = null)));

const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

function LinkCode({ account, at }: { account: P.AccountView; at: P.Attention }) {
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phoneNo, setPhoneNo] = useState('');
  const wa = account.network === 'whatsapp';
  const tg = account.network === 'telegram';
  const app = netName(account.network);
  const where: Partial<Record<P.Network, string>> = {
    whatsapp: 'Settings → Linked devices → Link a device.',
    telegram: 'Settings → Devices → Link Desktop Device.',
    gmessages: 'Tap your profile picture → Device pairing → QR code scanner.',
  };
  const pairCode = (at.detail as { pairCode?: string } | undefined)?.pairCode;
  const [now, setNow] = useState(Date.now());
  const svg = useMemo(() => (at.qr ? qrSvg(at.qr) : null), [at.qr]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!full) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [full]);
  useEffect(() => {
    if (!full) return;
    const id = pushLayer(() => setFull(false));
    return () => dropLayer(id);
  }, [full]);
  const left = at.qrRefreshAt ? Math.max(0, Math.ceil((at.qrRefreshAt - now) / 1000)) : null;
  const timer = !svg ? null : left === null ? 'It refreshes on its own when it expires.' : left > 0 ? `A new code replaces this one in ${left}s.` : 'Getting a new code…';
  const fresh = async () => {
    setBusy(true);
    try {
      await api(`/api/accounts/${account.id}/action`, { body: { action: 'refreshLink' } });
    } catch (e: any) {
      toast({ kind: 'error', title: 'No new code', body: e.message });
    } finally {
      setBusy(false);
    }
  };
  const pair = async () => {
    setBusy(true);
    try {
      await api(`/api/accounts/${account.id}/action`, { body: { action: 'pairPhone', args: { phone: phoneNo } } });
    } catch (e: any) {
      toast({ kind: 'error', title: tg ? 'No code sent' : 'No pairing code', body: e.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="attention-qr">
      {svg && !pairCode && <button class="qr" title="Show full screen" aria-label="Show the code full screen" onClick={() => setFull(true)} dangerouslySetInnerHTML={{ __html: svg }} />}
      <div class="qr-side">
        {pairCode ? (
          <p class="qr-pair-code">{pairCode}</p>
        ) : (
          <ol>
            <li>Open {app} on your phone.</li>
            <li>{where[account.network] ?? 'Settings → Linked devices → Link new device.'}</li>
            <li>Point the camera at this code. Tap it to fill the screen.</li>
          </ol>
        )}
        {timer && !pairCode && <p class="qr-timer">{timer}</p>}
        {coarsePointer && !wa && <p class="qr-note">A phone can't scan its own screen. If this is the phone you're linking, open this page on a computer.</p>}
        {(wa || tg) && !pairCode && (
          <div class="qr-pair">
            <p class="qr-note">
              {coarsePointer ? "A phone can't scan its own screen. " : ''}
              {wa ? 'Or link with your phone number: WhatsApp then asks you to type a code instead.' : 'Or sign in with your phone number: Telegram sends you a code to type here.'}
            </p>
            <input class="input" type="tel" placeholder="+15551234567" value={phoneNo} onInput={(e) => setPhoneNo((e.target as HTMLInputElement).value)} />
            <button class="btn ghost" disabled={busy || phoneNo.replace(/\D/g, '').length < 7} onClick={pair}>
              {wa ? 'Get a pairing code' : 'Send me a code'}
            </button>
          </div>
        )}
        <button class="btn ghost" disabled={busy} onClick={fresh}>
          <Icon name="refresh" size={15} /> New code
        </button>
      </div>
      {full && svg && (
        <div class="qr-full" role="dialog" aria-label={`${app} link code`} onClick={() => setFull(false)}>
          <div class="qr-full-code" dangerouslySetInnerHTML={{ __html: svg }} />
          <p>{timer} Tap anywhere to close.</p>
        </div>
      )}
    </div>
  );
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const timeLeft = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`;
};

function deviceLabel(v: any): string | null {
  if (v.otherDeviceName && v.otherDevice) return `${v.otherDeviceName} (${v.otherDevice})`;
  return v.otherDevice ? `device ${v.otherDevice}` : null;
}

function endedText(v: any): string {
  const device = deviceLabel(v) ?? 'the other device';
  if (v.outcome === 'mismatch') return 'You said the emoji did not match, so nothing was verified. If they really differed, do not verify: something may be in the way.';
  if (v.outcome === 'timeout') {
    return `${v.cancelledBy === 'them' ? `${device[0].toUpperCase()}${device.slice(1)} gave up waiting` : `Nothing came from ${device} in time`}. After the emoji appear, both sides have to confirm within about a minute, and switching between apps can take longer than that. Nothing was verified.`;
  }
  return `${v.cancelledBy === 'them' ? `Cancelled on ${device}` : 'Cancelled'}: ${v.reason ?? 'no reason given'}. Nothing was verified.`;
}

/** The other side of "verify this device" in another client: accept, compare the emoji, say whether they match. */
function VerifyDevice({ account, verification: v }: { account: P.AccountView; verification: any }) {
  const [busy, setBusy] = useState('');
  const now = useNow(!!v.expiresAt && v.phase !== 'ended');
  const step = async (name: string) => {
    setBusy(name);
    try {
      await api(`/api/accounts/${account.id}/action`, { body: { action: 'verifyDevice', args: { step: name } } });
    } catch (e: any) {
      toast({ kind: 'error', title: 'Verification failed', body: e.message });
    } finally {
      setBusy('');
    }
  };
  const device = deviceLabel(v);
  if (v.phase === 'ended') {
    return (
      <div class="verify-device ended">
        <p class="verify-why">{endedText(v)}</p>
        <p class="det-note">The recovery key on this page verifies this device without a second app.</p>
        <div class="btn-row">
          <button class="btn primary" disabled={!!busy} onClick={() => step('start')}>
            {busy === 'start' ? 'Asking…' : 'Start again'}
          </button>
          <button class="btn ghost" disabled={!!busy} onClick={() => step('dismiss')}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }
  const remaining = v.expiresAt ? v.expiresAt - now : null;
  const sasStep = v.phase === 'compare' || v.phase === 'confirmed';
  const hint =
    v.phase === 'requested'
      ? 'Accept here, then go back to the other app: the emoji show up on both.'
      : v.phase === 'ready'
        ? 'Open the other app: it starts the emoji check. If no emoji appear there, tap “Show emoji”.'
        : v.phase === 'compare'
          ? 'If they are the same, tap “They match” here and in the other app, within a minute of each other.'
          : v.phase === 'confirmed'
            ? 'Now confirm in the other app.'
            : !v.otherDevice
              ? 'Open Element (or another app signed in to this account) and accept the request there.'
              : 'Waiting for the other app…';
  return (
    <div class="verify-device">
      <p class="verify-meta">
        {device && (
          <>
            With <b>{device}</b>.{' '}
          </>
        )}
        {remaining !== null && (
          <span class={`verify-clock${sasStep && remaining < 20_000 ? ' urgent' : ''}`}>{remaining <= 0 ? 'Time is up.' : sasStep ? `${timeLeft(remaining)} left.` : `Expires in ${timeLeft(remaining)}.`}</span>
        )}
      </p>
      {v.phase === 'compare' && (
        <ol class="sas-emoji" aria-label="Emoji to compare">
          {(v.emoji ?? []).map((e: { symbol: string; description: string }) => (
            <li>
              <span class="sas-symbol">{e.symbol}</span>
              <span class="sas-name">{e.description}</span>
            </li>
          ))}
        </ol>
      )}
      <p class="det-note">{hint}</p>
      {v.sending > 0 && <p class="det-note verify-sending">The connection to the homeserver dropped; sending again until it goes through…</p>}
      <div class="btn-row">
        {v.phase === 'requested' && (
          <button class="btn primary" disabled={!!busy} onClick={() => step('accept')}>
            Accept
          </button>
        )}
        {v.phase === 'ready' && (
          <button class="btn ghost" disabled={!!busy} onClick={() => step('sas')}>
            Show emoji
          </button>
        )}
        {v.phase === 'compare' && (
          <button class="btn primary" disabled={!!busy} onClick={() => step('confirm')}>
            They match
          </button>
        )}
        {v.phase === 'compare' ? (
          <button class="btn danger" disabled={!!busy} onClick={() => step('mismatch')}>
            They don't match
          </button>
        ) : (
          <button class="btn ghost" disabled={!!busy} onClick={() => step('cancel')}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function AttentionBlock({ a }: { a: P.AccountView }) {
  const [live, setLive] = useState(false);
  const at = a.attention!;
  const verification = (at.detail as any)?.verification;
  const heading =
    verification
      ? verification.phase === 'ended'
        ? 'Verification did not finish'
        : 'Verify this device'
      : at.kind === 'link_device'
      ? `Link this hub as a ${netName(a.network)} device`
      : at.kind === 'login'
        ? 'Sign in'
        : at.kind === 'captcha'
          ? 'Finish a captcha'
          : at.kind === 'verify'
            ? 'Confirm it is you'
            : at.kind === 'selector_broken'
              ? 'The client changed'
              : 'Needs attention';
  return (
    <div class={`attention ${at.kind}`}>
      <div class="attention-top">
        <Icon name={at.kind === 'link_device' ? 'qr' : at.liveView ? 'monitor' : 'alert'} size={20} />
        <div>
          <b>{heading}</b>
          <p>{at.message}</p>
          <small>since {ago(at.since)}</small>
        </div>
      </div>
      {at.kind === 'link_device' && <LinkCode account={a} at={at} />}
      {verification && <VerifyDevice account={a} verification={verification} />}
      {at.kind === 'verify' && (at.detail as any)?.code && <SignInCode account={a} code={(at.detail as any).code} />}
      {at.kind === 'verify' && typeof (at.detail as any)?.emoji === 'string' && (
        <p class="pair-emoji" aria-label={`Tap ${(at.detail as any).emoji} on your phone`}>
          {(at.detail as any).emoji}
        </p>
      )}
      {at.kind === 'captcha' && !!(at.detail as { captcha?: P.CaptchaCheck } | undefined)?.captcha?.url && <SolveCaptcha account={a} check={(at.detail as { captcha: P.CaptchaCheck }).captcha} />}
      {at.kind === 'login' && !at.liveView && (a.network === 'gmessages' ? <SignInWith account={a} what="cookies" /> : a.network === 'telegram' || a.network === 'matrix' ? <SignInWith account={a} what="password" /> : null)}
      {at.liveView && (
        <button class="btn primary" onClick={() => setLive(true)}>
          <Icon name="monitor" size={15} /> Open live view
        </button>
      )}
      {at.kind === 'selector_broken' && at.detail !== undefined && <pre class="detail-dump">{JSON.stringify(at.detail, null, 2)}</pre>}
      {live && <LiveView account={a} onClose={() => setLive(false)} />}
    </div>
  );
}

/** The cards of what the network wants done (docs/account-self.md): each says it plainly and opens the live view; none is dismissed here. */
function AccountNotices({ a, openLive }: { a: P.AccountView; openLive: () => void }) {
  const notices = a.self?.notices ?? [];
  if (!notices.length) return null;
  return (
    <>
      {notices.map((n) => (
        <div class={`attention notice ${n.kind}`}>
          <div class="attention-top">
            <Icon name={n.kind === 'standing' ? 'alert' : n.kind === 'agreements' ? 'fileText' : 'lock'} size={20} />
            <div>
              <b>{n.title}</b>
              <p>{n.message}</p>
              <small>
                {netName(a.network)} said so {ago(n.since)}. It goes when {netName(a.network)} stops saying it.
              </small>
            </div>
          </div>
          {n.liveView && a.liveView && (
            <button class="btn primary" onClick={openLive}>
              <Icon name="monitor" size={15} /> Open live view
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/** An account action from the attention, with a toast when it fails. */
async function attentionAction(a: P.AccountView, action: string, args?: Record<string, unknown>): Promise<boolean> {
  try {
    await api(`/api/accounts/${a.id}/action`, { body: { action, ...(args ? { args } : {}) } });
    return true;
  } catch (e: any) {
    toast({ kind: 'error', title: 'That did not work', body: e.message });
    return false;
  }
}

/**
 * A captcha to solve in your own browser (Signal's rate-limit challenge): open its page, solve it, and paste the link
 * "Open Signal" points at. Nothing here solves it.
 */
function SolveCaptcha({ account, check }: { account: P.AccountView; check: P.CaptchaCheck }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    if (await attentionAction(account, check.action, { captcha: value.trim() })) {
      setValue('');
      toast({ kind: 'info', title: 'Sent', body: `${netName(account.network)} takes it from here.` });
    }
    setBusy(false);
  };
  return (
    <div class="captcha-solve">
      <p class="det-note">
        Open{' '}
        <a href={check.url} target="_blank" rel="noopener noreferrer">
          the captcha page
        </a>
        , solve it, then copy the link of “Open Signal” (right-click, or long-press on a phone) and paste it here.
      </p>
      <div class="qr-pair">
        <input class="input" autocomplete="off" spellcheck={false} placeholder="signalcaptcha://…" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} aria-label="The captcha link" />
        <button class="btn primary" disabled={busy || !value.trim()} onClick={() => void submit()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

/** Telegram's sign-in by number: the code it sent, again, or back to a QR code. */
function SignInCode({ account, code }: { account: P.AccountView; code: { length?: number; next?: string } }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (action: string, args?: Record<string, unknown>) => {
    setBusy(true);
    if ((await attentionAction(account, action, args)) && action === 'signIn') setValue('');
    setBusy(false);
  };
  const digits = value.replace(/\D/g, '');
  return (
    <div class="qr-pair">
      <input class="input" inputMode="numeric" autocomplete="one-time-code" placeholder={code.length ? '•'.repeat(code.length) : 'Code'} value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} aria-label="The code" />
      <button class="btn primary" disabled={busy || digits.length < (code.length ?? 4)} onClick={() => run('signIn', { code: digits })}>
        Sign in
      </button>
      <button class="btn ghost" disabled={busy} onClick={() => run('resendCode')}>
        Send it again
      </button>
      <button class="btn ghost" disabled={busy} onClick={() => run('refreshLink')}>
        Use a QR code instead
      </button>
    </div>
  );
}

/** A sign-in that lapsed or needs one more step: a password (Telegram's two-step one, Matrix), or Google's cookies (Google Messages). */
function SignInWith({ account, what }: { account: P.AccountView; what: 'password' | 'cookies' }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    if (await attentionAction(account, what === 'cookies' ? 'pairGoogle' : 'relogin', what === 'cookies' ? { cookies: value.trim() } : { password: value })) setValue('');
    setBusy(false);
  };
  return (
    <div class="qr-pair">
      {what === 'cookies' ? (
        <textarea class="input" rows={3} spellcheck={false} placeholder="Cookies of messages.google.com, signed in: “Copy as cURL” from the browser's network tab, a cookie export, or SID=…; HSID=…" value={value} onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)} />
      ) : (
        <input class="input" type="password" autocomplete="current-password" placeholder="Password" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
      )}
      <button class="btn primary" disabled={busy || !value.trim()} onClick={submit}>
        {what === 'cookies' ? 'Pair with Google' : 'Sign in'}
      </button>
    </div>
  );
}

/** Matrix only. Off until asked for: setting it up publishes a new device's keys on the real account. */
function EncryptionSection({ a }: { a: P.AccountView }) {
  const [st, setSt] = useState<any>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [keyError, setKeyError] = useState('');
  const call = (action: string, args?: unknown) => api<{ result: any }>(`/api/accounts/${a.id}/action`, { body: { action, ...(args ? { args } : {}) } }).then((r) => r.result);
  useEffect(() => {
    let dead = false;
    const load = () => call('encryptionStatus').then((s) => !dead && setSt(s), () => !dead && setSt(null));
    load();
    const t = setInterval(load, 5000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [a.id]);
  const act = async (label: string, action: string, args?: unknown) => {
    setBusy(label);
    setKeyError('');
    try {
      setSt(await call(action, args));
      setKey('');
    } catch (e: any) {
      // A recovery key that did not work: say why next to the field, where the user is looking.
      if (label === 'key') setKeyError(String(e.message).replace(/^action failed: /, ''));
      else toast({ kind: 'error', title: 'Encryption', body: e.message });
    } finally {
      setBusy('');
    }
  };
  const keyInput = (
    <input
      class="input"
      type={'password' as 'text'}
      autocomplete="off"
      spellcheck={false}
      placeholder="EsT… or your security phrase"
      value={key}
      onInput={(e) => setKey((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => e.key === 'Enter' && key.trim() && st?.active && act('key', 'addRecoveryKey', { recoveryKey: key.trim() })}
    />
  );
  if (!st) return null;
  if (!st.on || (!st.active && !st.error)) {
    return (
      <section class="det-section">
        <h3>Encryption</h3>
        <p class="det-note">Encrypted rooms and DMs stay unreadable and read-only until you set this up. Setting up adds this hub to your account as a new device, publishes its keys, and your other clients will show it as unverified until you verify it.</p>
        <div class="add-form">
          <label class="field-label">
            Recovery key <span class="muted-label">— optional: from Element (“security key”) or your security phrase. It verifies this device and unlocks old messages. Kept with this account's other secrets on the hub</span>
          </label>
          {keyInput}
        </div>
        <div class="btn-row">
          <button class="btn primary" disabled={!!busy} onClick={() => act('setup', 'setupEncryption', key.trim() ? { recoveryKey: key.trim() } : {})}>
            <Icon name="lock" size={14} /> {busy === 'setup' ? 'Setting up…' : 'Set up encryption'}
          </button>
        </div>
      </section>
    );
  }
  if (!st.active) {
    return (
      <section class="det-section">
        <h3>Encryption</h3>
        <p class="det-note">It is switched on, but not working: {st.error}. Encrypted rooms refuse to send until this is fixed.</p>
      </section>
    );
  }
  const flowOn = st.verification && st.verification.phase !== 'ended';
  const problems: string[] = st.recovery?.problems ?? [];
  return (
    <section class="det-section">
      <h3>Encryption</h3>
      <dl class="kv">
        <dt>This device</dt>
        <dd>{st.deviceId}</dd>
        <dt>Fingerprint</dt>
        <dd>
          <code>{st.fingerprint}</code>
        </dd>
        <dt>Verified</dt>
        <dd>{st.verified ? 'Yes, cross-signed' : 'No. Your other clients show this device as unverified'}</dd>
        <dt>Key backup</dt>
        <dd>{st.backup ? `Connected, version ${st.backup.version}` : 'Not connected. Old messages stay locked until a recovery key or a verified device opens it'}</dd>
        <dt>Room keys</dt>
        <dd>
          {st.roomKeys} here, {st.undecrypted} {st.undecrypted === 1 ? 'message waits' : 'messages wait'} for a key
        </dd>
      </dl>
      {(!st.verified || !st.backup) && (
        <div class="recovery-box">
          <label class="field-label">
            Unlock with your recovery key <span class="muted-label">— the security key Element showed when you set up recovery (48 letters and digits), or your security phrase. It verifies this device and connects the key backup, with no second app needed</span>
          </label>
          {keyInput}
          {(keyError || st.recoveryError) && <p class="form-error">{keyError || st.recoveryError}</p>}
          <div class="btn-row">
            <button class="btn primary" disabled={!!busy || !key.trim()} onClick={() => act('key', 'addRecoveryKey', { recoveryKey: key.trim() })}>
              <Icon name="lock" size={14} /> {busy === 'key' ? 'Checking…' : 'Unlock'}
            </button>
          </div>
        </div>
      )}
      {problems.length > 0 && !st.recoveryError && (
        <ul class="det-note recovery-problems">
          {problems.map((p) => (
            <li>{p}</li>
          ))}
        </ul>
      )}
      {!st.verified && !flowOn && (
        <div class="btn-row">
          <button class="btn ghost" disabled={!!busy || st.hasIdentity === false} title={st.hasIdentity === false ? 'This account has no cross-signing identity yet; set up encryption in Element first' : undefined} onClick={() => act('verify', 'verifyDevice', { step: 'start' })}>
            {busy === 'verify' ? 'Asking…' : 'Or verify with another device'}
          </button>
        </div>
      )}
      {st.lastVerification && st.lastVerification !== 'verified' && !st.verification && <p class="det-note">Last verification did not finish: {st.lastVerification}</p>}
    </section>
  );
}

function LogView({ accountId }: { accountId: string }) {
  const [text, setText] = useState<string | null>(null);
  const load = () => api<string>(`/api/accounts/${accountId}/log`).then(setText, (e) => setText(String(e.message)));
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [accountId]);
  if (text === null) return <Loading inline label="Loading…" />;
  return <pre class="log-view">{text || '(empty)'}</pre>;
}

export function AccountPane({ accountId, onBack }: { accountId: string; onBack?: () => void }) {
  rev.value;
  mailRev.value;
  const row = accountRow(accountId);
  const [showLog, setShowLog] = useState(false);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState('');
  const [purge, setPurge] = useState(false);
  const S = selfParts.value;
  useEffect(() => void loadSelf(), []);
  if (!row)
    return (
      <section class="pane account-pane">
        <div class="account-scroll">
          <p class="det-note">This account is not in the list. One just added shows up as soon as it starts.</p>
        </div>
      </section>
    );
  const a = row.chat;
  const mail = row.mail;
  const mg = row.managed;
  // Its session can go too when dither-accounts holds it; an imported one's session is this hub's, and stays.
  const canPurge = a ? !!a.managedBy && a.managedBy.origin !== 'import' : !!mg && mg.origin !== 'import';
  // An account with no chats here is run through dither-accounts, when it lets this hub.
  const runs = !!a || !!mg?.manages;
  const liveOk = a ? a.liveView : !!mg?.liveView && !!mg.manages;
  const disabled = a ? a.status === 'disabled' : mg ? !mg.enabled : false;
  const page = a?.managedBy?.url ?? mail?.managedUrl ?? db.accountsManager?.url ?? null;
  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(label);
    try {
      await fn();
    } catch (e: any) {
      toast({ kind: 'error', title: 'Action failed', body: e.message });
    } finally {
      setBusy('');
    }
  };
  const seen = a && {
    spaces: [...db.spaces.values()].filter((s) => s.accountIds.includes(a.id)).length,
    convs: [...db.conversations.values()].filter((c) => c.vantages.some((v) => v.accountId === a.id)).length,
  };
  return (
    <section class="pane account-pane" data-account-pane={row.id}>
      <header class="conv-head">
        {onBack && (
          <button class="icon-btn back" data-track="pager: back button" onClick={onBack} aria-label="Back">
            <Icon name="back" />
          </button>
        )}
        <span class="conv-head-icon">
          <KindBadge kind={row.kind} size={34} />
        </span>
        <div class="conv-head-text">
          <h2>
            {row.platform} · {row.name}
          </h2>
          <div class="conv-head-sub">
            <span class={`status-pill ${row.status.status}`}>{row.status.label}</span>
            <span class="muted-label">{a ? `added ${ago(a.createdAt)}` : mg?.origin === 'self' ? 'added from here' : mg ? 'added on dither-accounts' : ''}</span>
          </div>
        </div>
      </header>
      <div class="account-scroll">
        <FeatureStrip row={row} />
        {a?.attention && <AttentionBlock a={a} />}
        {/* What the network wants done, its status, folders and sessions (AccountSelf.tsx). */}
        {a && <AccountNotices a={a} openLive={() => setLive(true)} />}
        {mail && <MailAccountSection a={mail} openLive={liveOk ? () => setLive(true) : undefined} />}
        {!a && !mail && row.features.some((f) => f.feature === 'notices' && f.state !== 'off') && (
          <section class="det-section">
            <h3>Notices</h3>
            <p class="det-note">
              What it tells you shows under Notices, ranked with your chats.{' '}
              <button class="link-btn" onClick={() => go({ view: 'notices' })}>
                Open Notices
              </button>
            </p>
          </section>
        )}
        {a && seen && (
          <section class="det-section">
            <h3>Connection</h3>
            <dl class="kv">
              <dt>Network</dt>
              <dd>{netName(a.network)}</dd>
              <dt>Label</dt>
              <dd>{a.label}</dd>
              <dt>Status</dt>
              <dd>{STATUS[a.status]}</dd>
              {a.network === 'calendar' && (
                <>
                  <dt>Calendar at</dt>
                  <dd>{a.url ?? 'no address'}</dd>
                </>
              )}
              <dt>Runs in</dt>
              <dd>
                {a.managedBy ? (
                  <>
                    dither-accounts
                    {a.managedBy.url && (
                      <>
                        {' · '}
                        <a href={a.managedBy.url} target="_blank" rel="noopener">
                          its page there
                        </a>
                      </>
                    )}
                  </>
                ) : (
                  'this hub'
                )}
              </dd>
              <dt>Carries</dt>
              <dd>
                {seen.spaces} {seen.spaces === 1 ? 'space' : 'spaces'} · {seen.convs} {seen.convs === 1 ? 'conversation' : 'conversations'}
              </dd>
              <dt>Can</dt>
              <dd class="caps">
                {a.capabilities.map((c) => (
                  <span class="cap">{c}</span>
                ))}
              </dd>
            </dl>
          </section>
        )}
        {a?.network === 'matrix' && !a.demo && <EncryptionSection a={a} />}
        {a?.network === 'telegram' && !a.demo && <TelegramSignIns a={a} />}
        {a?.capabilities.includes('stories') && <StoriesSetting a={a} />}
        {a && S && <S.AccountSelfSection a={a} openLive={() => setLive(true)} />}
        {a && <ImportsSection a={a} />}
        <section class="det-section">
          <h3>Controls</h3>
          {runs ? (
            <div class="btn-row">
              <button class="btn ghost" disabled={!!busy} onClick={() => act(() => api(`/api/accounts/${row.id}/action`, { body: { action: 'restart' } }), 'restart')}>
                <Icon name="refresh" size={14} /> {busy === 'restart' ? 'Restarting…' : a ? 'Restart adapter' : 'Restart'}
              </button>
              <button class="btn ghost" disabled={!!busy} onClick={() => act(() => api(`/api/accounts/${row.id}`, { method: 'PATCH', body: { enabled: disabled } }), 'toggle')}>
                <Icon name="power" size={14} /> {disabled ? 'Enable' : 'Disable'}
              </button>
              <button class="btn ghost" onClick={() => setShowLog(!showLog)}>
                <Icon name="panel" size={14} /> {showLog ? 'Hide log' : a ? 'Adapter log' : 'Its log'}
              </button>
              {liveOk && (
                <button class="btn ghost" onClick={() => setLive(true)}>
                  <Icon name="monitor" size={14} /> Live view
                </button>
              )}
            </div>
          ) : (
            <p class="det-note">
              dither-accounts runs it, and has not let dither-chat start, stop or remove it.{' '}
              {page && (
                <a href={page} target="_blank" rel="noopener">
                  Open it there
                </a>
              )}
            </p>
          )}
          {live && <LiveView account={{ id: row.id, label: row.name, network: row.network, kind: row.kind }} onClose={() => setLive(false)} />}
          {showLog && <LogView accountId={row.id} />}
        </section>
        {runs && (
          <section class="det-section danger">
            <h3>Remove</h3>
            <p class="det-note">
              {a
                ? `Disconnects the adapter and drops anything only this account could see. The account on ${netName(a.network)} itself is untouched.`
                : `Stops it and removes it from dither-accounts. Its mail here goes a day later; the account at ${row.platform} itself is untouched.`}
            </p>
            {canPurge && (
              <label class="toggle-row">
                <input type="checkbox" checked={purge} onChange={(e) => setPurge((e.target as HTMLInputElement).checked)} />
                <span>
                  <b>Also delete its session</b>
                  <small>
                    Unticked, dither-accounts keeps the session, so the account can come back without signing in again.
                    {(a?.network === 'signal' || a?.network === 'whatsapp') && ' Deleting it does not unlink this device on your phone: do that there too.'}
                  </small>
                </span>
              </label>
            )}
            <button
              class="btn danger"
              disabled={!!busy}
              onClick={() => {
                const doPurge = canPurge && purge;
                if (confirm(`Remove the ${row.platform} account “${row.name}” from dither-chat${doPurge ? ', and delete its session' : ''}?`))
                  act(async () => {
                    await api(`/api/accounts/${row.id}${doPurge ? '?purge=1' : ''}`, { method: 'DELETE' });
                    go({ view: 'accounts' });
                  }, 'delete');
              }}
            >
              <Icon name="trash" size={14} /> Remove account
            </button>
          </section>
        )}
      </div>
    </section>
  );
}

