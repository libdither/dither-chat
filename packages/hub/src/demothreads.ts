/**
 * The demo world's threads, forums and group DMs beyond messages (docs/threads.md): following a thread and how it
 * notifies, archiving and locking, starting threads and forum posts with tags, publishing, a channel's archived
 * threads, and running a group DM the demo account owns. Answers the way the Discord adapter does (dither-accounts
 * extractors/discord/src/threads.ts), so the hub and pages read the same against either. demo.ts hands each Discord
 * account's commands here.
 */
import type * as P from '@dither-chat/protocol';
import { postProblem, threadNameProblem } from '@dither-chat/protocol';

export const DEMO_THREAD_CAPS: P.Capability[] = ['followThreads', 'createThreads', 'forumPosts', 'threadState', 'myThreads', 'crosspost', 'removeMembers', 'transferOwner', 'groupPicture'];

/** What this needs of a demo account. */
export interface DemoThreadHost {
  selfId: string;
  emit: (ev: P.AdapterEvent) => void;
  /** The account's conversation fact for a native id, as demo.ts keeps it. */
  fact: (nativeId: string) => P.ConversationFact | null;
  /** Keep a new thread or post among the account's conversations, so it takes sends. */
  keep: (fact: P.ConversationFact) => void;
  /** The account may manage threads where this channel is (the demo's Maintainer). */
  moderator: (channel: string) => boolean;
  /** A fresh id. */
  id: (key: string) => string;
}

/** The demo's forum and what is in it, for one account. */
export interface DemoThreadWorld {
  /** Forums with their tags. */
  forums: Record<string, P.ForumFact>;
  /** Threads with their starting facts (tags, owner, joined). */
  threads: Record<string, P.ThreadFact>;
  /** Archived threads a channel lists on request, with their first message; `mine`: private ones you are in. */
  archived: { fact: P.ConversationFact; first: Omit<P.MessageFact, 'conversation'>; mine?: boolean }[];
  /** Group DMs the demo account owns. */
  owns: string[];
}

export class DemoThreads {
  private facts = new Map<string, P.ThreadFact>();
  /** Archived or not, as changed here; else as the fact says. */
  private archivedNow = new Map<string, boolean>();
  private lockedNow = new Set<string>();
  private owners = new Map<string, string>();
  private gone = new Map<string, Set<string>>();
  private pictures = new Map<string, string | null>();

  constructor(
    private h: DemoThreadHost,
    private w: DemoThreadWorld,
  ) {
    for (const [id, f] of Object.entries(w.threads)) this.facts.set(id, { ...f });
    for (const g of w.owns) this.owners.set(g, h.selfId);
  }

  /** A thread's or group's conversation fact as it stands now. */
  private now(nativeId: string): P.ConversationFact {
    const base = this.h.fact(nativeId) ?? this.w.archived.find((a) => a.fact.nativeId === nativeId)?.fact;
    if (!base) throw new Error('Discord does not know that');
    if (base.shape === 'group') {
      const gone = this.gone.get(nativeId) ?? new Set();
      const pic = this.pictures.get(nativeId);
      return { ...base, participants: (base.participants ?? []).filter((p) => !gone.has(p)), ...(pic !== undefined ? (pic ? { avatarUrl: pic } : { avatarUrl: undefined }) : {}) };
    }
    const archived = this.archivedNow.get(nativeId) ?? !!base.archived;
    const f = { ...(this.facts.get(nativeId) ?? {}), ...(this.lockedNow.has(nativeId) ? { locked: true } : {}) };
    // A thread's membership is its native mute, as the adapter tells it.
    const mute: P.NativeMute | undefined = f.joined === false ? { level: 'mentions' } : f.joined ? { ...(f.notify ? { level: f.notify } : {}), ...(f.muted ? { muted: true } : {}), ...(f.mutedUntil ? { until: f.mutedUntil } : {}) } : undefined;
    return { ...base, archived, thread: f, ...(mute ? { mute } : {}) };
  }

  private tell(nativeId: string): P.ConversationFact {
    const f = this.now(nativeId);
    this.h.emit({ t: 'conversation', conversation: f });
    return f;
  }

  /** Every forum's tags and every thread's facts, after the account's conversations went out. */
  announce() {
    for (const [id, forum] of Object.entries(this.w.forums)) {
      const base = this.h.fact(id);
      if (base) this.h.emit({ t: 'conversation', conversation: { ...base, forum } });
    }
    for (const id of this.facts.keys()) if (this.h.fact(id)) this.tell(id);
  }

