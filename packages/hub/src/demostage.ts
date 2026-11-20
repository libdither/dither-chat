/**
 * The demo world's stage (docs/calls.md "Demo calls"): a stage channel in the libdither server with a topic, the call
 * room's bot and two more people speaking, an audience of invented people, two hands up, and the main demo account a
 * moderator there, sound only (no cameras). The call room (democalls.ts) carries the devices' audio as for any call; this lays the stage over
 * the room's state: everyone's role, the people who are only simulated (their speaking flags take turns), and the
 * stage actions, which change roles as Discord's would and are allowed by the same rule the device's buttons follow
 * (protocol stageRights). A simulated person invited to speak accepts a moment later.
 *
 * Roles start over once the last device leaves, so each run of scripts/verify-stage-demo.ts sees the same stage.
 */
import type * as P from '@dither-chat/protocol';
import { stageMoveFits, stageRights } from '@dither-chat/protocol';
import { snow } from './demo-ids.ts';

type Emit = (ev: P.AdapterEvent) => void;

/** One simulated person on the stage. */
interface StagePerson {
  identity: P.IdentityFact;
  role: P.StageRole;
  rank?: P.StageRank;
  /** With a hand up: when it went up. */
  askedAt?: number;
}

interface StageSeed {
  /** The stage channel's native id. */
  channel: string;
  topic: string;
  /** Native ids of the accounts that moderate here (their own client says so to them). */
  moderators: string[];
  /** The room's bot: a speaker here, and a moderator. */
  bot: string;
  people: StagePerson[];
}

interface Call {
  id: string;
  self: string;
  emit: Emit;
  /** The room's last state for this call, before the stage is laid over it. */
  room: P.CallState | null;
}

/** How long a simulated person takes to accept an invitation to speak. */
const ACCEPT_MS = 1500;
/** How often the simulated speakers take turns. */
const TURN_MS = 1200;

