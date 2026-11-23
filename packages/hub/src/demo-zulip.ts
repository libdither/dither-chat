/**
 * The demo world's Zulip organization (DITHER_DEMO_SCENARIO=zulip), as dither-accounts' Zulip extractor sends one
 * (its docs/zulip.md): the organization a community, a channel folder a section, each channel a forum that takes no
 * messages of its own, each topic a thread of it with its id lowercased. Everyone and everything here is made up.
 *
 * What it exercises: more topics in a channel than the sidebar's six, unread ones among older read ones, a mention in
 * one, a muted topic with unread messages, a resolved topic (Zulip's ✔ in front of its name, read as archived), a
 * message moved from another topic (`extra.movedAt`), a direct message, and profiles with a time zone.
 */
import type * as P from '@dither-chat/protocol';
import type { AccountRow } from './store.ts';
import type { InprocAdapter } from './supervisor.ts';

export const DEMO_ZULIP_ACCOUNT = { id: 'acc_demo-zulip', network: 'zulip' as const, label: 'lab', color: '#6492FE' };

/** On only in its scenario: the default world's counts are what the tests and perf baselines expect. */
export const demoZulipOn = () => (process.env.DITHER_DEMO_SCENARIO ?? '').split(',').includes('zulip');

export const ZULIP_HOST = 'chat.example.org';
const MIN = 60_000;
const RESOLVED = '✔ ';

const user = (id: number) => `${ZULIP_HOST}/u/${id}`;
const channel = (id: number) => `${ZULIP_HOST}/s/${id}`;
/** A topic's id: its name lowercased without a resolved topic's ✔, as the extractor's Ids.topic. */
export const zulipTopic = (stream: number, name: string) => `${ZULIP_HOST}/s/${stream}/t/${encodeURIComponent((name.startsWith(RESOLVED) ? name.slice(RESOLVED.length) : name).toLowerCase())}`;

interface Person {
  id: number;
  name: string;
  zone: string;
  role: string;
}
const ME: Person = { id: 8, name: 'You', zone: 'America/Chicago', role: 'Member' };
const PEOPLE: Person[] = [
  { id: 11, name: 'Ada Park', zone: 'Europe/Berlin', role: 'Administrator' },
  { id: 12, name: 'Ben Ortiz', zone: 'America/Los_Angeles', role: 'Member' },
  { id: 13, name: 'Cleo Wu', zone: 'Asia/Tokyo', role: 'Moderator' },
];
const [ADA, BEN, CLEO] = PEOPLE as [Person, Person, Person];

interface Topic {
  stream: number;
  name: string;
  /** Messages, oldest first: [minutes ago, who, body, mentions you]. */
  msgs: [number, Person, string, boolean?][];
  /** How many of the newest are unread. */
  unread?: number;
  muted?: boolean;
  followed?: boolean;
  /** This message (by its index) was moved here from another topic, this many minutes ago. */
  moved?: [index: number, minutesAgo: number];
}

const DESIGN = 10;
const GENERAL = 11;
const RELEASES = 12;

const TOPICS: Topic[] = [
  {
    stream: DESIGN,
    name: 'Color tokens',
    msgs: [
      [190, ADA, 'Proposal: name tokens by role, not by hue.'],
      [150, CLEO, 'Agreed. `surface`, `text`, `accent`, and a muted step for each.'],
      [40, BEN, 'Draft is in the design file, comments welcome.'],
      [12, ADA, '@**You** can you check the contrast on the muted steps?', true],
    ],
    unread: 2,
    followed: true,
  },
  {
    stream: DESIGN,
    name: 'Spacing scale',
    msgs: [
      [300, BEN, 'Do we keep the 4px grid?'],
      [25, CLEO, 'Yes, with 2px only inside dense tables.'],
    ],
    unread: 1,
  },
  {
    stream: DESIGN,
    name: `${RESOLVED}Icon sizes`,
    msgs: [
      [2 * 1440, CLEO, 'Icons at 16 and 20, or 16 and 24?'],
      [2 * 1440 - 30, ADA, '16 and 20. Settled.'],
    ],
  },
  { stream: DESIGN, name: 'Dark mode', msgs: [[3 * 1440, BEN, 'Dark palette shipped behind the flag.']] },
  { stream: DESIGN, name: 'Typography', msgs: [[4 * 1440, ADA, 'One family, two weights.']] },
  { stream: DESIGN, name: 'Motion', msgs: [[5 * 1440, CLEO, 'Keep transitions under 200 ms.']] },
  { stream: DESIGN, name: 'Grid', msgs: [[6 * 1440, BEN, 'Twelve columns on wide screens.']] },
  { stream: DESIGN, name: 'Empty states', msgs: [[7 * 1440, ADA, 'Each empty list says what goes there.']] },
  {
    stream: GENERAL,
    name: 'Lunch plans',
    msgs: [
      [80, BEN, 'Noodles on Thursday?'],
      [70, CLEO, 'In.'],
    ],
    unread: 1,
  },
  { stream: GENERAL, name: 'Welcome', msgs: [[30 * 1440, ADA, 'Welcome to the lab organization.']] },
  {
    stream: RELEASES,
    name: 'v2.4',
    msgs: [
      [600, ADA, 'Release notes for 2.4 are drafted.'],
      [500, BEN, 'The changelog line about tokens belongs here, not in design.'],
      [480, ADA, 'Tagging tomorrow morning.'],
    ],
    moved: [1, 450],
  },
  {
    stream: RELEASES,
    name: 'Nightly builds',
    msgs: [
      [200, CLEO, 'Nightly 812 passed.'],
      [150, CLEO, 'Nightly 813 passed.'],
      [100, CLEO, 'Nightly 814 passed.'],
    ],
    unread: 3,
    muted: true,
  },
];

