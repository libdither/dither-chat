/**
 * The demo world's stickers, GIFs, voice messages, view-once and stories (media.ts, docs/media-kinds.md), so the picker, the
 * recorder and the stories strip can be tried with no network. Pictures are inline SVG, as the rest of the demo's are.
 */
import type * as P from '@dither-chat/protocol';
import { signalStickerLink, STORY_LIFETIME_MS } from '@dither-chat/protocol';

export const DEMO_MEDIA_CAPS: Partial<Record<P.Network, P.Capability[]>> = {
  discord: ['sendStickers', 'sendVoice', 'searchGifs'],
  signal: ['sendStickers', 'installStickers', 'sendVoice', 'sendViewOnce', 'stories'],
  telegram: ['sendGifs'],
  whatsapp: ['sendGifs'],
};

/** An invented GIF: an animated SVG (a bouncing emoji on a gradient, with a word), so it moves as a GIF would. */
const gifSvg = (emoji: string, word: string, a: string, b: string, w: number, h: number) =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><text x="${w / 2}" y="${h / 2 + 10}" font-size="${Math.round(h / 2.6)}" text-anchor="middle">${emoji}<animateTransform attributeName="transform" type="translate" values="0 0;0 -${Math.round(h / 10)};0 0" dur="0.8s" repeatCount="indefinite"/></text><text x="${w / 2}" y="${h - 12}" font-family="Impact, sans-serif" font-size="${Math.round(h / 7)}" fill="#fff" stroke="#000" stroke-width="1.5" text-anchor="middle">${word}</text></svg>`,
  ).toString('base64')}`;

/** Discord's GIF search in the demo: invented GIFs, found by their words. */
export const DEMO_GIFS: P.GifFact[] = (
  [
    ['party', 'PARTY', '🎉', '#7b5cff', '#ff6f91', 220, 160],
    ['yes', 'YES!', '👍', '#2bb673', '#0e7c86', 200, 200],
    ['congrats', 'CONGRATS', '🏆', '#f7971e', '#ffd200', 240, 150],
    ['dance', 'DANCE', '🕺', '#a1c4fd', '#5c7cfa', 180, 220],
    ['thinking', 'HMM', '🤔', '#f953c6', '#b91d73', 220, 170],
    ['wow', 'WOW', '😮', '#43cea2', '#185a9d', 200, 150],
    ['laugh', 'LOL', '😂', '#ff9966', '#ff5e62', 220, 200],
    ['sleepy', 'ZZZ', '😴', '#8e2de2', '#4a00e0', 200, 160],
    ['cat', 'MEOW', '😺', '#f2a541', '#e86a92', 210, 210],
    ['wave', 'HI!', '👋', '#5cc8ff', '#7fd1ae', 220, 150],
    ['no', 'NOPE', '🙅', '#ff6f61', '#c94b4b', 190, 190],
    ['love', 'AWW', '💜', '#b794f6', '#e86a92', 220, 180],
  ] as const
).map(([id, word, emoji, a, b, w, h]) => ({ id: `demo-${id}`, url: `https://gifs.example.com/${id}`, src: gifSvg(emoji, word, a, b, w, h), gif: gifSvg(emoji, word, a, b, w, h), width: w, height: h, title: `${id} ${word.toLowerCase()}` }));

