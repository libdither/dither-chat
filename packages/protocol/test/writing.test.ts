import { expect, test } from 'bun:test';
import { conforms, differs, hiddenLost, wordsLost } from '../src/writing/check.ts';
import { measure } from '../src/writing/count.ts';
import { contained, doc, para, text, type Node } from '../src/writing/doc.ts';
import { add, agree, apart, choose, done, draft, leave, move, outcome, went, write } from '../src/writing/draft.ts';
import { send, split } from '../src/writing/encode.ts';
import { fit } from '../src/writing/fit.ts';
import { at, PLACES, PROFILES } from '../src/writing/profile.ts';
import { drafts } from './writing-drafts.ts';
import { reading, tokens } from './writing-oracle.ts';

const P = PROFILES;
const wire = (d: Node, id: string, f = {}) => send(d, P[id], f).wire as any;
const keys = (d: Node, id: string, f = {}, o = {}) => send(d, P[id], f, o).changes.map((c) => `${c.level}:${c.key}`);
const kit = (ids: Record<string, string>, kind = 'user'): Node => ({ type: 'mention', attrs: { kind, label: 'Kit', ids } });
const link = (href: string) => ({ type: 'link', attrs: { href } });

test('offsets count what the network counts', () => {
  const d = doc(para('🍜 ', text('hot', 'bold'), ' ', kit({ signal: 'uuid-kit' })));
  expect(wire(d, 'signal')).toEqual({ message: '🍜 hot ￼', textStyle: ['3:3:BOLD'], mention: ['7:1:uuid-kit'] });
  const b = wire(doc(para('é ', text('menu', link('https://example.org/m')), ' #food #1 https://example.org/x.')), 'bluesky');
  expect(b.facets.map((x: any) => [x.index.byteStart, x.index.byteEnd, x.features[0].$type.split('#')[1]])).toEqual([[3, 7, 'link'], [8, 13, 'tag'], [17, 38, 'link']]);
});

test('styles that cross are written as each network can', () => {
  const d = doc(para(text('a', 'bold'), text('b', 'bold', 'italic'), text('c', 'italic')));
  expect(wire(d, 'signal').textStyle).toEqual(['0:2:BOLD', '1:2:ITALIC']);
  expect(wire(d, 'discord').content).toBe('**a*b***​*c*');
  // Telegram's ranges may only sit inside one another: the crossing one is cut in two.
  expect(wire(d, 'telegram').entities.map((e: any) => [e._.replace('messageEntity', ''), e.offset, e.length])).toEqual([['Bold', 0, 2], ['Italic', 1, 1], ['Italic', 2, 1]]);
  expect(send(d, P.discord).changes).toEqual([]);
});

test('one line in each kind of wire', () => {
  const d = doc(para('Hi ', text('there', 'bold'), ' ', text('secret', 'spoiler')));
  expect(wire(d, 'reddit', { title: 't', place: 'p' }).text).toBe('Hi **there** >!secret!<');
  expect(wire(d, 'matrix').formatted_body).toBe('<p>Hi <strong>there</strong> <span data-mx-spoiler>secret</span></p>');
  expect(wire(d, 'slack').blocks[0].elements[0].elements[1]).toEqual({ type: 'text', text: 'there', style: { bold: true } });
  expect(wire(d, 'irc')).toBe('Hi \x02there\x02 secret');
  expect(wire(d, 'x')).toEqual({ text: 'Hi there secret' });
});

test('what a place cannot carry steps down, and that is said', () => {
  const d = doc({ type: 'heading', attrs: { level: 2 }, content: [text('Plan')] }, para(text('gone', 'strike'), ' x', text('2', 'sup'), ' ', text('menu', link('https://example.org/m'))));
  expect(wire(d, 'signal').message).toBe('Plan\ngone x^2 menu (https://example.org/m)');
  expect(keys(d, 'signal')).toEqual(['flattened:sup', 'restyled:heading', 'restyled:link']);
  expect(wire(d, 'sms').text).toBe('Plan\n~gone~ x^2 menu (https://example.org/m)');
  const table: Node = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para('Dish')] }, { type: 'tableCell', content: [para('Cost')] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [para('Soup')] }, { type: 'tableCell', content: [para('4')] }] }] };
  expect(wire(doc(table), 'discord').content).toBe('```\nDish | Cost\nSoup | 4\n```');
  expect(wire(doc(table), 'signal').textStyle).toEqual(['0:11:MONOSPACE', '12:8:MONOSPACE']);
  expect(wire(doc(table), 'github')).toBe('| Dish | Cost |\n| --- | --- |\n| Soup | 4 |');
});

