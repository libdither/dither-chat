/**
 * An account's own self on its network, on its page (docs/account-self.md), loaded as a chunk of its own: your status there, where you are signed in, its folders brought into
 * your sidebar once, and its privacy settings as words. Each part shows only where the account says it or can do it.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, OWN_PRESENCE_STATES, PRESENCE_LABEL, SELF_LIMITS } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import './self.css';
import { api, toast } from '../state.ts';
import { CLEAR_AFTER, clearsAt } from '../selfparts.ts';
import { Loading } from './Loader.tsx';

// The app's model and format modules stay out of this chunk (they would split from the startup chunk they sit in).
const netName = (n: P.Network) => NETWORK_META[n].name;
/** As the protocol's bioLength counts: one per character. */
const bioLength = (s: string) => [...s].length;
const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Your status there, its folders, privacy and sessions. */
export function AccountSelfSection({ a, openLive }: { a: P.AccountView; openLive: () => void }) {
  const self = a.self;
  const presence = a.capabilities.includes('setPresence');
  const sessions = a.capabilities.includes('sessions');
  if (!self && !presence && !sessions) return null;
  return (
    <>
      {presence && <PresenceSection a={a} />}
      {sessions && <SessionsSection a={a} openLive={openLive} />}
      {self?.folders && <FoldersSection a={a} />}
      {self?.privacy && self.privacy.length > 0 && (
        <section class="det-section">
          <h3>Privacy on {netName(a.network)}</h3>
          <dl class="kv">
            {self.privacy.map((f) => (
              <>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </>
            ))}
          </dl>
          <p class="det-note">As {netName(a.network)} keeps them. Change them in the live view.</p>
        </section>
      )}
    </>
  );
}

