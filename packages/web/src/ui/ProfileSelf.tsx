/**
 * The parts of a profile that are about you and them on their network (docs/account-self.md): your private note on
 * them there, next to your own; Block and Ignore in their menu; what their profile shows beyond its text (badges,
 * colours); and, on your own profile, your name, pronouns, picture and banner where the account may change them.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, SELF_LIMITS } from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { api, db, toast } from '../state.ts';
import { uploadFile } from '../upload.ts';
import { selfOffers, withNetworkNote } from '../selfparts.ts';
import type { MenuEntry } from './ContextMenu.tsx';
import { NetGlyph } from './bits.tsx';

// The app's model and format modules stay out of this chunk (they would split from the startup chunk they sit in).
const netName = (n: P.Network) => NETWORK_META[n].name;
/** As the protocol's bioLength counts: one per character. */
const bioLength = (s: string) => [...s].length;

const able = (network: P.Network, cap: P.Capability) => [...db.accounts.values()].some((a) => a.network === network && a.status === 'online' && a.capabilities.includes(cap));

/**
 * Block and Ignore for each of their accounts on a network one of yours can do it on. Block asks first: it is not
 * undone from here but from How you stand (Unblock).
 */
export function selfEntries(ids: P.IdentityView[], profile: P.ProfileView, links: P.PersonLinkView[], onChanged: (patch: Partial<P.ProfileView>) => void): MenuEntry[] {
  const out: MenuEntry[] = [];
  const several = new Set(ids.map((i) => i.network)).size < ids.length;
  for (const { identity: i, ignore, ignored, block } of selfOffers(ids, profile.ignored, links, db.accounts.values())) {
    const net = netName(i.network);
    const on = `on ${net}${several ? ` (${i.handle ?? i.nativeId})` : ''}`;
    if (ignore)
      out.push({
        label: ignored ? `Stop Ignoring ${on}` : `Ignore ${on}`,
        icon: ignored ? 'bell' : 'bellOff',
        run: async () => {
          try {
            const r = await api<{ ignored: boolean }>(`/api/self/people/${i.id}/ignore`, { body: { ignored: !ignored } });
            const rest = (profile.ignored ?? []).filter((x) => x.identityId !== i.id);
            const acc = [...db.accounts.values()].find((a) => a.network === i.network && a.capabilities.includes('ignore'));
            onChanged({ ignored: r.ignored && acc ? [...rest, { accountId: acc.id, identityId: i.id }] : rest });
            toast({ kind: 'info', title: r.ignored ? `Ignored ${on}` : `No longer ignored ${on}`, body: r.ignored ? 'Their messages stay, kept out of the way there, and never alert here.' : 'Their messages show and alert as anyone’s again.' });
          } catch (e) {
            toast({ kind: 'error', title: `${net} did not take it`, body: (e as Error).message });
          }
        },
      });
    if (block)
      out.push({
        label: `Block ${on}`,
        icon: 'x',
        danger: true,
        run: async () => {
          if (!confirm(`Block ${i.displayName ?? i.handle ?? 'them'} on ${net}? They can no longer message you there, and a friendship ends. Unblock is under How you stand.`)) return;
          try {
            const r = await api<P.AddResultView>(`/api/self/people/${i.id}/block`, { body: {} });
            if ((r as { check?: string }).check) return toast({ kind: 'error', title: `${net} wants a check first`, body: 'Do it in the account’s live view; nothing was blocked.' });
            const acc = [...db.accounts.values()].find((a) => a.network === i.network && a.capabilities.includes('block'));
            if (acc) onChanged({ links: [...links.filter((l) => !(l.identityId === i.id && l.accountId === acc.id)), { accountId: acc.id, identityId: i.id, personId: i.personId, relationship: 'blocked', since: Date.now() }] });
            toast({ kind: 'info', title: `Blocked ${on}`, body: 'Their messages never alert here.' });
          } catch (e) {
            toast({ kind: 'error', title: `${net} did not take it`, body: (e as Error).message });
          }
        },
      });
  }
  return out;
}

/** "Ignored on Discord": a tag for the hero. */
export function ignoredNets(ids: P.IdentityView[], profile: P.ProfileView): P.Network[] {
  return [...new Set(ids.filter((i) => (profile.ignored ?? []).some((x) => x.identityId === i.id)).map((i) => i.network))];
}

