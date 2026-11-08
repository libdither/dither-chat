/**
 * Files in messages (docs/files.md): which viewer shows one, what its card says, and opening the viewer. The viewers
 * themselves are chunks of their own (ui/files/), loaded when a file is opened.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { extOf, guessKind } from '@dither-chat/protocol';
import { bytes } from './format.ts';

/** The kinds a viewer in ui/files/ shows. Images, video and audio have their own (Viewer.tsx, the timeline's players). */
export const VIEWABLE: ReadonlySet<P.FileKind> = new Set(['text', 'markdown', 'json', 'csv', 'pdf', 'archive']);

/** What the file is: by its bytes once the hub has looked, else by its name and the network's type. */
export function fileKind(a: Pick<P.AttachmentView, 'kind' | 'mime' | 'name' | 'info'>): P.FileKind {
  if (a.info) return a.info.kind;
  if (a.kind !== 'file') return a.kind;
  return guessKind(a.mime, a.name);
}

/** The type to go by: the one the bytes say, else the network's. */
export const fileMime = (a: Pick<P.AttachmentView, 'mime' | 'info'>) => a.info?.mime ?? a.mime;

const LANGUAGE: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  go: 'Go',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  php: 'PHP',
  shell: 'Shell script',
  sql: 'SQL',
  css: 'CSS',
  html: 'HTML',
  xml: 'XML',
  json: 'JSON',
  yaml: 'YAML',
  toml: 'TOML',
  nix: 'Nix',
  diff: 'Patch',
  latex: 'LaTeX',
  lua: 'Lua',
  haskell: 'Haskell',
};
const MIME_LABEL: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/zip': 'ZIP archive',
  'application/gzip': 'Gzip archive',
  'application/x-tar': 'Tar archive',
  'application/java-archive': 'Java archive',
  'application/vnd.android.package-archive': 'Android app',
  'application/x-7z-compressed': '7-Zip archive',
  'application/vnd.rar': 'RAR archive',
  'application/x-xz': 'XZ archive',
  'application/x-bzip2': 'Bzip2 archive',
  'application/zstd': 'Zstandard archive',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/vnd.oasis.opendocument.text': 'OpenDocument text',
  'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument spreadsheet',
  'application/vnd.oasis.opendocument.presentation': 'OpenDocument presentation',
  'application/epub+zip': 'EPUB book',
  'application/msword': 'Word document',
  'application/vnd.ms-excel': 'Excel spreadsheet',
  'application/vnd.ms-powerpoint': 'PowerPoint',
  'application/x-executable': 'Program',
  'application/vnd.microsoft.portable-executable': 'Windows program',
  'application/x-mach-binary': 'Mac program',
  'application/vnd.sqlite3': 'SQLite database',
  'application/x-iso9660-image': 'Disc image',
  'image/svg+xml': 'SVG image',
  'text/html': 'HTML page',
  'text/csv': 'CSV table',
  'text/tab-separated-values': 'TSV table',
  'text/markdown': 'Markdown',
  'text/plain': 'Text',
};

/** A name for the file's type: "Markdown", "Rust", "ZIP archive", "PNG image". */
export function typeLabel(a: Pick<P.AttachmentView, 'kind' | 'mime' | 'name' | 'info'>): string {
  const lang = a.info?.language;
  const mime = (fileMime(a) ?? '').split(';')[0].trim().toLowerCase();
  if (MIME_LABEL[mime] && !(mime === 'text/plain' && lang)) return MIME_LABEL[mime];
  if (lang && LANGUAGE[lang]) return LANGUAGE[lang];
  const [top, sub = ''] = mime.split('/');
  if (top === 'image' || top === 'video' || top === 'audio') {
    const short = sub.replace(/^(x-|vnd\.)/, '').split(/[.+;-]/)[0].toUpperCase();
    return `${short || top} ${top}`.replace(/^(\S+) (\S+)$/, (_, s, t) => `${s} ${t}`);
  }
  const ext = extOf(a.name);
  if (ext) return `${ext.toUpperCase()} file`;
  return mime && mime !== 'application/octet-stream' ? mime : 'File';
}

const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function duration(s: number): string {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** What a file's card says under its name: type, then pages, lines, entries or length, then size. */
export function fileFacts(a: Pick<P.AttachmentView, 'kind' | 'mime' | 'name' | 'info' | 'size'>): string {
  const i = a.info;
  const at = i?.partial ? 'at least ' : '';
  const parts = [typeLabel(a)];
  if (i?.pages) parts.push(plural(i.pages, 'page'));
  else if (i?.entries !== undefined && i.kind !== 'binary') parts.push(at + plural(i.entries, 'entry', 'entries'));
  else if (i?.lines !== undefined && i.kind !== 'binary') parts.push(at + plural(i.lines, 'line'));
  else if (i?.duration) parts.push(duration(i.duration));
  else if (i?.width && i.height) parts.push(`${i.width}×${i.height}`);
  const size = bytes(i?.size ?? a.size);
  if (size) parts.push(size);
  return parts.join(' · ');
}

/** Which icon a file's card has. */
export function fileIcon(kind: P.FileKind, language?: string): string {
  if (kind === 'archive') return 'archive';
  if (kind === 'csv') return 'grid';
  if (kind === 'text' && language) return 'fileCode';
  if (kind === 'text' || kind === 'markdown' || kind === 'json' || kind === 'pdf') return 'fileText';
  return 'file';
}

/**
 * A file the viewers can open: a chat attachment, or a part of a mail (ui/mail/MailFiles.tsx). `infoUrl` answers
 * what the file is (FileInfo) when `info` is not known yet.
 */
export interface FileSource {
  url: string;
  infoUrl: string | null;
  name: string | null;
  mime: string | null;
  size: number | null;
  kind: P.AttachmentKind;
  info?: P.FileInfo;
}

/** A chat attachment as a viewer opens it. */
export const attachmentSource = (a: P.AttachmentView): FileSource => ({
  url: a.url,
  infoUrl: `/api/attachments/${encodeURIComponent(a.id)}/info`,
  name: a.name,
  mime: a.mime,
  size: a.size,
  kind: a.kind,
  ...(a.info ? { info: a.info } : {}),
});

/** The file open in the viewer, and the message it came in (a chat message; null for mail). */
export const fileViewer = signal<{ att: FileSource; message: P.MessageView | null } | null>(null);

export function openFileViewer(att: P.AttachmentView, message: P.MessageView | null = null) {
  fileViewer.value = { att: attachmentSource(att), message };
}

/** Opens any file in the viewer. */
export function openFileSource(att: FileSource) {
  fileViewer.value = { att, message: null };
}
