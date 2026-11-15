/**
 * Stylesheet scope (docs/testing.md "Stylesheets"), cheap enough for every CI run: bun run check:css.
 *
 * A component's own stylesheet (any .css under packages/web/src but styles.css, imported by the component) is global
 * once it loads: a rule in it applies to every element on the page, not only the component's. So a rule there that
 * names only classes the rest of the app uses too reaches into the rest of the app, but only after that component has
 * been shown once. On 2026-11-14 the X feed's `.composer { … }` (its post box) gave the chat's message box a second
 * frame, and only once the feed had been opened that session.
 *
 * Each such stylesheet is owned by the files that import it and the files only they import (directly or further down).
 * A class is the stylesheet's own when it is written in those files and in no other (as a word in a string or template
 * literal whose words could all be classes: `class="post-item opens"`, `` `post-composer ${level}` ``; a sheet in a
 * directory of its own under ui/ is owned by every file there too). Then:
 * - every selector in it needs at least one class of its own (`.thread-focal .post-composer` is fine; `.composer`,
 *   `.on`, `button` or `textarea:focus` alone are not);
 * - a class it styles at the top (the whole selector is that class, with pseudo-classes) is not also styled by
 *   styles.css or another component's stylesheet, so the two never fight over one name.
 * A selector that must reach outside says why: `/* css-scope: <reason> *\/` in the comment right before its rule.
 *
 *   bun scripts/check-css.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'packages/web/src');
const GLOBAL = join(SRC, 'styles.css');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(SRC);
const code = files.filter((f) => /\.(tsx?|jsx?)$/.test(f) && !f.endsWith('.d.ts'));
const sheets = files.filter((f) => f.endsWith('.css') && f !== GLOBAL);

// ------------------------------------------------------------------ code: imports and the words in its strings

// A literal is read as a class list only when every word in it could be a class here (lower case, digits, - and _):
// "No app opens ${mime}" is a sentence, not a use of `.opens`.
const CLASSY = /^-?[a-z_][a-z0-9_-]*$/;
const imports = new Map<string, string[]>(); // file -> local files it imports statically (a lazy import() is not one)
const words = new Map<string, Set<string>>(); // file -> every class-like word in its string and template literals

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (files.includes(c)) return c;
  return null;
}

for (const f of code) {
  const text = readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, false, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const w = new Set<string>();
  const addWords = (s: string) => {
    const ts = s.split(/\s+/).filter(Boolean);
    if (ts.every((t) => CLASSY.test(t))) for (const t of ts) w.add(t);
  };
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const r = resolveLocal(f, n.moduleSpecifier.text);
      if (r) out.push(r);
      return;
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const r = resolveLocal(f, n.moduleSpecifier.text);
      if (r) out.push(r);
      return;
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) addWords(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) addWords(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  imports.set(f, out);
  words.set(f, w);
}

const importers = new Map<string, Set<string>>();
for (const [f, deps] of imports) for (const d of deps) (importers.get(d) ?? importers.set(d, new Set()).get(d)!).add(f);

/**
 * The files that import the sheet, and the files only they import, as far down as that goes. A sheet in a directory of
 * its own under ui/ (ui/feed/feed.css) is that directory's: every file in it is the component's.
 */
function owners(sheet: string): Set<string> {
  const own = new Set([...(importers.get(sheet) ?? [])]);
  const dir = dirname(sheet);
  if (dir !== join(SRC, 'ui') && dir.startsWith(join(SRC, 'ui') + '/')) for (const f of code) if (f.startsWith(dir + '/')) own.add(f);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of own)
      for (const d of imports.get(f) ?? []) {
        if (own.has(d) || d.endsWith('.css')) continue;
        if ([...(importers.get(d) ?? [])].every((i) => own.has(i))) {
          own.add(d);
          grew = true;
        }
      }
  }
  return own;
}

// ------------------------------------------------------------------ stylesheets: rules, selectors, classes

interface Rule {
  selectors: string[];
  line: number;
  allowed: boolean; // a `css-scope:` comment right before it
}