const svg = (emoji: string, bg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><circle cx="80" cy="80" r="76" fill="${bg}"/><text x="80" y="104" font-size="72" text-anchor="middle">${emoji}</text></svg>`).toString('base64')}`;

const pack = (id: string, name: string, source: P.StickerSource, items: [string, string, string][]): P.StickerPackFact => ({
  id,
  name,
  source,
  stickers: items.map(([sid, sname, emoji], i) => ({ id: sid, name: sname, emoji, url: svg(emoji, ['#F2A541', '#7FD1AE', '#B794F6', '#5CC8FF'][i % 4]), mime: 'image/svg+xml' })),
});

/** Packs as each demo network has them; Signal's grows by the packs installed from a link. */
function packsFor(network: P.Network, installed: P.StickerPackFact[]): P.StickerPackFact[] {
  if (network === 'discord')
    return [
      pack('demo-guild', 'Pixel Pals', 'server', [
        ['1100000000000000001', 'wave', '👋'],
        ['1100000000000000002', 'party', '🎉'],
        ['1100000000000000003', 'thinking', '🤔'],
      ]),
      pack('demo-wumpus', 'Wumpus Beyond', 'standard', [
        ['1100000000000000011', 'hello', '😺'],
        ['1100000000000000012', 'sleepy', '😴'],
      ]),
    ];
  return [
    pack('0123456789abcdef0123456789abcdef', 'Bandit the Cat', 'installed', [
      ['0123456789abcdef0123456789abcdef:0', 'hi', '😸'],
      ['0123456789abcdef0123456789abcdef:1', 'love', '😻'],
      ['0123456789abcdef0123456789abcdef:2', 'shock', '🙀'],
    ]),
    ...installed,
  ];
}

export class DemoMedia {
  private installed: P.StickerPackFact[] = [];
  private storyOn = true;

  constructor(
    private network: P.Network,
    private self: string,
    private emit: (ev: P.AdapterEvent) => void,
  ) {}

  /** Stories from two Signal contacts, a text one and a picture one, posted a little while ago. */
  start(people: string[], group?: string) {
    if (this.network !== 'signal' || people.length < 2) return;
    const now = Date.now();
    const ts1 = now - 3 * 60 * 60_000;
    const ts2 = now - 40 * 60_000;
    this.emit({ t: 'story', story: { nativeId: `${people[0]}:${ts1}`, author: people[0], ts: ts1, expiresAt: ts1 + STORY_LIFETIME_MS, allowsReplies: true, text: { text: 'First swim of the year 🌊', style: 'SERIF', color: '#ffffff', gradient: { colors: ['#5CC8FF', '#B794F6'], angle: 180 } } } });
    this.emit({
      t: 'story',
      story: { nativeId: `${people[1]}:${ts2}`, author: people[1], ts: ts2, expiresAt: ts2 + STORY_LIFETIME_MS, allowsReplies: true, attachment: { kind: 'image', mime: 'image/svg+xml', name: 'story.svg', width: 160, height: 160, url: svg('🌇', '#E86A92') } },
    });
    if (group) {
      const ts3 = now - 90 * 60_000;
      this.emit({ t: 'story', story: { nativeId: `${people[0]}:${ts3}`, author: people[0], conversation: group, ts: ts3, expiresAt: ts3 + STORY_LIFETIME_MS, allowsReplies: false, text: { text: 'Group trip photos coming', background: '#7FD1AE' } } });
    }
  }

  /** A sticker by the id the picker gave, or null. */
  sticker(id: string): P.StickerFact | null {
    for (const p of packsFor(this.network, this.installed)) for (const s of p.stickers) if (s.id === id) return s;
    return null;
  }

  /** The commands of media.ts; undefined when it is not one. Throws with the network's refusal. */
  command(cmd: P.AdapterCommand): unknown {
    switch (cmd.t) {
      case 'stickers': {
        const all = packsFor(this.network, this.installed);
        const from = Number(cmd.cursor ?? 0) || 0;
        const page = all.slice(from, from + 1);
        return { packs: page, next: from + 1 < all.length ? String(from + 1) : null, ...(this.network === 'discord' ? { note: 'Stickers from other servers need Nitro' } : {}) } satisfies P.StickerPage;
      }
      case 'gifs': {
        if (this.network !== 'discord') return undefined;
        const q = cmd.query?.trim().toLowerCase();
        const found = q ? DEMO_GIFS.filter((g) => q.split(/\s+/).some((w) => g.title!.includes(w))) : DEMO_GIFS;
        const from = Number(cmd.cursor ?? 0) || 0;
        const page = found.slice(from, from + 8);
        return { gifs: page, next: from + 8 < found.length ? String(from + 8) : null } satisfies P.GifPage;
      }
      case 'addStickerPack': {
        const link = signalStickerLink(cmd.uri);
        if (!link) throw new Error('That is not a signal.art sticker pack link');
        const p = pack(link.packId, 'Installed pack', 'installed', [[`${link.packId}:0`, 'one', '⭐']]);
        if (!this.installed.some((x) => x.id === p.id)) this.installed.push(p);
        return { pack: p };
      }
      case 'storyViewed':
        return { sent: true };
      case 'storyReply': {
        const [author, ts] = cmd.story.split(':');
        const conversation = cmd.conversation ?? `dm:${this.self}:${author}`;
        const nativeId = `${conversation}~story-${Date.now()}`;
        this.emit({ t: 'message', live: true, message: { nativeId, conversation, author: this.self, ts: Date.now(), body: cmd.emoji ? '' : (cmd.body ?? ''), kind: 'text', extra: { storyReply: { author, ts: Number(ts), ...(cmd.emoji ? { emoji: cmd.emoji } : {}) } } } });
        return { nativeId };
      }
      case 'action':
        if (cmd.action !== 'stories') return undefined;
        if (typeof (cmd.args as { on?: unknown } | undefined)?.on === 'boolean') this.storyOn = (cmd.args as { on: boolean }).on;
        return { on: this.storyOn, running: this.storyOn } satisfies P.StoriesSetting;
    }
    return undefined;
  }
}
