import { describe, expect, test } from 'bun:test';
import { changesInContext } from '../src/historyRows.ts';
import { markChanged, wordDiff } from '../src/wordDiff.ts';

const show = (ps: { k: string; t?: string }[]) => ps.map((p) => (p.k === '=' ? p.t : p.k === 'gap' ? '…' : `${p.k}[${p.t}]`)).join('');

describe('wordDiff', () => {
  test('changes a space apart are one change, and a shared space stays outside it', () => {
    expect(show(wordDiff('bring a tent, some rope, then go', 'bring the big blue tent, some rope and chalk, then go'))).toBe(
      'bring -[a]+[the big blue] tent, some -[rope,]+[rope and chalk,] then go',
    );
  });
  test('words added at the end leave the space before them outside', () => {
    expect(show(wordDiff('leaving at 5:45', 'leaving at 5:45 from the gym'))).toBe('leaving at 5:45 +[from the gym]');
  });
  test('a word swapped', () => {
    expect(show(wordDiff('we meet on Tuesday then', 'we meet on Thursday then'))).toBe('we meet on -[Tuesday]+[Thursday] then');
  });
  test('nothing changed, all added, all taken out', () => {
    expect(show(wordDiff('same', 'same'))).toBe('same');
    expect(show(wordDiff('', 'new words'))).toBe('+[new words]');
    expect(show(wordDiff('old words', ''))).toBe('-[old words]');
  });
  test('a long text keeps its untouched start and end out of the comparison', () => {
    const long = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ');
    const parts = wordDiff(long, long.replace('w1500', 'changed'));
    expect(parts.filter((p) => p.k !== '=').map((p) => p.t)).toEqual(['w1500', 'changed']);
  });
});

describe('changesInContext', () => {
  test('three words either side, the rest left out', () => {
    const a = 'one two three four five six seven eight nine ten eleven twelve';
    expect(show(changesInContext(a, a.replace('six', '6')))).toBe('…three four five -[six]+[6] seven eight nine…');
  });
  test('a short text stays whole', () => {
    expect(show(changesInContext('meet at 6', 'meet at 6:30, traffic'))).toBe('meet at -[6]+[6:30, traffic]');
  });
});

describe('markChanged', () => {
  test('marks the words put in, a space between them inside the mark', () => {
    expect(markChanged('<p>meet at 6:30, traffic</p>', '<p>meet at 6</p>')).toBe('<p>meet at <span class="msg-changed">6:30, traffic</span></p>');
  });
  test('markdown marks are not words, and a change across tags is marked inside each', () => {
    expect(markChanged('see <b>the new plan</b> now', 'see the plan now')).toBe('see <b>the <span class="msg-changed">new</span> plan</b> now');
  });
  test('an entity counts as the character it shows', () => {
    expect(markChanged('tom &amp; jerry rule', 'tom &amp; jerry')).toBe('tom &amp; jerry <span class="msg-changed">rule</span>');
  });
  test('a rewrite, or only words taken out, marks nothing', () => {
    expect(markChanged('something else entirely now', 'hi')).toBe('something else entirely now');
    expect(markChanged('short now', 'short now and long before')).toBe('short now');
  });
});
