import { describe, expect, test } from 'bun:test';
import { articleView, postView } from '../src/feed.ts';

const sign = (raw: string) => (raw.includes('refused') ? null : `/media/SIG/${Buffer.from(raw).toString('base64url')}?a=acc_demo-x`);

describe("an article's pictures", () => {
  test('go through the hub as signed media paths; links, other words and refused ones stay as they were', () => {
    const md = 'Hi [a link](https://example.com/page) ![a \\] chart](https://cdn.example.com/a%28b%29.png)\n\n[![p](https://cdn.example.com/p.png)](https://cdn.example.com/full.png) ![no](https://refused.example.com/x.png) ![x](javascript:alert(1))';
    expect(articleView(md, sign)).toBe(
      `Hi [a link](https://example.com/page) ![a \\] chart](${sign('https://cdn.example.com/a(b).png')})\n\n[![p](${sign('https://cdn.example.com/p.png')})](https://cdn.example.com/full.png) ![no](https://refused.example.com/x.png) ![x](javascript:alert(1))`,
    );
  });
  test('a post view signs its article; a post without one has none', () => {
    const p = { id: 'p-1', url: 'https://example.com/p/1', ts: 1, text: 'preview', article: '![c](https://cdn.example.com/c.png)' };
    expect(postView(p, 'substack', sign).article).toBe(`![c](${sign('https://cdn.example.com/c.png')})`);
    expect('article' in postView({ ...p, article: undefined }, 'substack', sign) && postView({ ...p, article: undefined }, 'substack', sign).article !== undefined).toBe(false);
  });
});
