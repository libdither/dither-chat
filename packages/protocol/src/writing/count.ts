/** How networks count a message's length: each its own way. */
export type Counter = 'utf16' | 'codepoints' | 'graphemes' | 'bytes' | 'weighted' | 'links' | 'sms';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (s: string) => [...segmenter.segment(s)].map((x) => x.segment);
const URL = /https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/g;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** X's weights (twitter-text v3): these code points count one, every other two, an emoji two. */
const LIGHT: [number, number][] = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
/** An emoji as the lists of emoji have it: a flag and a keycap are one, a bare © is a letter. */
const EMOJI = (() => {
  try {
    return new RegExp('^\\p{RGI_Emoji}$', 'v');
  } catch {
    return /\p{Extended_Pictographic}/u;
  }
})();
const weighted = (s: string) => {
  let n = 0;
  for (const g of graphemes(s.normalize('NFC'))) {
    if (EMOJI.test(g)) n += 2;
    else for (const c of g) n += LIGHT.some(([a, b]) => c.codePointAt(0)! >= a && c.codePointAt(0)! <= b) ? 1 : 2;
  }
  return n;
};

const GSM = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ!"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const GSM_TWO = new Set('^{}\\[~]|€');

export interface Measure {
  /** As the network counts. */
  n: number;
  max: number | null;
  over: boolean;
  /** What the count is of, for the counter's words: "characters", "bytes", "texts". */
  unit: string;
  note?: string;
}

export function measure(s: string, counter: Counter, max: number | null, urlLength = 23): Measure {
  const m = (n: number, unit: string, note?: string): Measure => ({ n, max, over: max != null && n > max, unit, ...(note ? { note } : {}) });
  switch (counter) {
    case 'utf16':
      return m(s.length, 'characters');
    case 'codepoints':
      return m([...s].length, 'characters');
    case 'graphemes':
      return m(graphemes(s).length, 'characters');
    case 'bytes':
      return m(bytes(s), 'bytes');
    case 'weighted': {
      const links = s.match(URL) ?? [];
      return m(weighted(s.replace(URL, '')) + links.length * urlLength, 'weighted characters', links.length ? `each link counts ${urlLength}` : undefined);
    }
    case 'links': {
      const links = s.match(URL) ?? [];
      return m(graphemes(s.replace(URL, '')).length + links.length * urlLength, 'characters', links.length ? `each link counts ${urlLength}` : undefined);
    }
    case 'sms': {
      // Plain letters go 160 to a text (153 each once it is split); anything else makes the whole text 70 (67).
      const plain = [...s].every((c) => GSM.has(c) || GSM_TWO.has(c));
      const units = plain ? [...s].reduce((n, c) => n + (GSM_TWO.has(c) ? 2 : 1), 0) : s.length;
      const [one, each] = plain ? [160, 153] : [70, 67];
      const texts = units <= one ? (units ? 1 : 0) : Math.ceil(units / each);
      return { n: texts, max, over: max != null && texts > max, unit: texts === 1 ? 'text' : 'texts', note: `${units} of ${texts <= 1 ? one : texts * each}${plain ? '' : ', as it has a letter outside the plain set'}` };
    }
  }
}