test('what was hidden stays hidden, or the words are named', () => {
  const secret = text('the ending', 'spoiler');
  // In a table that becomes lines, on code, and under a fold: still hidden where the place can hide.
  const cell: Node = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para(secret)] }] }] };
  expect(wire(doc(cell), 'discord').content).toBe('||the ending||');
  expect(wire(doc(para(text('rm -rf', 'spoiler', 'code'))), 'discord').content).toBe('||rm -rf||');
  const fold: Node = { type: 'fold', attrs: { title: 'Ending' }, content: [para('He ', kit({ signal: 'uuid-kit' })), { type: 'codeBlock', content: [text('x = 1')] }] };
  expect(wire(doc(fold), 'signal').textStyle).toEqual(['0:6:BOLD', '7:4:SPOILER', '12:5:MONOSPACE', '12:5:SPOILER']);
  expect(send(doc(fold), P.signal).changes.some((c) => c.level === 'exposed')).toBe(false);
  // Where it cannot: said, with the words.
  expect(send(doc(para('It ends: ', secret)), P.x).changes[0]).toMatchObject({ level: 'exposed', key: 'hidden', words: ['the ending'] });
  expect(send(doc(fold), P.x).changes[0]).toMatchObject({ level: 'exposed', words: ['He Kit', 'x = 1'] });
  // Where the whole post sits behind a content warning, it is still behind a tap: said, but not as a leak.
  expect(keys(doc(para('It ends: ', secret)), 'mastodon')).toContain('exposed:hidden');
  expect(send(doc(para('It ends: ', secret)), P.mastodon, { warning: 'Spoilers' }).changes.map((c) => `${c.level}:${c.key}`)).toEqual(['restyled:hiddenBehind']);
  // A block folded only to save room gives nothing away.
  expect(keys(doc({ ...fold, attrs: { title: 'Log', why: 'long' } }), 'x').some((k) => k.startsWith('exposed'))).toBe(false);
});

test('a kind this version does not know goes as its words, and that is said', () => {
  const d = doc({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [para('buy ', text('milk', 'spoiler'))] }] }, para('x', { type: 'footnote', attrs: { n: 1 } }));
  for (const id of PLACES) {
    const s = send(d, P[id], { title: 't', place: 'p' });
    expect(s.changes.some((c) => c.key === 'unknown')).toBe(true);
    expect(wordsLost(d, s.reads)).toEqual([]);
  }
  expect(wire(d, 'discord').content).toBe('buy ||milk||\nx');
});

test('a mention is a person: each place has its own id for them, or their name goes', () => {
  const d = doc(para(kit({ discord: '8001', matrix: '@kit:example.org', mastodon: 'kit@example.social' }), ' and ', kit({}, 'everyone')));
  expect(wire(d, 'discord')).toEqual({ content: '<@8001> and @everyone', allowed_mentions: { parse: ['everyone'], users: ['8001'], roles: [] } });
  expect(wire(d, 'matrix')['m.mentions']).toEqual({ user_ids: ['@kit:example.org'], room: true });
  expect(wire(d, 'mastodon').status).toBe('@kit@example.social and Kit');
  // No id there: the name, without an @ where the network would look one up and could find a stranger.
  const x = send(d, P.x);
  expect((x.wire as any).text).toBe('Kit and Kit');
  expect(x.changes[0]).toMatchObject({ key: 'mention', words: ['Kit'] });
  expect((send(d, P.sms).wire as any).text).toBe('@Kit and @Kit');
  // Words typed as @everyone tell nobody.
  expect(wire(doc(para('hello @everyone')), 'discord').allowed_mentions.parse).toEqual([]);
});

test('what is written beside the text goes only where the place has it', () => {
  const d = doc(para('Soup at eight.'));
  const f = { title: 'Dinner', warning: 'food', to: 'sam@example.org', place: 'cooking' };
  expect(wire(d, 'mail', f)).toMatchObject({ to: 'sam@example.org', subject: 'Dinner', 'text/plain': 'Soup at eight.', 'text/html': '<div>Soup at eight.</div>' });
  expect(wire(d, 'mastodon', f)).toEqual({ status: 'Soup at eight.', spoiler_text: 'food', sensitive: true });
  expect(wire(d, 'signal', f).message).toBe('Soup at eight.');
  expect(keys(d, 'signal', f)).toEqual(['exposed:warning', 'dropped:title']);
  // The writer may choose to have them in the text there.
  const chosen = send(d, P.signal, f, { lead: true, warn: true });
  expect((chosen.wire as any).message).toBe('Dinner\nfood\nSoup at eight.');
  expect((chosen.wire as any).textStyle).toEqual(['0:6:BOLD', '7:4:BOLD', '12:14:SPOILER']);
  expect(chosen.changes.some((c) => c.level === 'exposed')).toBe(false);
  // Where nothing can be hidden, choosing it puts the warning first and the text after it, and that is the end of it.
  const open = send(d, P.x, f, { warn: true });
  expect(open.counted).toBe('food\n\nSoup at eight.');
  expect(open.changes.map((c) => `${c.level}:${c.key}`)).toEqual(['dropped:title', 'restyled:warningLine']);
  expect(keys(d, 'reddit', {})).toEqual(['blocked:needsTitle', 'blocked:needsPlace']);
  // A profile is made for the place: a comment on Reddit has no title.
  expect(send(d, at(P.reddit, { role: 'comment', fields: {} }), {}).changes).toEqual([]);
});

