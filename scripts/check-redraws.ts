/**
 * Every component that draws from the client's copy of the hub's data, and that Preact may skip, reads what says that
 * data changed (docs/perf.md "What redraws"). Cheap enough for every CI run: bun run check:redraws.
 *
 * `db`, `timelines` and `quoted` (store.ts) are plain objects: reading them subscribes nothing. @preact/signals skips
 * drawing a component again when its parent does and its props are all the same, if the component read a signal while
 * it rendered or keeps state of its own (useState, useReducer, useComputed, useSignal). Such a component that reads
 * `db` and none of the change signals (versions.ts: `rev`, `metaRev`, `mailRev`, `presenceRev`, a `timelineRev`)
 * shows what it read the last time something else made it draw. The server sidebar's channel tree read unread counts
 * from `db` and one setting, so a read made on another device never reached it.
 *
 * A component Preact never skips draws whenever its parent does: what it reads counts as its parent's. What a
 * component reads while it renders counts, through any number of calls in packages/web/src. What runs later does not:
 * event handlers (a function in a JSX attribute), effects, callbacks and timers, untracked(), and useState's and
 * useRef's first values. One that is right without a change signal (its props change whenever what it reads does)
 * says why in a comment starting `redraws:` in the lines just before it.
 *
 * scripts/redraws-known.json lists the components found when this check began, to be fixed: one of those passes, and
 * one that no longer needs to be there fails until it is taken off. It should only shrink.
 *
 *   bun scripts/check-redraws.ts            the problems, if any
 *   bun scripts/check-redraws.ts --why      with, for each, a chain of calls that reaches the data
 *   bun scripts/check-redraws.ts --update   writes scripts/redraws-known.json from what it finds
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const WEB = join(ROOT, 'packages/web');
const SRC = join(WEB, 'src');
const why = process.argv.includes('--why');
const update = process.argv.includes('--update');
const KNOWN_FILE = join(import.meta.dir, 'redraws-known.json');
const known = new Set<string>((JSON.parse(readFileSync(KNOWN_FILE, 'utf8')) as { known: string[] }).known);

const cfg = ts.getParsedCommandLineOfConfigFile(join(WEB, 'tsconfig.json'), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => {
    throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  },
});
if (!cfg) throw new Error('packages/web/tsconfig.json did not parse');
const program = ts.createProgram({ rootNames: cfg.fileNames, options: { ...cfg.options, noEmit: true } });
const checker = program.getTypeChecker();
const ours = (f: ts.SourceFile) => f.fileName.startsWith(SRC + '/') && !/\.test\.tsx?$/.test(f.fileName);

/** The data no signal stands for, and the signals that move when it changes, by the file that declares them. */
const DATA: Record<string, Set<string>> = { 'store.ts': new Set(['db', 'timelines', 'quoted']) };
const VERSIONS: Record<string, Set<string>> = { 'versions.ts': new Set(['rev', 'metaRev', 'mailRev', 'presenceRev']) };
/** Called, these give a change signal: `timelineRev(key).value`. */
const VERSION_FNS: Record<string, Set<string>> = { 'versions.ts': new Set(['timelineRev']) };

/** The declaration a name stands for, through imports and re-exports (state.ts passes store.ts on). */
function declOf(n: ts.Node): ts.Declaration | undefined {
  let s = checker.getSymbolAtLocation(n);
  if (!s) return undefined;
  if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
  return s.valueDeclaration ?? s.declarations?.[0];
}
function named(d: ts.Declaration | undefined, table: Record<string, Set<string>>): string | null {
  if (!d) return null;
  const f = d.getSourceFile();
  if (!ours(f)) return null;
  const set = table[relative(SRC, f.fileName)];
  const name = (d as ts.NamedDeclaration).name;
  return set && name && ts.isIdentifier(name) && set.has(name.text) ? name.text : null;
}

type Fn = ts.FunctionLikeDeclaration;
const isFn = (n: ts.Node): n is Fn =>
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isGetAccessorDeclaration(n);

/** The function a call or a name runs, when it is one of ours: a declaration, or a const holding a function. */
function fnOf(callee: ts.Node): Fn | undefined {
  const d = declOf(callee);
  if (!d || !ours(d.getSourceFile())) return undefined;
  if (isFn(d)) return d;
  if (ts.isVariableDeclaration(d) && d.initializer) {
    let init: ts.Expression = d.initializer;
    // memo(function Row(…) {…}), memo((…) => …)
    while (ts.isCallExpression(init) && init.arguments.length && /^(memo|forwardRef)$/.test(init.expression.getText()))
      init = init.arguments[0];
    if (isFn(init)) return init;
  }
  return undefined;
}

