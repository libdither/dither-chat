/**
 * Add account (docs/accounts.md, "Adding mail"): the chat networks and dither-accounts' other kinds side by side, each
 * tile with the icons of what an account of it can do here. A chunk of its own (Accounts.tsx loads it when it opens).
 */
import type * as P from '@dither-chat/protocol';
import { CALENDAR_URL_DEFAULT, kindFeatures, NETWORK_FEATURES, NETWORK_META, NETWORKS } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { isNetwork, KIND_META } from '../accountrows.ts';
import { netName } from '../model.ts';
import { api, db, go, rev, toast } from '../state.ts';
import { featureLabel, KindBadge } from './AccountFeatures.tsx';
import { Modal, NetBadge } from './bits.tsx';
import { Icon } from './icons.tsx';

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
  // Runs only in dither-accounts, beside T3 Code on the same machine (its docs/t3.md).
  t3: {
    adapter: 't3',
    blurb: "Shows T3 Code's coding threads as chats: each thread a conversation with its agent, under its project, and what you write goes to the thread as its next turn. It runs in dither-accounts on the machine T3 Code runs on, through T3's own command line, and needs nothing to sign in. Which projects it shows is set on dither-accounts' page (all by default).",
    fields: [],
  },
  // A calendar service beside the hub (docs/calendar.md): the hub links to it itself, never through dither-accounts.
  calendar: {
    adapter: 'calendar',
    blurb:
      "Links dither-calendar (or another calendar that speaks the same protocol) at this address. While the account is here, the calendar is too: its pane and tab, the plans it finds in your chats, its reminders, and a Calendar chat where you write what to add. Remove the account to turn all of it off.",
    fields: [],
  },
  // Not a tile: mail accounts are dither-accounts' kinds (proton, imap, google), offered from its list (ManagedAdd).
  email: {
    adapter: 'imap',
    blurb: 'Mail accounts are added through dither-accounts.',
    fields: [],
  },
};

/** The kinds Add account offers besides the chat networks: dither-accounts' that bring mail or notices here. */
function managedTiles(kinds: P.ManagedKindView[] | null): P.ManagedKindView[] {
  return (kinds ?? [])
    .filter((k) => !isNetwork(k.kind) && k.add && kindFeatures(k.interfaces).length)
    .sort((a, b) => Number(b.manages) - Number(a.manages) || Number(b.interfaces.includes('mail')) - Number(a.interfaces.includes('mail')) || a.name.localeCompare(b.name));
}

/** A tile's feature icons: what an account of it can do here. */
function TileFeatures({ features, network }: { features: P.AccountFeature[]; network: P.Network | null }) {
  return (
    <span class="feat-icons tile">
      {features.map((f) => (
        <span class="feat on" title={featureLabel(f, network)}>
          <Icon name={FEATURE_ICONS[f]} size={12} />
        </span>
      ))}
    </span>
  );
}
const FEATURE_ICONS: Record<P.AccountFeature, string> = { chat: 'chat', calls: 'phone', spaces: 'hash', feed: 'rss', mail: 'mail', calendar: 'calendar', notices: 'bell' };

export function AddAccount({ onClose }: { onClose: () => void }) {
  rev.value;
  const [pick, setPick] = useState<string>('discord');
  const [kinds, setKinds] = useState<P.ManagedKindView[] | null | undefined>(undefined);
  const load = () =>
    api<P.KindsPage>('/api/accounts/kinds').then(
      (r) => setKinds(r.kinds),
      () => setKinds(null),
    );
  useEffect(() => void load(), []);
  const tiles = managedTiles(kinds ?? null);
  const chosen = isNetwork(pick) ? null : (tiles.find((k) => k.kind === pick) ?? null);
  return (
    <Modal title="Add an account" onClose={onClose}>
      <div class="add-form">
        <label class="field-label">What it is</label>
        <div class="net-pick">
          {NETWORKS.map((n) => (
            <button class={`net-opt ${pick === n ? 'on' : ''}`} style={{ '--net': NETWORK_META[n].color } as any} data-kind={n} onClick={() => setPick(n)}>
              <NetBadge network={n} size={22} />
              {netName(n)}
              <TileFeatures features={NETWORK_FEATURES[n]} network={n} />
            </button>
          ))}
          {tiles.map((k) => (
            <button class={`net-opt ${pick === k.kind ? 'on' : ''} ${k.manages ? '' : 'asks'}`} style={{ '--net': KIND_META[k.kind]?.color ?? '#5B7083' } as any} data-kind={k.kind} onClick={() => setPick(k.kind)}>
              <KindBadge kind={k.kind} size={22} />
              {k.name}
              <TileFeatures features={kindFeatures(k.interfaces)} network={null} />
            </button>
          ))}
        </div>
        {kinds === null && db.accountsManager && <p class="add-note">
          <Icon name="info" size={14} /> Mail accounts are added on{' '}
          {db.accountsManager.url ? (
            <a href={db.accountsManager.url} target="_blank" rel="noopener">
              dither-accounts’ page
            </a>
          ) : (
            'dither-accounts’ page'
          )}{' '}
          while it is not answering here; they show up in this list.
        </p>}
        {isNetwork(pick) ? <AddChat network={pick} onClose={onClose} /> : chosen ? <ManagedAdd kind={chosen} onClose={onClose} onAsked={load} /> : null}
      </div>
    </Modal>
  );
}

