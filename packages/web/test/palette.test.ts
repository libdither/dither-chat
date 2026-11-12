import { describe, expect, test } from 'bun:test';
import { backTo, entry, keyAct, matches, moveSel, newMenu, NEW, pickCap, pickLine, pop, push, rankGroups, rankPeople, replaceTop, rootKeys, JOIN, SEARCH, toRoot, togglePick, unpickLast, update, type Entry, type KeyTarget } from '../src/palette.ts';

const page = (kind: 'root' | 'new' | 'groups' | 'mine', q = '') => entry(kind === 'new' ? { kind, mode: undefined } : { kind }, kind, q);

describe('the stack', () => {
  test('a page pushed sits on top; one off goes back to the one under it, what was typed there kept', () => {
    const root = page('root', 'ann');
    const s = push(push([root], page('new')), page('mine'));
    expect(s.map((e) => e.kind)).toEqual(['root', 'new', 'mine']);
    const back = pop(s)!;
    expect(back.map((e) => e.kind)).toEqual(['root', 'new']);
    expect(pop(back)![0]).toBe(root);
    expect(pop(back)![0].q).toBe('ann');
  });
  test('backing out of the bottom page closes', () => {
    expect(pop([page('new')])).toBeNull();
  });
  test('a crumb goes back to its page, dropping everything above it', () => {
    const s = [page('root'), page('new'), page('groups'), page('mine')];
    expect(backTo(s, 1).map((e) => e.kind)).toEqual(['root', 'new']);
    expect(backTo(s, 0).map((e) => e.kind)).toEqual(['root']);
    expect(backTo(s, 9)).toHaveLength(4);
  });
  test('the root crumb: the root at the bottom, or a fresh one in place of a stack opened at a page', () => {
    const root = page('root', 'kept');
    expect(toRoot([root, page('new')], () => page('root'))).toEqual([root]);
    const fresh = toRoot([page('new'), page('mine')], () => page('root'));
    expect(fresh.map((e) => [e.kind, e.q])).toEqual([['root', '']]);
  });
  test('a page swapped for another, and one page changed', () => {
    const s = [page('root'), page('mine')];
    expect(replaceTop(s, page('new')).map((e) => e.kind)).toEqual(['root', 'new']);
    const u = update(s, s[0].id, { q: 'x', sel: 2 });
    expect([u[0].q, u[0].sel, u[1]]).toEqual(['x', 2, s[1]]);
  });
  test('every page gets its own id', () => {
    expect(new Set([page('root'), page('root'), page('new')].map((e: Entry) => e.id)).size).toBe(3);
  });
});

describe('keys', () => {
  const k = (key: string, target: KeyTarget, o: { empty?: boolean; ctrl?: boolean; multi?: boolean; picked?: number } = {}) => keyAct({ key, target, empty: o.empty ?? true, ctrl: o.ctrl, multi: o.multi, picked: o.picked });
  test('Escape backs out a page, wherever the focus is', () => {
    for (const t of ['input', 'box', 'control'] as const) expect(k('Escape', t)).toBe('back');
  });
  test('Backspace backs out only from an empty input or the box', () => {
    expect(k('Backspace', 'input')).toBe('back');
    expect(k('Backspace', 'input', { empty: false })).toBeNull();
    expect(k('Backspace', 'box')).toBe('back');
    expect(k('Backspace', 'control')).toBeNull();
    expect(k('Backspace', 'input', { ctrl: true })).toBeNull();
  });
  test('on a page with people picked, Backspace un-picks the last one first', () => {
    expect(k('Backspace', 'input', { multi: true, picked: 2 })).toBe('unpick');
    expect(k('Backspace', 'input', { multi: true, picked: 0 })).toBe('back');
    expect(k('Backspace', 'input', { empty: false, multi: true, picked: 2 })).toBeNull();
  });
  test('arrows move; Enter takes the row; a button keeps its own Enter', () => {
    expect(k('ArrowDown', 'input')).toBe('down');
    expect(k('ArrowUp', 'box')).toBe('up');
    expect(k('Enter', 'input')).toBe('take');
    expect(k('Enter', 'box')).toBe('take');
    expect(k('Enter', 'control')).toBeNull();
  });
  test('picking several: Enter picks or un-picks, Ctrl+Enter goes on, from anywhere', () => {
    expect(k('Enter', 'input', { multi: true })).toBe('toggle');
    expect(k('Enter', 'input', { multi: true, ctrl: true })).toBe('goOn');
    expect(k('Enter', 'control', { multi: true, ctrl: true })).toBe('goOn');
    expect(k('Enter', 'input', { ctrl: true })).toBe('take');
  });
  test('Tab and letters are not the palette’s', () => {
    expect(k('Tab', 'input')).toBeNull();
    expect(k('a', 'input')).toBeNull();
  });
  test('the highlight goes round the ends', () => {
    expect(moveSel(0, 3, 1)).toBe(1);
    expect(moveSel(2, 3, 1)).toBe(0);
    expect(moveSel(0, 3, -1)).toBe(2);
    expect(moveSel(7, 3, 1)).toBe(0);
    expect(moveSel(0, 0, 1)).toBe(0);
  });
});