export class DemoStage {
  private calls = new Map<string, Call>();
  /** Roles of the devices' own selves on the stage, by native id. Everyone joins in the audience. */
  private selves = new Map<string, P.StageRole>();
  /** When a device's own hand went up, by native id. */
  private asked = new Map<string, number>();
  private people: StagePerson[];
  private turn = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    readonly seed: StageSeed,
    private clock: { every: (fn: () => void, ms: number) => ReturnType<typeof setInterval>; stop: (t: ReturnType<typeof setInterval>) => void; later: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; now: () => number } = {
      every: (fn, ms) => setInterval(fn, ms),
      stop: (t) => clearInterval(t),
      later: (fn, ms) => setTimeout(fn, ms),
      now: () => Date.now(),
    },
  ) {
    this.people = this.fresh();
  }

  /** The seed's people as the stage starts: the hands up went up a few minutes ago, one after another. */
  private fresh(): StagePerson[] {
    const t = this.clock.now();
    let n = 0;
    return this.seed.people.map((p) => ({ ...p, ...(p.role === 'hand' ? { askedAt: t - (10 - n++) * 60_000 } : {}) }));
  }

  /** The identities a device's adapter tells the hub about before it joins, so the room can name them. */
  get identities(): P.IdentityFact[] {
    return this.seed.people.map((p) => p.identity);
  }

  /** A device joins the stage: the room's events for its call go through the emit this returns. */
  join(call: string, self: string, emit: Emit): Emit {
    this.calls.set(call, { id: call, self, emit, room: null });
    this.selves.set(self, 'audience');
    if (!this.timer) this.timer = this.clock.every(() => this.tick(), TURN_MS);
    return (ev) => this.event(call, ev);
  }

  leave(call: string) {
    const c = this.calls.get(call);
    if (!c) return;
    this.calls.delete(call);
    if (![...this.calls.values()].some((x) => x.self === c.self)) {
      this.selves.delete(c.self);
      this.asked.delete(c.self);
    }
    if (this.calls.size) return this.push();
    // The last device left: the stage starts over for the next one.
    if (this.timer) this.clock.stop(this.timer);
    this.timer = null;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    this.people = this.fresh();
    this.selves.clear();
    this.asked.clear();
    this.turn = 0;
  }

  has(call: string): boolean {
    return this.calls.has(call);
  }

  /** The room's event for one call: its state gets the stage laid over it, the rest goes on as it is. */
  private event(call: string, ev: P.AdapterEvent) {
    const c = this.calls.get(call);
    if (!c) return;
    if (ev.t === 'call' && ev.state) {
      c.room = ev.state;
      c.emit({ ...ev, state: this.over(c) });
    } else c.emit(ev);
    if (ev.t === 'call' && ev.ended) this.leave(call);
  }

  /** Who is speaking among the simulated speakers now: one at a time, with a pause between turns. */
  private speakingNow(): string | null {
    const speakers = this.people.filter((p) => p.role === 'speaker');
    if (!speakers.length || this.turn % 4 === 3) return null;
    return speakers[Math.floor(this.turn / 4) % speakers.length].identity.nativeId;
  }

  private roleOf(id: string): P.StageRole {
    if (id === this.seed.bot) return 'speaker';
    return this.selves.get(id) ?? this.people.find((p) => p.identity.nativeId === id)?.role ?? 'audience';
  }

  private rankOf(id: string): P.StageRank | undefined {
    return id === this.seed.bot || this.seed.moderators.includes(id) ? 'moderator' : this.people.find((p) => p.identity.nativeId === id)?.rank;
  }

  /** A hand's time: a device's own, or a simulated person's. */
  private askedOf(id: string): number | undefined {
    return this.asked.get(id) ?? this.people.find((p) => p.identity.nativeId === id)?.askedAt;
  }

  /** One call's state: the room's people with their roles, then the simulated ones. */
  over(c: Call): P.CallState {
    const room = c.room ?? { conversation: this.seed.channel, participants: [] };
    const speaking = this.speakingNow();
    const inRoom = new Set(room.participants.map((p) => p.id));
    const roomPeople = room.participants.map((p): P.CallParticipant => {
      const stage = this.roleOf(p.id);
      // Only a speaker is heard on a stage, and the demo's stage is sound only: the bot's camera and Go Live stay off.
      const { video: _v, streaming: _s, ...rest } = p;
      const rank = this.rankOf(p.id);
      const askedAt = stage === 'hand' ? this.askedOf(p.id) : undefined;
      return { ...rest, stage, speaking: stage === 'speaker' && p.speaking, ...(stage !== 'speaker' ? { muted: true } : {}), ...(rank ? { stageRank: rank } : {}), ...(askedAt !== undefined ? { askedAt } : {}) };
    });
    const simulated = this.people
      .filter((p) => !inRoom.has(p.identity.nativeId))
      .map((p): P.CallParticipant => ({
        id: p.identity.nativeId,
        muted: p.role !== 'speaker',
        deafened: false,
        speaking: p.identity.nativeId === speaking,
        stage: p.role,
        ...(p.rank ? { stageRank: p.rank } : {}),
        ...(p.role === 'hand' && p.askedAt !== undefined ? { askedAt: p.askedAt } : {}),
      }));
    // What this device's account may do now, by the one rule (stageRights), said outright as an adapter does.
    return { ...room, participants: [...roomPeople, ...simulated], video: [], stage: { topic: this.seed.topic, ...this.rights(c.self) } };
  }

  private rights(self: string): { can: P.StageSelfAction[]; canOn: P.StageMove[] } {
    return stageRights(undefined, this.roleOf(self), this.rankOf(self));
  }

  private push() {
    for (const c of this.calls.values()) if (c.room) c.emit({ t: 'call', call: c.id, state: this.over(c) });
  }

  tick() {
    this.turn++;
    this.push();
  }

  /** A stage action from one device: allowed by the same rule its buttons follow. Returns a refusal in words, or null when done. */
  action(call: string, action: P.StageAction, user?: string): string | null {
    const c = this.calls.get(call);
    if (!c) return 'Not on this stage.';
    const me = this.selves.get(c.self) ?? 'audience';
    const { can, canOn } = this.rights(c.self);
    const set = (role: P.StageRole) => {
      this.selves.set(c.self, role);
      if (role === 'hand') this.asked.set(c.self, this.clock.now());
      else this.asked.delete(c.self);
    };
    switch (action) {
      case 'raiseHand':
      case 'lowerHand':
      case 'speak':
      case 'listen':
        if (!can.includes(action)) return SELF_NO[action](me);
        set(action === 'raiseHand' ? 'hand' : action === 'speak' ? 'speaker' : 'audience');
        break;
      case 'invite':
      case 'audience': {
        if (!canOn.includes(action)) return 'Only a moderator can do that.';
        if (!user) return 'Whom?';
        const self = this.selves.has(user) ? user : null;
        const person = this.people.find((p) => p.identity.nativeId === user);
        if (!self && !person) return 'Nobody by that id on this stage.';
        const now = self ? this.selves.get(self)! : person!.role;
        if (!stageMoveFits(action, now)) return action === 'invite' ? 'They are speaking already.' : 'They are in the audience already.';
        const to: P.StageRole = action === 'invite' ? 'invited' : 'audience';
        if (self) {
          this.selves.set(self, to);
          this.asked.delete(self);
        } else {
          person!.role = to;
          delete person!.askedAt;
          // A simulated person says yes a moment later, as people do.
          if (action === 'invite') {
            const t = this.clock.later(() => {
              this.pending.delete(t);
              if (person!.role === 'invited') {
                person!.role = 'speaker';
                this.push();
              }
            }, ACCEPT_MS);
            this.pending.add(t);
          }
        }
        break;
      }
      default:
        return 'Not a stage action.';
    }
    this.push();
    return null;
  }
}