/** Calls whose function argument does not run while the caller renders. */
const LATER = new Set([
  'useEffect',
  'useLayoutEffect',
  'useCallback',
  'useSignalEffect',
  'useState',
  'useRef',
  'useReducer',
  'effect',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'requestIdleCallback',
  'queueMicrotask',
  'addEventListener',
  'then',
  'catch',
  'finally',
  'untracked',
  'onceListed',
  'idle',
  'later',
]);
/** Calls whose first argument is a value only read on the first render: `useState(db.x.get(id))`. */
const FIRST_ONLY = new Set(['useState', 'useRef']);

interface Reads {
  /** A chain of calls that ends at the data, if it reads it. */
  data: string[] | null;
  /** It reads a change signal. */
  version: boolean;
  /** It reads some signal, or keeps state: Preact skips it when its props are the same. */
  skippable: boolean;
}
const summaries = new Map<Fn, Reads>();
const NONE: Reads = { data: null, version: false, skippable: false };
/** Hooks that keep state on the component that calls them, so that @preact/signals may skip it. */
const STATEFUL = new Set(['useState', 'useReducer', 'useComputed', 'useSignal']);

/** Whether `e`'s value is a signal (`Signal`, `ReadonlySignal`), so `e.value` subscribes what renders. */
function isSignal(e: ts.Expression): boolean {
  const t = checker.getNonNullableType(checker.getTypeAtLocation(e));
  const name = (t.aliasSymbol ?? t.getSymbol())?.getName();
  return name === 'Signal' || name === 'ReadonlySignal' || name === 'Computed';
}

const label = (f: Fn) => {
  const n =
    f.name && ts.isIdentifier(f.name)
      ? f.name.text
      : ts.isVariableDeclaration(f.parent) && ts.isIdentifier(f.parent.name)
        ? f.parent.name.text
        : ts.isCallExpression(f.parent) && ts.isVariableDeclaration(f.parent.parent) && ts.isIdentifier(f.parent.parent.name)
          ? f.parent.parent.name.text
          : '(function)';
  const sf = f.getSourceFile();
  return `${n} (${relative(SRC, sf.fileName)}:${sf.getLineAndCharacterOfPosition(f.getStart()).line + 1})`;
};

/** The function of `const x = computed(() => …)`, for `x.value`. */
function followed(e: ts.Expression): Fn | undefined {
  const d = declOf(e);
  if (!d || !ours(d.getSourceFile()) || !ts.isVariableDeclaration(d) || !d.initializer) return undefined;
  const init = d.initializer;
  if (!ts.isCallExpression(init) || init.expression.getText() !== 'computed') return undefined;
  const f = init.arguments[0];
  return f && isFn(f) ? f : undefined;
}

/**
 * What `fn` reads while it runs: its own body, the callbacks it runs at once (`.map`), the functions it calls, and the
 * components it draws that Preact never skips (they draw when it does).
 */
function readsOf(fn: Fn): Reads {
  const known = summaries.get(fn);
  if (known) return known;
  summaries.set(fn, NONE); // a call back into it, while working it out, adds nothing new
  const out: Reads = { data: null, version: false, skippable: false };
  const take = (r: Reads, via: string, own: boolean) => {
    if (r.data && !out.data) out.data = [via, ...r.data];
    if (own && r.version) out.version = true;
    if (own && r.skippable) out.skippable = true;
  };
  // memo(function Row(…) {…}) compares its props itself.
  if (ts.isCallExpression(fn.parent) && /^memo$/.test(fn.parent.expression.getText())) out.skippable = true;
  const visit = (n: ts.Node) => {
    if (ts.isTypeNode(n)) return;
    if (n !== fn && isFn(n)) {
      // A function written here runs at once only as a callback argument (`.map(c => …)`, useMemo) or a render prop
      // between JSX tags; one in a JSX attribute is a handler, one kept in a name runs when called (followed below).
      const p = n.parent;
      if (ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression)) {
        const callee = ts.isPropertyAccessExpression(p.expression) ? p.expression.name.text : p.expression.getText();
        if (LATER.has(callee)) return;
      } else if (!ts.isJsxExpression(p) || ts.isJsxAttribute(p.parent)) return;
    }
    if (ts.isCallExpression(n)) {
      const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : n.expression.getText();
      if (STATEFUL.has(callee)) out.skippable = true;
      if (FIRST_ONLY.has(callee)) {
        n.arguments.slice(1).forEach(visit);
        return;
      }
      const f = fnOf(n.expression);
      if (f && f !== fn) take(readsOf(f), label(f), true);
    }
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      const d = declOf(n);
      const data = named(d, DATA);
      if (data && !out.data) out.data = [data];
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'value' && isSignal(n.expression)) {
      out.skippable = true;
      const e = n.expression;
      if (named(declOf(ts.isCallExpression(e) ? e.expression : e), ts.isCallExpression(e) ? VERSION_FNS : VERSIONS))
        out.version = true;
      // A computed of ours that reads a change signal moves when it does, and only when its value changes with it.
      const f = followed(e);
      if (f && readsOf(f).version) out.version = true;
    }
    // <Child …/>: one Preact never skips draws when this one does, so what it reads is this one's to watch.
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      const c = fnOf(n.tagName);
      if (c && c !== fn) {
        const r = readsOf(c);
        if (!r.skippable) take(r, `<${label(c)}>`, false);
      }
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  summaries.set(fn, out);
  return out;
}

