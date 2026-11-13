/**
 * The demo world's servers beyond their channels (docs/servers.md): scheduled events, saying Interested, leaving,
 * a server's rules and onboarding after a join, your nickname, and invite links with limits. Answers the way the
 * Discord adapter does (dither-accounts extractors/discord/src/servers.ts), so the hub and pages read the same
 * against either. demo.ts hands each Discord account's commands here.
 */
import type * as P from '@dither-chat/protocol';
import { DISCORD_INVITE_OPTIONS, gateAnswerProblem, NICK_MAX, nickProblem } from '@dither-chat/protocol';

/** What this needs of a demo account. */
export interface DemoServerHost {
  key: string;
  selfId: string;
  emit: (ev: P.AdapterEvent) => void;
  /** The communities (guild ids) the account is in now. */
  guilds: () => string[];
  /** What the account leaves with a server: its categories and channels. */
  childrenOf: (guild: string) => { spaces: string[]; convs: string[] };
  /** Whether the account runs this server (the demo's Maintainer, taken as its owner). */
  admin: (guild: string) => boolean;
}

export const DEMO_SERVER_CAPS: P.Capability[] = ['events', 'rsvp', 'leave', 'gates', 'inviteLinks', 'nick'];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The next weekday (0 Monday) at hh:00 UTC after t. */
function nextWeekday(t: number, day: number, hh: number): number {
  const d = new Date(t);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh);
  const dow = (new Date(base).getUTCDay() + 6) % 7;
  let add = (day - dow + 7) % 7;
  if (add === 0 && base <= t) add = 7;
  return base + add * DAY;
}

export interface DemoServerIds {
  rust: string;
  dither: string;
  hk: string;
  pixel: string;
  rustVoice: string;
  ditherVoice: string;
  /** Someone in the demo world, as a creator. */
  lev: string;
}

/** Per account: the events it sees, its answers, its gates and nicknames, its invite links. */
export class DemoServers {
  private events = new Map<string, P.ScheduledEventFact>();
  private gates = new Map<string, P.SpaceGate[]>();
  private nicks = new Map<string, string>();
  private links = new Map<string, P.InviteLinkFact[]>();
  private left = new Set<string>();

  constructor(
    private h: DemoServerHost,
    private ids: DemoServerIds,
    epoch: number,
  ) {
    const tue = nextWeekday(epoch, 1, 17);
    const all: P.ScheduledEventFact[] = [
      {
        nativeId: 'evt-rust-office',
        space: ids.rust,
        name: 'Rust office hours',
        description: 'Bring a borrow checker error you cannot shake. Mentors in the voice channel for an hour.',
        start: tue,
        end: tue + HOUR,
        status: 'scheduled',
        place: { kind: 'voice', conversation: ids.rustVoice },
        interested: 214,
        youInterested: false,
        rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
        exceptions: [{ nativeId: 'ex-rust-office-2', original: tue + 14 * DAY, cancelled: true }],
      },
      {
        nativeId: 'evt-dither-sync',
        space: ids.dither,
        name: 'Dither sync',
        description: 'Routing table review and what is next for the coordinate space.',
        start: epoch + 2 * DAY,
        end: epoch + 2 * DAY + HOUR,
        status: 'scheduled',
        place: { kind: 'voice', conversation: ids.ditherVoice },
        interested: 6,
        youInterested: h.key === 'dmain',
        creator: h.selfId,
      },
      {
        nativeId: 'evt-dither-meetup',
        space: ids.dither,
        name: 'Meetup at the lab',
        start: epoch + 9 * DAY,
        end: epoch + 9 * DAY + 3 * HOUR,
        status: 'scheduled',
        place: { kind: 'external', location: 'Hackerspace, 2nd floor' },
        interested: 3,
        youInterested: false,
        creator: ids.lev,
      },
      {
        nativeId: 'evt-hk-race',
        space: ids.hk,
        name: 'Any% race night',
        start: epoch + 3 * DAY,
        status: 'scheduled',
        place: { kind: 'external', location: 'https://www.twitch.tv/' },
        interested: 41,
        youInterested: false,
      },
    ];
    for (const e of all) this.events.set(e.nativeId, e);
    // A server joined from the demo's invite asks for its rules, then what you want to see.
    this.gates.set(ids.pixel, [
      {
        space: ids.pixel,
        kind: 'rules',
        description: 'Read and agree to the rules before you post.',
        rules: ['Be kind. Critique the art, not the artist.', 'Credit palettes and references.', 'No AI-generated submissions in the weekly challenge.'],
        version: '2026-10-01T00:00:00.000Z',
      },
      {
        space: ids.pixel,
        kind: 'onboarding',
        prompts: [
          {
            id: 'p-what',
            title: 'What do you make?',
            single: false,
            required: true,
            options: [
              { id: 'o-sprites', title: 'Sprites', emoji: '👾' },
              { id: 'o-tiles', title: 'Tilesets', emoji: '🧱' },
              { id: 'o-anim', title: 'Animation', emoji: '🎞️' },
            ],
          },
          { id: 'p-weekly', title: 'Join the weekly challenge?', single: true, required: false, options: [{ id: 'o-yes', title: 'Yes, ping me' }, { id: 'o-no', title: 'Just watching' }] },
        ],
      },
    ]);
  }

  private mine(space: string): P.ScheduledEventFact[] {
    return [...this.events.values()].filter((e) => e.space === space);
  }

  /** On start: every server's events, one list each. */
  announce() {
    for (const guild of this.h.guilds()) if (!this.left.has(guild)) this.h.emit({ t: 'scheduledEvents', space: guild, events: this.mine(guild) });
  }

