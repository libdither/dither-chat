/**
 * The demo world's moderating (docs/moderation.md): removing, banning, admins, roles, timeouts, ending a group, member
 * labels, leaving a Signal group (naming who takes over as admin), and others' messages and reactions. Answers the way
 * the Signal and Discord adapters do (dither-accounts extractors/signal and extractors/discord), so the hub and pages
 * read the same against either. demo.ts hands the commands here and lets this add to each About; all of it is in
 * memory, until the hub restarts or the demo world is made again.
 */
import type * as P from '@dither-chat/protocol';
import { BAN_DELETE_CHOICES, MEMBER_LABEL_MAX, memberLabelProblem, modRefusal, TIMEOUT_DURATIONS } from '@dither-chat/protocol';

export interface DemoModHost {
  network: P.Network;
  selfId: string;
  emit: (ev: P.AdapterEvent) => void;
  /** Whether the account runs this place (an admin, the demo's Maintainer). */
  admin: (target: P.AboutTarget) => boolean;
  /** The Discord server a conversation is in, or the server itself. */
  guildOf: (target: P.AboutTarget) => string | null;
  /** The About as demo.ts makes it, before what this adds. */
  about: (target: P.AboutTarget) => P.About;
}

export const DEMO_MOD_CAPS: Partial<Record<P.Network, P.Capability[]>> = {
  discord: ['moderate', 'setPicture'],
  signal: ['moderate', 'memberLabels', 'setPicture', 'leave'],
};

interface Place {
  removed: Set<string>;
  banned: Set<string>;
  admins: Map<string, boolean>;
  roles: Map<string, Set<string>>;
  timeouts: Map<string, number>;
  labels: Map<string, { text?: string; emoji?: string }>;
  /** Server-muted and server-deafened people, and where people were moved (null: disconnected). */
  voice: Map<string, { muted?: boolean; deafened?: boolean; channel?: string | null }>;
  ended: boolean;
}

const NOT_ADMIN = 'Only admins can do this.';
const ELSEWHERE = 'The audit log, AutoMod, pruning, emoji and integrations: open Discord.';

export class DemoModeration {
  private places = new Map<string, Place>();
  private left = new Set<string>();

  constructor(private h: DemoModHost) {}

  private place(id: string): Place {
    let p = this.places.get(id);
    if (!p) this.places.set(id, (p = { removed: new Set(), banned: new Set(), admins: new Map(), roles: new Map(), timeouts: new Map(), labels: new Map(), voice: new Map(), ended: false }));
    return p;
  }

  /** The key a place's moderation lives under: a Signal group itself, a Discord server for any of its channels. */
  private key(target: P.AboutTarget): string {
    return this.h.network === 'discord' ? (this.h.guildOf(target) ?? target.nativeId) : target.nativeId;
  }

  /** Is this a place moderated here: a Signal group, or anything in a Discord server? */
  private moderated(target: P.AboutTarget, about: P.About): boolean {
    if (this.h.network === 'signal') return target.kind === 'conversation' && about.noun === 'Group';
    return this.h.network === 'discord' && !!this.h.guildOf(target);
  }

