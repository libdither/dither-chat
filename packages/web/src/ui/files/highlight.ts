/**
 * Light syntax highlighting for the text viewer: comments, strings, numbers, keywords, and tags and keys in markup and
 * data. One regular expression per family of languages, no grammar. Wrong now and then, never slow.
 */

/** c comment, s string, n number, k keyword, t tag or type, a attribute or key, h heading, add and del for patches. */
export type Cls = '' | 'c' | 's' | 'n' | 'k' | 't' | 'a' | 'h' | 'add' | 'del';
export type Token = [cls: Cls, text: string];

const words = (s: string) => new Set(s.split(' '));
const JS = words(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof undefined var void while with yield async await of static get set interface type implements private protected public readonly declare namespace abstract as from keyof never any unknown number string boolean satisfies',
);
const RUST = words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err');
const PY = words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self');
const GO = words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false');
const CLIKE = words(
  'auto break case char const continue default do double else enum extern float for goto if inline int long return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected virtual template typename namespace using new delete this throw try catch true false nullptr bool package import extends implements interface final abstract boolean byte null super synchronized val var fun when object override let func guard self protocol extension string internal sealed data where is in out',
);
const SHELL = words('if then else elif fi for while until do done case esac in function return local export exit set unset readonly shift source alias echo cd');
const RUBY = words('def end class module if elsif else unless while until for in do return yield begin rescue ensure raise nil true false self require then case when puts attr_accessor');
const SQL = words('select from where insert into values update set delete create table index view drop alter add primary key foreign references not null and or join left right inner outer on group by order having limit offset as distinct union all case when then else end is in like between exists default with returning');
const NIX = words('let in with rec inherit if then else assert import true false null or');
const LUA = words('and break do else elseif end false for function goto if in local nil not or repeat return then true until while');
const HS = words('case class data deriving do else if import in infix instance let module newtype of then type where');
const DOCKER = words('FROM RUN CMD COPY ADD ENV ARG WORKDIR EXPOSE ENTRYPOINT USER VOLUME LABEL HEALTHCHECK SHELL STOPSIGNAL ONBUILD AS');
const DATA = words('true false null yes no on off');

const NUM = String.raw`\b(?:0x[\da-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`;
const DQ = String.raw`"(?:[^"\\\n]|\\.)*"?`;
const SQ = String.raw`'(?:[^'\\\n]|\\.)*'?`;
const BT = String.raw`\x60(?:[^\x60\\]|\\[\s\S])*\x60?`;
const ID = String.raw`[A-Za-z_$][\w$]*`;

interface Family {
  re: RegExp;
  /** Groups in order: comment, string, number, word. */
  keywords?: Set<string>;
  /** Capitalised words are types. */
  types?: boolean;
  /** Keywords regardless of case (SQL). */
  anyCase?: boolean;
}

const family = (comments: string[], strings: string[], keywords?: Set<string>, extra: Partial<Family> = {}): Family => ({
  re: new RegExp(`(${comments.join('|')})|(${strings.join('|')})|(${NUM})|(${ID})`, 'g'),
  keywords,
  ...extra,
});

const SLASH = [String.raw`\/\/[^\n]*`, String.raw`\/\*[\s\S]*?(?:\*\/|$)`];
const HASH = [String.raw`#[^\n]*`];
const FAMILIES: Record<string, Family> = {
  javascript: family(SLASH, [DQ, SQ, BT], JS, { types: true }),
  typescript: family(SLASH, [DQ, SQ, BT], JS, { types: true }),
  rust: family(SLASH, [DQ, String.raw`'(?:[^'\\\n]|\\.)'`], RUST, { types: true }),
  go: family(SLASH, [DQ, BT, String.raw`'(?:[^'\\\n]|\\.)'`], GO, { types: true }),
  c: family(SLASH, [DQ, String.raw`'(?:[^'\\\n]|\\.)'`], CLIKE, { types: true }),
  python: family(HASH, [String.raw`"""[\s\S]*?(?:"""|$)`, String.raw`'''[\s\S]*?(?:'''|$)`, DQ, SQ], PY, { types: true }),
  shell: family(HASH, [DQ, SQ], SHELL),
  ruby: family(HASH, [DQ, SQ], RUBY, { types: true }),
  sql: family([String.raw`--[^\n]*`, String.raw`\/\*[\s\S]*?(?:\*\/|$)`], [SQ, DQ], SQL, { anyCase: true }),
  nix: family([...HASH, String.raw`\/\*[\s\S]*?(?:\*\/|$)`], [DQ, String.raw`''[\s\S]*?(?:''|$)`], NIX),
  lua: family([String.raw`--\[\[[\s\S]*?(?:\]\]|$)`, String.raw`--[^\n]*`], [DQ, SQ], LUA),
  haskell: family([String.raw`\{-[\s\S]*?(?:-\}|$)`, String.raw`--[^\n]*`], [DQ], HS, { types: true }),
  lisp: family([String.raw`;[^\n]*`], [DQ]),
  latex: family([String.raw`%[^\n]*`], []),
  css: family([String.raw`\/\*[\s\S]*?(?:\*\/|$)`], [DQ, SQ]),
  yaml: family(HASH, [DQ, SQ], DATA),
  toml: family(HASH, [DQ, SQ], DATA),
  ini: family([String.raw`[#;][^\n]*`], [DQ, SQ], DATA),
  dockerfile: family(HASH, [DQ, SQ], DOCKER),
  makefile: family(HASH, [DQ, SQ]),
  plain: family([], [DQ]),
};
for (const l of ['cpp', 'csharp', 'java', 'kotlin', 'swift', 'scala', 'dart', 'php', 'groovy', 'zig', 'protobuf', 'graphql', 'hcl']) FAMILIES[l] = FAMILIES.c;
for (const l of ['perl', 'r', 'elixir', 'julia', 'powershell']) FAMILIES[l] = FAMILIES.shell;
FAMILIES.clojure = FAMILIES.lisp;
FAMILIES.erlang = FAMILIES.latex;