  /** A server just joined: its gate comes as an event, as the real adapter tells it after the join. */
  joined(guild: string) {
    this.left.delete(guild);
    const g = this.gates.get(guild)?.[0] ?? null;
    if (g) this.h.emit({ t: 'gate', space: guild, gate: g });
  }

  private inGuild(space: string) {
    if (this.left.has(space) || !this.h.guilds().includes(space)) throw new Error('This demo account is not in that server');
  }

  /** The About of a server with what this adds: leaving, your nickname, invite links. */
  about(target: P.AboutTarget, about: P.About, community: boolean): P.About {
    if (target.kind !== 'space' || !community) return about;
    const owner = this.h.admin(target.nativeId);
    const links = this.links.get(target.nativeId) ?? [];
    return {
      ...about,
      leaving: owner ? { can: false, reason: 'You own this server: Discord lets you leave only after you give it to someone else (Server Settings → Members) or delete it, in Discord.' } : { can: true },
      nick: { value: this.nicks.get(target.nativeId) ?? null, canEdit: true, max: NICK_MAX },
      ...(about.invite
        ? {
            invite: {
              ...about.invite,
              link: links[0]?.url ?? about.invite.link,
              links,
              options: DISCORD_INVITE_OPTIONS,
              ...(target.nativeId === this.ids.dither ? { vanity: 'https://discord.gg/libdither' } : {}),
            },
          }
        : {}),
    };
  }

  /** An invite change on a server, done here (true), or left to demo.ts (false). */
  configureInvite(target: P.AboutTarget, change: P.AboutChange): boolean {
    if (target.kind !== 'space' || change.key !== 'invite') return false;
    const list = this.links.get(target.nativeId) ?? [];
    if (change.op === 'create') {
      const code = `demo${(Date.now() + list.length).toString(36)}`;
      const maxAge = change.maxAge ?? DISCORD_INVITE_OPTIONS.defaults.maxAge;
      list.unshift({ code, url: `https://discord.gg/${code}`, inviter: this.h.selfId, uses: 0, maxUses: change.maxUses ?? 0, ...(maxAge ? { expiresAt: Date.now() + maxAge * 1000 } : {}), ...(change.temporary ? { temporary: true } : {}), canRevoke: true });
    } else {
      const i = change.code ? list.findIndex((l) => l.code === change.code) : 0;
      if (i < 0 || !list.length) throw new Error('That link is gone already');
      list.splice(i, 1);
    }
    this.links.set(target.nativeId, list);
    return true;
  }

  /** The commands this handles: { value } when it did, undefined for any other. Throws a sentence when Discord would refuse. */
  command(cmd: P.AdapterCommand): { value: unknown } | undefined {
    switch (cmd.t) {
      case 'scheduledEvents':
        this.inGuild(cmd.space);
        return { value: { events: this.mine(cmd.space) } satisfies P.ScheduledEventsResult };
      case 'rsvp': {
        this.inGuild(cmd.space);
        const e = this.events.get(cmd.event);
        if (!e || e.space !== cmd.space) throw new Error('Unknown event');
        let next: P.ScheduledEventFact;
        if (cmd.occurrence) {
          const ex = [...(e.exceptions ?? [])];
          const i = ex.findIndex((x) => x.nativeId === cmd.occurrence || String(x.original) === cmd.occurrence);
          if (i >= 0) ex[i] = { ...ex[i], youInterested: cmd.interested };
          else ex.push({ nativeId: cmd.occurrence, original: Number(cmd.occurrence) || 0, youInterested: cmd.interested });
          next = { ...e, exceptions: ex };
        } else {
          const was = e.youInterested === true;
          next = { ...e, youInterested: cmd.interested, interested: Math.max(0, (e.interested ?? 0) + (cmd.interested === was ? 0 : cmd.interested ? 1 : -1)) };
        }
        this.events.set(e.nativeId, next);
        this.h.emit({ t: 'scheduledEvent', event: next });
        return { value: next };
      }
      case 'leave': {
        if (cmd.target.kind !== 'space') throw new Error('Leaving a group DM is not in the demo');
        this.inGuild(cmd.target.nativeId);
        if (this.h.admin(cmd.target.nativeId)) throw new Error('You own this server: give it to someone else first');
        const kids = this.h.childrenOf(cmd.target.nativeId);
        for (const c of kids.convs) this.h.emit({ t: 'leave', kind: 'conversation', nativeId: c });
        for (const s of kids.spaces) this.h.emit({ t: 'leave', kind: 'space', nativeId: s });
        this.h.emit({ t: 'leave', kind: 'space', nativeId: cmd.target.nativeId });
        this.left.add(cmd.target.nativeId);
        return { value: { left: true } satisfies P.LeaveResult };
      }
      case 'gate':
        return { value: this.gates.get(cmd.space)?.[0] ?? null };
      case 'answerGate': {
        const list = this.gates.get(cmd.space) ?? [];
        const g = list[0];
        if (!g) throw new Error('This server asks nothing of you now');
        const problem = gateAnswerProblem(g, cmd.answer);
        if (problem) throw new Error(problem);
        list.shift();
        const next = list[0] ?? null;
        this.h.emit({ t: 'gate', space: cmd.space, gate: next });
        return { value: { done: true, next } satisfies P.GateResult };
      }
      case 'setNick': {
        this.inGuild(cmd.space);
        const problem = nickProblem(cmd.nick);
        if (problem) throw new Error(problem);
        if (cmd.nick.trim()) this.nicks.set(cmd.space, cmd.nick.trim());
        else this.nicks.delete(cmd.space);
        return { value: null };
      }
      default:
        return undefined;
    }
  }
}