  /** The archived threads of a channel, told with their first messages. */
  archived(channel: string, mine: boolean): string[] {
    const list = this.w.archived.filter((a) => a.fact.parentConversation === channel && (!mine || a.mine));
    for (const a of list) {
      this.h.emit({ t: 'conversation', conversation: { ...a.fact, archived: true } });
      this.h.emit({ t: 'message', live: false, message: { ...a.first, conversation: a.fact.nativeId } });
    }
    return list.map((a) => a.fact.nativeId);
  }

  /** A thread's About part; a group's owner, removing, its picture and leaving; a DM's closing. */
  about(target: P.AboutTarget, about: P.About): P.About {
    if (target.kind !== 'conversation') return about;
    const c = this.h.fact(target.nativeId) ?? this.w.archived.find((a) => a.fact.nativeId === target.nativeId)?.fact;
    if (!c) return about;
    if (c.shape === 'thread') {
      const f = this.now(target.nativeId);
      const mod = this.h.moderator(c.parentConversation ?? '');
      const own = f.thread?.owner === this.h.selfId;
      const locked = !!f.thread?.locked;
      const canArchive = mod || (own && !locked);
      return {
        ...about,
        thread: {
          archived: !!f.archived,
          locked,
          canArchive,
          canLock: mod,
          ...(!canArchive ? { reason: locked ? 'It is locked: only someone with Manage Threads may open it again.' : 'You need the Manage Threads permission, or to have started the thread.' } : {}),
          joined: f.thread?.joined === true,
          ...(f.thread?.notify ? { notify: f.thread.notify } : {}),
          ...(f.thread?.muted ? { muted: true } : {}),
        },
      };
    }
    if (c.shape === 'group') {
      const owner = this.owners.get(c.nativeId);
      const youOwn = owner === this.h.selfId;
      const now = this.now(c.nativeId);
      const others = (now.participants ?? []).filter((p) => p !== this.h.selfId).length;
      const list = about.members?.list.filter((m) => !this.gone.get(c.nativeId)?.has(m.id)).map((m) => (m.id === owner ? { ...m, role: 'Group owner', rank: 100 } : m));
      return {
        ...about,
        ...(about.members && list ? { members: { ...about.members, list } } : {}),
        fields: { ...about.fields, avatar: { value: this.pictures.get(c.nativeId) ?? about.fields.avatar?.value ?? null, canEdit: true } },
        ownership: { ...(owner ? { owner } : {}), youOwn, canRemove: youOwn && others > 0, canTransfer: youOwn && others > 0, ...(!youOwn ? { reason: 'Only the group owner may do this.' } : {}) },
        leaving: { can: true, silent: true, ...(youOwn && others ? { warning: 'You own this group: Discord makes someone else in it its owner.' } : {}) },
      };
    }
    if (c.shape === 'direct') return { ...about, leaving: { can: true, warning: 'Closing it only hides it in Discord: it comes back when either of you writes.' } };
    return about;
  }

