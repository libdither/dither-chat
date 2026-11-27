/**
 * Who is in a call or a voice channel right now, and where (docs/calls.md "In a call now"), from plain inputs: the
 * builder voicenow.ts runs on the page's signals, kept apart so a test needs none of them.
 */
import type * as P from '@dither-chat/protocol';

/** One place someone is in now. */
export interface VoicePlace {
  conversationId: string;
  /** For the icon's tooltip: "In voice in #hangout · Dither", "In a call with you". */
  words: string;
}

export interface VoiceNow {
  /** By person id: where each is. A person with two accounts in two places has both. */
  byPerson: Map<string, VoicePlace[]>;
  /** By identity id, for identities no person stands for as well as those one does. */
  byIdentity: Map<string, VoicePlace[]>;
  /** A voice channel's own row: how many are in it, and their names. */
  channels: Map<string, { n: number; words: string }>;
}

/** What the builder looks up in the client's copy of the hub's data; the test gives its own. */
export interface VoiceLook {
  conv(id: string): Pick<P.ConversationView, 'id' | 'shape' | 'peerPersonId'> | undefined;
  personOf(identityId: string): string | null;
  isSelf(identityId: string): boolean;
  name(identityId: string): string;
  /** "#hangout · Dither" for a channel, a group's title for a group. */
  placeName(conversationId: string): string;
}

type Call = Pick<P.CallView, 'conversationId' | 'participants' | 'state' | 'ringing'>;
type Active = { conversationId: string; phase: 'connecting' | 'live' | 'ended'; participants: { id: string }[] };

/** The lookup, from plain inputs. Your own identities are never in it. Entries in a stable order (the input's). */
export function buildVoiceNow(channels: Iterable<Pick<P.VoiceChannelView, 'conversationId' | 'members'>>, calls: Iterable<Call>, active: Active | null, look: VoiceLook): VoiceNow {
  const now: VoiceNow = { byPerson: new Map(), byIdentity: new Map(), channels: new Map() };
  const add = (identityId: string | null, personId: string | null, conversationId: string, words: string) => {
    const put = (m: Map<string, VoicePlace[]>, key: string) => {
      const list = m.get(key) ?? [];
      if (!list.some((p) => p.conversationId === conversationId)) list.push({ conversationId, words });
      m.set(key, list);
    };
    if (identityId) put(now.byIdentity, identityId);
    if (personId) put(now.byPerson, personId);
  };
  const callWords = (conversationId: string, voiceChannel: boolean) => {
    const c = look.conv(conversationId);
    if (voiceChannel) return `In voice in ${look.placeName(conversationId)}`;
    return c?.shape === 'direct' ? 'In a call with you' : `In a call in ${look.placeName(conversationId)}`;
  };
  const voiceIds = new Set<string>();
  for (const v of channels) {
    if (!v.members.length) continue;
    voiceIds.add(v.conversationId);
    const others = v.members.filter((m) => !look.isSelf(m.identityId));
    for (const m of others) add(m.identityId, look.personOf(m.identityId), v.conversationId, callWords(v.conversationId, true));
    if (others.length) now.channels.set(v.conversationId, { n: others.length, words: `In voice: ${others.map((m) => look.name(m.identityId)).join(', ')}` });
  }
  const inCall = (conversationId: string, ids: string[]) => {
    const words = callWords(conversationId, voiceIds.has(conversationId));
    const c = look.conv(conversationId);
    let any = false;
    for (const id of ids) {
      if (look.isSelf(id)) continue;
      const person = look.personOf(id);
      add(id, person, conversationId, words);
      any = true;
    }
    // A one-to-one call going on: the other side is in it, whether or not the network lists them.
    if (!any && c?.shape === 'direct' && c.peerPersonId) add(null, c.peerPersonId, conversationId, words);
  };
  for (const c of calls) if (c.state === 'ongoing' && !c.ringing) inCall(c.conversationId, c.participants);
  if (active && active.phase !== 'ended') inCall(active.conversationId, active.participants.map((p) => p.id));
  return now;
}

/** The lookup as text, the same whenever who is where is: a mute or a speaking light does not change it. */
export function voiceNowText(v: VoiceNow): string {
  return JSON.stringify([[...v.byPerson], [...v.byIdentity], [...v.channels]]);
}

/** The lookup back from its text. */
export function voiceNowFrom(text: string): VoiceNow {
  const [byPerson, byIdentity, channels] = JSON.parse(text) as [[string, VoicePlace[]][], [string, VoicePlace[]][], [string, { n: number; words: string }][]];
  return { byPerson: new Map(byPerson), byIdentity: new Map(byIdentity), channels: new Map(channels) };
}

/** Where a person (or, without one, an identity) is now, leaving out the conversations given (a row's own: its call mark shows those). */
export function placesOf(now: VoiceNow, who: { person?: string | null; identity?: string | null }, skip: readonly string[] = []): VoicePlace[] {
  const list = (who.person ? now.byPerson.get(who.person) : undefined) ?? (who.identity ? now.byIdentity.get(who.identity) : undefined) ?? [];
  return list.filter((p) => !skip.includes(p.conversationId));
}
