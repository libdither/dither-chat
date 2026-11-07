/**
 * DiscordChatExporter HTML -> the facts the Discord adapter would have produced (docs/import-discord.md).
 *
 * One file per channel, named "<Guild> - <Channel> [<channelId>].html". Each message group is read on its own:
 * the first message carries the author header and any reply link, the rest inherit the author. Bodies are rendered
 * HTML and are turned back into Discord Markdown; a mention becomes <@id> when its name is an author anywhere in the
 * export. Media links are absolute file:///home/<user>/... paths into the exporting machine's home, so `localPath`
 * maps them under the source's raw/ directory.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { type El, classes, find, findAll, findOwn, hasClass, parseFragment, text, walk } from './html.ts';

export const DCE_HTML_READER = 'dce-html@1';

const DISCORD_EPOCH = 1420070400000n;
export function snowflakeToMs(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return 0;
  }
}

/** "Monday, May 4, 2026 3:45 PM" in the exporting machine's zone: to the minute, as the export has it. */
export function parseDceTime(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s.replace(/[  ]/g, ' ').replace(/^[A-Za-z]+,\s*/, ''));
  return Number.isNaN(t) ? undefined : t;
}

export interface ChannelBatch {
  /** The HTML file, relative to raw/. */
  file: string;
  guild: string | null;
  conversation: P.ConversationFact;
  identities: P.IdentityFact[];
  messages: P.MessageFact[];
  /** Local files the facts refer to by file:// URL (attachments, avatars, stickers, embed images). */
  files: Set<string>;
  missingFiles: number;
}

export interface ReadOptions {
  rawDir: string;
  /** The importing account's own user id: decides direct vs group, and mentions of you. */
  selfId: string;
  /** Called for each local file before it goes into a URL; returns the URL to use (the media store's). */
  mediaUrl?: (absPath: string) => string;
}