/** Badges and colours their profile shows, under About. */
export function ProfileExtras({ said }: { said: P.PersonAboutView[] }) {
  const badges = said.flatMap((a) => (a.badges ?? []).map((b) => ({ ...b, network: a.network })));
  const colors = said.find((a) => a.themeColors?.length)?.themeColors;
  const deco = said.find((a) => a.decoration)?.decoration;
  if (!badges.length && !colors && !deco) return null;
  return (
    <div class="pf-badges">
      {deco && <img class="pf-deco" src={deco} alt="" title="The frame around their picture" width={28} height={28} loading="lazy" />}
      {badges.map((b) => (
        <span class="pf-badge" title={`${b.name} · ${netName(b.network)}`}>
          {b.icon ? <img src={b.icon} alt="" width={16} height={16} loading="lazy" /> : <NetGlyph network={b.network} size={11} />}
          {b.name}
        </span>
      ))}
      {colors && (
        <span class="pf-theme" title="Their profile's colours">
          {colors.map((c) => (
            <span class="pf-swatch" style={{ background: c }} />
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * Your private note on them on each network that keeps one, beside your dither note. Neither is lost: a network note
 * you replace goes into your dither note first if it is not there (the hub does it), and "Add to my note" copies it in.
 */
export function NetworkNotes({ ids, abouts, note, setNote, learn }: { ids: P.IdentityView[]; abouts: Record<string, P.PersonAboutView | undefined>; note: string | null; setNote: (text: string) => Promise<void> | void; learn: (a: P.PersonAboutView) => void }) {
  const rows = ids.filter((i) => abouts[i.id] && able(i.network, 'notes'));
  if (!rows.length) return null;
  return (
    <>
      {rows.map((i) => (
        <NetworkNote i={i} about={abouts[i.id]!} note={note} setNote={setNote} learn={learn} />
      ))}
    </>
  );
}

function NetworkNote({ i, about, note, setNote, learn }: { i: P.IdentityView; about: P.PersonAboutView; note: string | null; setNote: (text: string) => Promise<void> | void; learn: (a: P.PersonAboutView) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const net = netName(i.network);
  const text = about.note ?? '';
  const limit = SELF_LIMITS[i.network]?.note;
  const over = draft !== null && limit !== undefined && bioLength(draft) > limit;
  const kept = !!text && (note ?? '').includes(text);
  const save = async () => {
    if (draft === null || busy || over) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ note: string; personNote: string | null }>(`/api/self/identities/${i.id}/note`, { method: 'PUT', body: { note: draft, ...(about.accountId ? { accountId: about.accountId } : {}) } });
      // The account whose answer showed the note is the one it is written through.
      learn({ ...about, note: r.note || undefined });
      if (r.personNote !== null) await setNote(r.personNote);
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="pf-net-note">
      <span class="pf-bio-net">
        <NetGlyph network={i.network} size={11} /> Your note on {net}
      </span>
      {draft === null ? (
        <div class="about-text multi">
          <p>{text || <em>None on {net}</em>}</p>
          <button class="link-btn" title={`Change your note on ${net}`} onClick={() => (setDraft(text), setError(null))}>
            {text ? 'Change' : 'Write one'}
          </button>
        </div>
      ) : (
        <div class="about-edit multi">
          <textarea class="about-input" rows={2} value={draft} aria-label={`Your note on ${net}`} aria-invalid={over} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} />
          {error && (
            <p class="pf-bio-error" role="alert">
              {error}
            </p>
          )}
          <p class="pf-hint">Only you see it, on {net} too. What it said before is kept in your note here.</p>
          <div class="about-edit-btns">
            {limit !== undefined && <span class={`pf-bio-count ${over ? 'over' : ''}`}>{over ? `${bioLength(draft) - limit} over ${limit}` : `${limit - bioLength(draft)} of ${limit} left`}</span>}
            <button class="btn ghost small" onClick={() => (setDraft(null), setError(null))}>
              Cancel
            </button>
            <button class="btn primary small" disabled={busy || over} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
      {text && !kept && draft === null && (
        <button class="link-btn" onClick={() => void setNote(withNetworkNote(note, net, text))}>
          Add to my note here
        </button>
      )}
    </div>
  );
}

/** Your name, pronouns, picture and banner on one network, where its account may change them. */
export function OwnProfileFields({ identity, about, onSaved }: { identity: P.IdentityView; about?: P.PersonAboutView; onSaved: (a: P.PersonAboutView) => void }) {
  const acc = [...db.accounts.values()].find((a) => a.selfIdentityId === identity.id);
  const can = (c: P.Capability) => !!acc?.capabilities.includes(c);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(identity.displayName ?? '');
  const [pronouns, setPronouns] = useState(about?.pronouns ?? '');
  const [accent, setAccent] = useState(about?.accent ?? '#5865f2');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!acc || !['editName', 'editPronouns', 'editAvatar', 'editBanner'].some((c) => can(c as P.Capability))) return null;
  const net = netName(identity.network);
  const lim = SELF_LIMITS[identity.network] ?? {};
  const send = async (what: string, body: Record<string, unknown>) => {
    setBusy(what);
    setError(null);
    try {
      const a = await api<P.PersonAbout>(`/api/self/identities/${identity.id}/profile`, { method: 'PUT', body });
      // What the network answered, as the profile shows it; the identity's own facts come over the socket.
      if (about) onSaved({ ...about, ...(a.pronouns !== undefined ? { pronouns: a.pronouns } : {}), ...(a.displayName ? { displayName: a.displayName } : {}), ...(a.accent ? { accent: a.accent } : {}) });
      toast({ kind: 'info', title: `Saved on ${net}`, body: 'It shows there as it does here.' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const picture = (key: 'avatar' | 'banner') => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (lim.avatarBytes && f.size > lim.avatarBytes) return setError(`${net} takes pictures up to ${lim.avatarBytes / 1024 / 1024} MB`);
      setBusy(key);
      try {
        const up = await uploadFile(f, f.name, f.type);
        await send(key, { [key]: up.id });
      } catch (e) {
        setError((e as Error).message);
        setBusy(null);
      }
    };
    input.click();
  };
  if (!open)
    return (
      <button class="link-btn pf-own-more" onClick={() => setOpen(true)}>
        Change your name, picture{can('editPronouns') ? ', pronouns' : ''}{can('editBanner') ? ' or banner' : ''} on {net}
      </button>
    );
  return (
    <div class="pf-own-fields">
      {can('editName') && (
        <label class="field">
          <span>Display name on {net}</span>
          <span class="field-row">
            <input class="input" value={name} maxLength={(lim.displayName ?? 100) * 2} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <button class="btn small" disabled={!!busy || (lim.displayName !== undefined && bioLength(name.trim()) > lim.displayName)} onClick={() => void send('name', { displayName: name.trim() })}>
              {busy === 'name' ? 'Saving…' : 'Save'}
            </button>
          </span>
        </label>
      )}
      {can('editPronouns') && (
        <label class="field">
          <span>Pronouns</span>
          <span class="field-row">
            <input class="input" value={pronouns} placeholder="they/them" onInput={(e) => setPronouns((e.target as HTMLInputElement).value)} />
            <button class="btn small" disabled={!!busy || (lim.pronouns !== undefined && bioLength(pronouns.trim()) > lim.pronouns)} onClick={() => void send('pronouns', { pronouns: pronouns.trim() })}>
              {busy === 'pronouns' ? 'Saving…' : 'Save'}
            </button>
          </span>
        </label>
      )}
      <div class="btn-row">
        {can('editAvatar') && (
          <button class="btn ghost small" disabled={!!busy} onClick={() => picture('avatar')}>
            {busy === 'avatar' ? 'Uploading…' : 'New picture'}
          </button>
        )}
        {can('editBanner') && (
          <>
            <button class="btn ghost small" disabled={!!busy} onClick={() => picture('banner')} title={identity.network === 'discord' ? 'A banner picture needs Discord Nitro' : undefined}>
              {busy === 'banner' ? 'Uploading…' : 'New banner'}
            </button>
            <label class="pf-accent">
              <input type="color" value={accent} onInput={(e) => setAccent((e.target as HTMLInputElement).value)} aria-label="Banner colour" />
              <button class="btn ghost small" disabled={!!busy} onClick={() => void send('accent', { accent })}>
                Set banner colour
              </button>
            </label>
          </>
        )}
        <button class="btn ghost small" onClick={() => (setOpen(false), setError(null))}>
          Done
        </button>
      </div>
      {error && (
        <p class="pf-bio-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