/** Why a stage refuses one of your own actions, by where you are. */
const SELF_NO: Record<P.StageSelfAction, (me: P.StageRole) => string> = {
  raiseHand: (me) => (me === 'hand' ? 'Your hand is up already.' : me === 'audience' ? 'You may speak without asking.' : 'You are not in the audience.'),
  lowerHand: () => 'Your hand is not up.',
  speak: (me) => (me === 'speaker' ? 'You are speaking already.' : 'Only a moderator or someone invited can speak.'),
  listen: () => 'You are in the audience already.',
};

const sid = (k: string, name: string, handle: string): P.IdentityFact => ({ nativeId: snow(`stage-${k}`), displayName: name, handle });

/** The demo stage's own people: two speakers and an audience of twenty, all invented. */
export function demoStageSeed(channel: string, moderators: string[], bot: string): StageSeed {
  const speakers: StagePerson[] = [
    { identity: sid('ines', 'Inés Varga', 'ines.v'), role: 'speaker', rank: 'moderator' },
    { identity: sid('tobi', 'Tobi Achterberg', 'tobi.a'), role: 'speaker' },
  ];
  const audience = [
    ['amaru', 'Amaru'], ['bex', 'Bex'], ['calla', 'Calla'], ['dov', 'Dov'], ['eira', 'Eira'], ['fitz', 'Fitz'], ['gaia', 'Gaia'],
    ['halvor', 'Halvor'], ['isko', 'Isko'], ['jun', 'Jun'], ['kesi', 'Kesi'], ['loic', 'Loïc'], ['marisol', 'Marisol'], ['nilo', 'Nilo'],
    ['odile', 'Odile'], ['pax', 'Pax'], ['rafi', 'Rafi'], ['senna', 'Senna'], ['tuva', 'Tuva'], ['vesna', 'Vesna'],
  ].map(([k, name], i): StagePerson => ({ identity: sid(k, name, `${k}.listens`), role: i === 2 || i === 9 ? 'hand' : 'audience' }));
  return { channel, topic: 'Office hours: routing questions', moderators, bot, people: [...speakers, ...audience] };
}
