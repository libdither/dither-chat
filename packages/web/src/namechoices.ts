/**
 * Which name and which picture show for a person, chosen on their profile (ui/Profile.tsx; docs/profile.md "Which
 * account speaks for them"): the choices the hero's menus offer, and which is on.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { accountName } from './chatroutes.ts';

/** One of their accounts having a name, and which of its names it is. */
export type NameRef = { i: P.IdentityView; field: P.NameField };
/** A name of theirs, once however many of their accounts have it: "Kit" and "kit" are two. */
export type NameEntry = { text: string; refs: NameRef[] };
/** A row of the name picker: `from` null puts the main account's name back; `nick`, your nickname for the person. */
export type NameRow = { text: string; refs: NameRef[]; detail: string; from: P.NameFrom | null; on: boolean; nick?: true };

// A phone number for a handle (Signal, WhatsApp) is no name to go by.
const PHONE = /^[+\d][\d\s()-]*$/;

/**
 * Every name of theirs (docs/profile.md "Choosing from the hero"), each text once with the accounts that have it, one
 * ref an account: names first (your nicknames, their display names), then handles; the main account's first in each.
 */
export function nameEntries(ids: P.IdentityView[], mainId: string | undefined): NameEntry[] {
  const sorted = [...ids].sort((a, b) => +(b.id === mainId) - +(a.id === mainId));
  const out = new Map<string, NameEntry>();
  for (const pass of [['nickname', 'display'], ['handle']] as const)
    for (const i of sorted)
      for (const field of pass) {
        const text = (field === 'nickname' ? i.nickname : field === 'display' ? i.displayName : i.handle)?.trim();
        if (!text || (field === 'handle' && PHONE.test(text))) continue;
        let e = out.get(text);
        if (!e) out.set(text, (e = { text, refs: [] }));
        if (!e.refs.some((r) => r.i.id === i.id)) e.refs.push({ i, field });
      }
  return [...out.values()];
}

/** The line under their name: their other names, handles left out (the Accounts card has them). */
export const alsoNames = (entries: NameEntry[], shown: string) => entries.filter((e) => e.text !== shown && e.refs.some((r) => r.field !== 'handle'));

/** Where a name is from, for its tooltip: each account's network and handle. */
export const whereFrom = (e: NameEntry) => e.refs.map((r) => [NETWORK_META[r.i.network].name, r.i.handle && !PHONE.test(r.i.handle) && r.i.handle].filter(Boolean).join(' ')).join(', ');

/**
 * The picker's rows: your nickname for the person first, where you gave one; the main account's name as you see it
 * (`faceName`), following it as it changes, with the accounts that share it; then each other name. The tick is on your
 * nickname, else the name chosen, else the main account's (also when the account chosen lacks that name now).
 */
export function nameRows(entries: NameEntry[], person: P.PersonView, faceName: string, several: boolean): NameRow[] {
  const nick = person.nickname;
  const chosen = nick ? undefined : person.nameFrom;
  const has = (e: NameEntry) => !!chosen && e.refs.some((r) => r.i.id === chosen.identityId && r.field === chosen.field);
  const hit = entries.find(has);
  const label = (e: NameEntry) => (e.refs.every((r) => r.field === 'nickname') ? 'Account nickname' : e.refs.every((r) => r.field === 'handle') ? 'Handle' : '');
  const rows: NameRow[] = nick ? [{ text: nick, refs: [], detail: 'Your nickname', from: null, on: true, nick: true }] : [];
  rows.push({ text: faceName, refs: entries.find((e) => e.text === faceName)?.refs ?? [], detail: several ? "Main account's" : '', from: null, on: !nick && (!hit || hit.text === faceName) });
  for (const e of entries) {
    if (e.text === faceName) continue;
    rows.push({ text: e.text, refs: e.refs, detail: label(e), from: { identityId: e.refs[0].i.id, field: e.refs[0].field }, on: has(e) });
  }
  return rows;
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
