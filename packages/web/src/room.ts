/**
 * A call as a room (docs/calls.md "The room view"): every live audio thing is a room with roles. A call is a room where
 * everyone speaks; a stage (a Discord stage, later an X Space) is one where a few speak and the rest listen. This sorts
 * a call's people into the room's zones by role, with nothing network-specific in it; ui/CallRoom.tsx draws them.
 */
import type * as P from '@dither-chat/protocol';

export interface Room {
  /** The room has an audience at all: a stage. Without one everyone is a speaker. */
  staged: boolean;
  speakers: P.CallParticipant[];
  /** Everyone not speaking: you first, then hands up (oldest first), then invited, then the rest. */
  audience: P.CallParticipant[];
  /** How many listen in all: the stage's own count when it sends only some of them (a big Space), else the audience's. */
  listening: number;
  /** Asking to speak, oldest first. */
  hands: P.CallParticipant[];
  /** Your own role here ('speaker' in a room without an audience). */
  me: P.StageRole;
}

const AUDIENCE_ORDER: Record<P.StageRole, number> = { speaker: 0, hand: 1, invited: 2, audience: 3 };
const role = (p: P.CallParticipant): P.StageRole => p.stage ?? 'audience';

/** Hands first by when they went up (those without a time after, as listed). */
function byAsked(a: { p: P.CallParticipant; i: number }, b: { p: P.CallParticipant; i: number }): number {
  return (a.p.askedAt ?? Infinity) - (b.p.askedAt ?? Infinity) || a.i - b.i;
}

/** Who asks to speak, oldest first; never you. */
export function requestsOf(participants: P.CallParticipant[], isSelf: (id: string) => boolean): P.CallParticipant[] {
  return participants
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => role(p) === 'hand' && !isSelf(p.id))
    .sort(byAsked)
    .map(({ p }) => p);
}

/**
 * The room's zones. `staged`: the room has an audience, from the call's stage facts or, while they are still on their
 * way, from the conversation being a stage, so a stage never flashes up as a plain call while it connects.
 */
export function roomOf(participants: P.CallParticipant[], isSelf: (id: string) => boolean, stage: Pick<P.CallStage, 'listeners'> | undefined, staged = !!stage): Room {
  if (!staged) return { staged: false, speakers: participants, audience: [], listening: 0, hands: [], me: 'speaker' };
  const speakers = participants.filter((p) => role(p) === 'speaker');
  const audience = participants
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => role(p) !== 'speaker')
    .sort((a, b) => Number(isSelf(b.p.id)) - Number(isSelf(a.p.id)) || AUDIENCE_ORDER[role(a.p)] - AUDIENCE_ORDER[role(b.p)] || (role(a.p) === 'hand' ? byAsked(a, b) : a.i - b.i))
    .map(({ p }) => p);
  const me = participants.find((p) => isSelf(p.id));
  const hands = participants
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => role(p) === 'hand')
    .sort(byAsked)
    .map(({ p }) => p);
  return { staged: true, speakers, audience, listening: Math.max(stage?.listeners ?? 0, audience.length), hands, me: me ? role(me) : 'audience' };
}

/** The room's line under its title: "3 speakers · 21 listening". */
export function roomCounts(r: Room): string {
  const n = (k: number, one: string, many: string) => `${k.toLocaleString('en')} ${k === 1 ? one : many}`;
  if (!r.staged) return n(r.speakers.length, 'person', 'people');
  return `${n(r.speakers.length, 'speaker', 'speakers')} · ${r.listening.toLocaleString('en')} listening`;
}

/**
 * The whole audience as the "+N more" list shows it: matching `query` (in a name, any case), people you know first
 * (`known`: higher first), then as the room has them.
 */
export function audienceList(audience: P.CallParticipant[], query: string, nameOf: (id: string) => string, known: (id: string) => number): P.CallParticipant[] {
  const q = query.trim().toLowerCase();
  return audience
    .map((p, i) => ({ p, i, k: known(p.id) }))
    .filter(({ p }) => !q || nameOf(p.id).toLowerCase().includes(q))
    .sort((a, b) => b.k - a.k || a.i - b.i)
    .map(({ p }) => p);
}

/** What a rank says under a speaker's name ("Speaker" without one). */
export const RANK_WORDS: Record<P.StageRank, string> = { host: 'Host', cohost: 'Co-host', moderator: 'Moderator' };
