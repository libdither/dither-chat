/**
 * No import cycles (docs/testing.md "Import cycles"), cheap enough for every CI run: bun run check:cycles.
 *
 * In each package's src/, a static import cycle (a imports b, b imports a, through any number of files) makes the order
 * modules run in depend on which one is loaded first. A value one of them reads while loading (a constant, a signal, a
 * class it extends) can then be read before it exists: a TDZ error, or `undefined`, that shows only in some load order,
 * or only after the bundler moves code between chunks. A cycle also keeps the bundler from splitting its files apart.
 * T3 Code checks the same (apps/mobile/src/dependency-graph.test.ts); the web build fails on a cycle between output
 * chunks too (packages/web/vite.config.ts chunkCycleGuard).
 *
 * Counted: `import … from './x.ts'` and `export … from './x.ts'` between files of one package. Not counted: type-only
 * imports (`import type`, `import { type X }` alone), dynamic `import()`, tests, and other packages (a package imports
 * another only through its exports, and the protocol package imports none).
 *
 * The usual way out is to move what both sides need (a signal, a small function) into a module of its own that imports
 * neither: state.ts → store.ts and api.ts, attention.ts → tally.ts.
 *
 *   bun scripts/check-cycles.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mts)$/.test(p) && !p.endsWith('.d.ts') && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Each file's static, non-type imports of other files in the set. */
function graph(files: string[]): Map<string, string[]> {
  const set = new Set(files);
  const resolveLocal = (from: string, spec: string) => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(from), spec);
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (set.has(c)) return c;
    return null;
  };
  const g = new Map<string, string[]>();
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, false, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    for (const st of sf.statements) {
      let spec: string | null = null;
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const c = st.importClause;
        if (c?.isTypeOnly) continue;
        const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : null;
        if (c && !c.name && named && named.length > 0 && named.every((e) => e.isTypeOnly)) continue;
        spec = st.moduleSpecifier.text;
      } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        if (st.isTypeOnly) continue;
        const named = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : null;
        if (named && named.length > 0 && named.every((e) => e.isTypeOnly)) continue;
        spec = st.moduleSpecifier.text;
      }
      const r = spec && resolveLocal(f, spec);
      if (r) out.push(r);
    }
    g.set(f, out);
  }
  return g;
}

/** Strongly connected groups of more than one file, or a file that imports itself (Tarjan's algorithm). */
function cycles(g: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of g.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1 || (g.get(v) ?? []).includes(v)) out.push(group);
    }
  };
  for (const v of g.keys()) if (!index.has(v)) visit(v);
  return out;
}

/** One loop through the group, to show: from its first file along imports inside the group back to it. */
function loopIn(group: string[], g: Map<string, string[]>): string[] {
  const inGroup = new Set(group);
  const start = group[group.length - 1];
  const prev = new Map<string, string>();
  const queue = [start];
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of g.get(v) ?? []) {
      if (!inGroup.has(w)) continue;
      if (w === start) {
        const path = [v];
        for (let x = v; x !== start; ) path.unshift((x = prev.get(x)!));
        return [...path, start];
      }
      if (!prev.has(w)) {
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return group;
}

let files = 0;
let edges = 0;
const problems: string[] = [];
for (const pkg of readdirSync(join(ROOT, 'packages'))) {
  const src = join(ROOT, 'packages', pkg, 'src');
  if (!statSync(src, { throwIfNoEntry: false })?.isDirectory()) continue;
  const g = graph(walk(src));
  files += g.size;
  for (const deps of g.values()) edges += deps.length;
  for (const group of cycles(g)) {
    const rel = (f: string) => relative(src, f);
    problems.push(`packages/${pkg}/src: ${group.length} files import each other in a loop, e.g. ${loopIn(group, g).map(rel).join(' → ')}${group.length > 2 ? `\n    all of them: ${group.map(rel).sort().join(', ')}` : ''}`);
  }
}
// A resolver that silently finds nothing would pass: there are well over a thousand imports to follow.
if (edges < 500) problems.push(`only ${edges} imports found among ${files} files: the check is not reading them`);

if (problems.length) {
  console.log(`check-cycles: ${problems.length} import cycle${problems.length > 1 ? 's' : ''}:`);
  for (const p of problems) console.log(`  ${p}`);
  console.log('\nMove what both sides need into a module of its own that imports neither (docs/testing.md "Import cycles").');
  process.exit(1);
}
console.log(`check-cycles: ${files} files, ${edges} imports, no cycles`);