/** Common names a Markdown code block uses for a language. */
export const ALIASES: Record<string, string> = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rs: 'rust', sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', rb: 'ruby', yml: 'yaml', 'c++': 'cpp', cs: 'csharp', kt: 'kotlin', golang: 'go', md: 'markdown', patch: 'diff', html: 'html', svg: 'xml', jsonc: 'json', hs: 'haskell', docker: 'dockerfile', make: 'makefile', tex: 'latex' };

function scan(text: string, f: Family): Token[] {
  const out: Token[] = [];
  const re = new RegExp(f.re.source, f.re.flags);
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(['', text.slice(last, m.index)]);
    let cls: Cls = '';
    if (m[1] !== undefined) cls = 'c';
    else if (m[2] !== undefined) cls = 's';
    else if (m[3] !== undefined) cls = 'n';
    else {
      const w = m[4];
      if (f.keywords?.has(f.anyCase ? w.toLowerCase() : w)) cls = 'k';
      else if (f.types && /^[A-Z][a-z0-9]/.test(w)) cls = 't';
    }
    out.push([cls, m[0]]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(['', text.slice(last)]);
  return out;
}

function markup(text: string): Token[] {
  const out: Token[] = [];
  const re = /(<!--[\s\S]*?(?:-->|$))|(<!\[CDATA\[[\s\S]*?(?:\]\]>|$))|(<[!?\/]?[\w:.-]*)|(\/?\??>)|("[^"]*"?|'[^']*'?)|([\w:.-]+)(?=\s*=)|(&#?\w+;)/g;
  let last = 0;
  let inTag = false;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Quoted text and attributes only count inside a tag; outside, an apostrophe is just text.
    if (!inTag && (m[5] !== undefined || m[6] !== undefined)) {
      re.lastIndex = m.index + 1;
      continue;
    }
    if (m.index > last) out.push(['', text.slice(last, m.index)]);
    let cls: Cls = '';
    if (m[1] !== undefined || m[2] !== undefined) cls = 'c';
    else if (m[3] !== undefined) {
      cls = 't';
      inTag = true;
    } else if (m[4] !== undefined) {
      cls = 't';
      inTag = false;
    } else if (m[5] !== undefined) cls = 's';
    else if (m[6] !== undefined) cls = 'a';
    else cls = 'k';
    out.push([cls, m[0]]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(['', text.slice(last)]);
  return out;
}

function json(text: string): Token[] {
  const out: Token[] = [];
  const re = new RegExp(String.raw`("(?:[^"\\\n]|\\.)*"?)(\s*:)?|(-?` + NUM + String.raw`)|\b(true|false|null)\b|(\/\/[^\n]*)`, 'g');
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(['', text.slice(last, m.index)]);
    if (m[1] !== undefined) {
      out.push([m[2] !== undefined ? 'a' : 's', m[1]]);
      if (m[2]) out.push(['', m[2]]);
    } else out.push([m[3] !== undefined ? 'n' : m[4] !== undefined ? 'k' : 'c', m[0]]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(['', text.slice(last)]);
  return out;
}

/** Whole lines: patches and Markdown source. */
function lines(text: string, classify: (line: string, state: { fence: boolean }) => Cls): Token[] {
  const state = { fence: false };
  const out: Token[] = [];
  const all = text.split('\n');
  all.forEach((l, i) => {
    out.push([classify(l, state), l]);
    if (i < all.length - 1) out.push(['', '\n']);
  });
  return out;
}

const diff = (l: string): Cls => (/^(\+\+\+|---) /.test(l) ? 'h' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('@@') ? 'k' : /^(diff|index) /.test(l) ? 'c' : '');
const md = (l: string, st: { fence: boolean }): Cls => {
  if (/^\s*(```|~~~)/.test(l)) {
    st.fence = !st.fence;
    return 'c';
  }
  if (st.fence) return 's';
  if (/^#{1,6}\s/.test(l)) return 'h';
  if (/^\s*>/.test(l)) return 'c';
  if (/^\s*([-*+]|\d+\.)\s/.test(l)) return 'k';
  return '';
};

/** Tokens for `text` in `language` (files.ts LANGUAGES names, or a Markdown fence's). Null: no highlighting. */
export function highlight(text: string, language: string | null | undefined): Token[] | null {
  const l = language ? (ALIASES[language.toLowerCase()] ?? language.toLowerCase()) : null;
  if (!l) return null;
  if (l === 'html' || l === 'xml') return markup(text);
  if (l === 'json') return json(text);
  if (l === 'diff') return lines(text, diff);
  if (l === 'markdown') return lines(text, md);
  const f = FAMILIES[l];
  return f ? scan(text, f) : null;
}

/** Tokens cut into lines, a token that spans lines (a block comment) cut where they break. At most `limit` lines. */
export function toLines(tokens: Token[], limit = Infinity): Token[][] {
  const out: Token[][] = [[]];
  for (const [cls, text] of tokens) {
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        if (out.length >= limit) return out;
        out.push([]);
      }
      if (parts[i]) out[out.length - 1].push([cls, parts[i]]);
    }
  }
  return out;
}
