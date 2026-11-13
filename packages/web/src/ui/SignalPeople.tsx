/**
 * People and your own profile where the network lets you do more from here (docs/profile.md, Signal): safety numbers
 * to compare and mark verified, blocking someone or a group, and your own name, emoji, picture and username. Each
 * shows only where an account's capabilities or its profile's `editable` say so.
 */
import type * as P from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { renderSVG } from 'uqr';
import { ago } from '../format.ts';
import { netName } from '../model.ts';
import { api, db, toast } from '../state.ts';
import { uploadFile } from '../upload.ts';
import type { MenuEntry } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import { Card, Tag } from './ProfileShell.tsx';

/** Some account on this network can do it. */
const can = (network: P.Network, cap: P.Capability) => [...db.accounts.values()].some((a) => a.network === network && a.capabilities.includes(cap));

/** The digits as Signal shows them: 12 groups of 5. */
export const safetyGroups = (digits: string) => digits.match(/.{1,5}/g) ?? [];

/** A QR code of the bytes Signal's own code holds, for their phone to scan. */
async function bytesQr(base64: string): Promise<string> {
  const bytes = [...atob(base64)].map((c) => c.charCodeAt(0));
  return renderSVG(bytes, { ecc: 'M', border: 4, whiteColor: '#ffffff', blackColor: '#000000' }).replace('<svg ', '<svg shape-rendering="crispEdges" ');
}

/**
 * Your safety number with them on each network that has one: compare the digits with theirs, or let their phone scan
 * the code, then mark it verified. A number that changed since says so; a new key after you verified is unverified.
 */
export function SafetyCard({ abouts, name, onChanged }: { abouts: P.PersonAboutView[]; name: string; onChanged: (a: P.PersonAboutView) => void }) {
  const withSafety = abouts.filter((a) => a.safety && can(a.network, 'safetyNumbers'));
  if (!withSafety.length) return null;
  return (
    <Card title="Safety number" icon="lock" class="pf-safety">
      {withSafety.map((a) => (
        <SafetyNumber a={a} name={name} label={withSafety.length > 1} onChanged={onChanged} />
      ))}
    </Card>
  );
}

