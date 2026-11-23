/**
 * What one place to write to can carry: which blocks, styles and things in the text, what may sit inside what, how long
 * it may be and how that is counted, the fields it has beside the text, and how it goes on the wire. A profile is data:
 * the editor draws its controls from it, fit.ts makes a draft fit it, encode.ts writes it out and read.ts reads that
 * back as the place will.
 *
 * A profile is made for a place when someone writes there, not once for a network: the table below is the network's
 * part, and `at` lays over it what the server, the kind of place (a post, a comment, a caption) and the account say.
 */
import type { Counter } from './count.ts';
import type { BlockKind, EntityKind, MarkKind, Node } from './doc.ts';

/** What is written beside the text. A place sends only the ones it has. */
export interface Fields {
  title?: string;
  warning?: string;
  place?: string;
  to?: string;
  cc?: string;
}
export type MentionKind = 'user' | 'role' | 'channel' | 'everyone';

/** Marker strings around styled text and before blocks: Markdown and its many cousins. */
export interface Markers {
  family: 'markers';
  marks: Partial<Record<MarkKind, [string, string]>>;
  link?: (href: string) => [string, string];
  /** Characters a backslash makes plain. Absent: the network has no way to write a marker as itself. */
  escape?: string;
  /** Between two of its paragraphs, and a line break inside one. */
  para: string;
  br: string;
  heading?: (level: number) => string;
  quote?: string;
  bullet?: string;
  /** What an item's further lines start with; 'marker' is as many spaces as its marker is wide. */
  indent?: string;
  fence?: string;
  rule?: string;
  table?: true;
  fold?: (title: string, inner: string, fence: string) => string;
  image?: (n: Node) => string;
  mention?: (n: Node) => string;
  time?: (n: Node) => string;
  emoji?: (n: Node) => string;
  /**
   * Where it takes a marker for a style: 'flanking' by CommonMark's rule (not next to a space, and not between a letter
   * and a punctuation mark), 'words' only around whole words. Absent: wherever a pair is found.
   */
  reads?: 'flanking' | 'words';
  /** Spaces in a row are shown as one, so they are written with no-break spaces between. */
  collapses?: boolean;
  /** `&name;` is read as a character, so an & before one is written out. */
  entities?: boolean;
  /** Code may sit between more than one backtick, so code can hold a backtick. */
  code2?: boolean;
  /** Words the place would act on when typed (an @everyone), made plain. */
  defuse?: (s: string) => string;
}
/** Plain text with ranges beside it that say what a stretch is. */
export interface Ranges {
  family: 'ranges';
  /** What offsets count. */
  unit: 'utf16' | 'bytes' | 'codepoints';
  shape: 'signal' | 'telegram' | 'bluesky' | 'plain';
  /** Two ranges may cross (Signal), or only sit inside one another (Telegram): then a crossing one is cut in two. */
  overlap?: 'nested';
}
/** A subset of HTML, with a plain copy beside it made for `plain`. */
export interface Html {
  family: 'html';
  shape: 'matrix' | 'mail';
  plain: string;
}
/** A tree of the network's own blocks. */
export interface Blocks {
  family: 'blocks';
  shape: 'slack';
}

export interface Limit {
  max: number | null;
  count: Counter;
  url?: number;
}

