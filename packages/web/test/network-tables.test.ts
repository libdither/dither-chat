/**
 * The web's per-network cases (src/model.ts): a network in NETWORKS that one leaves out says why here, as not applying
 * or as a known gap naming the work. A network added, or a gap filled, makes this fail until the case or the list here
 * says so. The hub's and the protocol's tables: packages/hub/test/network-tables.test.ts.
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { NETWORKS } from '@dither-chat/protocol';
import { stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { deepLink, externalProfile } = await import('../src/model.ts');

type LeftOut = Partial<Record<P.Network, { na: string } | { gap: string }>>;

function covers(has: (n: P.Network) => boolean, left: LeftOut) {
  for (const n of NETWORKS) {
    const why = left[n];
    if (has(n)) expect(why ? `${n} is in the table, and also said to be left out` : null).toBeNull();
    else expect(why ? null : `${n} is left out with no reason given`).toBeNull();
  }
}

/** A person and a chat like each network's. */
const SAMPLE: Record<P.Network, { identity: { nativeId: string; handle?: string }; conversation: string }> = {
  discord: { identity: { nativeId: '100000000000001', handle: 'ann.l' }, conversation: '100000000000002' },
  signal: { identity: { nativeId: 'tel:+15550101', handle: '+1 555 0101' }, conversation: 'group:abc' },
  matrix: { identity: { nativeId: '@ann:matrix.example.org' }, conversation: '!room:matrix.example.org' },
  whatsapp: { identity: { nativeId: '15550101@s.whatsapp.net', handle: '+15550101' }, conversation: '120000000000@g.us' },
  telegram: { identity: { nativeId: '5001', handle: 'ann_l' }, conversation: '-1005001' },
  gmessages: { identity: { nativeId: '+15550101', handle: '+1 555-0101' }, conversation: 'ns:c1' },
  messenger: { identity: { nativeId: '5001' }, conversation: '5002' },
  instagram: { identity: { nativeId: '5001', handle: 'ann.l' }, conversation: '5002' },
  x: { identity: { nativeId: '5001', handle: 'ann_l' }, conversation: '5001-5002' },
  email: { identity: { nativeId: 'ann@example.org' }, conversation: 'thread-1' },
  calendar: { identity: { nativeId: 'ann@example.org' }, conversation: 'cal-1' },
  t3: { identity: { nativeId: 'agent' }, conversation: 'thread-1' },
  mastodon: { identity: { nativeId: '5001', handle: 'ann@social.example.org' }, conversation: '5002' },
  reddit: { identity: { nativeId: 't2_5001', handle: 'ann_l' }, conversation: 't3_5002' },
  lemmy: { identity: { nativeId: 'https://lemmy.example.org/u/ann', handle: 'ann@lemmy.example.org' }, conversation: '5002' },
  substack: { identity: { nativeId: '5001', handle: 'annl' }, conversation: '5002' },
  bluesky: { identity: { nativeId: 'did:plc:ann', handle: 'ann.bsky.social' }, conversation: 'at://did:plc:ann/post/1' },
  lesswrong: { identity: { nativeId: 'ann-id', handle: 'ann-l' }, conversation: 'post-1' },
  zulip: { identity: { nativeId: 'chat.example.org/u/7', handle: 'ann@example.org' }, conversation: 'chat.example.org/s/3/t/plans' },
};

const notBuilt = (what: string) => ({ gap: `no ${what} built for it yet` });

test("deepLink: a chat's address on its network's own site", () => {
  const conv = (n: P.Network) => ({ id: `cnv_${n}`, network: n, nativeId: SAMPLE[n].conversation, shape: 'channel', spaceIds: [], parentId: null, vantages: [] }) as unknown as P.ConversationView;
  covers((n) => !!deepLink(conv(n)), {
    signal: { na: 'Signal has no web addresses for chats' },
    whatsapp: notBuilt('chat link'),
    telegram: notBuilt('chat link'),
    gmessages: notBuilt('chat link'),
    messenger: notBuilt('chat link'),
    instagram: notBuilt('chat link'),
    x: notBuilt('chat link'),
    calendar: { na: 'no site of its own' },
    t3: { na: 'a local app: no site' },
    mastodon: notBuilt('post link'),
    reddit: notBuilt('post link'),
    lemmy: notBuilt('post link'),
    substack: notBuilt('post link'),
    bluesky: notBuilt('post link'),
    lesswrong: notBuilt('post link'),
    // Open in Zulip: being added by the Zulip presentation work (branch zulip/presentation).
    zulip: { gap: 'Open in Zulip links: the Zulip presentation work adds them' },
  });
});

test("externalProfile: someone's page on their network's own site", () => {
  const ident = (n: P.Network) => ({ id: `idn_${n}`, network: n, ...SAMPLE[n].identity, handle: SAMPLE[n].identity.handle ?? null }) as unknown as P.IdentityView;
  covers((n) => !!externalProfile(ident(n)), {
    signal: notBuilt('profile link'),
    telegram: notBuilt('profile link'),
    gmessages: { na: 'people are phone numbers: no profile page' },
    messenger: notBuilt('profile link'),
    instagram: notBuilt('profile link'),
    x: notBuilt('profile link'),
    calendar: { na: 'no people' },
    t3: { na: 'agent threads: no people' },
    mastodon: notBuilt('profile link'),
    reddit: notBuilt('profile link'),
    lemmy: notBuilt('profile link'),
    substack: notBuilt('profile link'),
    bluesky: notBuilt('profile link'),
    lesswrong: notBuilt('profile link'),
    // A person's Zulip page: being added by the Zulip presentation work (branch zulip/presentation).
    zulip: { gap: "a person's Zulip page: the Zulip presentation work adds it" },
  });
});
