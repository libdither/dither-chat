import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { accountRows, kindName, type AccountRow } from '../accountrows.ts';
import { netName } from '../model.ts';
import { api, db, go, mailRev, rev } from '../state.ts';
import { useLayer } from '../phone.ts';
import { AccountChip, Modal } from './bits.tsx';
import { FeatureIcons, KindBadge } from './AccountFeatures.tsx';
import { Icon } from './icons.tsx';
import { MailAccessNote } from './mail/MailAccounts.tsx';
import { Loading } from './Loader.tsx';

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

/** The one list (docs/accounts.md "One list"): every account this hub uses, chats, mail or notices alike. */
export function AccountsSidebar({ active, onAdd }: { active?: string; onAdd: () => void }) {
  rev.value;
  mailRev.value;
  const rows = accountRows();
  const mgr = db.accountsManager;
  const mailWaits = db.mail.access.state !== 'off' && db.mail.access.state !== 'granted';
  return (
    <div class="sidebar-inner">
      <header class="side-head">
        <h1>Accounts</h1>
        <span class="side-sub">
          {mgr ? (
            <>
              Each account runs in{' '}
              {mgr.url ? (
                <a href={mgr.url} target="_blank" rel="noopener">
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
        {mgr?.reachable === false && <p class="acc-note">dither-accounts is not answering. What it runs keeps running; this list is what it last said.</p>}
        {mailWaits && (
          <div class="acc-note">
            <MailAccessNote />
          </div>
        )}
        {rows.map((r) => (
          <button class={`row acc-row ${r.id === active ? 'active' : ''}`} data-account={r.id} data-kind={r.kind} onClick={() => go({ view: 'accounts', account: r.id })}>
            <span class="row-avatar">
              <KindBadge kind={r.kind} size={30} />
            </span>
            <span class="row-main">
              <span class="row-top">
                <span class="row-title">
                  <RowName row={r} />
                </span>
                <span class={`status-pill ${r.status.status}`}>{r.status.label}</span>
              </span>
              <span class="row-bottom">
                <span class="row-preview">
                  {r.platform}
                  {r.note ? ` · ${r.note}` : ''}
                </span>
                <FeatureIcons row={r} />
              </span>
            </span>
          </button>
        ))}
        <button class="add-btn" onClick={onAdd}>
          <Icon name="plus" size={16} /> Add account
        </button>
      </div>
    </div>
  );
}

/** A row's name with its colour: a chat account's chip (with its menu), else the same look. */
export function RowName({ row }: { row: AccountRow }) {
  if (row.chat) return <AccountChip account={row.chat} small />;
  return (
    <span class="acc-chip small" title={`${row.platform} account “${row.name}”`}>
      <span class="acc-dot" style={{ background: row.color }} />
      {row.name}
    </span>
  );
}

const XK = { CONTROL: 0xffe3, V: 0x76, SUPER_L: 0xffeb };

const liveName = (t: LiveTarget) => (t.network ? netName(t.network) : kindName(t.kind ?? 'email'));

/** What a live view shows: a chat account, or an account dither-accounts runs for mail (its kind, then). */
export type LiveTarget = { id: string; label: string; network?: P.Network | null; kind?: string };

export function LiveView({ account, onClose }: { account: LiveTarget; onClose: () => void }) {
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
    <div class="lv-full" role="dialog" aria-label={`Live view of ${liveName(account)} ${account.label}`}>
      <header class="lv-bar">
        <span class="lv-title">
          <KindBadge kind={account.network ?? account.kind ?? 'email'} size={18} />
          <span class="lv-name">
            {liveName(account)} {account.label}
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
/** An account's page (AccountPane.tsx): a chunk of its own, loaded the first time one opens. */
type PaneChunk = typeof import('./AccountPane.tsx');
const paneChunk = signal<PaneChunk | null>(null);
let paneLoading: Promise<unknown> | null = null;
const loadPane = () => (paneLoading ??= import('./AccountPane.tsx').then((m) => (paneChunk.value = m), () => (paneLoading = null)));

export function AccountPane(props: { accountId: string; onBack?: () => void }) {
  const C = paneChunk.value;
  useEffect(() => void loadPane(), []);
  if (!C)
    return (
      <section class="pane account-pane">
        <Loading label="Loading…" />
      </section>
    );
  return <C.AccountPane {...props} />;
}

/** Add account (AddAccount.tsx): a chunk of its own, loaded the first time it opens. */
type AddChunk = typeof import('./AddAccount.tsx');
const addChunk = signal<AddChunk | null>(null);
let addLoading: Promise<unknown> | null = null;
const loadAdd = () => (addLoading ??= import('./AddAccount.tsx').then((m) => (addChunk.value = m), () => (addLoading = null)));

export function AddAccount({ onClose }: { onClose: () => void }) {
  const C = addChunk.value;
  useEffect(() => void loadAdd(), []);
  if (!C)
    return (
      <Modal title="Add an account" onClose={onClose}>
        <Loading inline label="Loading…" />
      </Modal>
    );
  return <C.AddAccount onClose={onClose} />;
}