export interface Profile {
  id: string;
  name: string;
  /**
   * Whose ids its people and emoji are known by: a mention's `ids` are looked up under this. A network by default; a
   * second server or workspace of the same network is a space of its own.
   */
  space?: string;
  /** What is written there, for the words on its controls. */
  role: 'chat' | 'post' | 'comment' | 'mail';
  /** Blocks beside the paragraph, styles and things in the text that go as themselves. */
  blocks: readonly BlockKind[];
  marks: readonly MarkKind[];
  entities: readonly EntityKind[];
  rules?: {
    /** How deep a quote may sit in a quote (1: not at all), and a list in a list. */
    quoteDepth?: number;
    listDepth?: number;
    headingLevels?: number;
    /** A code block's language is kept. */
    codeLang?: boolean;
    /** Other styles may sit on code. */
    marksInCode?: boolean;
    align?: boolean;
    /** Formats a raw block may go in as it is. */
    raw?: string[];
    /** The network looks up an @name typed in the text by itself, so a name it should not look up goes without the @. */
    findsMentions?: boolean;
    /**
     * A mention, or an emoji by its name, is found by its characters. 'word': a letter right beside one would change
     * what it names. 'space': it is one only at the start of a line or after a space. A space is put where one is needed.
     */
    apart?: 'word' | 'space';
    /** A custom emoji is known by an id there, not by its name alone. */
    emojiById?: boolean;
    /** No file can go with the text. */
    files?: false;
    /** A file beside the text can be hidden until the reader taps it. */
    hidesFiles?: boolean;
    /** Who can be mentioned beside a person. */
    mentionKinds?: readonly MentionKind[];
    /** What holds only lines of text there, and no blocks: a quote, a list's item, a table's cell (one line), a fold. */
    lines?: readonly ('blockquote' | 'listItem' | 'tableCell' | 'fold')[];
    /** An empty line shows only between two lines of text, and several as one. */
    gaps?: 'one';
    /** Blocks follow each other with nothing between: two quotes side by side read as one, and two tables need an empty line between. */
    tight?: boolean;
  };
  /**
   * Past the limit: refused; or it goes as several messages by itself (a chat); or it can be made a thread of posts,
   * which is the writer's choice to make. `and` are further limits that hold too.
   */
  limit?: Limit & { over: 'refuse' | 'split' | 'thread'; and?: Limit[]; /** The limit of the text when a file goes with it (a caption). */ withFile?: number };
  fields?: {
    title?: { word: string; required: boolean; max: number };
    /** `counts`: the warning is counted with the text against the limit. */
    warning?: { max: number; counts?: boolean };
    place?: { word: string; prefix: string };
    people?: true;
  };
  /** How the text is written. */
  wire: Markers | Ranges | Html | Blocks;
  /** What goes beside the written text: the fields, who is told, and the rest of the network's message. */
  beside?: (body: any, f: Fields, d: Node, pr: Profile) => Record<string, unknown>;
}

/** A network's profile as it holds in one place. */
export const at = (pr: Profile, over: Partial<Profile>): Profile => ({ ...pr, ...over, rules: { ...pr.rules, ...over.rules } });