/** Rules at the top and inside @media/@supports/@container/@layer; @keyframes and @font-face hold no selectors. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  let lastComment = '';
  let lastCommentEnd = -1;
  const lineAt = (at: number) => css.slice(0, at).split('\n').length;
  const parseBlock = (end: string | null) => {
    let start = i;
    while (i < css.length) {
      if (css.startsWith('/*', i)) {
        const close = css.indexOf('*/', i + 2);
        lastComment = css.slice(i + 2, close);
        i = close + 2;
        lastCommentEnd = i;
        start = i;
        continue;
      }
      const ch = css[i];
      if (ch === '}' && end) {
        i++;
        return;
      }
      if (ch === ';') {
        i++;
        start = i;
        continue;
      }
      if (ch === '{') {
        const head = css.slice(start, i).trim();
        const commentBefore = lastCommentEnd >= 0 && css.slice(lastCommentEnd, start).trim() === '' ? lastComment : '';
        const at = start + css.slice(start, i).search(/\S/);
        i++;
        if (/^@(media|supports|container|layer)\b/.test(head)) parseBlock('}');
        else if (head.startsWith('@')) skipBlock();
        else {
          out.push({ selectors: splitSelectors(head), line: lineAt(at), allowed: /css-scope:\s*\S/.test(commentBefore) });
          skipBlock();
        }
        start = i;
        continue;
      }
      i++;
    }
  };
  const skipBlock = () => {
    for (let depth = 1; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
  };
  parseBlock(null);
  return out;
}

/** Commas at the top level of a selector list, not inside :is(…) or [attr="a,b"]. */
function splitSelectors(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Classes a selector names, outside attribute selectors and strings; :not(.x) excludes rather than names, so it is left out. */
function classesOf(sel: string): string[] {
  const plain = sel.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/(["']).*?\1/g, '');
  return [...plain.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]);
}

/** The class a selector is about when it is only that class (`.x`, `.x:hover`, `.x::before`), else null. */
function topClass(sel: string): string | null {
  const m = /^\.(-?[A-Za-z_][\w-]*)((?::{1,2}[\w-]+(?:\([^)]*\))?)*)$/.exec(sel.trim());
  return m ? m[1] : null;
}

// ------------------------------------------------------------------ the check

const topClasses = new Map<string, Set<string>>(); // class -> sheets that style it as a whole selector
const allSheets = [GLOBAL, ...sheets];
const parsed = new Map(allSheets.map((s) => [s, rules(readFileSync(s, 'utf8'))]));
for (const [s, rs] of parsed)
  for (const r of rs)
    for (const sel of r.selectors) {
      const c = topClass(sel);
      if (c) (topClasses.get(c) ?? topClasses.set(c, new Set()).get(c)!).add(s);
    }

const problems: string[] = [];
const rel = (f: string) => relative(ROOT, f);
for (const sheet of sheets) {
  const own = owners(sheet);
  if (!own.size) {
    problems.push(`${rel(sheet)}: no file imports it`);
    continue;
  }
  const elsewhere = new Set<string>();
  for (const f of code) if (!own.has(f)) for (const w of words.get(f)!) elsewhere.add(w);
  const isOwn = (c: string) => !elsewhere.has(c);
  for (const r of parsed.get(sheet)!) {
    if (r.allowed) continue;
    for (const sel of r.selectors) {
      const cs = classesOf(sel);
      if (!cs.some(isOwn)) {
        const shared = cs.length ? `names only classes used outside it (${cs.map((c) => `.${c}`).join(' ')})` : 'names no class';
        const users = cs.length
          ? code.filter((f) => !own.has(f) && cs.every((c) => words.get(f)!.has(c))).map(rel).slice(0, 3)
          : [];
        problems.push(`${rel(sheet)}:${r.line}: \`${sel}\` ${shared}${users.length ? `; written in ${users.join(', ')}` : ''}`);
        continue;
      }
      const c = topClass(sel);
      const others = c ? [...(topClasses.get(c) ?? [])].filter((s) => s !== sheet) : [];
      if (others.length) problems.push(`${rel(sheet)}:${r.line}: \`.${c}\` is styled at the top here and in ${others.map(rel).join(', ')}`);
    }
  }
}

if (problems.length) {
  console.log(`check-css: ${problems.length} selector${problems.length > 1 ? 's' : ''} in a component's stylesheet reach outside it:`);
  for (const p of problems) console.log(`  ${p}`);
  console.log(
    '\nGive the selector a class of the component\'s own (rename a shared one, or put the component\'s root class in\nfront), or say why it must reach out: /* css-scope: <reason> */ right before the rule (docs/testing.md "Stylesheets").',
  );
  process.exit(1);
}
console.log(`check-css: ${sheets.length} component stylesheets, every selector scoped to its own component`);
