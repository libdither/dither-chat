import { describe, expect, test } from 'bun:test';
import { applyDrop, moveStep, type Layout } from '../src/layout.ts';

const base: Layout = { order: ['space:a', 'folder:f', 'conversation:g', 'space:b'], folders: [{ id: 'f', items: ['space:c', 'person:p'] }] };
const fresh = () => 'n';

describe('dropping in the sidebar', () => {
  test('reorders the top level', () => {
    expect(applyDrop(base, 'space:b', { key: 'space:a', where: 'before' }, fresh).order).toEqual(['space:b', 'space:a', 'folder:f', 'conversation:g']);
    expect(applyDrop(base, 'space:a', { key: 'conversation:g', where: 'after' }, fresh).order).toEqual(['folder:f', 'conversation:g', 'space:a', 'space:b']);
  });
  test('a Signal group goes into a folder like any other place', () => {
    const l = applyDrop(base, 'conversation:g', { key: 'folder:f', where: 'into' }, fresh);
    expect(l.order).toEqual(['space:a', 'folder:f', 'space:b']);
    expect(l.folders[0].items).toEqual(['space:c', 'person:p', 'conversation:g']);
  });
  test('dropping one place on another makes a folder where the target was', () => {
    const l = applyDrop(base, 'space:b', { key: 'space:a', where: 'into' }, fresh);
    expect(l.order).toEqual(['folder:n', 'folder:f', 'conversation:g']);
    expect(l.folders[1]).toEqual({ id: 'n', items: ['space:a', 'space:b'] });
  });
  test('out of a folder to the top level', () => {
    const l = applyDrop(base, 'space:c', { key: 'space:a', where: 'after' }, fresh);
    expect(l.order).toEqual(['space:a', 'space:c', 'folder:f', 'conversation:g', 'space:b']);
    expect(l.folders[0].items).toEqual(['person:p']);
  });
  test('reorders within a folder, and into one from outside by row', () => {
    expect(applyDrop(base, 'person:p', { key: 'space:c', folder: 'f', where: 'before' }, fresh).folders[0].items).toEqual(['person:p', 'space:c']);
    const l = applyDrop(base, 'space:a', { key: 'person:p', folder: 'f', where: 'before' }, fresh);
    expect(l.folders[0].items).toEqual(['space:c', 'space:a', 'person:p']);
    expect(l.order).not.toContain('space:a');
  });
  test('a folder goes into a folder, one level deep', () => {
    const two: Layout = { ...base, folders: [...base.folders, { id: 'h', items: ['space:x'] }], order: [...base.order, 'folder:h'] };
    const l = applyDrop(two, 'folder:h', { key: 'folder:f', where: 'into' }, fresh);
    expect(l.folders.find((f) => f.id === 'f')!.items).toEqual(['space:c', 'person:p', 'folder:h']);
    expect(l.order).not.toContain('folder:h');
    // f now holds a folder, so it cannot go inside another: it lands beside it.
    const three: Layout = { ...l, folders: [...l.folders, { id: 'k', items: [] }], order: [...l.order, 'folder:k'] };
    const m = applyDrop(three, 'folder:f', { key: 'folder:k', where: 'into' }, fresh);
    expect(m.folders.find((f) => f.id === 'k')!.items).toEqual([]);
    expect(m.order.indexOf('folder:f')).toBe(m.order.indexOf('folder:k') - 1);
    // Nor into a folder that is inside one.
    const n = applyDrop({ ...three, folders: three.folders.map((f) => (f.id === 'k' ? f : f)) }, 'folder:k', { key: 'folder:h', folder: 'f', where: 'into' }, fresh);
    expect(n.folders.find((f) => f.id === 'h')!.items).toEqual(['space:x']);
    expect(n.folders.find((f) => f.id === 'f')!.items).toEqual(['space:c', 'person:p', 'folder:k', 'folder:h']);
  });
  test('a folder inside a folder comes out to the top beside its parent', () => {
    const l: Layout = { order: ['space:a', 'folder:f'], folders: [{ id: 'f', items: ['folder:h', 'space:c'] }, { id: 'h', items: ['space:x'] }] };
    const m = applyDrop(l, 'folder:h', { key: 'folder:f', where: 'after' }, fresh);
    expect(m.order).toEqual(['space:a', 'folder:f', 'folder:h']);
    expect(m.folders[0].items).toEqual(['space:c']);
    // A place dropped beside a row in the inner folder goes into the inner folder.
    const p = applyDrop(l, 'space:a', { key: 'space:x', folder: 'h', where: 'before' }, fresh);
    expect(p.folders[1].items).toEqual(['space:a', 'space:x']);
    // Beside a top-level entry from a row two levels down: next to the outer folder.
    const q = applyDrop(l, 'space:x', { key: 'space:a', where: 'before' }, fresh);
    expect(q.order).toEqual(['space:x', 'space:a', 'folder:f']);
  });
  test('onto itself does nothing', () => {
    expect(applyDrop(base, 'space:a', { key: 'space:a', where: 'into' }, fresh)).toBe(base);
  });
  test('move step stops at the ends', () => {
    expect(moveStep(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
    expect(moveStep(['a', 'b'], 'a', 1)).toEqual(['b', 'a']);
  });
});
