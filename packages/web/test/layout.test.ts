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
  test('folders do not nest', () => {
    const l = applyDrop({ ...base, folders: [...base.folders, { id: 'h', items: [] }], order: [...base.order, 'folder:h'] }, 'folder:h', { key: 'folder:f', where: 'into' }, fresh);
    expect(l.folders.find((f) => f.id === 'f')!.items).toEqual(['space:c', 'person:p']);
    expect(l.order.indexOf('folder:h')).toBe(l.order.indexOf('folder:f') - 1);
  });
  test('onto itself does nothing', () => {
    expect(applyDrop(base, 'space:a', { key: 'space:a', where: 'into' }, fresh)).toBe(base);
  });
  test('move step stops at the ends', () => {
    expect(moveStep(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
    expect(moveStep(['a', 'b'], 'a', 1)).toEqual(['b', 'a']);
  });
});
