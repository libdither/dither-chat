import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, NETWORKS } from '@dither-chat/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { renderSVG } from 'uqr';
import { ago } from '../format.ts';
import { netName } from '../model.ts';
import { api, db, go, mailRev, prefs, rev, toast } from '../state.ts';
import { dropLayer, pushLayer, useLayer } from '../phone.ts';
import { AccountChip, Modal, NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';
import { ImportsSection } from './Imports.tsx';
import { TelegramSignIns } from './TelegramSignIns.tsx';
import { MailAccountRows } from './mail/MailAccounts.tsx';
import { MailAccessNote } from './mail/MailSidebar.tsx';

/** The add-account dialog, opened from the accounts list or from settings. */
export const addingAccount = signal(false);

export const STATUS: Record<P.AccountStatus, string> = {
  online: 'Online',
  connecting: 'Connecting',
  attention: 'Needs you',
  offline: 'Offline',
  error: 'Error',
  disabled: 'Disabled',
};

export function AccountsSidebar({ active, onAdd }: { active?: string; onAdd: () => void }) {
  rev.value;
  mailRev.value;
  const accounts = [...db.accounts.values()];
  return (
    <div class="sidebar-inner">
      <header class="side-head">
        <h1>Accounts</h1>
        <span class="side-sub">
          {db.accountsManager ? (
            <>
              Each account runs in{' '}
              {db.accountsManager.url ? (
                <a href={db.accountsManager.url} target="_blank" rel="noopener">
                  dither-accounts
                </a>
              ) : (
                'dither-accounts'
              )}
            </>
          ) : (
            'Each account runs in its own adapter on this hub'
          )}
        </span>
      </header>
      <div class="side-scroll">
        {accounts.map((a) => (
          <button class={`row acc-row ${a.id === active ? 'active' : ''}`} onClick={() => go({ view: 'accounts', account: a.id })}>
            <span class="row-avatar">
              <NetBadge network={a.network} size={30} />
            </span>
            <span class="row-main">
              <span class="row-top">
                <span class="row-title">
                  <AccountChip account={a} small />
                </span>
                <span class={`status-pill ${a.status}`}>{STATUS[a.status]}</span>
              </span>
              <span class="row-bottom">
                <span class="row-preview">
                  {netName(a.network)}
                  {a.demo ? ' · demo data' : ''}
                  {a.attention ? ` · ${a.attention.message}` : ''}
                </span>
              </span>
            </span>
          </button>
        ))}
        <button class="add-btn" onClick={onAdd}>
          <Icon name="plus" size={16} /> Add account
        </button>
        {db.mail.access.state !== 'off' && (
          <section class="acc-mail-group" aria-label="Mail">
            <h2 class="acc-group-head">Mail</h2>
            <MailAccessNote />
            <MailAccountRows />
          </section>
        )}
      </div>
    </div>
  );
}

/** Black on white with a four-module quiet zone and square edges, the way phone scanners want it. */
function qrSvg(text: string) {
  return renderSVG(text, { ecc: 'M', border: 4, whiteColor: '#ffffff', blackColor: '#000000' }).replace('<svg ', '<svg shape-rendering="crispEdges" ');
}

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

const XK = { CONTROL: 0xffe3, V: 0x76, SUPER_L: 0xffeb };

export function LiveView({ account, onClose }: { account: P.AccountView; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [state, setState] = useState('connecting');
  const [fit, setFit] = useState(true);
  const [text, setText] = useState('');
  const [show, setShow] = useState(false);
  useLayer(onClose);

  /** Put text on the sandbox's clipboard and press Ctrl+V there, into whichever field has focus. */
  const sendText = (value: string, cmdHeld = false) => {
    const rfb = rfbRef.current;
    if (!rfb || !value) return;
    // The VNC clipboard only carries Latin-1, and anything else would arrive as "?". Press those keys instead.
    if (/[^\x00-\xff]/.test(value)) {
      for (const ch of value) {
        const cp = ch.codePointAt(0)!;
        const sym = ch === '\n' ? 0xff0d : cp < 0x100 ? cp : 0x01000000 + cp;
        rfb.sendKey(sym, '', true);
        rfb.sendKey(sym, '', false);
      }
      return;
    }
    rfb.clipboardPasteFrom(value);
    // The clipboard has to arrive first. On a Mac the Cmd key is down in the sandbox too, and would make this a different shortcut.
    setTimeout(() => {
      if (cmdHeld) rfb.sendKey(XK.SUPER_L, 'MetaLeft', false);
      rfb.sendKey(XK.CONTROL, 'ControlLeft', true);
      rfb.sendKey(XK.V, 'KeyV', true);
      rfb.sendKey(XK.V, 'KeyV', false);
      rfb.sendKey(XK.CONTROL, 'ControlLeft', false);
      rfb.focus();
    }, 150);
    // It may be a password: do not leave it on the sandbox's clipboard. x11vnc ignores empty text, hence the space.
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => rfbRef.current?.clipboardPasteFrom(' '), 2000);
  };

  useEffect(() => {
    let dead = false;
    const el = box.current;
    // noVNC swallows every key, so the browser never gets as far as pasting. Let Ctrl+V through, and take the paste.
    let cmdHeld = false;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        cmdHeld = e.metaKey;
        e.stopPropagation();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      sendText(e.clipboardData?.getData('text/plain') ?? '', cmdHeld);
      cmdHeld = false;
    };
    el?.addEventListener('keydown', onKey, true);
    el?.addEventListener('paste', onPaste, true);
    (async () => {
      // noVNC uses top-level await; load it only when a live view is opened.
      const { default: RFB } = await import('@novnc/novnc');
      if (dead || !el) return;
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/liveview/${account.id}`;
      const rfb: any = new RFB(el, url, { wsProtocols: ['binary'] });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.addEventListener('connect', () => {
        setState('connected');
        rfb.focus();
      });
      rfb.addEventListener('disconnect', (e: any) => setState(e.detail?.clean ? 'closed' : 'disconnected'));
      rfbRef.current = rfb;
    })().catch((e) => setState('error: ' + e.message));
    return () => {
      dead = true;
      clearTimeout(clearTimer.current);
      el?.removeEventListener('keydown', onKey, true);
      el?.removeEventListener('paste', onPaste, true);
      try {
        rfbRef.current?.clipboardPasteFrom(' ');
        rfbRef.current?.disconnect();
      } catch {}
      rfbRef.current = null;
    };
  }, [account.id]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.scaleViewport = fit;
    rfb.clipViewport = !fit;
    rfb.dragViewport = !fit;
  }, [fit]);

  const submit = () => {
    sendText(text);
    setText('');
    setShow(false);
  };

  return (
    <div class="lv-full" role="dialog" aria-label={`Live view of ${netName(account.network)} ${account.label}`}>
      <header class="lv-bar">
        <span class="lv-title">
          <NetBadge network={account.network} size={18} />
          <span class="lv-name">
            {netName(account.network)} {account.label}
          </span>
          <span class={`lv-state ${state}`}>{state}</span>
        </span>
        <form
          class="lv-paste"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          title="Click a field in the sandbox first. Ctrl+V also works there directly."
        >
          <input
            type={(show ? 'text' : 'password') as 'text'}
            value={text}
            autocomplete="off"
            placeholder="Paste or type, then Send"
            aria-label="Text to paste into the sandbox"
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
          />
          <button type="button" class="icon-btn small" title={show ? 'Hide' : 'Show'} aria-label={show ? 'Hide text' : 'Show text'} onClick={() => setShow(!show)}>
            <Icon name="eye" size={15} />
          </button>
          <button type="submit" class="btn" disabled={!text || state !== 'connected'}>
            Send
          </button>
        </form>
        <button class="btn ghost lv-fit" onClick={() => setFit(!fit)} title={fit ? 'Show at actual size, and drag to move around' : 'Fit the whole screen in the window'}>
          {fit ? 'Actual size' : 'Fit'}
        </button>
        <button class="icon-btn" onClick={onClose} aria-label="Close live view" title="Close">
          <Icon name="x" size={18} />
        </button>
      </header>
      <div class="lv-screen" ref={box} />
    </div>
  );
}

/** A clock for countdowns, ticking once a second while `on`. */
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
  const [text, setText] = useState('Loading…');
  const load = () => api<string>(`/api/accounts/${accountId}/log`).then(setText, (e) => setText(String(e.message)));
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [accountId]);
  return <pre class="log-view">{text || '(empty)'}</pre>;
}

export function AccountPane({ accountId, onBack }: { accountId: string; onBack?: () => void }) {
  rev.value;
  const a = db.accounts.get(accountId);
  const [showLog, setShowLog] = useState(false);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState('');
  const [purge, setPurge] = useState(false);
  if (!a) return null;
  const m = a.managedBy;
  // Its session can go too when dither-accounts holds it; an imported one's session is this hub's, and stays.
  const canPurge = !!m && m.origin !== 'import';
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
  const seen = {
    spaces: [...db.spaces.values()].filter((s) => s.accountIds.includes(a.id)).length,
    convs: [...db.conversations.values()].filter((c) => c.vantages.some((v) => v.accountId === a.id)).length,
  };
  return (
    <section class="pane account-pane">
      <header class="conv-head">
        {onBack && (
          <button class="icon-btn back" onClick={onBack} aria-label="Back">
            <Icon name="back" />
          </button>
        )}
        <span class="conv-head-icon">
          <NetBadge network={a.network} size={34} />
        </span>
        <div class="conv-head-text">
          <h2>
            {netName(a.network)} · {a.label}
          </h2>
          <div class="conv-head-sub">
            <span class={`status-pill ${a.status}`}>{STATUS[a.status]}</span>
            <span class="muted-label">{a.capabilities.length} capabilities · added {ago(a.createdAt)}</span>
          </div>
        </div>
      </header>
      <div class="account-scroll">
        {a.attention && <AttentionBlock a={a} />}
        <section class="det-section">
          <h3>Connection</h3>
          <dl class="kv">
            <dt>Network</dt>
            <dd>{netName(a.network)}</dd>
            <dt>Label</dt>
            <dd>{a.label}</dd>
            <dt>Status</dt>
            <dd>{STATUS[a.status]}</dd>
            <dt>Runs in</dt>
            <dd>
              {m ? (
                <>
                  dither-accounts
                  {m.url && (
                    <>
                      {' · '}
                      <a href={m.url} target="_blank" rel="noopener">
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
        {a.network === 'matrix' && !a.demo && <EncryptionSection a={a} />}
        {a.network === 'telegram' && !a.demo && <TelegramSignIns a={a} />}
        <ImportsSection a={a} />
        <section class="det-section">
          <h3>Controls</h3>
          <div class="btn-row">
            <button class="btn ghost" disabled={!!busy} onClick={() => act(() => api(`/api/accounts/${a.id}/action`, { body: { action: 'restart' } }), 'restart')}>
              <Icon name="refresh" size={14} /> {busy === 'restart' ? 'Restarting…' : 'Restart adapter'}
            </button>
            <button
              class="btn ghost"
              disabled={!!busy}
              onClick={() => act(() => api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { enabled: a.status === 'disabled' } }), 'toggle')}
            >
              <Icon name="power" size={14} /> {a.status === 'disabled' ? 'Enable' : 'Disable'}
            </button>
            <button class="btn ghost" onClick={() => setShowLog(!showLog)}>
              <Icon name="panel" size={14} /> {showLog ? 'Hide log' : 'Adapter log'}
            </button>
            {a.liveView && (
              <button class="btn ghost" onClick={() => setLive(true)}>
                <Icon name="monitor" size={14} /> Live view
              </button>
            )}
          </div>
          {live && <LiveView account={a} onClose={() => setLive(false)} />}
          {showLog && <LogView accountId={a.id} />}
        </section>
        <section class="det-section danger">
          <h3>Remove</h3>
          <p class="det-note">Disconnects the adapter and drops anything only this account could see. The account on {netName(a.network)} itself is untouched.</p>
          {canPurge && (
            <label class="toggle-row">
              <input type="checkbox" checked={purge} onChange={(e) => setPurge((e.target as HTMLInputElement).checked)} />
              <span>
                <b>Also delete its session</b>
                <small>
                  Unticked, dither-accounts keeps the session, so the account can come back without signing in again.
                  {(a.network === 'signal' || a.network === 'whatsapp') && ' Deleting it does not unlink this device on your phone: do that there too.'}
                </small>
              </span>
            </label>
          )}
          <button
            class="btn danger"
            disabled={!!busy}
            onClick={() => {
              const doPurge = canPurge && purge;
              if (confirm(`Remove the ${netName(a.network)} account “${a.label}” from dither-chat${doPurge ? ', and delete its session' : ''}?`))
                act(async () => {
                  await api(`/api/accounts/${a.id}${doPurge ? '?purge=1' : ''}`, { method: 'DELETE' });
                  go({ view: 'accounts' });
                }, 'delete');
            }}
          >
            <Icon name="trash" size={14} /> Remove account
          </button>
        </section>
      </div>
    </section>
  );
}

const NET_HELP: Record<P.Network, { adapter: string; blurb: string; fields: { key: string; label: string; placeholder?: string; secret?: boolean; optional?: boolean }[]; config?: string[] }> = {
  discord: {
    adapter: 'discord',
    blurb: 'Runs the real Discord web client in a sandbox on the hub. After you add it, open the live view and sign in there once; dither-chat drives it from the inside, the way Vencord does.',
    fields: [],
  },
  signal: {
    adapter: 'signal',
    blurb: 'Links this hub as another Signal device through signal-cli. After you add it, scan the QR code with your phone. Your primary phone stays in charge.',
    fields: [],
  },
  matrix: {
    adapter: 'matrix',
    blurb: 'Talks to your homeserver with the Matrix API directly — no browser, no bridge.',
    fields: [
      { key: 'userId', label: 'User ID', placeholder: '@you:matrix.org' },
      { key: 'password', label: 'Password', secret: true },
    ],
    config: ['homeserver'],
  },
  whatsapp: {
    adapter: 'whatsapp',
    blurb: 'Links this hub as another WhatsApp device, like WhatsApp Web. After you add it, scan the QR code with your phone, or ask for a pairing code. Your phone stays in charge; open WhatsApp on it at least every two weeks or the link lapses.',
    fields: [],
  },
  // These two run only in dither-accounts (docs/accounts.md).
  telegram: {
    adapter: 'telegram',
    blurb: "Signs in to Telegram as you, as another device the way Telegram Desktop does. Leave api_id and api_hash empty to use Telegram Desktop's own app, or give both from an app of your own (my.telegram.org, API development tools), which is what Telegram's terms ask for. After you add it, scan the QR code with Telegram on your phone, or sign in with your number and the code Telegram sends.",
    fields: [
      { key: 'apiId', label: 'api_id', placeholder: "empty: Telegram Desktop's", optional: true },
      { key: 'apiHash', label: 'api_hash', placeholder: "empty: Telegram Desktop's", secret: true, optional: true },
      { key: 'testDc', label: "Telegram's test servers", placeholder: 'yes, for a test account; else leave empty', optional: true },
    ],
  },
  gmessages: {
    adapter: 'gmessages',
    blurb: 'Pairs with Google Messages on your Android phone, like messages.google.com: your texts (SMS and RCS) go through the phone, which must stay on and online. After you add it, scan the QR code under Device pairing in Messages. If your phone has no QR scanner there any more, paste the cookies of messages.google.com (signed in) below instead, and tap the emoji your phone shows.',
    fields: [{ key: 'cookies', label: 'Google cookies', placeholder: '“Copy as cURL” of messages.google.com, or SID=…; HSID=…', secret: true, optional: true }],
  },
  // These three run in dither-accounts, in a sandboxed browser hooked into the real web app.
  messenger: {
    adapter: 'messenger',
    blurb: 'Runs Messenger in a sandboxed browser in dither-accounts. After you add it, open its live view and sign in to Facebook as on your desktop.',
    fields: [],
  },
  instagram: {
    adapter: 'instagram',
    blurb: 'Runs Instagram in a sandboxed browser in dither-accounts. After you add it, open its live view and sign in to Instagram as on your desktop.',
    fields: [],
  },
  x: {
    adapter: 'x',
    blurb: 'Runs X in a sandboxed browser in dither-accounts, for your direct messages. After you add it, open its live view and sign in to X as on your desktop.',
    fields: [],
  },
  // Not offered here: mail accounts are added on dither-accounts' page (Mail, below the chat accounts).
  email: {
    adapter: 'imap',
    blurb: 'Mail accounts (IMAP, or Proton Mail) are added on the dither-accounts page; they show up here under Mail.',
    fields: [],
  },
};

export function AddAccount({ onClose }: { onClose: () => void }) {
  rev.value;
  const [network, setNetwork] = useState<P.Network>('discord');
  const [label, setLabel] = useState('');
  const [homeserver, setHomeserver] = useState('https://matrix.org');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const help = NET_HELP[network];
  const submit = async () => {
    setBusy(true);
    try {
      const secret: Record<string, string> = {};
      for (const f of help.fields) if (fields[f.key]) secret[f.key] = fields[f.key];
      const account = await api<P.AccountView>('/api/accounts', {
        body: {
          network,
          adapter: help.adapter,
          label: label.trim() || undefined,
          config: network === 'matrix' ? { homeserver } : {},
          secret,
        },
      });
      toast({ kind: 'info', title: 'Account added', body: `${netName(network)} · ${account.label}. Finish setup from its page.` });
      onClose();
      go({ view: 'accounts', account: account.id });
    } catch (e: any) {
      toast({ kind: 'error', title: 'Could not add account', body: e.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Add an account" onClose={onClose}>
      <div class="add-form">
        <label class="field-label">Network</label>
        <div class="net-pick">
          {NETWORKS.map((n) => (
            <button class={`net-opt ${network === n ? 'on' : ''}`} style={{ '--net': NETWORK_META[n].color } as any} onClick={() => setNetwork(n)}>
              <NetBadge network={n} size={22} />
              {netName(n)}
            </button>
          ))}
        </div>
        <p class="add-blurb">{help.blurb}</p>
        {db.accountsManager && (
          <p class="add-note">
            <Icon name="info" size={14} /> It runs in dither-accounts
            {db.accountsManager.url ? (
              <>
                , so you can also add it on{' '}
                <a href={db.accountsManager.url} target="_blank" rel="noopener">
                  its page
                </a>
                .
              </>
            ) : (
              '.'
            )}
          </p>
        )}
        <label class="field-label">
          Label <span class="muted-label">— how you tell two accounts on {netName(network)} apart</span>
        </label>
        <input class="input" placeholder={network === 'discord' ? 'main / alt' : network === 'signal' || network === 'whatsapp' ? 'personal' : 'matrix.org'} value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
        {network === 'matrix' && (
          <>
            <label class="field-label">Homeserver</label>
            <input class="input" value={homeserver} onInput={(e) => setHomeserver((e.target as HTMLInputElement).value)} />
          </>
        )}
        {help.fields.map((f) => (
          <>
            <label class="field-label">
              {f.label} {f.optional && <span class="muted-label">— optional</span>}
            </label>
            <input
              class="input"
              type={(f.secret ? 'password' : 'text') as 'text'}
              placeholder={f.placeholder}
              value={fields[f.key] ?? ''}
              onInput={(e) => setFields({ ...fields, [f.key]: (e.target as HTMLInputElement).value })}
            />
          </>
        ))}
        {help.fields.length === 0 && network !== 'matrix' && (
          <p class="add-note">
            <Icon name="info" size={14} /> No credentials to type here. You finish signing in on the account's page after it is added.
          </p>
        )}
        <div class="modal-actions">
          <button class="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={busy} onClick={submit}>
            {busy ? 'Adding…' : 'Add account'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