test('a marker string is read back as its place reads it', () => {
  const typed = doc(para('2 *3* 4 and _x_ <b> [a](b) `c` ~~d~~ ||e|| &copy;'), para('# not a heading'), para('- not a list'), para('1. nor this'), para('> nor a quote'), para('---'), para('    four spaces'));
  for (const id of ['discord', 'github', 'reddit', 'zulip']) {
    const s = send(typed, P[id], id === 'reddit' ? { title: 't', place: 'p' } : {});
    expect([id, s.changes]).toEqual([id, []]);
    expect(differs(typed, s.reads)).toBeNull();
  }
  expect(wire(typed, 'github').split('\\\n')[0]).toBe('2 \\*3\\* 4 and \\_x\\_ \\<b> \\[a\\](b) \\`c\\` \\~\\~d\\~\\~ ||e|| &amp;copy;');
  // WhatsApp has no way to write a marker as itself: the line is named.
  expect(send(doc(para('2 *3* 4')), P.whatsapp).changes[0]).toMatchObject({ level: 'restyled', key: 'reread', words: ['2 *3* 4'] });
  expect(send(doc(para('a * b * c and snake_case_name')), P.whatsapp).changes).toEqual([]);
  // An address typed bare is left alone; code may hold a backtick; a style next to a punctuation mark still holds.
  expect(wire(doc(para('see https://example.org/a_b_c ', text('x`y', 'code'))), 'discord').content).toBe('see https://example.org/a_b_c ``x`y``');
  const flank = send(doc(para('a', text('"b"', 'bold'), 'c')), P.github);
  expect(flank.wire).toBe('a**​"b"​**c');
  expect(flank.changes).toEqual([]);
});

test('a paragraph is a line, everywhere', () => {
  const d = doc(para('one'), para('two'), para(), para('a  b'));
  expect(wire(d, 'discord').content).toBe('one\ntwo\n\na  b');
  expect(wire(d, 'github')).toBe('one\\\ntwo\n\na  b');
  expect(wire(d, 'reddit', { title: 't', place: 'p' }).text).toBe('one  \ntwo\n\na  b');
  expect(wire(d, 'mail')['text/html']).toBe('<div>one</div><div>two</div><div><br></div><div>a &nbsp;b</div>');
  expect(wire(d, 'matrix').formatted_body).toBe('<p>one<br>two<br><br>a &nbsp;b</p>');
  expect(wire(d, 'signal').message).toBe('one\ntwo\n\na  b');
  // A break inside a paragraph, from an older draft, is a new line.
  expect(wire(doc(para('one', { type: 'hardBreak' }, 'two')), 'discord').content).toBe('one\ntwo');
});

test('a tree from elsewhere cannot carry an attack', () => {
  const d = doc({ type: 'paragraph', attrs: { textAlign: 'left" onmouseover="x' }, content: [text('a', link('javascript:alert(1)')), text('b', { type: 'color', attrs: { color: 'red;background:url(x)' } })] });
  const s = send(d, P.mail);
  expect((s.wire as any)['text/html']).toBe('<div>ab</div>');
  expect(s.changes.map((c) => c.key)).toEqual(['linkKind']);
});

test('counting, and what happens past the limit', () => {
  expect(measure('a'.repeat(250) + ' https://example.org/' + 'x'.repeat(80), 'weighted', 280, 23).n).toBe(274);
  expect(measure('👨‍👩‍👧', 'graphemes', 300).n).toBe(1);
  expect(measure('中'.repeat(71), 'sms', null)).toMatchObject({ n: 2, unit: 'texts' });
  const long = doc(para('word '.repeat(100).trim()), para('more '.repeat(20).trim()));
  // A post: refused until the writer makes it a thread.
  const x = send(long, P.x);
  expect(x.changes[0]).toMatchObject({ level: 'blocked', key: 'limit' });
  expect(x.thread).toBe(3);
  const threaded = send(long, P.x, {}, { thread: true });
  expect(threaded.parts!.length).toBe(3);
  expect(threaded.parts!.every((p) => !measure(p.counted, 'weighted', 280, 23).over)).toBe(true);
  expect(threaded.changes[0]).toMatchObject({ level: 'restyled', key: 'limit' });
  expect(split(fit(long, P.x).doc, P.x).map((p) => wordsLost(long, p).length > 0)).toEqual([true, true, true]);
  // A chat: it goes as several by itself.
  expect(send(doc(para('x'.repeat(2500))), P.discord).changes[0]).toMatchObject({ level: 'blocked' });
  expect(send(doc(para('word '.repeat(600))), P.discord).parts!.length).toBe(2);
  // Mastodon counts a link as 23 whatever its length, and its warning with the text.
  expect(measure('see https://example.org/' + 'x'.repeat(200), 'links', 500, 23).n).toBe(27);
  expect(measure('a😀', 'utf16', 10).n).toBe(3);
  expect(send(doc(para('x'.repeat(450))), P.mastodon, { warning: 'y'.repeat(100) }).changes[0]).toMatchObject({ level: 'blocked', key: 'limit' });
  expect(keys(doc(para('x')), 'mastodon', { warning: 'y'.repeat(501) })).toContain('blocked:warningLong');
  // A line that must be cut anyway fills the post before it first.
  expect(send(doc(para('Title'), para('word '.repeat(80).trim())), P.x, {}, { thread: true }).parts!.length).toBe(2);
  // A Telegram message with a picture is a caption, which is shorter.
  const picture: Node = { type: 'image', attrs: { src: 'https://example.org/a.png', alt: 'A' } };
  expect(send(doc(para('x'.repeat(2000))), P.telegram).parts).toBe(null);
  expect(send(doc(para('word '.repeat(400)), picture), P.telegram).parts!.length).toBe(2);
  // IRC sends a line at a time, of at most 512 bytes with its command.
  expect(send(doc(para('word '.repeat(200))), P.irc).parts!.length).toBe(3);
  // Bluesky counts two ways.
  expect(send(doc(para('👨‍👩‍👧'.repeat(200))), P.bluesky).size).toMatchObject({ over: true, unit: 'bytes' });
});

