/**
 * Folders inside folders as the hub keeps them (store.ts setFolders/folders, docs/organize.md): one level, in the
 * parent's order, and nothing deeper or circular kept.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';

const f = (id: string, items: P.FolderView['items']): P.FolderView => ({ id, name: id, icon: null, color: null, items });
const sp = (id: string) => ({ kind: 'space' as const, id });
const fo = (id: string) => ({ kind: 'folder' as const, id });

describe('folders inside folders', () => {
  test('a folder item nests, in the parent’s order, and comes back the same', () => {
    const store = new Store(':memory:', mediaSigner('s'));
    const set = [f('acct', [fo('a'), sp('s1'), fo('b')]), f('a', [sp('s2')]), f('b', [sp('s3'), sp('s4')])];
    store.setFolders(set);
    expect(store.folders()).toEqual(set);
  });

  test('only one level: a folder inside a folder holds no folders, and a loop keeps its first link', () => {
    const store = new Store(':memory:', mediaSigner('s'));
    store.setFolders([f('top', [fo('mid')]), f('mid', [fo('low'), sp('s1')]), f('low', [sp('s2')])]);
    const got = store.folders();
    expect(got.find((x) => x.id === 'top')!.items).toEqual([fo('mid')]);
    expect(got.find((x) => x.id === 'mid')!.items).toEqual([sp('s1')]);
    store.setFolders([f('x', [fo('y')]), f('y', [fo('x')])]);
    expect(store.folders()).toEqual([f('x', [fo('y')]), f('y', [])]);
  });

  test('a folder listed in two stays in the first; an unknown one is dropped', () => {
    const store = new Store(':memory:', mediaSigner('s'));
    store.setFolders([f('p', [fo('c'), fo('ghost')]), f('q', [fo('c')]), f('c', [sp('s1')])]);
    const got = store.folders();
    expect(got.find((x) => x.id === 'p')!.items).toEqual([fo('c')]);
    expect(got.find((x) => x.id === 'q')!.items).toEqual([]);
  });
});