/**
 * Adding an account of a dither-accounts kind that is not a chat network (Proton Mail): its own form there, made by the
 * manager on this hub's grant; or, while this hub may not add the kind, asking for that on its page.
 */
function ManagedAdd({ kind: k, onClose, onAsked }: { kind: P.ManagedKindView; onClose: () => void; onAsked: () => void }) {
  const [label, setLabel] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const page = db.accountsManager?.url ?? null;
  const fields = k.add?.fields ?? [];
  const wrong = fields.map((f) => (form[f.key] && f.pattern && !new RegExp(f.pattern).test(form[f.key].trim()) ? `${f.label}: ${f.hint ?? 'that does not look right'}` : null)).find(Boolean);
  const missing = fields.find((f) => !f.optional && f.default === undefined && !form[f.key]?.trim());
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ id: string }>('/api/accounts/managed', { body: { kind: k.kind, label: label.trim(), form } });
      toast({ kind: 'info', title: 'Account added', body: `${k.name}${label.trim() ? ` · ${label.trim()}` : ''}. ${k.add?.next ?? 'Finish setting it up from its page.'}` });
      onClose();
      go({ view: 'accounts', account: r.id });
    } catch (e: any) {
      toast({ kind: 'error', title: 'Could not add account', body: e.message });
    } finally {
      setBusy(false);
    }
  };
  const ask = async () => {
    setBusy(true);
    try {
      await api(`/api/accounts/kinds/${encodeURIComponent(k.kind)}/ask`, { body: {} });
      toast({ kind: 'info', title: 'Asked dither-accounts', body: `Approve it on its page, then add ${k.name} accounts here.` });
      onAsked();
    } catch (e: any) {
      toast({ kind: 'error', title: 'Could not ask', body: e.message });
    } finally {
      setBusy(false);
    }
  };
  const there = page ? (
    <a href={page} target="_blank" rel="noopener">
      dither-accounts’ page
    </a>
  ) : (
    'dither-accounts’ page'
  );
  return (
    <>
      <p class="add-blurb">{k.add?.blurb}</p>
      {!k.manages ? (
        <div class="add-ask" data-asked={k.asked ?? 'no'}>
          {k.asked === 'pending' ? (
            <p class="add-note">
              <Icon name="clock" size={14} /> Asked: approve dither-chat adding {k.name} accounts on {there}, then add one here.
            </p>
          ) : (
            <>
              <p class="add-note">
                <Icon name="info" size={14} /> {k.asked === 'denied' ? 'You declined dither-chat adding' : 'dither-chat may not add'} {k.name} accounts yet. Ask dither-accounts, or add it on {there}; it shows up in this list either way.
              </p>
              <div class="modal-actions">
                <button class="btn ghost" onClick={onClose}>
                  Cancel
                </button>
                <button class="btn primary" disabled={busy} onClick={ask}>
                  {busy ? 'Asking…' : k.asked === 'denied' ? 'Ask again' : 'Ask dither-accounts'}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <p class="add-note">
            <Icon name="info" size={14} /> It runs in dither-accounts, which keeps its sign-in; dither-chat reads and sends its mail.
          </p>
          <label class="field-label">
            Label <span class="muted-label">— optional, how you tell two {k.name} accounts apart</span>
          </label>
          <input class="input" placeholder={k.name} value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
          {fields.map((f) => (
            <>
              <label class="field-label">
                {f.label} {f.optional && <span class="muted-label">— optional</span>}
              </label>
              <input
                class="input"
                type={(f.secret ? 'password' : 'text') as 'text'}
                placeholder={f.placeholder ?? f.default}
                value={form[f.key] ?? ''}
                onInput={(e) => setForm({ ...form, [f.key]: (e.target as HTMLInputElement).value })}
              />
              {f.hint && <small class="field-hint">{f.hint}</small>}
            </>
          ))}
          {!fields.length && (
            <p class="add-note">
              <Icon name="monitor" size={14} /> No password to type here. {k.add?.next ?? 'You finish signing in on its page after it is added.'}
            </p>
          )}
          {wrong && <p class="add-error">{wrong}</p>}
          <div class="modal-actions">
            <button class="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button class="btn primary" disabled={busy || !!wrong || !!missing} onClick={submit}>
              {busy ? 'Adding…' : `Add ${k.name}`}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** Adding a chat account: the hub makes it (in dither-accounts, when it runs them) from its network's form. */
function AddChat({ network, onClose }: { network: P.Network; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [homeserver, setHomeserver] = useState('https://matrix.org');
  const [calendarUrl, setCalendarUrl] = useState(CALENDAR_URL_DEFAULT);
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
          config: network === 'matrix' ? { homeserver } : network === 'calendar' ? { url: calendarUrl.trim() } : {},
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
    <>
        <p class="add-blurb">{help.blurb}</p>
        {db.accountsManager && network !== 'calendar' && (
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
        {network === 'calendar' && (
          <>
            <label class="field-label">
              Address <span class="muted-label">— where the calendar runs, as this hub reaches it</span>
            </label>
            <input class="input" value={calendarUrl} placeholder={CALENDAR_URL_DEFAULT} onInput={(e) => setCalendarUrl((e.target as HTMLInputElement).value)} />
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
    </>
  );
}