// One small test for each place: together they are 10,500 sends, too many for one test's time on a busy machine.
for (const id of PLACES)
  for (const typed of [false, true])
    test(`random drafts${typed ? ' with typed markers' : ''}: nothing is lost or shown unsaid on ${id}`, () => {
      const next = drafts(typed ? 777 : 12345, typed);
      const pr = P[id];
      for (let i = 0; i < 250; i++) {
        const d = next();
        const s = send(d, pr, { title: 't', place: 'p' });
        const said = new Set(s.changes.map((c) => c.key));
        // The fitted draft holds only what the place carries, and fitting it again changes nothing and says nothing.
        expect([i, conforms(s.fitted, pr)]).toEqual([i, []]);
        const again = fit(s.fitted, pr);
        expect([i, differs(again.doc, s.fitted), again.changes]).toEqual([i, null, []]);
        // Every word arrives, and what was hidden stays hidden, or the writer is told.
        if (!said.has('lost')) expect([i, wordsLost(d, s.fitted), wordsLost(s.fitted, s.reads, true)]).toEqual([i, [], []]);
        if (!said.has('hidden')) expect([i, hiddenLost(d, s.reads)]).toEqual([i, []]);
        // Without marker characters among the words, a network that can escape reads exactly what was meant.
        if (!typed && ['discord', 'github', 'reddit', 'zulip'].includes(id)) expect([i, said.has('reread') || said.has('lost')]).toEqual([i, false]);
        // The same, asked of the wire itself by code that shares nothing with the model (writing-oracle.ts).
        const there = reading(id, s.wire);
        const words = tokens(d);
        if (there && !said.has('lost')) expect([i, words.all.filter((w) => !there.all.includes(w))]).toEqual([i, []]);
        if (there && !said.has('hidden') && !said.has('warning')) expect([i, words.hidden.filter((w) => there.seen.includes(w))]).toEqual([i, []]);
      }
    });