  /** What this adds to an About: who is gone, admins, roles and labels as changed here, and the account's powers. */
  about(target: P.AboutTarget, about: P.About): P.About {
    if (!this.moderated(target, about)) return about;
    if (this.left.has(target.nativeId)) {
      // As Signal's apps keep a group you left, read-only.
      const gone = 'You are no longer in this group.';
      const fields = Object.fromEntries(Object.entries(about.fields).map(([k, f]) => [k, { ...f!, canEdit: false, reason: gone }])) as P.AboutFields;
      const no = { can: false, reason: gone };
      return { ...about, fields, ...(about.adding ? { adding: { ...about.adding, ...no } } : {}), moderation: { remove: no, ban: no, admins: no, end: no }, leaving: no };
    }
    const p = this.place(this.key(target));
    const admin = this.h.admin(target) && !p.ended;
    const self = this.h.selfId;
    const members = about.members && {
      ...about.members,
      list: about.members.list
        .filter((m) => !p.removed.has(m.id) && !p.banned.has(m.id))
        .map((m): P.AboutMember => {
          if (this.h.network === 'signal') {
            const isAdmin = p.admins.get(m.id) ?? (m.rank ?? 0) >= 100;
            const label = p.labels.get(m.id);
            return { ...m, role: isAdmin ? 'Admin' : 'Member', rank: isAdmin ? 100 : 0, ...(label ? { label } : {}), ...(m.id === self ? { mod: { above: true, reason: 'That is you.' } } : {}) };
          }
          const roles = [...(p.roles.get(m.id) ?? [])];
          const above = m.id === self || (m.rank ?? 0) >= 100;
          const until = p.timeouts.get(m.id);
          return { ...m, mod: { ...(above ? { above: true, reason: m.id === self ? 'That is you.' : 'They have a role as high as yours.' } : {}), roles, ...(until && until > Date.now() ? { timedOutUntil: until } : {}) } };
        }),
    };
    const no = (reason: string): P.ModPower => ({ can: false, reason });
    const yes: P.ModPower = { can: true };
    if (this.h.network === 'signal') {
      const list = members?.list ?? [];
      const admins = list.filter((m) => m.rank === 100);
      const onlyAdmin = admin && admins.length === 1 && list.length > 1;
      const out = p.ended ? 'This group has been ended.' : NOT_ADMIN;
      return {
        ...about,
        ...(members ? { members } : {}),
        ...(p.ended ? { fields: Object.fromEntries(Object.entries(about.fields).map(([k, f]) => [k, { ...f!, canEdit: false, reason: out }])) as P.AboutFields } : {}),
        ...(about.fields.avatar ? { fields: { ...about.fields, avatar: { ...about.fields.avatar, canEdit: admin, ...(admin ? {} : { reason: out }) } } } : {}),
        moderation: {
          remove: admin ? yes : no(out),
          ban: admin ? yes : no(out),
          admins: admin ? yes : no(out),
          end: admin ? yes : no(out),
          banned: [...p.banned],
        },
        label: { value: p.labels.get(self)?.text ?? null, emoji: p.labels.get(self)?.emoji ?? null, canEdit: !p.ended, ...(p.ended ? { reason: out } : {}), max: MEMBER_LABEL_MAX },
        leaving: { can: true, ...(onlyAdmin ? { needsAdmin: true, warning: 'You are its only admin: name who becomes admin as you leave.' } : {}), canForget: true },
      };
    }
    const need = (perm: string) => no(`You need the ${perm} permission.`);
    const assignable = (about.roles ?? []).filter((r) => r.rank > 0 && r.rank < 100).map((r) => r.id);
    const icon = target.kind === 'space' && about.fields.avatar ? { fields: { ...about.fields, avatar: { ...about.fields.avatar, canEdit: admin, ...(admin ? {} : { reason: 'You need the Manage Server permission.' }) } } } : {};
    return {
      ...about,
      ...icon,
      ...(members ? { members } : {}),
      moderation: {
        remove: admin ? yes : need('Kick Members'),
        ban: admin ? { can: true, deleteHistory: BAN_DELETE_CHOICES } : need('Ban Members'),
        roles: admin ? { can: true, assignable } : { ...need('Manage Roles'), assignable: [] },
        timeout: admin ? { can: true, durations: TIMEOUT_DURATIONS } : { ...need('Timeout Members'), durations: TIMEOUT_DURATIONS },
        voiceMute: admin ? yes : need('Mute Members'),
        voiceDeafen: admin ? yes : need('Deafen Members'),
        voiceMove: admin ? yes : need('Move Members'),
        bansOnRequest: true,
        elsewhere: ELSEWHERE,
      },
    };
  }

  /** What this account may do to others' messages in a conversation. */
  messages(target: P.AboutTarget): P.MessageModeration | undefined {
    const about = this.h.about(target);
    if (!this.moderated(target, about) || !this.h.admin(target) || this.place(this.key(target)).ended) return undefined;
    return this.h.network === 'discord' ? { delete: true, reactions: true } : { delete: true };
  }

