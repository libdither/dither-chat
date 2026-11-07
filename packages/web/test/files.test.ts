import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { cleanName, extOf, guessKind, languageOf } from '@dither-chat/protocol';
import { fileFacts, fileKind, typeLabel } from '../src/files.ts';
import { highlight, toLines } from '../src/ui/files/highlight.ts';
import { delimiter, parseCsv } from '../src/ui/files/csv.ts';

const att = (o: Partial<P.AttachmentView>): P.AttachmentView => ({ id: 'a', kind: 'file', mime: null, name: null, size: null, width: null, height: null, url: '/media/x', ...o });

describe('a file before the hub has looked at it', () => {
  test('a viewer by name and type, binary when unsure', () => {
    expect(guessKind('application/octet-stream', 'notes.md')).toBe('markdown');
    expect(guessKind(null, 'main.rs')).toBe('text');
    expect(guessKind('text/csv', 'x')).toBe('csv');
    expect(guessKind('application/pdf', null)).toBe('pdf');
    expect(guessKind('image/svg+xml', 'logo.svg')).toBe('text');
    expect(guessKind('text/html', 'page.html')).toBe('text');
    expect(guessKind('application/octet-stream', 'firmware.bin')).toBe('binary');
    expect(guessKind('application/zip', 'a.zip')).toBe('archive');
  });
  test('names: the last extension, without tricks', () => {
    expect(extOf('a/b/c.tar.GZ')).toBe('gz');
    expect(extOf('.md')).toBe('');
    expect(extOf('invoice\u202efdp.exe')).toBe('exe');
    expect(cleanName('a\u0000b\u202ec')).toBe('abc');
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('x.TSX')).toBe('typescript');
  });
  test('what the hub found wins over the guess', () => {
    expect(fileKind(att({ name: 'a.txt', mime: 'text/plain', info: { mime: 'image/png', kind: 'image', size: 10 } }))).toBe('image');
    expect(fileKind(att({ kind: 'image', mime: 'image/png' }))).toBe('image');
  });
});

describe('what a file card says', () => {
  test('type, then pages, lines or entries, then size', () => {
    expect(fileFacts(att({ name: 'paper.pdf', info: { mime: 'application/pdf', kind: 'pdf', size: 1_258_291, pages: 12 } }))).toBe('PDF · 12 pages · 1.2 MB');
    expect(fileFacts(att({ name: 'main.rs', info: { mime: 'text/rust', kind: 'text', size: 673, lines: 26, language: 'rust' } }))).toBe('Rust · 26 lines · 673 B');
    expect(fileFacts(att({ name: 'big.log', info: { mime: 'text/plain', kind: 'text', size: 9_000_000, lines: 65_000, partial: true } }))).toBe('Text · at least 65,000 lines · 8.6 MB');
    expect(fileFacts(att({ name: 'x.zip', info: { mime: 'application/zip', kind: 'archive', size: 2048, entries: 1 } }))).toBe('ZIP archive · 1 entry · 2 KB');
    expect(fileFacts(att({ name: 'b.xlsx', size: 661, mime: 'application/octet-stream' }))).toBe('XLSX file · 661 B');
  });
  test('labels from the type, the language or the extension', () => {
    expect(typeLabel(att({ info: { mime: 'image/svg+xml', kind: 'text', size: 1, language: 'xml' } }))).toBe('SVG image');
    expect(typeLabel(att({ info: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'binary', size: 1 } }))).toBe('Excel spreadsheet');
    expect(typeLabel(att({ mime: 'image/webp', kind: 'image' }))).toBe('WEBP image');
  });
});

describe('CSV and TSV', () => {
  test('quotes, doubled quotes, separators and line breaks inside a field', () => {
    expect(parseCsv('a,b,c\n1,"x, y","he said ""hi"""\n2,"two\nlines",\n', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'he said "hi"'],
      ['2', 'two\nlines', ''],
    ]);
    expect(parseCsv('a;b\r\n1;2', ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  test('a field cut off at the end keeps what it has', () => {
    expect(parseCsv('a,b\n1,"unfinished', ',')).toEqual([
      ['a', 'b'],
      ['1', 'unfinished'],
    ]);
  });
  test('the delimiter', () => {
    expect(delimiter('a;b;c\n', { name: 'x.csv' })).toBe(';');
    expect(delimiter('a,b\n', { name: 'x.tsv' })).toBe('\t');
    expect(delimiter('"a,b";c;d\n', {})).toBe(';');
  });
});

describe('highlighting', () => {
  const classes = (t: string, l: string) => highlight(t, l)!.filter(([c]) => c).map(([c, s]) => `${c}:${s}`);
  test('code', () => {
    expect(classes('const x = "a"; // b', 'typescript')).toEqual(['k:const', 's:"a"', 'c:// b']);
    expect(classes("fn f<'a>(x: &'a str) {}", 'rust')).toEqual(['k:fn']);
    expect(classes('SELECT 1 from t', 'sql')).toEqual(['k:SELECT', 'n:1', 'k:from']);
  });
  test('markup: tags and attributes, text left alone', () => {
    expect(classes('<a href="x">it\'s "fine"</a>', 'html')).toEqual(['t:<a', 'a:href', 's:"x"', 't:>', 't:</a', 't:>']);
  });
  test('a comment over several lines is cut at each line', () => {
    expect(toLines(highlight('a /* b\nc */ d', 'c')!).map((l) => l.map(([c, s]) => c + ':' + s))).toEqual([[':a', ': ', 'c:/* b'], ['c:c */', ': ', ':d']]);
  });
  test('no language, no highlighting', () => {
    expect(highlight('x', null)).toBeNull();
    expect(highlight('x', 'klingon')).toBeNull();
  });
});
