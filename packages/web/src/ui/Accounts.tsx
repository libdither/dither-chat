import type * as P from '@dither-chat/protocol';
import { NETWORK_META, NETWORKS } from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { renderSVG } from 'uqr';
import { ago } from '../format.ts';
import { netName } from '../model.ts';
import { api, db, go, prefs, rev, toast } from '../state.ts';
import { AccountChip, Modal, NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';

const STATUS: Record<P.AccountStatus, string> = {
  online: 'Online',
  connecting: 'Connecting',
  attention: 'Needs you',
  offline: 'Offline',
  error: 'Error',
  disabled: 'Disabled',
};

export function AccountsSidebar({ active, onAdd }: { active?: string; onAdd: () => void }) {
  rev.value;
  const accounts = [...db.accounts.values()].filter((a) => prefs.value.showDemo || !a.demo);
  return (
    <div class="sidebar-inner">
      <header class="side-head">
        <h1>Accounts</h1>
        <span class="side-sub">Each account runs in its own adapter on this hub</span>
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
      </div>
    </div>
  );
}

function Qr({ text }: { text: string }) {
  const svg = renderSVG(text, { border: 2, whiteColor: '#ffffff', blackColor: '#000000' });
  return <div class="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function LiveView({ account, onClose }: { account: P.AccountView; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState('connecting');
  useEffect(() => {
    let rfb: any;
    let dead = false;
    (async () => {
      // noVNC uses top-level await; load it only when a live view is opened.
      const { default: RFB } = await import('@novnc/novnc');
      if (dead || !box.current) return;
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/liveview/${account.id}`;
      rfb = new RFB(box.current, url, { wsProtocols: ['binary'] });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.addEventListener('connect', () => setState('connected'));
      rfb.addEventListener('disconnect', (e: any) => setState(e.detail?.clean ? 'closed' : 'disconnected'));
    })().catch((e) => setState('error: ' + e.message));
    return () => {
      dead = true;
      try {
        rfb?.disconnect();
      } catch {}
    };
  }, [account.id]);
  return (
    <Modal
      wide
      onClose={onClose}
      title={
        <span class="lv-title">
          <NetBadge network={account.network} size={18} /> Live view · {netName(account.network)} {account.label}
          <span class={`lv-state ${state}`}>{state}</span>
        </span>
      }
    >
      <p class="lv-help">
        This is the real {netName(account.network)} client running in this account's sandbox on the hub. Finish whatever it is asking for here, and dither-chat
        carries on from there. Keyboard input goes to the sandbox while this view has focus.
      </p>
      <div class="lv-screen" ref={box} />
    </Modal>
  );
}

function AttentionBlock({ a }: { a: P.AccountView }) {
  const [live, setLive] = useState(false);
  const at = a.attention!;
  const heading =
    at.kind === 'link_device'
      ? 'Link this hub as a Signal device'
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
      {at.qr && (
        <div class="attention-qr">
          <Qr text={at.qr} />
          <ol>
            <li>Open Signal on your phone.</li>
            <li>Settings → Linked devices → Link new device.</li>
            <li>Scan this code. It refreshes on its own when it expires.</li>
          </ol>
        </div>
      )}
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
  const [busy, setBusy] = useState('');
  if (!a) return null;
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
            <dt>Carries</dt>
            <dd>
              {seen.spaces} spaces · {seen.convs} conversations
            </dd>
            <dt>Can</dt>
            <dd class="caps">
              {a.capabilities.map((c) => (
                <span class="cap">{c}</span>
              ))}
            </dd>
          </dl>
        </section>
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
          </div>
          {showLog && <LogView accountId={a.id} />}
        </section>
        <section class="det-section danger">
          <h3>Remove</h3>
          <p class="det-note">Disconnects the adapter and drops anything only this account could see. The account on {netName(a.network)} itself is untouched.</p>
          <button
            class="btn danger"
            disabled={!!busy}
            onClick={() => {
              if (confirm(`Remove the ${netName(a.network)} account “${a.label}” from dither-chat?`))
                act(async () => {
                  await api(`/api/accounts/${a.id}`, { method: 'DELETE' });
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
};

export function AddAccount({ onClose }: { onClose: () => void }) {
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
        <label class="field-label">
          Label <span class="muted-label">— how you tell two accounts on {netName(network)} apart</span>
        </label>
        <input class="input" placeholder={network === 'discord' ? 'main / alt' : network === 'signal' ? 'personal' : 'matrix.org'} value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
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