  /** The moderating commands; null for anything else. Throws the network's refusal in words. */
  command(cmd: P.AdapterCommand): { value: unknown } | null {
    switch (cmd.t) {
      case 'moderate':
        return { value: this.moderate(cmd.target, cmd.action) };
      case 'bans': {
        const p = this.place(this.key(cmd.target));
        return { value: { banned: [...p.banned].map((id) => ({ id, reason: 'Demo ban' })) } satisfies P.BansResult };
      }
      case 'setLabel': {
        const problem = memberLabelProblem(cmd.text, cmd.emoji);
        if (problem) throw new Error(problem);
        const target = { kind: 'conversation' as const, nativeId: cmd.conversation };
        const p = this.place(this.key(target));
        if (p.ended) throw new Error('This group has been ended.');
        if (cmd.text) p.labels.set(this.h.selfId, { text: cmd.text, ...(cmd.emoji ? { emoji: cmd.emoji } : {}) });
        else p.labels.delete(this.h.selfId);
        return { value: this.about(target, this.h.about(target)) };
      }
      case 'clearReactions':
        if (!this.messages({ kind: 'conversation', nativeId: cmd.conversation })?.reactions) throw new Error('You need the Manage Messages permission here.');
        return { value: {} };
      case 'leave': {
        if (this.h.network !== 'signal') return null;
        const about = this.about(cmd.target, this.h.about(cmd.target));
        if (about.leaving?.needsAdmin && !cmd.admins?.length) throw new Error('You are the only admin: name who becomes admin first.');
        // No leave event: the group stays, read-only, with its history (as the Signal adapter does).
        this.left.add(cmd.target.nativeId);
        return { value: { left: true } satisfies P.LeaveResult };
      }
      default:
        return null;
    }
  }

  private moderate(target: P.AboutTarget, a: P.ModAction): P.About {
    const about = this.about(target, this.h.about(target));
    const member = a.op === 'end' ? undefined : about.members?.list.find((m) => m.id === a.who);
    const refusal = modRefusal(about.moderation, a, member?.mod, !!member);
    if (refusal) throw new Error(refusal);
    const p = this.place(this.key(target));
    const line = (body: string) => this.h.emit({ t: 'message', live: true, message: { nativeId: `mod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, conversation: target.nativeId, author: this.h.selfId, ts: Date.now(), kind: 'system', body } });
    switch (a.op) {
      case 'remove':
        p.removed.add(a.who);
        if (this.h.network === 'signal') line('You removed someone from the group.');
        break;
      case 'ban':
        p.banned.add(a.who);
        if (this.h.network === 'signal') line('You banned someone from the group.');
        break;
      case 'unban':
        p.banned.delete(a.who);
        p.removed.add(a.who);
        break;
      case 'admin':
        p.admins.set(a.who, !a.remove);
        this.h.emit({ t: 'role', target, member: a.who, role: 'Admin', given: !a.remove, by: this.h.selfId, ts: Date.now() });
        break;
      case 'role': {
        const set = p.roles.get(a.who) ?? new Set<string>();
        if (a.remove) set.delete(a.role);
        else set.add(a.role);
        p.roles.set(a.who, set);
        const name = about.roles?.find((r) => r.id === a.role)?.name ?? 'a role';
        this.h.emit({ t: 'role', target: { kind: 'space', nativeId: this.key(target) }, member: a.who, role: name, given: !a.remove, by: this.h.selfId, ts: Date.now() });
        break;
      }
      case 'timeout':
        if (a.seconds) p.timeouts.set(a.who, Date.now() + a.seconds * 1000);
        else p.timeouts.delete(a.who);
        break;
      case 'end':
        p.ended = true;
        line('You ended the group.');
        break;
      case 'voiceMute':
      case 'voiceDeafen':
      case 'move':
      case 'disconnect': {
        const v = p.voice.get(a.who) ?? {};
        if (a.op === 'voiceMute') v.muted = a.on;
        else if (a.op === 'voiceDeafen') v.deafened = a.on;
        else if (a.op === 'move') {
          if (this.h.guildOf({ kind: 'conversation', nativeId: a.to }) !== this.key(target)) throw new Error('That voice channel is in another server.');
          v.channel = a.to;
        } else v.channel = null;
        p.voice.set(a.who, v);
        break;
      }
    }
    return this.about(target, this.h.about(target));
  }
}
