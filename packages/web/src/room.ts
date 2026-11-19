/**
 * A call as a room (docs/calls.md "The room view"): every live audio thing is a room with roles. A call is a room where
 * everyone speaks; a stage (and later an X Space) is one where a few speak and the rest listen. This sorts a call's
 * people into the room's zones by role, with nothing network-specific in it; ui/CallRoom.tsx draws them.
 */
import type * as P from '@dither-chat/protocol';

export interface Room {
  /** The room has an audience at all: a stage. Without one everyone is a speaker. */
  staged: boolean;
  speakers: P.CallParticipant[];
  /** Listening, invited and hands up, in that order: you, then hands, then invited, then the rest. */
  audience: P.CallParticipant[];
  /** Asking to speak, in the order they were listed. */
  hands: P.CallParticipant[];
  /** Your own role here ('speaker' in a room without an audience). */
  me: P.StageRole;
  /** You may invite people to speak and move speakers to the audience. */
  moderator: boolean;
}

const AUDIENCE_ORDER: Record<P.StageRole, number> = { speaker: 0, hand: 1, invited: 2, audience: 3 };

export function roomOf(participants: P.CallParticipant[], isSelf: (id: string) => boolean, stage?: P.CallStage): Room {
  if (!stage) return { staged: false, speakers: participants, audience: [], hands: [], me: 'speaker', moderator: false };
  const role = (p: P.CallParticipant): P.StageRole => p.stage ?? 'audience';
  const speakers = participants.filter((p) => role(p) === 'speaker');
  const audience = participants
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => role(p) !== 'speaker')
    .sort((a, b) => Number(isSelf(b.p.id)) - Number(isSelf(a.p.id)) || AUDIENCE_ORDER[role(a.p)] - AUDIENCE_ORDER[role(b.p)] || a.i - b.i)
    .map(({ p }) => p);
  const me = participants.find((p) => isSelf(p.id));
  return { staged: true, speakers, audience, hands: participants.filter((p) => role(p) === 'hand'), me: me ? role(me) : 'audience', moderator: stage.moderator };
}

/** The room's line under its title: "3 speaking · 21 listening". */
export function roomCounts(r: Room): string {
  if (!r.staged) return `${r.speakers.length} ${r.speakers.length === 1 ? 'person' : 'people'}`;
  return `${r.speakers.length} speaking · ${r.audience.length} listening`;
}