/** An address between a marker link's brackets: nothing in it may close them. */
export const within = (href: string) => href.replace(/[()<>\\\s|`]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const md = (href: string): [string, string] => ['[', `](${within(href)})`];
const id = (n: Node) => String(n.attrs?.id ?? '');
/** A name as Zulip takes one between its stars: without the characters that would end it. */
const name = (n: Node) => String(n.attrs?.label ?? '').replace(/[*`\\>"@|]/g, '');
const kind = (n: Node) => String(n.attrs?.kind ?? 'user');
const mentions = (d: Node, k: string, out: string[] = []): string[] => {
  if (d.type === 'mention' && kind(d) === k) out.push(id(d));
  for (const c of d.content ?? []) mentions(c, k, out);
  return [...new Set(out)];
};

const list: Profile[] = [
  {
    id: 'signal', name: 'Signal', role: 'chat',
    blocks: [], marks: ['bold', 'italic', 'strike', 'code', 'spoiler'], entities: ['mention'],
    rules: { marksInCode: true },
    limit: { max: 65536, count: 'bytes', over: 'refuse' },
    wire: { family: 'ranges', unit: 'utf16', shape: 'signal' },
  },
  {
    id: 'whatsapp', name: 'WhatsApp', role: 'chat',
    blocks: ['blockquote', 'list', 'codeBlock'], marks: ['bold', 'italic', 'strike', 'code'], entities: ['mention'],
    rules: { quoteDepth: 1, listDepth: 1, lines: ['blockquote', 'listItem'], tight: true, apart: 'word' },
    limit: { max: 65536, count: 'utf16', over: 'refuse' },
    wire: { family: 'markers', marks: { bold: ['*', '*'], italic: ['_', '_'], strike: ['~', '~'], code: ['`', '`'] }, reads: 'words', para: '\n', br: '\n', quote: '> ', bullet: '- ', indent: '  ', fence: '```', mention: (n) => '@' + id(n) },
    beside: (text, _f, d) => ({ text, mentions: mentions(d, 'user') }),
  },
  {
    id: 'telegram', name: 'Telegram', role: 'chat',
    blocks: ['blockquote', 'codeBlock'], marks: ['bold', 'italic', 'underline', 'strike', 'code', 'spoiler', 'link'], entities: ['mention', 'emoji'],
    rules: { quoteDepth: 1, codeLang: true, lines: ['blockquote'], findsMentions: true, emojiById: true, hidesFiles: true },
    limit: { max: 4096, count: 'utf16', over: 'split', withFile: 1024 },
    wire: { family: 'ranges', unit: 'utf16', shape: 'telegram', overlap: 'nested' },
  },
  {
    id: 'discord', name: 'Discord', role: 'chat',
    blocks: ['heading', 'blockquote', 'list', 'codeBlock'], marks: ['bold', 'italic', 'underline', 'strike', 'code', 'spoiler', 'link'], entities: ['mention', 'time', 'emoji'],
    rules: { quoteDepth: 1, listDepth: 3, headingLevels: 3, codeLang: true, mentionKinds: ['user', 'role', 'channel', 'everyone'], lines: ['listItem'], tight: true, emojiById: true, hidesFiles: true },
    limit: { max: 2000, count: 'codepoints', over: 'split' },
    wire: {
      family: 'markers', marks: { bold: ['**', '**'], italic: ['*', '*'], underline: ['__', '__'], strike: ['~~', '~~'], code: ['`', '`'], spoiler: ['||', '||'] }, link: md, code2: true,
      escape: '\\*_~`|[]<', para: '\n', br: '\n', heading: (l) => '#'.repeat(l) + ' ', quote: '> ', bullet: '- ', indent: '  ', fence: '```',
      // Typed as words, these tell nobody: a character of no width keeps them from being read as the mention.
      defuse: (s) => s.replace(/@(?=everyone|here)/g, '@\u200b'),
      mention: (n) => (kind(n) === 'everyone' ? '@everyone' : kind(n) === 'role' ? `<@&${id(n)}>` : kind(n) === 'channel' ? `<#${id(n)}>` : `<@${id(n)}>`),
      time: (n) => `<t:${n.attrs?.at}:${n.attrs?.style ?? 'f'}>`, emoji: (n) => `<${n.attrs?.animated ? 'a' : ''}:${n.attrs?.name}:${id(n)}>`,
    },
    // Only the people put in as mentions are told: an @everyone typed as words tells nobody.
    beside: (content, _f, d) => ({ content, allowed_mentions: { parse: mentions(d, 'everyone').length ? ['everyone'] : [], users: mentions(d, 'user'), roles: mentions(d, 'role') } }),
  },
  {
    id: 'matrix', name: 'Matrix', role: 'chat',
    blocks: ['heading', 'blockquote', 'list', 'codeBlock', 'horizontalRule', 'table', 'fold', 'image'], marks: ['bold', 'italic', 'underline', 'strike', 'code', 'spoiler', 'link', 'color', 'sub', 'sup'], entities: ['mention'],
    rules: { codeLang: true, marksInCode: true, mentionKinds: ['user', 'channel', 'everyone'] },
    limit: { max: 60000, count: 'bytes', over: 'refuse' },
    wire: { family: 'html', shape: 'matrix', plain: 'plain' },
  },
  {
    id: 'slack', name: 'Slack', role: 'chat',
    blocks: ['blockquote', 'list', 'codeBlock'], marks: ['bold', 'italic', 'underline', 'strike', 'code', 'link'], entities: ['mention', 'time', 'emoji'],
    rules: { quoteDepth: 1, codeLang: true, marksInCode: true, mentionKinds: ['user', 'role', 'channel', 'everyone'], lines: ['blockquote', 'listItem'] },
    limit: { max: 40000, count: 'utf16', over: 'refuse' },
    wire: { family: 'blocks', shape: 'slack' },
  },
  {
    id: 'zulip', name: 'Zulip', role: 'chat',
    blocks: ['blockquote', 'list', 'codeBlock', 'horizontalRule', 'table', 'fold'], marks: ['bold', 'italic', 'strike', 'code', 'link'], entities: ['mention', 'time', 'emoji'],
    rules: { codeLang: true, mentionKinds: ['user', 'role', 'channel', 'everyone'], lines: ['tableCell'], tight: true, apart: 'space' },
    limit: { max: 10000, count: 'codepoints', over: 'refuse' },
    wire: {
      family: 'markers', marks: { bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'], code: ['`', '`'] }, link: md, escape: '\\*_~`[]<', reads: 'flanking', collapses: true, code2: true,
      para: '\n', br: '\n', quote: '> ', bullet: '- ', indent: '  ', fence: '```', rule: '---', table: true,
      fold: (title, inner, fence) => `${fence}spoiler ${title}\n${inner}\n${fence}`,
      mention: (n) => (kind(n) === 'everyone' ? '@**all**' : kind(n) === 'role' ? `@*${name(n)}*` : kind(n) === 'channel' ? `#**${name(n)}**` : `@**${name(n)}|${id(n)}**`),
      time: (n) => `<time:${new Date((n.attrs?.at ?? 0) * 1000).toISOString()}>`, emoji: (n) => `:${n.attrs?.name}:`,
    },
  },
  {
    id: 'sms', name: 'SMS', role: 'chat',
    blocks: [], marks: [], entities: [],
    limit: { max: null, count: 'sms', over: 'split' },
    wire: { family: 'ranges', unit: 'utf16', shape: 'plain' },
  },
  {
    id: 'irc', name: 'IRC', role: 'chat',
    blocks: [], marks: ['bold', 'italic', 'underline', 'strike', 'code'], entities: [],
    rules: { marksInCode: true, files: false },
    // A line of at most 512 bytes with its command and the names in it; each line of a message is a line there.
    limit: { max: 400, count: 'bytes', over: 'split' },
    wire: { family: 'markers', marks: { bold: ['\x02', '\x02'], italic: ['\x1d', '\x1d'], underline: ['\x1f', '\x1f'], strike: ['\x1e', '\x1e'], code: ['\x11', '\x11'] }, para: '\n', br: '\n' },
  },
  {
    id: 'x', name: 'X', role: 'post',
    blocks: [], marks: [], entities: ['mention'],
    rules: { findsMentions: true, apart: 'word' },
    limit: { max: 280, count: 'weighted', url: 23, over: 'thread' },
    wire: { family: 'ranges', unit: 'utf16', shape: 'plain' },
  },
  {
    id: 'bluesky', name: 'Bluesky', role: 'post',
    blocks: [], marks: ['link'], entities: ['mention'],
    limit: { max: 300, count: 'graphemes', over: 'thread', and: [{ max: 3000, count: 'bytes' }] },
    wire: { family: 'ranges', unit: 'bytes', shape: 'bluesky' },
  },
  {
    id: 'mastodon', name: 'Mastodon', role: 'post',
    blocks: [], marks: [], entities: ['mention'],
    rules: { findsMentions: true, apart: 'word' },
    limit: { max: 500, count: 'links', url: 23, over: 'thread' },
    fields: { warning: { max: 500, counts: true } },
    wire: { family: 'ranges', unit: 'utf16', shape: 'plain' },
    // Behind a warning, the pictures are behind it too.
    beside: (body, f) => ({ status: body.text, ...(f.warning?.trim() ? { spoiler_text: f.warning.trim(), sensitive: true } : {}) }),
  },
  {
    id: 'reddit', name: 'Reddit', role: 'post',
    blocks: ['heading', 'blockquote', 'list', 'codeBlock', 'horizontalRule', 'table'], marks: ['bold', 'italic', 'strike', 'code', 'spoiler', 'sup', 'link'], entities: ['mention'],
    rules: { findsMentions: true, apart: 'word', mentionKinds: ['user', 'channel'], lines: ['tableCell'], gaps: 'one' },
    limit: { max: 40000, count: 'utf16', over: 'refuse' },
    fields: { title: { word: 'Title', required: true, max: 300 }, place: { word: 'Subreddit', prefix: 'r/' } },
    wire: {
      family: 'markers', marks: { bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'], code: ['`', '`'], spoiler: ['>!', '!<'], sup: ['^(', ')'] }, link: md, escape: '\\*_~`[]<^', reads: 'flanking', collapses: true, entities: true, code2: true,
      para: '\n\n', br: '  \n', heading: (l) => '#'.repeat(l) + ' ', quote: '> ', bullet: '- ', indent: '    ', fence: '```', rule: '***', table: true,
      mention: (n) => (kind(n) === 'channel' ? 'r/' : 'u/') + id(n),
    },
    beside: (text, f, _d, pr) => (pr.role === 'comment' ? { text } : { sr: f.place ?? '', title: f.title ?? '', kind: 'self', text }),
  },
  {
    id: 'github', name: 'GitHub', role: 'comment',
    blocks: ['heading', 'blockquote', 'list', 'codeBlock', 'horizontalRule', 'table', 'fold', 'image', 'raw'], marks: ['bold', 'italic', 'underline', 'strike', 'code', 'sub', 'sup', 'link'], entities: ['mention', 'emoji'],
    rules: { codeLang: true, raw: ['html'], findsMentions: true, apart: 'word', mentionKinds: ['user', 'role'], lines: ['tableCell'], gaps: 'one' },
    limit: { max: 65536, count: 'utf16', over: 'refuse' },
    wire: {
      family: 'markers', marks: { bold: ['**', '**'], italic: ['*', '*'], underline: ['<ins>', '</ins>'], strike: ['~~', '~~'], code: ['`', '`'], sub: ['<sub>', '</sub>'], sup: ['<sup>', '</sup>'] }, link: md, escape: '\\*_~`[]<', reads: 'flanking', collapses: true, entities: true, code2: true,
      para: '\n\n', br: '\\\n', heading: (l) => '#'.repeat(l) + ' ', quote: '> ', bullet: '- ', indent: 'marker', fence: '```', rule: '***', table: true,
      fold: (title, inner) => `<details><summary>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</summary>\n\n${inner}\n\n</details>`,
      image: (n) => `![${String(n.attrs?.alt ?? '').replace(/[\[\]\\]/g, '')}](${within(String(n.attrs?.src ?? ''))})`, mention: (n) => '@' + id(n), emoji: (n) => `:${n.attrs?.name}:`,
    },
  },
  {
    id: 'mail', name: 'Email', role: 'mail',
    blocks: ['heading', 'blockquote', 'list', 'codeBlock', 'horizontalRule', 'table', 'image', 'raw'], marks: ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'color', 'sub', 'sup'], entities: [],
    rules: { codeLang: false, marksInCode: true, align: true, raw: ['html'] },
    limit: { max: null, count: 'bytes', over: 'refuse' },
    fields: { title: { word: 'Subject', required: false, max: 998 }, people: true },
    wire: { family: 'html', shape: 'mail', plain: 'plain' },
    beside: (body, f) => ({ to: f.to ?? '', ...(f.cc?.trim() ? { cc: f.cc } : {}), subject: f.title ?? '', ...body }),
  },
  // Not a place to send to: the plain copy that goes beside HTML (a mail's text part, Matrix's `body`).
  {
    id: 'plain', name: 'Plain text', role: 'chat',
    blocks: [], marks: [], entities: [],
    wire: { family: 'ranges', unit: 'utf16', shape: 'plain' },
  },
];

export const PROFILES: Readonly<Record<string, Profile>> = Object.fromEntries(list.map((p) => [p.id, p]));
/** The places the demo offers, in order. */
export const PLACES = list.filter((p) => p.id !== 'plain').map((p) => p.id);
