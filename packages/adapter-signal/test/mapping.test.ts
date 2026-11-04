/**
 * Envelope -> fact mapping, against fixtures in the exact JSON shapes
 * signal-cli 0.14 writes (the `params` of a JSON-RPC `receive` notification:
 * `{account, envelope}`, assembled from its Json* records: JsonMessageEnvelope,
 * JsonDataMessage, JsonSyncDataMessage with the data message unwrapped into
 * it, JsonQuote, JsonMention, JsonTextStyle, JsonAttachment, JsonReaction,
 * JsonEditMessage, JsonSyncReadMessage, JsonTypingMessage, JsonCallMessage).
 *
 * People: self 5f2c7a8e-…-0001 (+15550100), Alice a11ce000-…-0002 (+15550137),
 * Sam 5a3e0000-…-0003 (+15550161); group Pmpi+EfPW…MwI= ("Climbing crew 🧗").
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterEvent, MessageFact } from '@dither-chat/protocol';
import {
  contactIdentity,
  describeGroupChange,
  directConversation,
  displayNameOf,
  groupConversation,
  type MapContext,
  mapReceive,
  noteToSelf,
  parseConversation,
  parseMsgId,
} from '../src/mapping.ts';
import type { SigContact, SigGroup, SigReceive } from '../src/types.ts';

const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const ALICE = 'a11ce000-2222-4ccc-9ddd-000000000002';
const SAM = '5a3e0000-3333-4eee-afff-000000000003';
const GID = 'Pmpi+EfPWmsxiomLe9Nx2XF9HOE483p6iKiFj65iMwI=';
const GROUP = `group:${GID}`;
const DM_ALICE = `dm:${SELF}:${ALICE}`;
const T = 1793330000000;
const DIR = '/data/accounts/acc_x/signal-cli';

const fixture = (name: string): SigReceive => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', `${name}.json`), 'utf8'));

const index = new Map<string, string>([
  [`${ALICE}:${T + 2000}`, DM_ALICE],
  [`${ALICE}:${T + 3000}`, DM_ALICE],
]);
const ctx = (over: Partial<MapContext> = {}): MapContext => ({
  self: SELF,
  selfNumber: '+15550100',
  signalDir: DIR,
  conversationOf: (id) => index.get(id),
  knownGroup: (g) => g === GID,
  sticker: (pack, id) => (pack === '9acc9e8aba563d26a4994e69263e3b25' && id === 7 ? { emoji: '🧗', contentType: 'image/webp' } : undefined),
  ...over,
});
const map = (name: string, over?: Partial<MapContext>) => mapReceive(fixture(name), ctx(over));
const of = <K extends AdapterEvent['t']>(events: AdapterEvent[], t: K) => events.filter((e): e is Extract<AdapterEvent, { t: K }> => e.t === t);
const message = (events: AdapterEvent[]): MessageFact => {
  const m = of(events, 'message');
  expect(m).toHaveLength(1);
  expect(m[0].live).toBe(true);
  return m[0].message;
};

describe('incoming data messages', () => {
  test('group text with body ranges and mentions', () => {
    const r = map('text-styles-mentions');
    expect(of(r.events, 'identity')).toEqual([{ t: 'identity', identity: { nativeId: ALICE, handle: '+15550137', displayName: 'Alice Chen' } }]);
    expect(message(r.events)).toEqual({
      nativeId: `${ALICE}:${T + 1000}`,
      conversation: GROUP,
      author: ALICE,
      ts: T + 1000,
      kind: 'text',
      body: `Hey <@${SELF}> and <@${SAM}>, the **purple V4** is *evil*. It was ~~easy~~. Spoiler: ||I flashed it||. Beta: \`heel hook\``,
      mentionsSelf: true,
    });
    expect(of(r.events, 'conversation')).toHaveLength(0); // known group: no stub
    expect(r.messages[0]).toMatchObject({ nativeId: `${ALICE}:${T + 1000}`, conversation: GROUP, author: ALICE, kind: 'text', timer: 0 });
  });

  test('unknown group: stub conversation from groupInfo and a refresh request', () => {
    const r = map('text-styles-mentions', { knownGroup: () => false });
    expect(of(r.events, 'conversation')).toEqual([{ t: 'conversation', conversation: { nativeId: GROUP, shape: 'group', encrypted: true, name: 'Climbing crew 🧗' } }]);
    expect(r.refreshGroups).toEqual([GID]);
  });

  test('reply in a 1:1: replyTo from the quote, quote kept as fallback', () => {
    const r = map('reply-quote');
    expect(of(r.events, 'conversation')).toEqual([{ t: 'conversation', conversation: { nativeId: DM_ALICE, shape: 'direct', participants: [SELF, ALICE], encrypted: true } }]);
    const m = message(r.events);
    expect(m.conversation).toBe(DM_ALICE);
    expect(m.replyTo).toBe(`${SELF}:${T - 60000}`);
    expect(m.body).toBe("perfect, I'll bring the spare chalk bag");
    expect(m.mentionsSelf).toBeUndefined();
    expect(m.extra).toEqual({ quote: { author: SELF, ts: T - 60000, text: 'yes! **7pm** at Mesa?' } });
  });

  test('attachments: file:// under the account dir, long-text attachment dropped', () => {
    const r = map('attachment');
    const m = message(r.events);
    expect(m.kind).toBe('media');
    expect(m.body).toBe('here is the purple V4');
    expect(m.attachments).toEqual([
      { nativeId: 'Xq3vM8kTt0aQ1bC2dE4f.jpg', kind: 'image', mime: 'image/jpeg', name: 'v4.jpg', size: 183424, width: 1600, height: 1200, url: `file://${DIR}/attachments/Xq3vM8kTt0aQ1bC2dE4f.jpg` },
      { nativeId: 'Vn0te1aac2bbb3ccc4dd.aac', kind: 'audio', mime: 'audio/aac', name: 'Vn0te1aac2bbb3ccc4dd.aac', size: 9001, url: `file://${DIR}/attachments/Vn0te1aac2bbb3ccc4dd.aac` },
    ]);
    expect(r.messages[0].files).toEqual([`${DIR}/attachments/Xq3vM8kTt0aQ1bC2dE4f.jpg`, `${DIR}/attachments/Vn0te1aac2bbb3ccc4dd.aac`]);
  });

  test('attachment ids cannot escape the attachments dir', () => {
    const rcv = fixture('attachment');
    rcv.envelope!.dataMessage!.attachments![0].id = '../../../secret.json';
    const m = message(mapReceive(rcv, ctx()).events);
    expect(m.attachments![0].url).toBe(`file://${DIR}/attachments/secret.json`);
  });

  test('reaction add and remove', () => {
    expect(of(map('reaction-add').events, 'reaction')).toEqual([{ t: 'reaction', conversation: GROUP, message: `${ALICE}:${T + 1000}`, author: SAM, key: '🔥' }]);
    expect(of(map('reaction-remove').events, 'reaction')).toEqual([{ t: 'reaction', conversation: GROUP, message: `${ALICE}:${T + 1000}`, author: SAM, key: '🔥', remove: true }]);
    expect(of(map('reaction-add').events, 'message')).toHaveLength(0);
  });

  test('remote delete', () => {
    const r = map('remote-delete');
    expect(of(r.events, 'delete')).toEqual([{ t: 'delete', conversation: DM_ALICE, nativeId: `${ALICE}:${T + 2000}` }]);
    expect(of(r.events, 'message')).toHaveLength(0);
  });

  test('edit re-emits the target message with the new body and editedTs', () => {
    const m = message(map('edit').events);
    expect(m).toMatchObject({
      nativeId: `${ALICE}:${T + 2000}`,
      conversation: DM_ALICE,
      author: ALICE,
      ts: T + 2000,
      editedTs: T + 7000,
      body: "perfect, I'll bring **TWO** chalk bags",
      replyTo: `${SELF}:${T - 60000}`,
    });
    expect(m.attachments).toBeUndefined(); // edits never wipe attachments
  });

  test('group update: system message plus a group refresh', () => {
    const r = map('group-update');
    expect(message(r.events)).toEqual({ nativeId: `${SAM}:${T + 8000}`, conversation: GROUP, author: SAM, ts: T + 8000, kind: 'system', body: 'Sam Rivera updated the group.' });
    expect(r.refreshGroups).toEqual([GID]);
    expect(r.messages[0].groupUpdate).toBe(GID);
  });

  test('sticker', () => {
    const m = message(map('sticker').events);
    expect(m).toMatchObject({ kind: 'sticker', body: '🧗', conversation: GROUP, author: SAM });
    expect(m.attachments).toEqual([{ nativeId: 'sticker:9acc9e8aba563d26a4994e69263e3b25:7', kind: 'image', mime: 'image/webp', name: 'sticker', url: `file://${DIR}/stickers/9acc9e8aba563d26a4994e69263e3b25/7` }]);
  });

  test('disappearing-message timer change is a system message', () => {
    const r = map('expiration-update');
    expect(message(r.events)).toMatchObject({ kind: 'system', body: 'Alice Chen set disappearing messages to 1 week.', conversation: DM_ALICE });
    expect(r.messages[0].timer).toBe(604800);
  });

  test('disappearing message carries its timer and files', () => {
    const r = map('disappearing');
    expect(message(r.events).extra).toEqual({ expiresInSeconds: 3600 });
    expect(r.messages[0]).toMatchObject({ expiresInSeconds: 3600, timer: 3600, files: [`${DIR}/attachments/D00rC0de1jpg2aaa3bbb.jpg`] });
  });

  test('view-once media stays on the phone', () => {
    const m = message(map('view-once').events);
    expect(m.kind).toBe('media');
    expect(m.attachments).toBeUndefined();
    expect(m.extra).toEqual({ viewOnce: true });
  });

  test('incoming call offer', () => {
    expect(message(map('call-offer').events)).toEqual({ nativeId: `${ALICE}:${T + 16000}`, conversation: DM_ALICE, author: ALICE, ts: T + 16000, kind: 'call', body: '📹 Incoming video call' });
  });

  test('group call updates are deduplicated by era', () => {
    const seen = new Set<string>();
    const once = (k: string) => (seen.has(k) ? false : (seen.add(k), true));
    expect(message(map('group-call', { once }).events)).toMatchObject({ kind: 'call', body: '📞 Sam Rivera started a group call' });
    expect(of(map('group-call', { once }).events, 'message')).toHaveLength(0);
  });

  test('pin, poll', () => {
    expect(message(map('pin').events)).toMatchObject({ kind: 'system', body: 'Alice Chen pinned a message.', replyTo: `${SAM}:${T + 14000}` });
    expect(message(map('poll').events)).toMatchObject({ kind: 'text', body: '📊 **Thursday or Friday?**\n• Thursday\n• Friday' });
  });

  test('housekeeping and failures produce no messages', () => {
    expect(of(map('profile-key-update').events, 'message')).toHaveLength(0);
    const r = map('decrypt-error');
    expect(of(r.events, 'message')).toHaveLength(0);
    expect(r.logs.some((l) => l.level === 'warn' && l.msg.includes('ProtocolInvalidMessageException'))).toBe(true);
  });
});

describe('sync messages (your other devices)', () => {
  test('sentMessage to a 1:1 is authored by you', () => {
    const r = map('sync-sent-dm');
    expect(of(r.events, 'identity')).toHaveLength(0);
    expect(of(r.events, 'conversation').map((e) => e.conversation.nativeId)).toEqual([DM_ALICE]);
    expect(message(r.events)).toEqual({ nativeId: `${SELF}:${T + 9000}`, conversation: DM_ALICE, author: SELF, ts: T + 9000, kind: 'text', body: 'on my way 🚲' });
  });

  test('sentMessage to a group, quoting someone', () => {
    const m = message(map('sync-sent-group').events);
    expect(m).toMatchObject({ nativeId: `${SELF}:${T + 10000}`, conversation: GROUP, author: SELF, body: 'see you all at **7**', replyTo: `${ALICE}:${T + 1000}` });
  });

  test('Note to Self', () => {
    const r = map('sync-sent-note-to-self');
    expect(of(r.events, 'conversation')).toEqual([{ t: 'conversation', conversation: { nativeId: `dm:${SELF}:${SELF}`, shape: 'self', name: 'Note to Self', participants: [SELF], encrypted: true } }]);
    const m = message(r.events);
    expect(m).toMatchObject({ conversation: `dm:${SELF}:${SELF}`, author: SELF, kind: 'media', body: 'whiteboard from today' });
    expect(m.attachments?.[0]).toMatchObject({ kind: 'image', width: 640, height: 400, name: 'whiteboard.png' });
  });

  test('edit sent from the phone', () => {
    expect(message(map('sync-sent-edit').events)).toMatchObject({ nativeId: `${SELF}:${T + 9000}`, conversation: DM_ALICE, author: SELF, ts: T + 9000, editedTs: T + 18000, body: 'on my way 🚲 (5 min)' });
  });

  test('reaction sent from the phone', () => {
    expect(of(map('sync-sent-reaction').events, 'reaction')).toEqual([{ t: 'reaction', conversation: GROUP, message: `${SAM}:${T + 14000}`, author: SELF, key: '👍' }]);
  });

  test('read sync: per conversation, up to the newest read message; unknown messages skipped', () => {
    const r = map('sync-read');
    expect(of(r.events, 'read')).toEqual([{ t: 'read', conversation: DM_ALICE, upToTs: T + 3000 }]);
    expect(r.logs.some((l) => l.msg.includes('not seen'))).toBe(true);
  });

  test('contacts sync asks for a resync', () => {
    expect(map('contacts-sync').resync).toBe(true);
  });
});

describe('typing', () => {
  test('started in a 1:1 and a group, lasting as long as on Signal; stopped says so', () => {
    expect(of(map('typing-dm').events, 'typing')).toEqual([{ t: 'typing', conversation: DM_ALICE, author: ALICE, ttl: 15_000 }]);
    expect(of(map('typing-group').events, 'typing')).toEqual([{ t: 'typing', conversation: GROUP, author: SAM, ttl: 15_000 }]);
    expect(of(map('typing-group-stopped').events, 'typing')).toEqual([{ t: 'typing', conversation: GROUP, author: SAM, stop: true }]);
  });
});

describe('contacts and groups', () => {
  const contact: SigContact = {
    number: '+15550137',
    uuid: ALICE.toUpperCase(),
    name: 'Alice Chen',
    givenName: 'Alice',
    familyName: 'Chen',
    nickGivenName: null,
    isHidden: false,
    profile: { givenName: 'Ali', familyName: null, hasAvatar: false },
  };

  test('listContacts -> contact identity (ACI lowercased, number as handle)', () => {
    expect(contactIdentity(contact, { contact: true })).toEqual({ nativeId: ALICE, handle: '+15550137', displayName: 'Alice Chen', contact: true });
    expect(contactIdentity({ ...contact, uuid: null }, { contact: true })).toBeNull();
    expect(contactIdentity({ ...contact, uuid: SELF }, { contact: true, self: SELF })).toMatchObject({ isSelf: true });
  });

  test('display name priority: nickname, contact name, profile name, username', () => {
    expect(displayNameOf({ ...contact, nickGivenName: 'Al', nickFamilyName: 'C' })).toBe('Al C');
    expect(displayNameOf({ ...contact, name: '' })).toBe('Alice Chen'); // given + family
    expect(displayNameOf({ uuid: SAM, name: '', profile: { givenName: 'Sam', familyName: 'Rivera' } })).toBe('Sam Rivera');
    expect(displayNameOf({ uuid: SAM, name: '', username: 'sam.42' })).toBe('sam.42');
  });

  const group: SigGroup = {
    id: GID,
    name: 'Climbing crew 🧗',
    description: 'thursday nights',
    isMember: true,
    members: [
      { number: '+15550100', uuid: SELF, isAdmin: true },
      { number: '+15550137', uuid: ALICE, isAdmin: false },
      { number: null, uuid: null },
    ],
    permissionSendMessage: 'EVERY_MEMBER',
    messageExpirationTime: 0,
  };

  test('listGroups -> group conversation', () => {
    expect(groupConversation(group)).toEqual({ nativeId: GROUP, shape: 'group', encrypted: true, name: 'Climbing crew 🧗', topic: 'thursday nights', participants: [SELF, ALICE] });
    expect(groupConversation({ ...group, permissionSendMessage: 'ONLY_ADMINS' }).variant).toBe('announcement');
  });

  test('1:1 and Note to Self', () => {
    expect(directConversation(SELF, ALICE)).toEqual({ nativeId: DM_ALICE, shape: 'direct', participants: [SELF, ALICE], encrypted: true });
    expect(directConversation(SELF, SELF)).toEqual(noteToSelf(SELF));
  });

  test('group change descriptions', () => {
    const names = (a: string) => (a === ALICE ? 'Alice' : a === SAM ? 'Sam' : a);
    const withSam = { ...group, members: [...group.members!, { number: '+15550161', uuid: SAM }] };
    expect(describeGroupChange(group, withSam, ALICE, SELF, names)).toBe('Alice added Sam.');
    expect(describeGroupChange(withSam, group, SAM, SELF, names)).toBe('Sam left the group.');
    expect(describeGroupChange(group, { ...group, name: 'Crew' }, SELF, SELF, names)).toBe('You renamed the group to “Crew”.');
    expect(describeGroupChange(group, { ...group, messageExpirationTime: 86400 }, ALICE, SELF, names)).toBe('Alice set disappearing messages to 1 day.');
    expect(describeGroupChange(undefined, group, ALICE, SELF, names)).toBe('Alice updated the group.');
    expect(describeGroupChange({ ...group, permissionEditDetails: 'EVERY_MEMBER' }, { ...group, permissionEditDetails: 'ONLY_ADMINS' }, SELF, SELF, names)).toBe('You changed who can edit group info to “Only admins”.');
    expect(describeGroupChange({ ...group, permissionAddMember: 'ONLY_ADMINS' }, { ...group, permissionAddMember: 'EVERY_MEMBER' }, ALICE, SELF, names)).toBe('Alice changed who can add members to “All members”.');
    const linked = { ...group, groupInviteLink: 'https://signal.group/#a' };
    expect(describeGroupChange({ ...group, groupInviteLink: null }, linked, SELF, SELF, names)).toBe('You turned on the group link.');
    expect(describeGroupChange(linked, { ...group, groupInviteLink: 'https://signal.group/#b' }, SELF, SELF, names)).toBe('You reset the group link.');
    expect(describeGroupChange(linked, { ...group, groupInviteLink: null }, SELF, SELF, names)).toBe('You turned off the group link.');
  });
});

describe('ids', () => {
  test('message ids', () => {
    expect(parseMsgId(`${ALICE}:${T}`)).toEqual({ author: ALICE, ts: T });
    expect(parseMsgId('nope')).toBeNull();
    expect(parseMsgId(`${ALICE}:abc`)).toBeNull();
  });
  test('conversation ids', () => {
    expect(parseConversation(GROUP, SELF)).toEqual({ kind: 'group', groupId: GID });
    expect(parseConversation(DM_ALICE, SELF)).toEqual({ kind: 'dm', peer: ALICE });
    expect(parseConversation(`dm:${SELF}:${SELF}`, SELF)).toEqual({ kind: 'self' });
    expect(parseConversation(`dm:${SAM}:${ALICE}`, SELF)).toBeNull(); // another account's 1:1
    expect(parseConversation('!room:matrix.org', SELF)).toBeNull();
  });
});
