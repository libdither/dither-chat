/**
 * The Unicode emoji catalog behind the reaction picker. About 400 KB of JSON,
 * so it loads the first time a picker opens rather than with the app.
 */
import { canonicalReactionKey } from '@dither-chat/protocol';

export interface EmojiItem {
  /** The shortcode, as in :joy:. */
  id: string;
  /** The shortcode and its aliases (:thumbsup: for :+1:). */
  codes: string[];
  name: string;
  /** Lowercase words a search can match. */
  words: string[];
  /** The emoji; index 1-5 are skin tones when it has them. */
  skins: string[];
}

export interface EmojiCategory {
  id: string;
  name: string;
  emoji: EmojiItem[];
}

const NAMES: Record<string, string> = {
  people: 'Smileys & people',
  nature: 'Animals & nature',
  foods: 'Food & drink',
  activity: 'Activities',
  places: 'Travel & places',
  objects: 'Objects',
  symbols: 'Symbols',
  flags: 'Flags',
};

let catalog: Promise<EmojiCategory[]> | null = null;

export function loadEmoji(): Promise<EmojiCategory[]> {
  catalog ??= import('@emoji-mart/data/sets/15/native.json').then(({ default: data }: any) => {
    const aliases = new Map<string, string[]>();
    for (const [alias, id] of Object.entries<string>(data.aliases ?? {})) aliases.set(id, [...(aliases.get(id) ?? []), alias]);
    return data.categories.map((c: any) => ({
      id: c.id,
      name: NAMES[c.id] ?? c.id,
      emoji: c.emojis.map((id: string): EmojiItem => {
        const e = data.emojis[id];
        return { id, codes: [id, ...(aliases.get(id) ?? [])], name: e.name, words: [id, e.name, ...e.keywords, ...(e.emoticons ?? [])].map((w: string) => w.toLowerCase()), skins: e.skins.map((s: any) => canonicalReactionKey(s.native)) };
      }),
    }));
  });
  return catalog;
}

/** Whole words first, then prefixes, then anywhere: "heart" should not open on "broken heart". */
export function searchEmoji(categories: EmojiCategory[], query: string, limit = 64): EmojiItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { e: EmojiItem; score: number }[] = [];
  for (const c of categories) {
    for (const e of c.emoji) {
      let score = 0;
      for (const w of e.words) {
        const s = w === q ? 3 : w.startsWith(q) ? 2 : w.includes(q) ? 1 : 0;
        if (s > score) score = s;
        if (score === 3) break;
      }
      if (score) scored.push({ e, score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.e);
}

export const skinOf = (e: EmojiItem, tone: number) => e.skins[tone] ?? e.skins[0];

export const SKIN_TONES = ['👋', '👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'];