function PresenceSection({ a }: { a: P.AccountView }) {
  const p = a.self?.presence;
  const net = netName(a.network);
  const [text, setText] = useState(p?.status?.text ?? '');
  const [emoji, setEmoji] = useState(p?.status?.emoji ?? '');
  const [clear, setClear] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limit = SELF_LIMITS[a.network]?.statusText;
  const over = limit !== undefined && bioLength(text.trim()) > limit;
  // Quiet hours as set (Settings, Push and quiet hours), for the opt-in below.
  const [quiet, setQuiet] = useState<P.QuietHours | null>(null);
  useEffect(() => void api<{ quietHours: P.QuietHours | null }>('/api/quiet-hours').then((r) => setQuiet(r.quietHours), () => {}), []);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/self/${a.id}/presence`, { body });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveStatus = () => {
    const expiresAt = clearsAt(clear, Date.now());
    void send({ status: text.trim() || emoji.trim() ? { text: text.trim(), emoji: emoji.trim(), ...(expiresAt ? { expiresAt } : {}) } : null });
  };
  return (
    <section class="det-section self-presence">
      <h3>Your status on {net}</h3>
      <div class="seg" role="radiogroup" aria-label={`Your status on ${net}`}>
        {OWN_PRESENCE_STATES.map((s) => (
          <button role="radio" aria-checked={p?.state === s} class={`seg-btn ${p?.state === s ? 'on' : ''}`} disabled={busy} onClick={() => void send({ state: s })}>
            <span class={`presence-dot ${s}`} /> {PRESENCE_LABEL[s]}
          </button>
        ))}
      </div>
      {p?.until && <p class="det-note">Until {new Date(p.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, then back to online.</p>}
      <div class="self-status">
        <input class="input self-emoji" value={emoji} placeholder="🙂" aria-label="Status emoji" onInput={(e) => setEmoji((e.target as HTMLInputElement).value)} />
        <input class="input" value={text} placeholder="What are you up to?" aria-label="Status text" aria-invalid={over} onInput={(e) => setText((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && !over && saveStatus()} />
        <select class="input" value={clear} aria-label="Clear after" onChange={(e) => setClear(Number((e.target as HTMLSelectElement).value))}>
          {CLEAR_AFTER.map(([label], i) => (
            <option value={i}>{label}</option>
          ))}
        </select>
      </div>
      <div class="btn-row">
        <button class="btn small primary" disabled={busy || over} onClick={saveStatus}>
          {busy ? 'Saving…' : 'Set status'}
        </button>
        {p?.status && (
          <button class="btn small ghost" disabled={busy} onClick={() => (setText(''), setEmoji(''), void send({ status: null }))}>
            Clear status
          </button>
        )}
        {over && <span class="pf-bio-count over">{bioLength(text.trim()) - limit!} over {limit}</span>}
      </div>
      {p?.status?.expiresAt && <p class="det-note">Clears {new Date(p.status.expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.</p>}
      {error && (
        <p class="pf-bio-error" role="alert">
          {error}
        </p>
      )}
      <label class="toggle-row">
        <input
          type="checkbox"
          checked={!!a.self?.dndQuietHours}
          onChange={async (e) => {
            const on = (e.target as HTMLInputElement).checked;
            try {
              await api(`/api/self/${a.id}/dnd-quiet`, { method: 'PUT', body: { on } });
            } catch (err) {
              toast({ kind: 'error', title: 'Could not change that', body: (err as Error).message });
            }
          }}
        />
        <span>
          <b>Do not disturb on {net} during quiet hours</b>
          <small>
            {quiet?.enabled ? `From ${quiet.start} to ${quiet.end}, then back to what it was. A status you set in between is left as it is.` : 'Quiet hours are off (Settings, Push and quiet hours): this does nothing until they are on.'}
          </small>
        </span>
      </label>
    </section>
  );
}

function SessionsSection({ a, openLive }: { a: P.AccountView; openLive: () => void }) {
  const [list, setList] = useState<P.AccountSession[] | null | 'loading'>(null);
  const [error, setError] = useState<string | null>(null);
  const net = netName(a.network);
  const load = () => {
    setList('loading');
    setError(null);
    api<P.SessionsResult>(`/api/self/${a.id}/sessions`).then(
      (r) => setList(r.sessions),
      (e) => (setList(null), setError((e as Error).message)),
    );
  };
  return (
    <section class="det-section">
      <h3>Signed in</h3>
      {list === null && (
        <button class="btn ghost small" onClick={load}>
          Where is {net} signed in?
        </button>
      )}
      {list === 'loading' && <Loading inline label={`Asking ${net}…`} />}
      {Array.isArray(list) && (
        <>
          <p class="det-note">
            {net} is signed in on {list.length} {list.length === 1 ? 'device' : 'devices'}.
          </p>
          <ul class="self-sessions">
            {list.map((s) => (
              <li>
                <b>{[s.client, s.os].filter(Boolean).join(' on ') || 'Unknown device'}</b>
                {s.current && <span class="cap">this hub</span>}
                <small>
                  {[s.location, s.lastUsed ? `last used ${when(s.lastUsed)}` : null].filter(Boolean).join(' · ')}
                </small>
              </li>
            ))}
          </ul>
          <p class="det-note">
            To sign one out, {net} asks for your password: do it in the live view (User Settings, Devices).{' '}
            {a.liveView && (
              <button class="link-btn" onClick={openLive}>
                Open live view
              </button>
            )}
          </p>
        </>
      )}
      {error && (
        <p class="pf-bio-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function FoldersSection({ a }: { a: P.AccountView }) {
  const self = a.self!;
  const net = netName(a.network);
  const named = (self.folders ?? []).filter((f) => f.name || f.spaces.length > 1);
  const [busy, setBusy] = useState(false);
  if (!named.length) return null;
  const bring = async () => {
    setBusy(true);
    try {
      const r = await api<P.FolderImportResult>(`/api/self/${a.id}/folders/import`, { body: {} });
      const made = r.made.map((f) => f.name).join(', ');
      toast({ kind: 'info', title: r.made.length ? `${r.made.length} ${r.made.length === 1 ? 'folder' : 'folders'} added` : 'Nothing to add', body: r.made.length ? `${made}. Your own folders stay as they were.` : r.skipped.map((s) => `${s.name ?? 'A folder'}: ${s.why}`).join('; ') || 'Every server is in one of your folders already.' });
    } catch (e) {
      toast({ kind: 'error', title: 'Could not bring them in', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="det-section">
      <h3>Folders on {net}</h3>
      <p class="det-note">
        {named.map((f) => `${f.name ?? 'Unnamed'} (${f.spaces.length})`).join(', ')}
      </p>
      {self.foldersImportedAt ? (
        <p class="det-note">
          Brought into your sidebar on {when(self.foldersImportedAt)}.{' '}
          <button class="link-btn" disabled={busy} onClick={() => void bring()}>
            Bring in what is new
          </button>
        </p>
      ) : (
        <>
          <button class="btn ghost small" disabled={busy} onClick={() => void bring()}>
            {busy ? 'Adding…' : `Add ${net}'s folders to your sidebar`}
          </button>
          <p class="det-note">Adds them after your own folders. A server already in one of yours stays where you put it.</p>
        </>
      )}
    </section>
  );
}
