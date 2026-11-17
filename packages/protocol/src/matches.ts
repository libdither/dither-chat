/**
 * Same person? (docs/same-person.md): pairs of people the hub thinks may be one person on several accounts, with the
 * evidence for each, for the owner to merge or turn down. Nothing is merged without a click.
 *
 * A side is what the people list shows as one row: a person (`per_…`), or an identity no person holds yet (`idn_…`),
 * as in the people graph.
 */
import type { Network } from './ontology.ts';

/** What one piece of evidence is, strongest first. */
export type MatchEvidenceKind =
  /** One side's profile names an account the other side has: a connected account, a link in the bio. */
  | 'claims'
  /** The same phone number or email address on both. */
  | 'contact'
  /** A bridge's stand-in account for the other (a Matrix puppet of a Discord user, say). */
  | 'bridge'
  /** The same profile picture, by a picture hash. */
  | 'picture'
  /** The same or a close name or handle. */
  | 'name'
  /** People already known to be one person around both: friends, group mates. */
  | 'friends'
  /** Bios alike. */
  | 'bio'
  /** Chats with you that hand over: one went quiet as the other began. */
  | 'handoff'
  /** jev, the machine's local model, read both profiles. */
  | 'model'
  /** Something counting against: both talk to you on the same network, say. */
  | 'against';

export interface MatchEvidence {
  kind: MatchEvidenceKind;
  /** In words, for the card: "Discord profile links x.com/annlee, their X account". */
  text: string;
  /** How much it moved the score, as a log-odds weight (negative counts against). */
  weight: number;
}

export interface MatchSide {
  /** per_… or idn_… */
  id: string;
  name: string;
  avatar?: string | null;
  /** Their accounts: network and handle, the identity ids for opening each. */
  identities: { id: string; network: Network; handle?: string | null; name?: string | null }[];
  /** You have a direct chat with them. */
  direct?: boolean;
}

export interface MatchSuggestion {
  /** Stable for a pair: the two side ids, sorted, joined with '+'. */
  key: string;
  a: MatchSide;
  b: MatchSide;
  /** 0..1: how likely they are one person. */
  p: number;
  evidence: MatchEvidence[];
  /** Turned down for later ("Later"): kept out of the list until this time. */
  laterUntil?: number;
}

/** Suggestions joined by a side they share (A~B and B~C): one card for all of them. */
export interface MatchGroup {
  sides: string[];
  /** Keys of the suggestions inside it. */
  keys: string[];
  /** The weakest link holding it together. */
  p: number;
}

export interface MatchesView {
  suggestions: MatchSuggestion[];
  groups: MatchGroup[];
  /** When the list was worked out, and whether a newer run is going. */
  at: number | null;
  running: boolean;
  /** Pictures waiting for the browser to hash them (GET /api/matches/pictures). */
  picturesWaiting: number;
  /** How many decisions the score has learned from, and whether it uses them yet. */
  learned: { yes: number; no: number; fitted: boolean };
  /** Kept profiles behind it, and whether profiles are being collected (adversarial). */
  profiles: { kept: number; collecting: boolean };
}

export type MatchDecision = 'no' | 'later';

/** Picture hashes the browser made: the hub draws no pictures itself. */
export interface PictureToHash {
  identityId: string;
  /** The picture, through the hub's media path. */
  src: string;
  /** The stored URL it was drawn from, sent back with the hash so a changed picture is hashed again. */
  url: string;
}

/** Odds at or over this are offered for "Merge all over…" (after a review). */
export const MATCH_STRONG = 0.9;
/** Under this a pair is not shown. */
export const MATCH_SHOWN = 0.35;

/** Collecting profiles (adversarial `profiles`): GET /api/profiles/collect. */
export interface ProfileCollectStatus {
  on: boolean;
  /** People with a kept profile, and earlier versions kept. */
  kept: number;
  versions: number;
  /** Collected since the hub started. */
  collected: number;
  networks: { network: Network; name: string; waiting: number; today: number; perDay: number; everySeconds: number }[];
}