const CHANNELS: { id: number; name: string; topic: string; folder?: boolean }[] = [
  { id: DESIGN, name: 'design', topic: 'Tokens, components and the design file', folder: true },
  { id: RELEASES, name: 'releases', topic: 'What ships, and when', folder: true },
  { id: GENERAL, name: 'general', topic: 'Everything else' },
];

const DM_BEN = `${ZULIP_HOST}/dm/${[ME.id, BEN.id].sort((a, b) => a - b).join(',')}`;

export class DemoZulip implements InprocAdapter {
  private emit!: (ev: P.AdapterEvent) => void;
  private epoch = 0;
  private resolved = new Map<string, boolean>();
  /** Messages sent here and topics started here, numbered on from the seeded ones. */
  private sent = 0;

  constructor(
    private acc: AccountRow,
    _dir: string,
  ) {}

  private name(t: Topic): string {
    const id = zulipTopic(t.stream, t.name);
    const bare = t.name.startsWith(RESOLVED) ? t.name.slice(RESOLVED.length) : t.name;
    return (this.resolved.get(id) ?? t.name.startsWith(RESOLVED)) ? RESOLVED + bare : bare;
  }

  private topicFact(t: Topic): P.ConversationFact {
    const name = this.name(t);
    return {
      nativeId: zulipTopic(t.stream, t.name),
      shape: 'thread',
      variant: 'text',
      name,
      parentConversation: channel(t.stream),
      archived: name.startsWith(RESOLVED),
      mute: t.muted ? { muted: true } : t.followed ? { level: 'all' } : {},
      thread: { joined: !!t.followed, ...(t.followed ? { notify: 'all' as const } : t.muted ? { muted: true } : {}) },
      lastMessageAt: this.epoch - t.msgs[t.msgs.length - 1]![0] * MIN,
    };
  }

  start(emit: (ev: P.AdapterEvent) => void) {
    this.emit = emit;
    this.epoch = JSON.parse(this.acc.config || '{}').epoch ?? Date.now();
    const at = (min: number) => this.epoch - min * MIN;
    emit({ t: 'hello', network: 'zulip', version: 'demo', capabilities: ['send', 'history', 'markRead', 'threads', 'listThreads', 'followThreads', 'threadState', 'forumPosts', 'profile', 'about'] });
    emit({ t: 'status', status: 'online', self: { nativeId: user(ME.id), displayName: ME.name, isSelf: true, contact: true } });
    for (const p of PEOPLE) emit({ t: 'identity', identity: { nativeId: user(p.id), displayName: p.name, contact: true } });
    emit({ t: 'space', space: { nativeId: ZULIP_HOST, kind: 'community', name: 'Example Lab', topic: 'A made-up Zulip organization' } });
    emit({ t: 'space', space: { nativeId: `${ZULIP_HOST}/f/1`, kind: 'section', name: 'Product', parents: [{ nativeId: ZULIP_HOST, position: '000001' }] } });
    for (const c of CHANNELS) {
      const newest = Math.min(...TOPICS.filter((t) => t.stream === c.id).map((t) => t.msgs[t.msgs.length - 1]![0]));
      emit({
        t: 'conversation',
        conversation: { nativeId: channel(c.id), shape: 'channel', variant: 'forum', name: c.name, topic: c.topic, spaces: [{ nativeId: c.folder ? `${ZULIP_HOST}/f/1` : ZULIP_HOST }], mute: {}, forum: { tags: [], sort: 'activity', layout: 'list' }, lastMessageAt: at(newest) },
      });
    }
    let n = 1000;
    for (const t of TOPICS) {
      const conv = zulipTopic(t.stream, t.name);
      emit({ t: 'conversation', conversation: this.topicFact(t) });
      t.msgs.forEach(([min, who, body, mention], i) => {
        const moved = t.moved?.[0] === i ? { movedAt: at(t.moved[1]) } : null;
        emit({ t: 'message', live: false, message: { nativeId: `${ZULIP_HOST}/m/${n++}`, conversation: conv, author: user(who.id), ts: at(min), body, ...(mention ? { mentionsSelf: true } : {}), ...(moved ? { extra: moved } : {}) } });
      });
      const unread = t.unread ?? 0;
      const first = t.msgs.length - unread;
      const mentions = t.msgs.slice(first).filter((m) => m[3]).length;
      emit({ t: 'read', conversation: conv, upToTs: unread ? at(t.msgs[first]![0]) - 1 : at(t.msgs[t.msgs.length - 1]![0]), unread, mentions });
    }
    emit({ t: 'conversation', conversation: { nativeId: DM_BEN, shape: 'direct', participants: [user(ME.id), user(BEN.id)], lastMessageAt: at(55) } });
    emit({ t: 'message', live: false, message: { nativeId: `${ZULIP_HOST}/m/${n++}`, conversation: DM_BEN, author: user(BEN.id), ts: at(60), body: 'Got a minute for the token review later?' } });
    emit({ t: 'message', live: false, message: { nativeId: `${ZULIP_HOST}/m/${n++}`, conversation: DM_BEN, author: user(ME.id), ts: at(55), body: 'After three works.' } });
    emit({ t: 'read', conversation: DM_BEN, upToTs: at(55), unread: 0, mentions: 0 });
  }