describe('the root', () => {
  const items = [
    { key: 'p:ann', label: 'Ann', last: 50, score: 10 },
    { key: 'p:bo', label: 'Bo', last: 90 },
    { key: 'c:rust', label: 'rust help', last: 70, score: 80 },
    { key: 'c:old', label: 'Old annex', last: 1 },
    { key: 'a:new', label: 'New message', last: 0 },
  ];
  test('nothing typed: the top of the inbox, the rest by latest message, and New… last', () => {
    expect(rootKeys(items, '', ['c:rust', 'p:ann', 'gone'])).toEqual(['c:rust', 'p:ann', 'p:bo', 'c:old', 'a:new', NEW]);
  });
  test('at most nine places before New…', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, last: i }));
    const keys = rootKeys(many, '', []);
    expect(keys).toHaveLength(10);
    expect(keys.at(-1)).toBe(NEW);
  });
  test('typed: matches by name times the inbox, then Search messages; no New…', () => {
    const keys = rootKeys(items, 'an', []);
    expect(keys[0]).toBe('p:ann');
    expect(keys).toContain('c:old');
    expect(keys.at(-1)).toBe(SEARCH);
    expect(keys).not.toContain(NEW);
    expect(keys).not.toContain('p:bo');
  });
  test('a pasted invite: Join first, so Enter takes it', () => {
    const keys = rootKeys(items, 'discord.gg/pixelart', []);
    expect(keys[0]).toBe(JOIN);
    expect(keys.at(-1)).toBe(SEARCH);
  });
});

describe('New', () => {
  test('its menu: Add people first (to the group on screen when there is one), then Scan a code and My code', () => {
    expect(newMenu({ newGroup: false, canAdd: true }).map((m) => m.key)).toEqual(['n:add', 'n:scan', 'n:mine']);
    expect(newMenu({ newGroup: false, canAdd: true, here: 'Climbing crew' })[0]).toEqual({ key: 'n:add-here', label: 'Add people to Climbing crew' });
    expect(newMenu({ newGroup: false, canAdd: false }).map((m) => m.key)).toEqual(['n:scan', 'n:mine']);
  });
  test('New group is one switch away', () => {
    expect(newMenu({ newGroup: true, canAdd: true }).map((m) => m.key)).toEqual(['n:add', 'n:group', 'n:scan', 'n:mine']);
  });
  test('New message, Join and Add someone have menus of their own', () => {
    expect(newMenu({ mode: 'message', newGroup: true, canAdd: true })).toEqual([]);
    expect(newMenu({ mode: 'join', newGroup: true, canAdd: true }).map((m) => m.key)).toEqual(['n:scan']);
    expect(newMenu({ mode: 'add', newGroup: true, canAdd: true }).map((m) => m.key)).toEqual(['n:scan', 'n:mine']);
  });
  const people = [
    { key: 'ann', name: 'Ann Lee', handles: '@annl', score: null, last: 10 },
    { key: 'bo', name: 'Bo', handles: 'bo.wav', score: 90, last: 5 },
    { key: 'cy', name: 'Cyrus', handles: '', score: null, last: 30 },
  ];
  test('nothing typed: the people you would most likely message first', () => {
    expect(rankPeople(people, '').map((p) => p.key)).toEqual(['bo', 'cy', 'ann']);
    expect(rankPeople(people, '', 2)).toHaveLength(2);
  });
  test('typed: by name or handle, best match first; nobody else', () => {
    expect(rankPeople(people, 'annl').map((p) => p.key)).toEqual(['ann']);
    expect(rankPeople(people, 'wav').map((p) => p.key)).toEqual(['bo']);
    expect(rankPeople(people, 'zz')).toEqual([]);
  });
});

describe('groups', () => {
  const groups = [
    { key: 'a', name: 'Family', last: 5 },
    { key: 'b', name: 'Climbing crew', last: 50 },
    { key: 'c', name: 'Housemates', last: 20 },
  ];
  test('most recent first; typed, best match', () => {
    expect(rankGroups(groups, '').map((g) => g.key)).toEqual(['b', 'c', 'a']);
    expect(rankGroups(groups, 'hou').map((g) => g.key)).toEqual(['c']);
    // A letter in the middle of each: the shorter name is the better match.
    expect(rankGroups(groups, 'm').map((g) => g.key)).toEqual(['a', 'c', 'b']);
    // The same match: the more recent first.
    expect(rankGroups([{ key: 'x', name: 'Crew', last: 1 }, { key: 'y', name: 'Crew', last: 9 }], 'crew').map((g) => g.key)).toEqual(['y', 'x']);
  });
});

describe('picking several', () => {
  test('picks and un-picks; past the cap nothing more', () => {
    expect(togglePick([], 'a', 2)).toEqual(['a']);
    expect(togglePick(['a'], 'a', 2)).toEqual([]);
    expect(togglePick(['a', 'b'], 'c', 2)).toEqual(['a', 'b']);
    expect(togglePick(['a', 'b'], 'a', 2)).toEqual(['b']);
  });
  test('Backspace un-picks the last one picked', () => {
    expect(unpickLast(['a', 'b'])).toEqual(['a']);
    expect(unpickLast([])).toEqual([]);
  });
  test('the cap: the most at once, never more than there is room for', () => {
    expect(pickCap(10)).toBe(10);
    expect(pickCap(10, 7)).toBe(7);
    expect(pickCap(10, 0)).toBe(0);
    expect(pickCap(10, -1)).toBe(0);
  });
  test('the line beside the button', () => {
    expect(pickLine(0, 10)).toBe('Pick up to 10');
    expect(pickLine(0, 0)).toBe('There is no room for anyone else');
    expect(pickLine(2, 10)).toBe('2 picked');
    expect(pickLine(10, 10)).toBe('10 picked, the most at once');
  });
  test('a search keeps what has the text anywhere', () => {
    expect(matches('Quinn quinn.q @quinn', ' QUI ')).toBe(true);
    expect(matches('Dad', 'qui')).toBe(false);
  });
});
