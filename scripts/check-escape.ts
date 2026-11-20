/**
 * Escape and back stay whole (docs/desktop.md "Escape and back"), cheap enough for every CI run: bun run check:escape.
 *
 * 1. Every handler in the web app that acts on Escape says it took it, with preventDefault(): escape.ts then lets that
 *    Escape go no further. One that does not would close its popover and also leave the page. A handler that means to
 *    let Escape through says why in a comment starting `escape:` in the lines just before it.
 * 2. scripts/verify-back.ts covers every route view (routes.ts) and every component that opens a layer (pushLayer or
 *    useLayer, phone.ts), or says in its UNCOVERED why not, so a new page or overlay comes with its way back checked.
 *
 *   bun scripts/check-escape.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'packages/web/src');
const problems: string[] = [];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);

/** Whether `fn`'s body calls preventDefault, itself or through a local helper (`stop()`) that does. */
function prevents(fn: ts.Node, helpers: Set<string>): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (ts.isPropertyAccessExpression(c) && c.name.text === 'preventDefault') found = true;
      if (ts.isIdentifier(c) && helpers.has(c.text)) found = true;
    }
    ts.forEachChild(n, walk);
  };
  walk(fn);
  return found;
}

const layerFiles = new Set<string>();
for (const file of files(SRC)) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(SRC, file);
  if (rel !== 'phone.ts' && /\b(useLayer|pushLayer)\(/.test(text)) layerFiles.add(rel);
  if (!text.includes("'Escape'")) continue;
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  // Local helpers that call preventDefault: `const stop = () => { e.preventDefault(); … }`.
  const helpers = new Set<string>();
  const findHelpers = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      isFn(n.initializer) &&
      prevents(n.initializer, new Set())
    )
      helpers.add(n.name.text);
    ts.forEachChild(n, findHelpers);
  };
  findHelpers(sf);
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) && n.text === 'Escape') {
      // A list of keys (`['Enter', 'Escape'].includes(e.key)`) only names it.
      if (!ts.isArrayLiteralExpression(n.parent)) {
        let fn: ts.Node | undefined = n.parent;
        while (fn && !isFn(fn)) fn = fn.parent;
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line;
        const before = text
          .split('\n')
          .slice(Math.max(0, line - 3), line + 1)
          .join('\n');
        if (!/escape:/.test(before) && (!fn || !prevents(fn, helpers)))
          problems.push(`  ${relative(ROOT, file)}:${line + 1}: acts on Escape without preventDefault()`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// 2. verify-back.ts covers every view and every layer.
const routes = readFileSync(join(SRC, 'routes.ts'), 'utf8');
// The Route union's members, one a line: `  | { view: 'inbox'; … }`.
const views = new Set([...routes.matchAll(/^\s+\| \{ view: '(\w+)'/gm)].map((m) => m[1]));
const verify = readFileSync(join(ROOT, 'scripts/verify-back.ts'), 'utf8');
const covered = new Set([...verify.matchAll(/view: '(\w+)'/g)].map((m) => m[1]));
for (const v of views)
  if (!covered.has(v)) problems.push(`  view '${v}' (routes.ts) is in no case of scripts/verify-back.ts`);
const uncovered = verify.slice(verify.indexOf('const UNCOVERED'));
const named = new Set(
  [...verify.matchAll(/file: '([^']+)'/g), ...uncovered.matchAll(/^\s+'([^']+\.tsx?)':/gm)].map((m) => m[1]),
);
for (const f of layerFiles)
  if (!named.has(f))
    problems.push(`  ${f} opens a layer, and scripts/verify-back.ts neither opens it nor says why not (UNCOVERED)`);
for (const f of named)
  if (!/^ui\/|^graph\//.test(f) || !files(SRC).some((x) => relative(SRC, x) === f))
    problems.push(`  scripts/verify-back.ts names ${f}, which is not in packages/web/src`);

if (problems.length) {
  console.log(`check-escape: ${problems.length} problem${problems.length > 1 ? 's' : ''}:\n${problems.join('\n')}\n`);
  console.log(
    'Escape is the back button of a keyboard (docs/desktop.md "Escape and back"): a handler that takes it calls',
  );
  console.log(
    'preventDefault() (or says why not, `// escape: <reason>`), and verify-back.ts covers each page and layer.',
  );
  process.exit(1);
}
console.log(
  `check-escape: every Escape handler takes it with preventDefault; verify-back covers ${views.size} views and ${layerFiles.size} layers`,
);
