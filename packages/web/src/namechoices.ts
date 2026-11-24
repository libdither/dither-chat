/**
 * Which name and which picture show for a person, chosen on their profile (ui/Profile.tsx; docs/profile.md "Which
 * account speaks for them"): the choices the hero's menus offer, and which is on.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { accountName } from './chatroutes.ts';

const FIELD_LABEL: Record<P.NameField, string> = { nickname: 'Your nickname', display: 'Display name', handle: 'Handle' };

export type NameChoice = { text: string; detail: string; from: P.NameFrom | null; on: boolean };

/**
 * The names a person may be shown by (docs/profile.md "Which account speaks for them"): the main account's as you see
 * it (`faceName`), following it as it changes, then each account's under its heading (the main account's first): your
 * nickname for it, its display name and its handle, each text once in an account. `from` null: the main account's again.
 */
export function nameChoices(ids: P.IdentityView[], person: P.PersonView, faceName: string): { auto: NameChoice; accounts: { i: P.IdentityView; heading: string; names: NameChoice[] }[] } {
  const chosen = person.nameFrom;
  const sameNet = (i: P.IdentityView) => ids.filter((x) => x.network === i.network).length > 1;
  // The main account's names first, then the others' in their order.
  const sorted = [...ids].sort((a, b) => +(b.id === person.faceId) - +(a.id === person.faceId));
  const accounts = sorted.map((i) => {
    const seen = new Set<string>();
    const names: NameChoice[] = [];
    for (const field of ['nickname', 'display', 'handle'] as const) {
      const text = (field === 'nickname' ? i.nickname : field === 'display' ? i.displayName : i.handle)?.trim();
      // A phone number for a handle (Signal, WhatsApp) is no name to go by.
      if (!text || seen.has(text) || (field === 'handle' && /^[+\d][\d\s()-]*$/.test(text))) continue;
      seen.add(text);
      const on = !!chosen && chosen.identityId === i.id && chosen.field === field;
      // The main account's name stands first already, as the one that follows it; the same text chosen from one
      // field stays, so the tick shows where it is.
      if (i === sorted[0] && text === faceName && !on) continue;
      names.push({ text, detail: FIELD_LABEL[field], from: { identityId: i.id, field }, on });
    }
    // Which account: its network, its handle where two share one, and whether it is the main one.
    const heading = [NETWORK_META[i.network].name, sameNet(i) && i.handle, i.id === person.faceId && ids.length > 1 && 'main account'].filter(Boolean).join(' · ');
    return { i, heading, names };
  });
  // A chosen name the account no longer has (a nickname removed) is not offered, and the main account's shows
  // meanwhile: then it is ticked.
  const auto = { text: faceName, detail: ids.length > 1 ? 'Follows their main account' : 'Follows your nickname, else their name', from: null, on: !accounts.some((a) => a.names.some((c) => c.on)) };
  return { auto, accounts };
}

/** The pictures a person of several accounts may show, one per picture; `on` is the one showing. */
export function pictureChoices(ids: P.IdentityView[], person: P.PersonView, face: P.IdentityView | null): { id: string; url: string; label: string; detail: string; on: boolean }[] {
  const seen = new Set<string>();
  const out: { id: string; url: string; label: string; detail: string; on: boolean }[] = [];
  // The main account's first: choosing it clears the choice.
  for (const i of face ? [face, ...ids.filter((x) => x.id !== face.id)] : ids) {
    if (!i.avatar || seen.has(i.avatar)) continue;
    seen.add(i.avatar);
    // Which account it is: its network and handle (two on one network look alike otherwise), and whether it is the main one.
    const label = accountName(i);
    const detail = [NETWORK_META[i.network].name, i.handle !== label && i.handle, i.id === face?.id && 'main account'].filter(Boolean).join(' · ');
    out.push({ id: i.id, url: i.avatar, label, detail, on: false });
  }
  const showing = out.find((c) => c.id === person.pictureIdentityId) ?? out.find((c) => c.url === person.avatar) ?? out.find((c) => c.id === face?.id);
  if (showing) showing.on = true;
  return out;
}