test('what a review broke stays fixed', () => {
  const hid = (t: string) => text(t, 'spoiler');
  const fold = (title: string, ...content: Node[]): Node => ({ type: 'fold', attrs: { title }, content });
  const exposed = (d: Node, id: string, f = {}) => send(d, P[id], f).changes.filter((c) => c.level === 'exposed').flatMap((c) => c.words ?? []);
  // A hidden word is not "still hidden" because its letters are scattered through other hidden text.
  const sam = doc(para('The killer is ', hid('Sam'), '.'), fold('Details', para('So amazing, a mystery')));
  expect(exposed(sam, 'github')).toEqual(['Sam']);
  expect(exposed(sam, 'zulip')).toEqual(['Sam']);
  expect(exposed(doc(para('The killer is ', hid('Sam'), '.'), fold('Details', para('Sam did it'))), 'github')).toEqual(['Sam']);
  // Hidden text with no letter in it is hidden text.
  expect(exposed(doc(para('Price: ', hid('$$$'))), 'x')).toEqual(['$$$']);
  expect(exposed(doc(para(hid('😀'))), 'sms')).toEqual(['😀']);
  // Matrix's plain copy is what a notification shows: nothing hidden is in it.
  const matrix = send(doc(para(text('W0W', 'strike', 'spoiler'), 'W1W'), fold('Ending', para('W2W'))), P.matrix);
  expect((matrix.wire as any).body).toBe('[hidden]W1W\nEnding\n[hidden]');
  expect(matrix.changes.map((c) => c.key)).toContain('plainCopy');
  // A picture under a fold is hidden with it, or said.
  const picture: Node = { type: 'image', attrs: { src: 'https://example.org/ending.png', alt: 'The ending' } };
  const pic = doc(fold('Spoiler picture', para('look'), picture));
  expect(exposed(pic, 'signal')).toEqual(['The ending']);
  expect(exposed(pic, 'discord')).toEqual([]);
  expect(send(pic, P.discord).files).toEqual([{ type: 'image', attrs: { src: 'https://example.org/ending.png', alt: 'The ending', hidden: true } }]);
  expect(keys(doc(picture), 'irc')).toEqual(['dropped:noFiles']);
  expect(exposed(doc(picture), 'signal', { warning: 'cw' })).toEqual(['cw']);
  expect(send(doc(picture), P.signal, { warning: 'cw' }, { warn: true }).changes.map((c) => `${c.level}:${c.key}`)).toContain('exposed:hiddenFile');
  // A table's rows are as wide as its widest: a network drops what a row has past its header.
  const cell = (type: string, t: string): Node => ({ type, content: [para(t)] });
  const wide = doc({ type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', 'Name')] }, { type: 'tableRow', content: [cell('tableCell', 'Soup'), cell('tableCell', 'PRICE'), cell('tableCell', 'third')] }] });
  expect(wire(wide, 'github')).toBe('| Name |  |  |\n| --- | --- | --- |\n| Soup | PRICE | third |');
  // Lines of the writer's own that would make a table do not.
  const typed = doc(para('a | b'), para('--- | ---'), para('1 | 2 | 3 | 4'));
  expect(wire(typed, 'reddit', { title: 't', place: 'p' }).text).toBe('a | b  \n\\--- | ---  \n1 | 2 | 3 | 4');
  expect(keys(typed, 'reddit', { title: 't', place: 'p' })).toEqual([]);
  // A letter beside a mention would make it another name.
  const ids = { github: 'kit', x: 'kit', reddit: 'kit', mastodon: 'kit@example.social', whatsapp: '15550100', zulip: '17', discord: '8001' };
  const glued = doc(para('mail', kit(ids), 'ten rules'));
  expect(wire(glued, 'github')).toBe('mail @kit ten rules');
  expect(wire(glued, 'x').text).toBe('mail @kit ten rules');
  expect(wire(glued, 'mastodon').status).toBe('mail @kit@example.social ten rules');
  expect(wire(glued, 'whatsapp').text).toBe('mail @15550100 ten rules');
  expect(wire(glued, 'zulip')).toBe('mail @**Kit|17**ten rules');
  expect(wire(glued, 'discord').content).toBe('mail<@8001>ten rules');
  // A tree from elsewhere: an address, a name or a label cannot end what holds it and start something else.
  const href = 'https://example.org/) and @torvalds please review (';
  expect(wire(doc(para(text('the guide', link(href)))), 'github')).toBe('[the guide](https://example.org/%29%20and%20@torvalds%20please%20review%20%28)');
  expect(wire(doc(para(text('the guide', link(href)))), 'x').text).toBe('the guide (https://example.org/)%20and%20@torvalds%20please%20review%20()');
  expect(wire(doc(para('hi ', { type: 'emoji', attrs: { name: 'wave: @**all** :wave' } })), 'zulip')).toBe('hi wave: @\\*\\*all\\*\\* :wave');
  expect(wire(doc(para({ type: 'mention', attrs: { kind: 'user', label: 'all** @**Sam', ids: { zulip: '17' } } })), 'zulip')).toBe('@**all Sam|17**');
  expect(wire(doc({ type: 'codeBlock', attrs: { language: 'js\n```\n@everyone' }, content: [text('x')] }), 'discord').content).toBe('```\nx\n```');
  expect(wire(doc(para('a\n# b')), 'discord').content).toBe('a\n\\# b');
  expect(wire(doc(para('ping @everyone and @here')), 'discord').content).toBe('ping @​everyone and @​here');
  // What a kind not known here hid stays hidden.
  const math: Node = { type: 'math', marks: [{ type: 'spoiler' }], content: [text('x=42')] };
  expect(wire(doc(para('It is ', math)), 'discord').content).toBe('It is ||x=42||');
  expect(exposed(doc(para('It is ', math)), 'x')).toEqual(['x=42']);
  // A damaged tree is read as far as it can be, on every place.
  const damaged = [{ type: 'time', attrs: { at: 'soon' } }, { type: 'time', attrs: { at: 1e18 } }, { type: 'text', text: 'a', marks: { type: 'bold' } }, { type: 'text', text: 7 }, { type: 'emoji' }, 5, null] as unknown as Node[];
  const broken = { type: 'doc', content: [para(...damaged), { type: 'heading', attrs: { level: -1 }, content: [text('h')] }, { type: 'paragraph', content: 'words' }, { type: 'orderedList', attrs: { start: 'x' }, content: [{ type: 'listItem' }] }] } as unknown as Node;
  for (const id of PLACES) expect(() => send(broken, P[id], { title: 't', place: 'p' })).not.toThrow();
  expect(wire(broken, 'discord').content).toBe('(a time)(a time)a\n# h\n\n1. ');
  // A quote of nothing is not written: it would be read as a quote of an empty line.
  expect(wire({ type: 'doc', content: [para('a'), { type: 'blockquote', content: [para()] }] }, 'discord').content).toBe('a');
  expect(keys({ type: 'doc', content: [para('a'), { type: 'orderedList', content: [] }, { type: 'table' }, { type: 'fold', attrs: { title: 'Ending', why: 'long' }, content: [] }] }, 'zulip')).toEqual([]);
  // Two places with one network's profile are two places: each has its own choices.
  const two = choose(draft('compose', ['mastodon:home', 'mastodon:work'], doc(para('word '.repeat(120).trim()))), 'mastodon:work', { thread: true });
  const both = outcome(two, (key) => P[key.split(':')[0]]);
  expect([both.stopped, both.sent['mastodon:work'].parts!.length]).toEqual([['mastodon:home'], 2]);
  // Markers a place cannot escape are read in a time that grows gently: this is forty of them.
  expect(send(doc(para('*a _b ~c '.repeat(40))), P.whatsapp).changes.some((c) => c.level === 'blocked')).toBe(false);
  // A link as the editor makes it (with a target and a rel) is the link it is.
  expect(keys(doc(para(text('the guide', { type: 'link', attrs: { href: 'https://example.org/', target: '_blank', rel: 'noopener', class: null } }))), 'discord')).toEqual([]);
  // What goes beside the text is the place's own, for the place it is: a comment has no title to send.
  expect(send(doc(para('x')), at(P.reddit, { role: 'comment', fields: {} }), { title: 'T', place: 'p' }).wire).toEqual({ text: 'x' });
  // Slack: lines are one section, a list counts on from where it was broken off, and an item's parts keep their order.
  const li = (...content: Node[]): Node => ({ type: 'listItem', content });
  const slack = wire(doc(para('one'), para(), para('two'), { type: 'orderedList', attrs: { start: 3 }, content: [li(para('A'), { type: 'bulletList', content: [li(para('in'))] }, para('B')), li(para('C'))] }), 'slack').blocks[0].elements;
  expect(slack[0]).toEqual({ type: 'rich_text_section', elements: [{ type: 'text', text: 'one' }, { type: 'text', text: '\n' }, { type: 'text', text: '\n' }, { type: 'text', text: 'two' }] });
  expect(slack.slice(1).map((e: any) => [e.type, e.indent ?? '', e.offset ?? '', JSON.stringify(e.elements).match(/"text":"(\w+)"/g)!.join()])).toEqual([
    ['rich_text_list', 0, 2, '"text":"A"'],
    ['rich_text_list', 1, '', '"text":"in"'],
    ['rich_text_section', '', '', '"text":"B"'],
    ['rich_text_list', 0, 3, '"text":"C"'],
  ]);
  // A custom emoji, like a person, has its own id in each place: a Discord id is not sent to Telegram.
  const party: Node = { type: 'emoji', attrs: { name: 'party', alt: '🎉', ids: { discord: '55' } } };
  expect(wire(doc(para(party)), 'discord').content).toBe('<:party:55>');
  expect(wire(doc(para(party)), 'telegram')).toEqual({ message: ':party:', entities: [] });
  // What hides is outermost.
  expect(wire(doc(para(text('secret words', 'spoiler', link('https://example.org/')))), 'discord').content).toBe('||[secret words](https://example.org/)||');
  // On GitHub: a tab does not make code, a rule under a line no heading, a line after a quote is not drawn into it.
  expect(keys(doc(para('\tsee ', text('bold', 'bold'))), 'github')).toEqual(['restyled:reread']);
  expect(wire(doc({ type: 'bulletList', content: [li(para('Title words'), { type: 'horizontalRule' })] }), 'github')).toBe('- Title words\n  ***');
  expect(wire(doc({ type: 'bulletList', content: [li({ type: 'blockquote', content: [para('quoted')] }, para('my own line'))] }), 'github')).toBe('- > quoted\n\n  my own line');
});

test('a draft goes whole, moves as it is, and goes once to each place', () => {
  const profile = (key: string) => P[key];
  const words = doc(para('The last chapter ', text('ends at the lighthouse', 'spoiler'), '.'));
  let d = draft('compose', ['x', 'mastodon', 'reddit'], words, { place: 'hiking' });
  // Reddit needs a title: while it does, nothing goes anywhere.
  let o = outcome(d, profile);
  expect([o.ready, o.stopped, o.exposing]).toEqual([false, ['reddit'], ['x', 'mastodon']]);
  // Left out, the rest may go, and the writer is asked about the two that would show the hidden words.
  o = outcome(leave(d, 'reddit'), profile);
  expect([o.ready, o.stopped, o.exposing]).toEqual([true, [], ['x', 'mastodon']]);
  // With a title it may go. X written separately, without the secret, no longer shows it; the others keep their words.
  d = { ...d, fields: { ...d.fields, title: 'The trail guide' } };
  d = write(apart(d, 'x'), doc(para('The last chapter is out.')), 'x');
  o = outcome(d, profile);
  expect([o.ready, o.exposing]).toEqual([true, ['mastodon']]);
  expect((o.sent.x.wire as any).text).toBe('The last chapter is out.');
  expect((o.sent.reddit.wire as any).text).toBe('The last chapter >!ends at the lighthouse!<.');
  // A choice is one place's: a thread on X is no thread on Mastodon.
  d = choose(d, 'x', { thread: true });
  expect(d.places.map((p) => p.options)).toEqual([{ thread: true }, undefined, undefined]);
  // It went to two. Sent again, it goes only where it has not been, and it is done when it has been everywhere.
  d = went(d, ['x', 'reddit'], 1700000000);
  expect([outcome(d, profile).due, done(d)]).toEqual([['mastodon'], false]);
  expect(done(went(d, ['mastodon'], 1700000001))).toBe(true);

  // A message to a person moves from one way of reaching them to another, and to a group's chat when the mail
  // gains a Cc: the chat is a pointer, and the words, the fields and what was a place's own go along.
  let m = draft('person-1', ['mail'], doc(para('See you at eight.')), { title: 'Dinner' });
  m = move(m, 'person-1', ['signal']);
  expect(outcome(m, profile).sent.signal.changes.map((c) => c.key)).toEqual(['title']);
  m = choose(m, 'signal', { lead: true });
  expect((outcome(m, profile).sent.signal.wire as any).message).toBe('Dinner\nSee you at eight.');
  m = move(m, 'group-7', ['signal', 'mail']);
  expect([m.chat, m.fields.title, m.places]).toEqual(['group-7', 'Dinner', [{ key: 'signal', options: { lead: true } }, { key: 'mail' }]]);
  // An empty draft goes nowhere.
  expect(outcome(draft(null, ['signal']), profile).ready).toBe(false);
});

test('what a second review broke stays fixed', () => {
  const hid = (t: string, ...more: any[]) => text(t, 'spoiler', ...more);
  const seen = (d: Node, id: string) => reading(id, send(d, P[id]).wire)!.seen;
  const says = (d: Node, id: string, f = {}) => send(d, P[id], f).changes.map((c) => c.key);
  // Discord: nothing inside what is hidden can end it early. An address may hold the marker that hides.
  expect(seen(doc(para(hid('see https://a.example/||x and the SECRET word'))), 'discord')).not.toContain('SECRET');
  expect(wire(doc(para(hid('the SECRET', link('https://a.example/||b')), ' after')), 'discord').content).toBe('||[the SECRET](https://a.example/%7C%7Cb)|| after');
  // An id is an id: one that is not goes nowhere near a wire, and the person goes as their name.
  const odd = (attrs: object): Node => ({ type: 'mention', attrs: { kind: 'user', label: 'Kit', ...attrs } });
  expect(wire(doc(para(hid('the SECRET '), odd({ ids: { discord: '1||' } }))), 'discord').content).toBe('||the SECRET|| @Kit');
  expect(wire(doc(para({ type: 'time', attrs: { at: 1700000000, style: 'R>||' } })), 'discord').content).toBe('<t:1700000000:f>');
  expect(wire(doc(para({ type: 'emoji', attrs: { name: 'party', ids: { discord: '9>||' } } })), 'discord').content).toBe(':party:');
  expect(wire(doc(para({ type: 'emoji', attrs: { name: 'party', ids: { discord: '77' }, animated: true } })), 'discord').content).toBe('<a:party:77>');
  // An id alone is an id somewhere: it is used only in the space it says it is of.
  expect(says(doc(para(odd({ id: '8001' }))), 'telegram')).toEqual(['mention']);
  expect(says(doc(para(odd({ id: '8001', space: 'discord' }))), 'telegram')).toEqual(['mention']);
  expect(wire(doc(para(odd({ id: '8001', space: 'discord' }))), 'discord').content).toBe('<@8001>');
  // A name is its owner's choice of words, and tells nobody: not the person, and not whoever it names.
  expect(wire(doc(para('thanks ', odd({ label: 'Kit (@nasa)', ids: { discord: '8001' } }))), 'x').text).toBe('thanks Kit (nasa)');
  expect(wire(doc(para(odd({ label: '@nasa', ids: {} }))), 'mastodon').status).toBe('nasa');
  expect(wire(doc(para(odd({ label: 'u/spez', ids: {} }))), 'reddit', { title: 't', place: 'p' }).text).not.toContain('u/spez');
  // What stands in for an emoji is an emoji, never words: words would be read as the writer's.
  expect(wire(doc(para('I agree ', { type: 'emoji', attrs: { name: 'ok', alt: 'to pay you 500 dollars' } })), 'telegram').message).toBe('I agree :ok:');
  // What comes right after an address is not part of it.
  const kitAt = odd({ ids: { bluesky: 'did:plc:kit' } });
  const sky = wire(doc(para('see https://a.example/', kitAt)), 'bluesky');
  expect(sky.text).toBe('see https://a.example/ @Kit');
  expect(sky.facets.map((f: any) => f.features[0].uri ?? f.features[0].did)).toEqual(['https://a.example/', 'did:plc:kit']);
  expect(wire(doc(para('https://a.example.org/', odd({ label: 'kitx', ids: {} }))), 'x').text).toBe('https://a.example.org/ kitx');
  // HTML kept as itself keeps to itself, or goes as its words.
  const raw = (source: string): Node => ({ type: 'raw', attrs: { format: 'html', source, text: 'News' } });
  expect([contained('<table><tr><td>News<br></td></tr></table>'), contained('<p>a <b>b</b></p><!-- done -->')]).toEqual([true, true]);
  for (const open of ['<!-- note', '<pre>', '<details>', '<div hidden>x</div>', '<p></details></p>', '<table><tr><td>News<!-- x', '<style>div{display:none}</style>', '<title>x', '<b title="a>b', 'a < b']) expect([open, contained(open)]).toEqual([open, false]);
  expect(says(doc(para('before'), raw('<!-- note'), para('after')), 'github')).toEqual(['rawOpen']);
  expect(wire(doc(para('before'), raw('<!-- note'), para('after')), 'github')).toBe('before\\\nNews\\\nafter');
  expect(says(doc(raw('<style>div{display:none}</style>'), para('my reply')), 'mail', { title: 't' })).toEqual(['rawOpen']);
  expect(says(doc(raw('<table><tr><td>News</td></tr></table>'), para('my reply')), 'mail', { title: 't' })).toEqual([]);
  // Words that stand where their kind cannot stand are put where it can: none is dropped for being out of place.
  const stray = { type: 'doc', content: [para('do not pay the invoice'), { type: 'bulletList', content: [text('not')] }, { type: 'table', content: [{ type: 'tableRow', content: [text('at')] }] }, text('no')] } as Node;
  expect(wire(stray, 'plain').text).toBe('do not pay the invoice\n- not\nat\nno');
  expect(wire(stray, 'github')).toContain('- not');
  // Letters one line was found in are taken: "no" is not found in "know".
  expect(wordsLost(doc(para('I know the piano'), para('no')), doc(para('I know the piano')))).toEqual(['no']);
  // What is beside the text is one line: a subject cannot bring a header, a title put first cannot bring a command.
  expect(JSON.stringify(send(doc(para('x')), P.mail, { title: 'Hi\r\nBcc: someone' }).wire)).not.toMatch(/\\[rn]Bcc/);
  expect(send(doc(para('x')), P.irc, { title: '\x01DCC SEND\x01' }, { lead: true }).counted).toBe('\x02DCC SEND\x02\nx');
  // A # that ends a heading is its own; a centred heading stays centred where alignment is carried.
  expect(wire(doc({ type: 'heading', attrs: { level: 2 }, content: [text('We are number #')] }), 'github')).toBe('## We are number \\#');
  expect(JSON.stringify(wire(doc({ type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [text('Menu')] }), 'mail', { title: 't' }))).toContain('text-align:center');
  // X counts an emoji as two whatever it is made of, and a bare © as the letter it is.
  expect(['🇯🇵🇯🇵', '1️⃣', '©®™', '👨‍👩‍👧'].map((x) => measure(x, 'weighted', 280).n)).toEqual([4, 2, 4, 2]);

  // A draft: nothing arriving is nothing to send, judged from the wire; a subject alone is a mail.
  const profile = (key: string) => P[key];
  const gone: Node = { type: 'image', attrs: { src: 'blob:https://app.example/1', alt: '' } };
  expect(outcome(draft(null, ['signal'], doc(gone)), profile).ready).toBe(false);
  expect(outcome(draft(null, ['signal'], doc(para('   '))), profile).ready).toBe(false);
  expect(outcome(draft(null, ['mail'], doc(para()), { title: 'Call me' }), profile).ready).toBe(true);
  // Left out and put back, a place has what was written for it. Agreed once, an exposure is not asked again.
  let d = write(apart(draft('compose', ['x', 'mastodon'], doc(para('It ', hid('ends at sea'), '.'))), 'x'), doc(para('For X: it ', hid('ends at sea'), '.')), 'x');
  d = add(leave(d, 'x'), 'x');
  expect((outcome(d, profile).sent.x.wire as any).text).toBe('For X: it ends at sea.');
  expect(outcome(d, profile).exposing).toEqual(['x', 'mastodon']);
  d = agree(d, 'x', ['ends at sea']);
  expect([outcome(d, profile).exposing, outcome(leave(d, 'mastodon'), profile).due]).toEqual([['mastodon'], ['x']]);
  // The same place twice is one place; a draft in a newer format is not sent by older code.
  expect(move(d, 'c', ['x', 'x']).places.length).toBe(1);
  expect(outcome({ ...draft(null, ['signal'], doc(para('hi'))), v: 99 }, profile).ready).toBe(false);
});

test('nothing JSON can carry makes it throw', () => {
  // Nor is anything walked ten thousand deep.
  const bomb = { toString: 1, valueOf: 1 };
  const armed = { type: 'doc', content: [{ type: 'heading', attrs: { level: bomb, textAlign: bomb }, content: [{ type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: bomb } }, { type: 'color', attrs: { color: bomb } }] }, { type: 'time', attrs: { at: bomb, style: bomb } }] }, { type: 'codeBlock', attrs: { language: bomb }, content: [text('x')] }] } as unknown as Node;
  let deep: any = para('bottom');
  for (let i = 0; i < 10000; i++) deep = { type: i % 2 ? 'blockquote' : 'fold', attrs: { title: 't' }, content: [deep] };
  for (const id of PLACES) {
    expect(() => send(armed, P[id], { title: 5, warning: {}, place: null } as any)).not.toThrow();
    expect(send({ type: 'doc', content: [deep] }, P[id], { title: 't', place: 'p' }).counted).toContain('bottom');
  }
});

test('long and odd lines do not take seconds', () => {
  // A long line is cut by halving, and a line of lone stars is read once: neither takes seconds.
  expect(send(doc(para(...Array.from({ length: 1500 }, (_, i) => text('ab ', i % 2 ? 'bold' : 'italic')))), P.telegram).parts!.length).toBe(2);
  expect(send(doc(para('*a '.repeat(4000))), P.whatsapp).changes.some((c) => c.level === 'blocked')).toBe(false);
});
