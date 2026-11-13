/**
 * The parts of a profile that are about you and them on their network (docs/account-self.md): Ignore in their menu
 * (Block is SignalPeople.tsx's, for every network that can); what their profile shows beyond its text (badges,
 * colours); and, on your own profile, your pronouns, banner and its colour where the profile's `editable` lists them
 * (your name and picture are SignalPeople.tsx's OwnProfileExtras, by the same list).
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, SELF_LIMITS } from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import './self.css';
import { api, db, toast } from '../state.ts';
import { uploadFile } from '../upload.ts';
import { selfOffers } from '../selfparts.ts';
import type { MenuEntry } from './ContextMenu.tsx';
import { NetGlyph } from './bits.tsx';

// The app's model and format modules stay out of this chunk (they would split from the startup chunk they sit in).
const netName = (n: P.Network) => NETWORK_META[n].name;
/** As the protocol's bioLength counts: one per character. */
const bioLength = (s: string) => [...s].length;

/** Ignore or Stop Ignoring for each of their accounts on a network one of yours can do it on. */
export function selfEntries(ids: P.IdentityView[], profile: P.ProfileView, links: P.PersonLinkView[], onChanged: (patch: Partial<P.ProfileView>) => void): MenuEntry[] {
  const out: MenuEntry[] = [];
  const several = new Set(ids.map((i) => i.network)).size < ids.length;
  for (const { identity: i, ignored } of selfOffers(ids, profile.ignored, links, db.accounts.values())) {
    const net = netName(i.network);
    const on = `on ${net}${several ? ` (${i.handle ?? i.nativeId})` : ''}`;
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
 * Your pronouns, banner and banner colour on one network, where your profile's `editable` lists them. Saved with the
 * same `PUT /api/identities/:id/about` as the bio.
 */
export function OwnProfileFields({ identity, about, onSaved }: { identity: P.IdentityView; about?: P.PersonAboutView; onSaved: (a: P.PersonAboutView) => void }) {
  const editable = about?.editable ?? [];
  const [open, setOpen] = useState(false);
  const [pronouns, setPronouns] = useState(about?.pronouns ?? '');
  const [accent, setAccent] = useState(about?.accent ?? '#5865f2');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const can = (f: P.ProfileField) => editable.includes(f);
  if (!can('pronouns') && !can('banner') && !can('accent')) return null;
  const net = netName(identity.network);
  const lim = SELF_LIMITS[identity.network] ?? {};
  const send = async (what: string, body: Record<string, unknown>) => {
    setBusy(what);
    setError(null);
    try {
      onSaved(await api<P.PersonAboutView>(`/api/identities/${identity.id}/about`, { method: 'PUT', body }));
      toast({ kind: 'info', title: `Saved on ${net}`, body: 'It shows there as it does here.' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const banner = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (lim.avatarBytes && f.size > lim.avatarBytes) return setError(`${net} takes pictures up to ${lim.avatarBytes / 1024 / 1024} MB`);
      setBusy('banner');
      try {
        const up = await uploadFile(f, f.name, f.type);
        await send('banner', { banner: up.id });
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
        Change your {[can('pronouns') && 'pronouns', (can('banner') || can('accent')) && 'banner'].filter(Boolean).join(' or ')} on {net}
      </button>
    );
  return (
    <div class="pf-own-fields">
      {can('pronouns') && (
        <label class="field">
          <span>Pronouns on {net}</span>
          <span class="field-row">
            <input class="input" value={pronouns} placeholder="they/them" onInput={(e) => setPronouns((e.target as HTMLInputElement).value)} />
            <button class="btn small" disabled={!!busy || (lim.pronouns !== undefined && bioLength(pronouns.trim()) > lim.pronouns)} onClick={() => void send('pronouns', { pronouns: pronouns.trim() })}>
              {busy === 'pronouns' ? 'Saving…' : 'Save'}
            </button>
          </span>
        </label>
      )}
      <div class="btn-row">
        {can('banner') && (
          <button class="btn ghost small" disabled={!!busy} onClick={banner} title={identity.network === 'discord' ? 'A banner picture needs Discord Nitro' : undefined}>
            {busy === 'banner' ? 'Uploading…' : 'New banner'}
          </button>
        )}
        {can('accent') && (
          <label class="pf-accent">
            <input type="color" value={accent} onInput={(e) => setAccent((e.target as HTMLInputElement).value)} aria-label="Banner colour" />
            <button class="btn ghost small" disabled={!!busy} onClick={() => void send('accent', { accent })}>
              Set banner colour
            </button>
          </label>
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
