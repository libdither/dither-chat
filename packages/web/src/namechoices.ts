/**
 * Which name and which picture show for a person, chosen on their profile (ui/Profile.tsx; docs/profile.md "Which
 * account speaks for them"): the choices the hero's menus offer, and which is on.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { accountName } from './chatroutes.ts';

const FIELD_LABEL: Record<P.NameField, string> = { nickname: 'Your nickname', display: 'Display name', handle: 'Handle' };

/**
 * The names a person may be shown by (docs/profile.md "Which account speaks for them"): the main account's as you see
 * it (`faceName`), following it as it changes, then each account's nickname of yours, display name and handle, each
 * text once. `from` null: the main account's again.
 */
export function nameChoices(ids: P.IdentityView[], person: P.PersonView, faceName: string): { text: string; detail: string; from: P.NameFrom | null; on: boolean }[] {
  const out: { text: string; detail: string; from: P.NameFrom | null; on: boolean }[] = [];
  const seen = new Set<string>();
  const sameNet = (i: P.IdentityView) => ids.filter((x) => x.network === i.network).length > 1;
  const chosen = person.nameFrom;
  for (const i of ids)
    for (const field of ['nickname', 'display', 'handle'] as const) {
      const text = (field === 'nickname' ? i.nickname : field === 'display' ? i.displayName : i.handle)?.trim();
      // A phone number for a handle (Signal, WhatsApp) is no name to go by.
      if (!text || seen.has(text) || (field === 'handle' && /^[+\d][\d\s()-]*$/.test(text))) continue;
      seen.add(text);
      const where = sameNet(i) && i.handle && field !== 'handle' ? `${NETWORK_META[i.network].name} (${i.handle})` : NETWORK_META[i.network].name;
      out.push({ text, detail: `${FIELD_LABEL[field]} · ${where}`, from: { identityId: i.id, field }, on: !!chosen && chosen.identityId === i.id && chosen.field === field });
    }
  // Following the main account: its name stands first, and picking it clears the choice. The same text chosen from one
  // field stays too, so the tick shows where it is.
  const auto = { text: faceName, detail: ids.length > 1 ? 'Main account’s name, as it changes' : 'Its name as you see it, as it changes', from: null, on: !chosen };
  return [auto, ...out.filter((c) => c.on || c.text !== faceName)];
}

/** The pictures a person of several accounts may show, one per picture; `on` is the one showing. */
export function pictureChoices(ids: P.IdentityView[], person: P.PersonView, face: P.IdentityView | null): { id: string; url: string; label: string; detail: string; on: boolean }[] {
  const seen = new Set<string>();
  const out: { id: string; url: string; label: string; detail: string; on: boolean }[] = [];
  // The main account's first: choosing it clears the choice.
  for (const i of face ? [face, ...ids.filter((x) => x.id !== face.id)] : ids) {
    if (!i.avatar || seen.has(i.avatar)) continue;
    seen.add(i.avatar);
    out.push({ id: i.id, url: i.avatar, label: accountName(i), detail: `${NETWORK_META[i.network].name}${i.id === face?.id ? ' · main account' : ''}`, on: false });
  }
  const showing = out.find((c) => c.id === person.pictureIdentityId) ?? out.find((c) => c.url === person.avatar) ?? out.find((c) => c.id === face?.id);
  if (showing) showing.on = true;
  return out;
}