/** A component: a function named with a capital whose body has JSX, in a .tsx file. */
function components(sf: ts.SourceFile): Fn[] {
  const out: Fn[] = [];
  const hasJsx = (n: ts.Node): boolean =>
    ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n) || ts.forEachChild(n, hasJsx) === true;
  const visit = (n: ts.Node) => {
    if (isFn(n)) {
      const name = label(n).split(' ')[0];
      if (/^[A-Z]/.test(name) && n.body && hasJsx(n.body)) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const problems: string[] = [];
const found: string[] = [];
let checked = 0;
for (const sf of program.getSourceFiles()) {
  if (!ours(sf) || !sf.fileName.endsWith('.tsx')) continue;
  const lines = sf.text.split('\n');
  for (const c of components(sf)) {
    checked++;
    const r = readsOf(c);
    if (!r.data || r.version || !r.skippable) continue;
    // The comment may sit before the statement that holds the function: `// redraws: …` over `const Row = memo(…)`.
    let at: ts.Node = c;
    while (at.parent && !ts.isSourceFile(at.parent) && !ts.isBlock(at.parent)) at = at.parent;
    const line = sf.getLineAndCharacterOfPosition(at.getStart()).line;
    if (/redraws:/.test(lines.slice(Math.max(0, line - 4), line + 1).join('\n'))) continue;
    const key = `${relative(SRC, sf.fileName)} ${label(c).split(' ')[0]}`;
    found.push(key);
    if (known.has(key) && !why) continue;
    problems.push(`  ${label(c)} reads ${r.data.at(-1)} while it renders, and no change signal${known.has(key) ? ' (known)' : ''}${why && r.data.length > 1 ? `\n      via ${r.data.slice(0, -1).join(' → ')}` : ''}`);
  }
}
if (update) {
  const note = 'bun scripts/check-redraws.ts --update: components that read the hub\'s data while they render, may be skipped by Preact, and read no change signal, when the check began. It should only shrink.';
  writeFileSync(KNOWN_FILE, `${JSON.stringify({ note, known: [...new Set(found)].sort() }, null, 1)}\n`);
  console.log(`check-redraws: wrote ${new Set(found).size} to scripts/redraws-known.json`);
  process.exit(0);
}
for (const k of known)
  if (!found.includes(k)) problems.push(`  ${k} is in scripts/redraws-known.json but reads what says its data changed now: take it off`);

const fresh = problems.filter((p) => !p.includes('(known)'));
if (fresh.length || why) {
  if (problems.length) console.log(`check-redraws: ${problems.length} problem${problems.length > 1 ? 's' : ''}:\n${problems.join('\n')}\n`);
  if (fresh.length) {
    console.log('A component Preact may skip draws again only when its props change or a signal it read moves. Read the');
    console.log('change signal for what it shows (rev for lists and counts, metaRev for names and settings, timelineRev(key)');
    console.log("for a timeline's messages), or say why its props are enough: `// redraws: <reason>` (docs/perf.md \"What");
    console.log('redraws"). bun scripts/check-redraws.ts --why shows how each reaches the data.');
    process.exit(1);
  }
}
console.log(`check-redraws: ${checked} components; those that read the hub's data and may be skipped read what says it changed${known.size ? `, but for ${known.size} known (scripts/redraws-known.json)` : ''}`);
