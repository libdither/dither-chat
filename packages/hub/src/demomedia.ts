/**
 * The demo world's stickers, voice messages, view-once and stories (media.ts, docs/media-kinds.md), so the picker, the
 * recorder and the stories strip can be tried with no network. Pictures are inline SVG, as the rest of the demo's are.
 */
import type * as P from '@dither-chat/protocol';
import { signalStickerLink, STORY_LIFETIME_MS } from '@dither-chat/protocol';

export const DEMO_MEDIA_CAPS: Partial<Record<P.Network, P.Capability[]>> = {
  discord: ['sendStickers', 'sendVoice'],
  signal: ['sendStickers', 'installStickers', 'sendVoice', 'sendViewOnce', 'stories'],
};

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