const htmlFiles = (rawDir: string) =>
  readdirSync(rawDir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.html') && /\[\d+\]\.html$/.test(d.name))
    .map((d) => join(d.parentPath, d.name).slice(rawDir.length + 1))
    .sort();

/** Every author's name -> id across the export, so a mention by name can become <@id>. */
export function authorIndex(rawDir: string): Map<string, string> {
  const byName = new Map<string, string>();
  const re = /class=["']?chatlog__author["']?\s+title=("[^"]*"|'[^']*'|[^\s>]+)\s+data-user-id=["']?(\d+)/g;
  for (const f of htmlFiles(rawDir)) {
    const html = readFileSync(join(rawDir, f), 'utf8');
    for (const m of html.matchAll(re)) byName.set(m[1].replace(/^["']|["']$/g, ''), m[2]);
  }
  return byName;
}

export function* readDceHtml(o: ReadOptions): Generator<ChannelBatch> {
  const names = authorIndex(o.rawDir);
  for (const f of htmlFiles(o.rawDir)) yield readFile(o, f, names);
}

/**
 * file:///home/<anyone>/X -> <raw>/X; null for anything else. DCE writes some names still percent-encoded, so the
 * name as written is tried before the decoded one.
 */
export function localPath(rawDir: string, url: string | undefined): string | null {
  const m = url?.match(/^file:\/\/\/home\/[^/]+\/(.+)$/);
  if (!m) return null;
  let decoded = m[1];
  try {
    decoded = decodeURIComponent(m[1]);
  } catch {}
  for (const rel of [m[1], decoded]) {
    if (rel.split('/').includes('..')) return null;
    if (existsSync(join(rawDir, rel))) return join(rawDir, rel);
  }
  return join(rawDir, decoded);
}

const GROUP_START = /<div\s+class=["']?chatlog__message-group["']?\s*>/g;

export function readFile(o: ReadOptions, file: string, names: Map<string, string>): ChannelBatch {
  const html = readFileSync(join(o.rawDir, file), 'utf8');
  const channelId = file.match(/\[(\d+)\]\.html$/)![1];
  const chatlogAt = html.search(/<div\s+class=["']?chatlog["']?\s*>/);
  const pre = parseFragment(html.slice(0, chatlogAt < 0 ? 0 : chatlogAt));
  const entries = findAll(pre, 'preamble__entry').map((e) => text(e).trim());
  const guild = entries[0] ?? null;
  const channelName = (entries[1] ?? '').split(' / ').pop()?.trim() || null;
  const isDm = guild === 'Direct Messages';

  const batch: ChannelBatch = { file, guild: isDm ? null : guild, conversation: { nativeId: channelId, shape: 'channel' }, identities: [], messages: [], files: new Set(), missingFiles: 0 };
  const idents = new Map<string, P.IdentityFact>();
  const url = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    const p = localPath(o.rawDir, raw);
    if (!p) return raw;
    batch.files.add(p);
    return o.mediaUrl ? o.mediaUrl(p) : `file://${p}`;
  };

  const starts: number[] = [];
  for (const m of html.matchAll(GROUP_START)) starts.push(m.index!);
  const end = html.search(/<div\s+class=["']?postamble["']?\s*>/);
  for (let i = 0; i < starts.length; i++) {
    const group = parseFragment(html.slice(starts[i], starts[i + 1] ?? (end > 0 ? end : html.length)));
    readGroup(group, { channelId, selfId: o.selfId, names, idents, url, out: batch.messages });
  }

  // Shape: a DM file with one other author is a direct chat; more is a group.
  const others = new Set(batch.messages.map((m) => m.author).filter((a) => a !== o.selfId));
  if (isDm) {
    const participants = [o.selfId, ...[...others].sort()];
    batch.conversation =
      others.size > 1
        ? { nativeId: channelId, shape: 'group', name: channelName ?? undefined, participants }
        : { nativeId: channelId, shape: 'direct', participants };
  } else batch.conversation = { nativeId: channelId, shape: 'channel', name: channelName ?? undefined };
  batch.identities = [...idents.values()];
  return batch;
}

interface GroupCtx {
  channelId: string;
  selfId: string;
  names: Map<string, string>;
  idents: Map<string, P.IdentityFact>;
  url: (raw: string | undefined) => string | undefined;
  out: P.MessageFact[];
}

function readGroup(group: El, c: GroupCtx) {
  let author: string | null = null;
  for (const box of findAll(group, 'chatlog__message-container')) {
    const id = box.attrs['data-message-id'];
    if (!id || !/^\d+$/.test(id)) continue;
    const ts = snowflakeToMs(id);

    const sys = find(box, 'chatlog__system-notification-author');
    if (sys) {
      const who = sys.attrs['data-user-id'];
      if (!who) continue;
      const name = text(sys).trim() || sys.attrs.title || 'Someone';
      note(c, who, sys.attrs.title, name);
      const what = text(find(box, 'chatlog__system-notification-content') ?? sys).replace(/\s+/g, ' ').trim();
      c.out.push({ nativeId: id, conversation: c.channelId, author: who, ts, kind: 'system', body: `${name} ${what}`.trim() });
      continue;
    }

    const head = find(box, 'chatlog__author');
    if (head?.attrs['data-user-id']) {
      author = head.attrs['data-user-id'];
      const avatar = find(group, 'chatlog__avatar')?.attrs.src;
      note(c, author, head.attrs.title, text(head).trim(), c.url(avatar));
    }
    if (!author) continue;

    const content = find(box, 'chatlog__content');
    const preserve = content ? (find(content, 'chatlog__markdown-preserve') ?? content) : null;
    let body = preserve ? markdown(preserve, c.names).trim() : '';
    const edited = find(box, 'chatlog__edited-timestamp');

    const attachments: P.AttachmentFact[] = [];
    for (const a of findOwn(box, 'chatlog__attachment', ['chatlog__embed', 'chatlog__reply'])) {
      const fact = attachmentOf(a, c.url);
      if (fact) attachments.push(fact);
    }
    const stickers = findOwn(box, 'chatlog__sticker', ['chatlog__reply']);
    if (!body && stickers.length) body = stickers.map((s) => `[sticker: ${s.attrs.title ?? 'sticker'}]`).join(' ');

    const reactions: P.ReactionFact[] = [];
    for (const r of findAll(box, 'chatlog__reaction')) {
      const img = find(r, 'chatlog__emoji');
      const count = Number(text(find(r, 'chatlog__reaction-count') ?? r).trim()) || 1;
      const e = emojiOf(img);
      if (e) reactions.push({ key: e.key, count, authors: [], ...(e.custom ? { emoji: { key: e.key, name: e.name, url: c.url(img?.attrs.src) ?? '', animated: e.animated } } : {}) });
    }

    const embeds = findOwn(box, 'chatlog__embed', ['chatlog__reply'])
      .slice(0, 6)
      .map((e) => {
        const titleLink = find(e, 'chatlog__embed-title-link');
        const generic = find(e, 'chatlog__embed-generic-gifv') ?? find(e, 'chatlog__embed-generic-video') ?? find(e, 'chatlog__embed-generic-image');
        if (generic) {
          // A message that was only a link to a GIF or picture: DCE keeps the media and drops the link, so the
          // media becomes an attachment, which plays where an embed's picture would not.
          const media = generic.attrs.src ?? [...walk(generic)].find((x) => x.attrs.src)?.attrs.src;
          const u = c.url(media);
          if (u) attachments.push({ kind: generic.tag === 'img' ? 'image' : 'video', name: originalName(media!), url: u });
          return { generic: true };
        }
        const img = find(e, 'chatlog__embed-image') ?? find(e, 'chatlog__embed-thumbnail');
        const pick = (cls: string) => {
          const x = find(e, cls);
          return x ? text(x).replace(/\s+/g, ' ').trim() || undefined : undefined;
        };
        return { title: pick('chatlog__embed-title'), description: pick('chatlog__embed-description'), url: titleLink?.attrs.href || undefined, author: pick('chatlog__embed-author'), image: c.url(img?.attrs.src) };
      })
      .filter((e) => !('generic' in e) && (e.title || e.description || e.image || e.url));

    const replyLink = find(box, 'chatlog__reply-link')?.attrs.onclick?.match(/scrollToMessage\(\s*event\s*,\s*['"](\d+)['"]/)?.[1];
    const mentionsSelf = body.includes(`<@${c.selfId}>`) || /@(everyone|here)\b/.test(body);

    const f: P.MessageFact = {
      nativeId: id,
      conversation: c.channelId,
      author,
      ts,
      kind: attachments.length && !body ? 'media' : 'text',
      body,
    };
    if (edited) f.editedTs = parseDceTime(edited.attrs.title) ?? ts;
    if (replyLink) f.replyTo = replyLink;
    if (mentionsSelf && author !== c.selfId) f.mentionsSelf = true;
    if (attachments.length) f.attachments = attachments;
    if (reactions.length) f.reactions = reactions;
    if (embeds.length) f.extra = { embeds };
    c.out.push(f);
  }
}

function note(c: GroupCtx, id: string, handle: string | undefined, display: string, avatar?: string) {
  const cur = c.idents.get(id) ?? { nativeId: id };
  if (handle && !cur.handle) cur.handle = handle;
  if (display && !cur.displayName) cur.displayName = display;
  if (avatar && !cur.avatarUrl) cur.avatarUrl = avatar;
  c.idents.set(id, cur);
}

const IMG = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const VID = /\.(mp4|mov|webm|mkv|avi)$/i;
const AUD = /\.(mp3|ogg|wav|flac|m4a|opus)$/i;

/** DCE's legacy media names are "<stem>-<5 hex>.<ext>"; the original name is the stem. */
export function originalName(path: string): string {
  const base = decodeURIComponent(path.split(/[\\/]/).pop()!.split('?')[0]);
  return base.replace(/-[0-9a-f]{5}(\.[^.]+)?$/i, '$1');
}

function attachmentOf(a: El, url: (raw: string | undefined) => string | undefined): P.AttachmentFact | null {
  const media = find(a, 'chatlog__attachment-media');
  const source = media ? (media.attrs.src ?? (media.children.find((x) => typeof x !== 'string' && x.tag === 'source') as El | undefined)?.attrs.src) : undefined;
  const link = find(a, 'chatlog__attachment-generic-name');
  const href = source ?? (link ? findA(link)?.attrs.href : undefined) ?? findA(a)?.attrs.href;
  if (!href) return null;
  const cdn = href.match(/\/attachments\/\d+\/(\d+)\//);
  const name = link ? text(link).trim() : originalName(href);
  const kind: P.AttachmentKind = media?.tag === 'video' || VID.test(name) ? 'video' : media?.tag === 'audio' || AUD.test(name) ? 'audio' : media?.tag === 'img' || IMG.test(name) ? 'image' : 'file';
  return { ...(cdn ? { nativeId: cdn[1] } : {}), kind, name, url: url(href)! };
}

function findA(e: El): El | null {
  for (const c of e.children) {
    if (typeof c === 'string') continue;
    if (c.tag === 'a') return c;
    const x = findA(c);
    if (x) return x;
  }
  return null;
}

/** A unicode emoji is its own alt text; a custom one has a name and an id in its image's file name. */
function emojiOf(img: El | null): { key: string; name: string; custom: boolean; animated: boolean } | null {
  if (!img) return null;
  const alt = (img.attrs.alt ?? '').trim();
  const src = img.attrs.src ?? '';
  const id = src.match(/(?:emojis\/|\/)(\d{15,21})(?:-[0-9a-f]{5})?\.(png|gif|webp)/i);
  if (id) {
    const name = alt.replace(/^:|:$/g, '') || 'emoji';
    return { key: `${name}:${id[1]}`, name, custom: true, animated: id[2].toLowerCase() === 'gif' };
  }
  return alt ? { key: alt, name: alt, custom: false, animated: false } : null;
}

// ------------------------------------------------------------------ rendered HTML -> Discord Markdown

export function markdown(e: El, names: Map<string, string>): string {
  return e.children.map((c) => md(c, names)).join('');
}

function md(n: El | string, names: Map<string, string>): string {
  if (typeof n === 'string') return n;
  const inner = () => markdown(n, names);
  const cls = classes(n);
  if (n.tag === 'br') return '\n';
  if (cls.includes('chatlog__edited-timestamp')) return '';
  if (cls.includes('chatlog__markdown-mention')) {
    const t = text(n).trim();
    const id = n.attrs.title ? names.get(n.attrs.title) : undefined;
    return t.startsWith('@') && id ? `<@${id}>` : t;
  }
  if (cls.includes('chatlog__markdown-pre--inline')) return '`' + text(n) + '`';
  if (cls.includes('chatlog__markdown-pre--multiline')) {
    const lang = cls.find((c) => c.startsWith('language-'))?.slice(9) ?? '';
    return '```' + lang + '\n' + text(n).replace(/\n$/, '') + '\n```';
  }
  if (cls.includes('chatlog__markdown-spoiler')) return `||${inner()}||`;
  if (cls.includes('chatlog__markdown-quote')) {
    const body = find(n, 'chatlog__markdown-quote-content') ?? n;
    return markdown(body, names).replace(/\n$/, '').replace(/^/gm, '> ') + '\n';
  }
  if (cls.includes('chatlog__markdown-quote-border')) return '';
  if (cls.includes('chatlog__emoji') || (n.tag === 'img' && hasClass(n, 'chatlog__emoji'))) {
    const e = emojiOf(n);
    return !e ? '' : e.custom ? `<${e.animated ? 'a' : ''}:${e.name}:${e.key.split(':').pop()}>` : e.key;
  }
  switch (n.tag) {
    case 'strong':
    case 'b':
      return `**${inner()}**`;
    case 'em':
    case 'i':
      return `*${inner()}*`;
    case 'u':
      return `__${inner()}__`;
    case 's':
    case 'del':
      return `~~${inner()}~~`;
    case 'code':
      return '`' + text(n) + '`';
    case 'pre':
      return '```\n' + text(n).replace(/\n$/, '') + '\n```';
    case 'a': {
      const href = n.attrs.href ?? '';
      const t = inner();
      return !href || t === href || href === `mailto:${t}` ? t || href : `[${t}](${href})`;
    }
    case 'h1':
      return `# ${inner()}\n`;
    case 'h2':
      return `## ${inner()}\n`;
    case 'h3':
      return `### ${inner()}\n`;
    case 'li':
      return `- ${inner()}\n`;
    case 'img':
      return n.attrs.alt ?? '';
    default:
      return inner();
  }
}
