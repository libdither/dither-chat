/**
 * Every table of the hub's and the protocol's kept per network: a network in NETWORKS that one leaves
 * out says why here, as not applying or as a known gap naming the work. A network added, or a gap filled, makes this
 * fail until the table or the list here says so. The web's own tables: packages/web/test/network-tables.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { ABOUT_RULES, ATTACHMENT_LIMITS, NETWORK_FEATURES, NETWORK_META, NETWORKS, REACTION_RULES } from '@dither-chat/protocol';
import { ownKeys } from '../src/matches.ts';
import { READ_PACE } from '../src/readqueue.ts';
import { COLLECT_PACE } from '../src/samepeople.ts';

/** Why a table leaves a network out: it does not apply there, or it is work not done yet. */
type LeftOut = Partial<Record<P.Network, { na: string } | { gap: string }>>;

/** The networks a table has, and the ones it leaves out on purpose: together exactly NETWORKS, with no overlap. */
function covers(has: (n: P.Network) => boolean, left: LeftOut) {
  for (const n of NETWORKS) {
    const why = left[n];
    if (has(n)) expect(why ? `${n} is in the table, and also said to be left out` : null).toBeNull();
    else expect(why ? null : `${n} is left out with no reason given`).toBeNull();
  }
}

describe('whole tables: every network', () => {
  test.each([
    ['NETWORK_META', NETWORK_META],
    ['NETWORK_FEATURES', NETWORK_FEATURES],
    ['ABOUT_RULES', ABOUT_RULES],
    ['REACTION_RULES', REACTION_RULES],
    ['ATTACHMENT_LIMITS', ATTACHMENT_LIMITS],
    ['READ_PACE', READ_PACE],
  ] as const)('%s', (_, table) => covers((n) => n in table, {}));
});

test('COLLECT_PACE: how often profiles are collected', () => {
  covers((n) => !!COLLECT_PACE[n], {
    gmessages: { na: 'its profile is the contact card the extractor already holds: no request, nothing new to collect' },
    instagram: { na: 'its extractor answers no profile command' },
    calendar: { na: 'no people' },
    t3: { na: 'agent threads: no people' },
  });
});

/** An identity like each network's, with the handle it has there. */
const SAMPLE: Record<P.Network, { native_id: string; handle?: string }> = {
  discord: { native_id: '100000000000001', handle: 'ann.l' },
  signal: { native_id: 'tel:+15550101', handle: '+1 555 0101' },
  matrix: { native_id: '@ann:matrix.example.org' },
  whatsapp: { native_id: '15550101@s.whatsapp.net' },
  telegram: { native_id: '5001', handle: 'ann_l' },
  gmessages: { native_id: '+15550101', handle: '+1 555-0101' },
  messenger: { native_id: '5001' },
  instagram: { native_id: '5001', handle: 'ann.l' },
  x: { native_id: '5001', handle: 'ann_l' },
  email: { native_id: 'ann@example.org' },
  calendar: { native_id: 'ann@example.org' },
  t3: { native_id: 'agent' },
  mastodon: { native_id: '5001', handle: 'ann@social.example.org' },
  reddit: { native_id: 't2_5001', handle: 'ann_l' },
  lemmy: { native_id: 'https://lemmy.example.org/u/ann', handle: 'ann@lemmy.example.org' },
  substack: { native_id: '5001', handle: 'annl' },
  bluesky: { native_id: 'did:plc:ann', handle: 'ann.bsky.social' },
  lesswrong: { native_id: 'ann-id', handle: 'ann-l' },
  zulip: { native_id: 'chat.example.org/u/7', handle: 'ann@example.org' },
  luma: { native_id: 'usr-ann', handle: 'annl' },
  partiful: { native_id: 'pfann' },
};

test('ownKeys: what an account is known by, for Same person?', () => {
  const noKey = 'no own key yet, so a profile linking their account here finds no one: matches.ts ownKeys';
  covers((n) => ownKeys({ network: n, ...SAMPLE[n] }).length > 0, {
    gmessages: { gap: `people are their phone numbers; ${noKey}` },
    messenger: { na: 'known by its native id, which a bridge stand-in names (the native: key every account has)' },
    instagram: { gap: noKey },
    calendar: { na: 'no people' },
    t3: { na: 'agent threads: no people' },
    mastodon: { gap: noKey },
    reddit: { gap: noKey },
    lemmy: { gap: noKey },
    substack: { gap: noKey },
    bluesky: { gap: noKey },
    lesswrong: { gap: noKey },
  });
});
