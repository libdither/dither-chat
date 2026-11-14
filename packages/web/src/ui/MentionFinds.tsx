/**
 * "@ finds" on a chat's or a space's About (docs/mentions.md, "The setting"): whom the @ list offers there, and
 * whether friends and everyone are only those on its network. Unset, a place inherits from the one it is in: a
 * thread's channel, a channel's server and its parents, then a folder holding any of them; the hub works it out the
 * same way (hub mentions.ts mentionSetting) when the list is asked for.
 */
import type * as P from '@dither-chat/protocol';
import { MENTION_SCOPES } from '@dither-chat/protocol';
import { convTitle, netName, placeConv, placePref, spaceParents } from '../model.ts';
import { db, patchPlaces } from '../state.ts';
import { Card } from './ProfileShell.tsx';

export const FINDS_LABEL: Record<P.MentionScope, string> = { here: 'People here', friends: 'Here and friends', everyone: 'Everyone you know' };
const LABEL = FINDS_LABEL;

/** The places a place inherits from, nearest first (not itself). */
function above(kind: P.PlaceKind, id: string): [P.PlaceKind, string][] {
  const out: [P.PlaceKind, string][] = [];
  const held: [string, string][] = [[kind, id]];
  let spaces: string[] = [];
  let peer: string | null | undefined;
  if (kind === 'conversation') {
    const c = db.conversations.get(id);
    const base = c ? placeConv(c) : undefined;
    if (base && base.id !== id) held.push(['conversation', base.id]);
    spaces = base?.spaceIds ?? [];
    if (c?.shape === 'direct') peer = c.peerPersonId;
  } else if (kind === 'space') spaces = spaceParents(id).map((s) => s.id);
  const seen = new Set<string>();
  while (spaces.length) {
    const next: string[] = [];
    for (const s of spaces) {
      if (seen.has(s)) continue;
      seen.add(s);
      held.push(['space', s]);
      next.push(...spaceParents(s).map((p) => p.id));
    }
    spaces = next;
  }
  // A direct chat is in a folder through its person.
  if (peer) held.push(['person', peer]);
  for (const [k, i] of held) {
    if ((k !== kind || i !== id) && k !== 'person') out.push([k as P.PlaceKind, i]);
  }
  // Folders after every channel and space, as the hub reads them.
  for (const [k, i] of held) {
    if (k !== 'folder') for (const f of db.folders.filter((f) => f.items.some((x) => x.kind === k && x.id === i)).sort((a, b) => a.id.localeCompare(b.id))) out.push(['folder', f.id]);
  }
  // A folder inside a folder: the outer one after it, as the hub reads them.
  for (const [k, i] of [...out]) {
    const outer = k === 'folder' ? db.folders.find((f) => f.items.some((x) => x.kind === 'folder' && x.id === i)) : undefined;
    if (outer) out.push(['folder', outer.id]);
  }
  return out;
}

const placeName = (kind: P.PlaceKind, id: string) =>
  kind === 'folder' ? db.folders.find((f) => f.id === id)?.name : kind === 'space' ? db.spaces.get(id)?.name : convTitle(db.conversations.get(id));

/** `refs`: the place's account keeps references (the Calendar chat): everyone by default, and no network to keep to. */
export function MentionFinds({ kind, id, network, refs }: { kind: P.PlaceKind; id: string; network?: P.Network; refs?: boolean }) {
  const own = placePref(kind, id);
  const up = <K extends 'mentionScope' | 'mentionSameNetwork'>(f: K) => {
    for (const [k, i] of above(kind, id)) {
      const v = db.placePrefs.get(`${k}:${i}`)?.[f];
      if (v !== undefined) return { v: v as NonNullable<P.PlacePrefView[K]>, name: placeName(k, i) };
    }
    return null;
  };
  const scope = up('mentionScope');
  const same = own.mentionSameNetwork ?? up('mentionSameNetwork')?.v ?? false;
  const inherit = scope ? `As ${scope.name ?? 'above'} (${LABEL[scope.v]})` : `Default (${LABEL[refs ? 'everyone' : 'here']})`;
  const where = kind === 'conversation' ? 'here' : 'in its chats';
  return (
    <Card title="@ finds" icon="users" class="pf-mentions">
      <label class="pf-level">
        <select class="select" value={own.mentionScope ?? ''} onChange={(e) => void patchPlaces([{ kind, id, mentionScope: ((e.target as HTMLSelectElement).value || null) as P.MentionScope | null }])}>
          <option value="">{inherit}</option>
          {MENTION_SCOPES.map((s) => (
            <option value={s}>{LABEL[s]}</option>
          ))}
        </select>
      </label>
      {network && !refs && (
        <label class="toggle-row">
          <input
            type="checkbox"
            role="switch"
            checked={same}
            onChange={(e) => {
              const on = (e.target as HTMLInputElement).checked;
              // Back to what it inherits, when that is what it says.
              void patchPlaces([{ kind, id, mentionSameNetwork: on === (up('mentionSameNetwork')?.v ?? false) ? null : on }]);
            }}
          />
          <span>Only on {netName(network)}</span>
        </label>
      )}
      <p class="pf-hint">
        Whom the @ list offers {where}. Friends are your friends and contacts on any network and everyone you have a direct chat with. Someone with no{' '}
        {network && !refs ? netName(network) : 'account here'} account gets a plain @name, and is not notified.
      </p>
    </Card>
  );
}
