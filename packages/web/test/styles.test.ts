/**
 * The stylesheet's blocks close. A brace lost in a merge does not break the build: modern CSS nests, so every rule
 * after it quietly lands inside the unclosed one and stops applying.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('every block in styles.css closes, and nothing closes twice', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  let depth = 0;
  let line = 1;
  const open: number[] = [];
  for (const ch of css) {
    if (ch === '\n') line++;
    else if (ch === '{') (depth++, open.push(line));
    else if (ch === '}') {
      depth--;
      open.pop();
      expect(depth).toBeGreaterThanOrEqual(0);
    }
  }
  // Where the first unclosed block opened, to find it fast (comments blanked, keeping their lines).
  expect({ depth, unclosedFrom: open[0] ?? null }).toEqual({ depth: 0, unclosedFrom: null });
});
