/** Links in plain text (src/links.ts): bios and posts. */
import { describe, expect, test } from 'bun:test';
import { linkParts } from '../src/links.ts';

describe('linkParts', () => {
  test('a link with its scheme, as written', () => {
    expect(linkParts('building cool things http://nachotype.com')).toEqual(['building cool things ', { href: 'http://nachotype.com', label: 'http://nachotype.com' }]);
  });
  test('bare addresses and www. get https; sentence ends stay text', () => {
    expect(linkParts('see nachotype.com/blog, or www.example.org.')).toEqual([
      'see ',
      { href: 'https://nachotype.com/blog', label: 'nachotype.com/blog' },
      ', or ',
      { href: 'https://www.example.org', label: 'www.example.org' },
      '.',
    ]);
  });
  test('words with dots are not links', () => {
    expect(linkParts('e.g. node.js and v1.2 are fine, so is a.b')).toEqual(['e.g. node.js and v1.2 are fine, so is a.b']);
  });
  test('a bracket the address opened is its own', () => {
    expect(linkParts('(https://en.wikipedia.org/wiki/Sheaf_(mathematics))')).toEqual(['(', { href: 'https://en.wikipedia.org/wiki/Sheaf_(mathematics)', label: 'https://en.wikipedia.org/wiki/Sheaf_(mathematics)' }, ')']);
  });
  test('Markdown links keep their words', () => {
    expect(linkParts('my [site](https://a.dev/x) here')).toEqual(['my ', { href: 'https://a.dev/x', label: 'site' }, ' here']);
  });
  test('@handles link on X only, and an email is not one', () => {
    expect(linkParts('art by @justamapping', 'x')).toEqual(['art by ', { href: 'https://x.com/justamapping', label: '@justamapping' }]);
    expect(linkParts('art by @justamapping', 'discord')).toEqual(['art by @justamapping']);
    expect(linkParts('mail me@site.com', 'x')).toEqual(['mail me@site.com']);
  });
  test('not inside another word, address or email, in any script', () => {
    expect(linkParts('bücher.de hello.world@site.com contact.co@x.com ftp://a.com')).toEqual(['bücher.de hello.world@site.com contact.co@x.com ftp://a.com']);
  });
  test('sentences missing a space and file names are not links', () => {
    expect(linkParts('great.So what. Nice.It works, do.it, build.sh, lib.so')).toEqual(['great.So what. Nice.It works, do.it, build.sh, lib.so']);
  });
  test('an address may end in = or _ or another script', () => {
    expect(linkParts('https://ja.wikipedia.org/wiki/日本 and https://a.com/?q=')).toEqual([
      { href: 'https://ja.wikipedia.org/wiki/日本', label: 'https://ja.wikipedia.org/wiki/日本' },
      ' and ',
      { href: 'https://a.com/?q=', label: 'https://a.com/?q=' },
    ]);
  });
  test('only http(s) links are made', () => {
    expect(linkParts('[x](javascript:alert(1)) javascript:alert(1) data:text/html,hi')).toEqual(['[x](javascript:alert(1)) javascript:alert(1) data:text/html,hi']);
  });
  test('a post keeps a Markdown link as written', () => {
    expect(linkParts('[https://bank.com](https://evil.example)', 'x', false)).toEqual(['[', { href: 'https://bank.com](https://evil.example)', label: 'https://bank.com](https://evil.example)' }]);
  });
});