function SafetyNumber({ a, name, label, onChanged }: { a: P.PersonAboutView; name: string; label: boolean; onChanged: (a: P.PersonAboutView) => void }) {
  const s = a.safety!;
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const net = netName(a.network);
  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      onChanged(await api<P.PersonAboutView>(`/api/identities/${a.identityId}/verify`, { body }));
      toast({ kind: 'info', title: done, body: '' }, 2500);
    } catch (e) {
      toast({ kind: 'error', title: 'That did not work', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const verify = () =>
    confirm(`Mark your safety number with ${name} on ${net} verified?\n\nOnly after you compared these digits with the ones ${name} sees, in person or on a call you trust, or their phone scanned this code.`) &&
    void act({ safetyNumber: s.digits }, 'Marked verified');
  const showQr = async () => {
    if (qr) return setQr(null);
    try {
      setQr(await bytesQr(s.scannable!));
    } catch {
      toast({ kind: 'error', title: 'Could not draw the code', body: '' });
    }
  };
  return (
    <div class="pf-safety-one" data-safety={a.identityId}>
      <div class="pf-safety-tags">
        {label && <Tag>{net}</Tag>}
        {s.trust === 'verified' ? (
          <Tag icon="check" tone="accent">
            Verified
          </Tag>
        ) : (
          <Tag tone="muted">Not verified</Tag>
        )}
        {s.changedAt && (
          <Tag icon="alert" tone="warn" title={new Date(s.changedAt).toLocaleString()}>
            Changed {ago(s.changedAt)}
          </Tag>
        )}
      </div>
      <div class="pf-safety-digits" aria-label={`Safety number ${s.digits}`}>
        {safetyGroups(s.digits).map((g) => (
          <code>{g}</code>
        ))}
      </div>
      {qr && <div class="qr-code pf-safety-qr" role="img" aria-label={`The code for ${name}'s phone to scan`} dangerouslySetInnerHTML={{ __html: qr }} />}
      <div class="btn-row">
        {s.scannable && (
          <button class="btn ghost small" onClick={() => void showQr()}>
            <Icon name="qr" size={13} /> {qr ? 'Hide the code' : 'Show the code'}
          </button>
        )}
        {s.trust === 'verified' ? (
          <button class="btn ghost small" disabled={busy} onClick={() => void act({ clear: true }, 'Verification cleared')}>
            Clear verification
          </button>
        ) : (
          <button class="btn small" disabled={busy} onClick={verify}>
            <Icon name="check" size={13} /> Mark as verified
          </button>
        )}
      </div>
      {s.changedAt && s.trust !== 'verified' && (
        <p class="pf-hint">Their safety number changed: they may have a new phone or reinstalled Signal. Compare it again before trusting anything sensitive.</p>
      )}
    </div>
  );
}

/**
 * Block or unblock each of their accounts where yours can (capability 'block'), for the profile's More menu. Blocked:
 * from their account's list, else what their profile said.
 */
export function blockEntries(ids: P.IdentityView[], links: P.PersonLinkView[], abouts: Record<string, P.PersonAboutView | undefined>, onDone: () => void): MenuEntry[] {
  return ids
    .filter((i) => can(i.network, 'block'))
    .map((i): MenuEntry => {
      const blocked = links.some((l) => l.identityId === i.id && l.relationship === 'blocked') || abouts[i.id]?.relationship === 'blocked';
      const net = netName(i.network);
      return blocked
        ? { label: `Unblock on ${net}`, icon: 'check', run: () => void blockIdentity(i, true, onDone) }
        : { label: `Block on ${net}…`, icon: 'x', danger: true, run: () => confirm(`Block them on ${net}? Their messages and calls stop reaching you, here and on your phone.`) && void blockIdentity(i, false, onDone) };
    });
}

async function blockIdentity(i: P.IdentityView, unblock: boolean, onDone: () => void) {
  try {
    await api(`/api/identities/${i.id}/block`, { body: { unblock } });
    toast({ kind: 'info', title: unblock ? 'Unblocked' : 'Blocked', body: '' }, 2500);
    onDone();
  } catch (e) {
    toast({ kind: 'error', title: unblock ? 'Could not unblock' : 'Could not block', body: (e as Error).message });
  }
}

/** Block or unblock a group from its page (About.blocked, capability 'block'). */
export function GroupBlock({ conversationId, network, blocked, onDone }: { conversationId: string; network: P.Network; blocked: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!can(network, 'block')) return null;
  const run = async () => {
    if (!blocked && !confirm(`Block this group on ${netName(network)}? Its messages stop reaching you, here and on your phone; you stay in it.`)) return;
    setBusy(true);
    try {
      await api(`/api/conversations/${conversationId}/block`, { body: { unblock: blocked } });
      toast({ kind: 'info', title: blocked ? 'Group unblocked' : 'Group blocked', body: '' }, 2500);
      onDone();
    } catch (e) {
      toast({ kind: 'error', title: blocked ? 'Could not unblock' : 'Could not block', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Blocking" icon="x">
      <p class="pf-hint">{blocked ? 'You blocked this group: nothing from it reaches you.' : 'Messages from this group reach you.'}</p>
      <button class={`btn small ${blocked ? '' : 'danger'}`} disabled={busy} onClick={() => void run()}>
        {blocked ? 'Unblock group' : 'Block group'}
      </button>
    </Card>
  );
}

/**
 * Your own profile beyond the bio, where the network's adapter can change it (PersonAbout.editable): your name, the
 * emoji by your bio, your picture, and your username with its link.
 */
export function OwnProfileExtras({ identity, about, onSaved }: { identity: P.IdentityView; about?: P.PersonAboutView; onSaved: (a: P.PersonAboutView) => void }) {
  const editable = about?.editable ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [emoji, setEmoji] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  if (!editable.some((f) => f !== 'bio')) return null;
  const net = netName(identity.network);
  const put = async (what: string, body: Record<string, unknown>) => {
    setBusy(what);
    try {
      onSaved(await api<P.PersonAboutView>(`/api/identities/${identity.id}/about`, { method: 'PUT', body }));
      return true;
    } catch (e) {
      toast({ kind: 'error', title: `${net} did not take it`, body: (e as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const picture = async (file: File | undefined) => {
    if (!file) return;
    setBusy('avatar');
    try {
      const up = await uploadFile(file, file.name, file.type || 'application/octet-stream');
      await put('avatar', { avatar: up.id });
    } catch (e) {
      toast({ kind: 'error', title: 'Could not upload the picture', body: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const u = about?.username;
  return (
    <div class="pf-own-extras" data-own-profile={identity.network}>
      {editable.includes('name') && (
        <label class="pf-own-row">
          <span>Name on {net}</span>
          <input class="input" value={name ?? about?.displayName ?? ''} onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label={`Your name on ${net}`} />
          {name !== null && name.trim() !== (about?.displayName ?? '') && (
            <button class="btn small primary" disabled={!!busy || !name.trim()} onClick={async () => (await put('name', { name })) && setName(null)}>
              Save
            </button>
          )}
        </label>
      )}
      {editable.includes('emoji') && (
        <label class="pf-own-row">
          <span>Emoji by your About</span>
          <input class="input pf-own-emoji" value={emoji ?? about?.status?.emoji ?? ''} maxLength={16} onInput={(e) => setEmoji((e.target as HTMLInputElement).value)} aria-label={`The emoji by your About on ${net}`} />
          {emoji !== null && emoji.trim() !== (about?.status?.emoji ?? '') && (
            <button class="btn small primary" disabled={!!busy} onClick={async () => (await put('emoji', { emoji: emoji.trim() })) && setEmoji(null)}>
              Save
            </button>
          )}
        </label>
      )}
      {editable.includes('avatar') && (
        <div class="pf-own-row">
          <span>Picture on {net}</span>
          <label class="btn small ghost">
            {busy === 'avatar' ? 'Uploading…' : 'Choose…'}
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden disabled={!!busy} onChange={(e) => void picture((e.target as HTMLInputElement).files?.[0])} />
          </label>
          {about?.avatar && (
            <button class="btn small ghost" disabled={!!busy} onClick={() => confirm(`Remove your picture on ${net}?`) && void put('avatar', { avatar: null })}>
              Remove
            </button>
          )}
        </div>
      )}
      {editable.includes('username') && (
        <div class="pf-own-row pf-own-username">
          <span>Username</span>
          {u && username === null ? (
            <>
              <code>{u.name}</code>
              <button class="btn small ghost" disabled={!!busy} onClick={() => setUsername('')}>
                Change
              </button>
              <button class="btn small ghost" disabled={!!busy} onClick={() => confirm(`Delete your ${net} username? Its link and code stop working.`) && void put('username', { username: null })}>
                Delete
              </button>
            </>
          ) : (
            <>
              <input class="input" placeholder="name" value={username ?? ''} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} aria-label={`Your username on ${net}`} />
              <button class="btn small primary" disabled={!!busy || !(username ?? '').trim()} onClick={async () => (await put('username', { username: (username ?? '').trim() })) && setUsername(null)}>
                Set
              </button>
              {u && (
                <button class="btn small ghost" onClick={() => setUsername(null)}>
                  Cancel
                </button>
              )}
            </>
          )}
        </div>
      )}
      {editable.includes('username') && (
        <p class="pf-hint">
          {u?.link
            ? 'Its link and code are under My code (New → QR codes): they reach you without your number.'
            : u
              ? `${net} shows a username's link only when it is set: set it again here for a link and code.`
              : `${net} adds a number after the name you pick (name.12).`}
        </p>
      )}
    </div>
  );
}