  /** The commands this answers: their reply's value, or null for one that is not its own. */
  command(cmd: P.AdapterCommand, about: (target: P.AboutTarget) => P.About): { value: unknown } | null {
    switch (cmd.t) {
      case 'followThread': {
        const f = this.facts.get(cmd.conversation) ?? {};
        this.facts.set(cmd.conversation, cmd.follow ? { ...f, joined: true } : { ...f, joined: false, notify: undefined, muted: undefined, mutedUntil: undefined });
        return { value: this.tell(cmd.conversation).thread };
      }
      case 'threadNotify': {
        const f = this.facts.get(cmd.conversation) ?? {};
        this.facts.set(cmd.conversation, {
          ...f,
          joined: true,
          ...(cmd.notify ? { notify: cmd.notify } : {}),
          ...(typeof cmd.muted === 'boolean' ? { muted: cmd.muted || undefined, mutedUntil: cmd.muted ? cmd.until : undefined } : {}),
        });
        return { value: this.tell(cmd.conversation).thread };
      }
      case 'threadState': {
        const t = about({ kind: 'conversation', nativeId: cmd.conversation }).thread;
        if (!t) throw new Error('That is not a thread');
        if (cmd.archived !== undefined && cmd.archived !== t.archived && !t.canArchive) throw new Error(t.reason ?? 'You may not');
        if (cmd.locked !== undefined && cmd.locked !== t.locked && !t.canLock) throw new Error('You need the Manage Threads permission.');
        if (cmd.archived !== undefined) this.archivedNow.set(cmd.conversation, cmd.archived);
        if (cmd.locked === true) this.lockedNow.add(cmd.conversation);
        if (cmd.locked === false) {
          this.lockedNow.delete(cmd.conversation);
          const f = this.facts.get(cmd.conversation);
          if (f) this.facts.set(cmd.conversation, { ...f, locked: undefined });
        }
        this.tell(cmd.conversation);
        return { value: about({ kind: 'conversation', nativeId: cmd.conversation }) };
      }
      case 'createThread': {
        const problem = threadNameProblem(cmd.name);
        if (problem) throw new Error(problem);
        const parent = this.h.fact(cmd.conversation);
        if (!parent || parent.shape !== 'channel') throw new Error('Discord does not know that channel');
        const nativeId = this.h.id(`thread-${cmd.name}`);
        const fact: P.ConversationFact = { nativeId, shape: 'thread', name: cmd.name.trim(), parentConversation: cmd.conversation, ...(parent.variant === 'announcement' ? { variant: 'announcement' } : {}) };
        this.facts.set(nativeId, { joined: true, owner: this.h.selfId, createdAt: Date.now(), ...(cmd.private ? { private: true } : {}) });
        this.h.keep(fact);
        this.tell(nativeId);
        if (cmd.body?.trim()) this.h.emit({ t: 'message', live: false, message: { nativeId: this.h.id(`m-${nativeId}`), conversation: nativeId, author: this.h.selfId, ts: Date.now(), body: cmd.body } });
        return { value: { conversation: nativeId } satisfies P.CreateThreadResult };
      }
      case 'createPost': {
        const forum = this.w.forums[cmd.conversation];
        if (!forum) throw new Error('That is not a forum Discord knows');
        const problem = postProblem({ name: cmd.name, body: cmd.body, tags: cmd.tags, files: cmd.attachments?.length ?? 0 }, forum);
        if (problem) throw new Error(problem);
        const nativeId = this.h.id(`post-${cmd.name}`);
        this.facts.set(nativeId, { joined: true, owner: this.h.selfId, createdAt: Date.now(), tags: cmd.tags ?? [], messageCount: 0 });
        this.h.keep({ nativeId, shape: 'thread', name: cmd.name.trim(), parentConversation: cmd.conversation });
        this.tell(nativeId);
        // A post's first message has the post's own id.
        this.h.emit({ t: 'message', live: false, message: { nativeId, conversation: nativeId, author: this.h.selfId, ts: Date.now(), body: cmd.body } });
        return { value: { conversation: nativeId } satisfies P.CreateThreadResult };
      }
      case 'crosspost': {
        const c = this.h.fact(cmd.conversation);
        if (c?.variant !== 'announcement') throw new Error('Only a message in an announcement channel is published');
        return { value: {} };
      }
      case 'removeMember':
      case 'setOwner': {
        const o = about(cmd.target).ownership;
        if (!o) throw new Error('Only a group DM has an owner');
        if (cmd.t === 'removeMember' ? !o.canRemove : !o.canTransfer) throw new Error(o.reason ?? 'You may not');
        if (cmd.t === 'removeMember') this.gone.set(cmd.target.nativeId, new Set([...(this.gone.get(cmd.target.nativeId) ?? []), cmd.who]));
        else this.owners.set(cmd.target.nativeId, cmd.who);
        this.tell(cmd.target.nativeId);
        return { value: about(cmd.target) };
      }
      case 'setPicture': {
        if (cmd.picture && !/^image\/(png|jpeg|gif|webp)$/.test(cmd.picture.mime)) throw new Error('A picture is a PNG, JPEG, GIF or WebP');
        this.pictures.set(cmd.target.nativeId, cmd.picture ? `https://cdn.discordapp.com/channel-icons/${cmd.target.nativeId}/demo.webp` : null);
        this.tell(cmd.target.nativeId);
        return { value: about(cmd.target) };
      }
      case 'leave': {
        if (cmd.target.kind !== 'conversation') return null;
        const c = this.h.fact(cmd.target.nativeId);
        if (!c || (c.shape !== 'group' && c.shape !== 'direct')) throw new Error("Leaving a channel or thread isn't something Discord does: leave its server, or unfollow the thread");
        if (c.shape === 'group') this.h.emit({ t: 'leave', kind: 'conversation', nativeId: c.nativeId });
        return { value: { left: true } satisfies P.LeaveResult };
      }
      default:
        return null;
    }
  }
}