  private about(p: Person): P.PersonAbout {
    return { displayName: p.name, timeZone: p.zone, facts: [{ label: 'Role', value: p.role }, { label: 'Time zone', value: p.zone }] };
  }

  command(cmd: P.AdapterCommand) {
    const reply = (result?: unknown) => 'id' in cmd && this.emit({ t: 'reply', id: cmd.id, ok: true, result });
    const fail = (error: string) => 'id' in cmd && this.emit({ t: 'reply', id: cmd.id, ok: false, error });
    switch (cmd.t) {
      case 'profile': {
        const p = [ME, ...PEOPLE].find((x) => user(x.id) === cmd.who);
        return p ? reply(this.about(p)) : fail('no such user');
      }
      case 'about': {
        const t = TOPICS.find((x) => zulipTopic(x.stream, x.name) === cmd.target.nativeId);
        if (!t) return reply({ fields: {} } satisfies P.About);
        const name = this.name(t);
        return reply({ fields: { name: { value: name, canEdit: false } }, thread: { archived: name.startsWith(RESOLVED), locked: false, canArchive: true, canLock: false, joined: !!t.followed, muted: !!t.muted } } satisfies P.About);
      }
      case 'threadState': {
        const t = TOPICS.find((x) => zulipTopic(x.stream, x.name) === cmd.conversation);
        if (!t || cmd.archived === undefined) return fail('Zulip has no such topic');
        this.resolved.set(cmd.conversation, cmd.archived);
        this.emit({ t: 'conversation', conversation: this.topicFact(t) });
        return reply({});
      }
      case 'threads': {
        const ids = TOPICS.filter((t) => channel(t.stream) === cmd.conversation && this.name(t).startsWith(RESOLVED) === cmd.archived).map((t) => zulipTopic(t.stream, t.name));
        return reply({ count: ids.length, more: false, ids } satisfies P.ThreadsResult);
      }
      case 'history':
        return reply({ count: 0, done: true } satisfies P.HistoryResult);
      // A message to a topic, and a new topic with its first message (the channel stream's box, docs/threads.md).
      case 'send': {
        const nativeId = `${ZULIP_HOST}/m/sent-${++this.sent}`;
        this.emit({ t: 'message', live: true, message: { nativeId, conversation: cmd.conversation, author: user(ME.id), ts: Date.now(), body: cmd.body } });
        return reply({ nativeId });
      }
      case 'createPost': {
        const c = CHANNELS.find((x) => channel(x.id) === cmd.conversation);
        if (!c) return fail('Zulip has no such channel');
        const name = cmd.name.trim();
        const conversation = zulipTopic(c.id, name);
        this.emit({ t: 'conversation', conversation: { nativeId: conversation, shape: 'thread', variant: 'text', name, parentConversation: channel(c.id), mute: {}, thread: { joined: true }, lastMessageAt: Date.now() } });
        this.emit({ t: 'message', live: true, message: { nativeId: `${ZULIP_HOST}/m/sent-${++this.sent}`, conversation, author: user(ME.id), ts: Date.now(), body: cmd.body } });
        return reply({ conversation } satisfies P.CreateThreadResult);
      }
      case 'markRead':
        return reply({});
      default:
        if ('id' in cmd) fail('the demo Zulip account cannot do that');
    }
  }

  stop() {}
}
