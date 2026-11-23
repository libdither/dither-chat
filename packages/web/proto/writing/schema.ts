/**
 * The editor's schema for the writing-model demo: the document of protocol/src/writing/doc.ts, as Tiptap has it, and
 * the typing rules. What the rules do depends on where the draft is going, which the page keeps in `live` (live.ts).
 * A part typed as Markdown or as HTML is parts.ts.
 */
import { Extension, InputRule, Mark, Node, markInputRule, mergeAttributes, nodeInputRule, textblockTypeInputRule, wrappingInputRule } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { live } from './live.ts';
import { langAt, Parts, sandbox, Source } from './parts.ts';

const simple = (name: string, tag: string, cls?: string) =>
  Mark.create({
    name,
    parseHTML: () => [{ tag: cls ? `${tag}.${cls}` : tag }],
    renderHTML: ({ HTMLAttributes }) => [tag, mergeAttributes(HTMLAttributes, cls ? { class: cls } : {}), 0],
  });

const Spoiler = simple('spoiler', 'span', 'w-spoiler');
const Sub = simple('sub', 'sub');
const Sup = simple('sup', 'sup');
const Color = Mark.create({
  name: 'color',
  addAttributes: () => ({ color: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-color]', getAttrs: (el) => ({ color: (el as HTMLElement).dataset.color }) }],
  renderHTML: ({ mark }) => ['span', { 'data-color': mark.attrs.color, style: `color:${mark.attrs.color}` }, 0],
});

const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  // `ids` is the person's id in each place they can be reached.
  addAttributes: () => ({ kind: { default: 'user' }, label: { default: '' }, ids: { default: {} } }),
  parseHTML: () => [{ tag: 'span[data-mention]', getAttrs: (el) => JSON.parse((el as HTMLElement).dataset.mention ?? '{}') }],
  renderHTML: ({ node }) => ['span', { class: 'w-mention', 'data-mention': JSON.stringify(node.attrs) }, '@' + node.attrs.label],
});
const Time = Node.create({
  name: 'time',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ at: { default: 0 }, style: { default: 'f' } }),
  parseHTML: () => [{ tag: 'span[data-time]', getAttrs: (el) => ({ at: Number((el as HTMLElement).dataset.time) }) }],
  renderHTML: ({ node }) => ['span', { class: 'w-time', 'data-time': String(node.attrs.at) }, new Date(node.attrs.at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })],
});
/** A network's own emoji: here only so that a draft holding one can be shown. */
const Emoji = Node.create({
  name: 'emoji',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ name: { default: '' }, id: { default: null }, alt: { default: null }, space: { default: null }, animated: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-emoji]', getAttrs: (el) => ({ name: (el as HTMLElement).dataset.emoji }) }],
  renderHTML: ({ node }) => ['span', { class: 'w-emoji', 'data-emoji': node.attrs.name }, node.attrs.alt || `:${node.attrs.name}:`],
});
/** A draft is blocks, and parts typed another way between them: a part is never inside a block. */
const Draft = Node.create({ name: 'doc', topNode: true, content: '(block | source)+' });
const Fold = Node.create({
  name: 'fold',
  group: 'block',
  content: 'block+',
  defining: true,
  // `why`: 'long' when it is folded only to save room, so showing it open gives nothing away.
  addAttributes: () => ({ title: { default: 'Spoiler' }, why: { default: null } }),
  parseHTML: () => [{ tag: 'div[data-fold]', getAttrs: (el) => ({ title: (el as HTMLElement).dataset.fold }) }],
  renderHTML: ({ node }) => ['div', { class: 'w-fold', 'data-fold': node.attrs.title }, 0],
});
const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);
const Raw = Node.create({
  name: 'raw',
  group: 'block',
  atom: true,
  selectable: true,
  // `fallback`: what could be read of it, for a place that takes no HTML (a piece of typed HTML kept whole has one).
  addAttributes: () => ({ format: { default: 'html' }, source: { default: '' }, text: { default: '' }, fallback: { default: null } }),
  parseHTML: () => [{ tag: 'div[data-raw]' }],
  renderHTML: ({ node }) => ['div', { 'data-raw': node.attrs.format }],
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'w-raw';
      dom.contentEditable = 'false';
      const bar = document.createElement('div');
      bar.className = 'w-raw-bar';
      bar.textContent = `Kept as its own ${String(node.attrs.format).toUpperCase()} · ${kb(new Blob([node.attrs.source]).size)}`;
      const frame = sandbox();
      frame.show(String(node.attrs.source));
      dom.append(bar, frame.el);
      return { dom };
    };
  },
});

/**
 * Typing. Markdown typed in the text becomes a style or a block only where some place the draft goes to carries it:
 * in a draft for SMS, stars stay stars. A new line is always a new paragraph. Hidden text that some place would show,
 * and a mention that some place cannot deliver, are marked where they stand.
 */
const Typing = Extension.create({
  name: 'typing',
  addInputRules() {
    const { marks, nodes } = this.editor.schema;
    // In a part typed as Markdown or HTML the markers stay as typed: nothing is made of them here.
    const gate = (what: string, rule: InputRule) => new InputRule({ find: rule.find, handler: (p) => (live.carries(what) && !langAt(p.state, p.range.from) ? rule.handler(p) : null) });
    return [
      gate('bold', markInputRule({ find: /(?:^|\s)(\*\*(?!\s)([^*]+?)(?<!\s)\*\*)$/, type: marks.bold })),
      // One star or underscore on each side, tight against the words: "a * b * c" and snake_case stay as typed.
      gate('italic', markInputRule({ find: /(?:^|\s)(\*(?![\s*])([^*]+?)(?<![\s*])\*)$/, type: marks.italic })),
      gate('italic', markInputRule({ find: /(?:^|\s)(_(?![\s_])([^_]+?)(?<![\s_])_)$/, type: marks.italic })),
      gate('strike', markInputRule({ find: /(?:^|\s)(~~(?!\s)([^~]+?)(?<!\s)~~)$/, type: marks.strike })),
      gate('code', markInputRule({ find: /(?:^|\s)(`([^`]+)`)$/, type: marks.code })),
      gate('spoiler', markInputRule({ find: /(?:^|\s)(\|\|(?!\s)([^|]+?)(?<!\s)\|\|)$/, type: marks.spoiler })),
      gate('heading', textblockTypeInputRule({ find: /^(#{1,6})\s$/, type: nodes.heading, getAttributes: (m) => ({ level: m[1].length }) })),
      gate('blockquote', wrappingInputRule({ find: /^\s*>\s$/, type: nodes.blockquote })),
      gate('bulletList', wrappingInputRule({ find: /^\s*([-+*])\s$/, type: nodes.bulletList })),
      gate('orderedList', wrappingInputRule({ find: /^(\d+)\.\s$/, type: nodes.orderedList, getAttributes: (m) => ({ start: +m[1] }) })),
      gate('codeBlock', textblockTypeInputRule({ find: /^```([a-z]+)?\s$/, type: nodes.codeBlock, getAttributes: (m) => ({ language: m[1] }) })),
      gate('horizontalRule', nodeInputRule({ find: /^(?:---)\s$/, type: nodes.horizontalRule })),
      // [words](address), where a link can have words of its own.
      gate(
        'link',
        new InputRule({
          find: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/,
          handler: ({ state, range, match }) => void state.tr.replaceWith(range.from, range.to, state.schema.text(match[1], [marks.link.create({ href: match[2] })])).removeStoredMark(marks.link),
        }),
      ),
      // "@kit " is Kit, if there is one and some place can tell them: a mention is a person, whatever the place.
      new InputRule({
        find: /(?:^|\s)@(\w+)\s$/,
        handler: ({ state, range, match }) => {
          const who = live.carries('mention') && langAt(state, range.from) !== 'html' && live.people.find((x) => x.label.toLowerCase() === match[1].toLowerCase());
          if (!who) return null;
          const from = range.to - match[1].length - 2;
          state.tr.replaceWith(from, range.to, [nodes.mention.create(who), state.schema.text(' ')]);
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    const line = () => this.editor.commands.first(({ commands }) => [() => commands.newlineInCode(), () => commands.splitListItem('listItem'), () => commands.createParagraphNear(), () => commands.liftEmptyBlock(), () => commands.splitBlock()]);
    // A style's own keys do nothing where no place carries the style: Ctrl+B in a text message stays out of the draft.
    const KEYS: Record<string, string> = { b: 'bold', i: 'italic', u: 'underline', e: 'code' };
    const gated = Object.fromEntries(Object.entries(KEYS).flatMap(([k, what]) => [k, k.toUpperCase()].map((key) => [`Mod-${key}`, () => !live.carries(what)])));
    return {
      ...gated,
      'Mod-Shift-s': () => !live.carries('strike'),
      'Mod-Shift-S': () => !live.carries('strike'),
      'Shift-Enter': line,
      Enter: () => {
        if (!live.enterSends() || this.editor.isActive('codeBlock') || this.editor.isActive('listItem') || this.editor.isActive('table')) return false;
        live.send();
        return true;
      },
      'Mod-Enter': () => {
        live.send();
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('writing-marks'),
        props: {
          decorations: (state) => {
            const out: Decoration[] = [];
            const exposes = live.exposes();
            const open = { class: 'w-exposed', title: `Shown openly on ${exposes}` };
            state.doc.descendants((node, pos) => {
              if (exposes && node.isText && node.marks.some((m) => m.type.name === 'spoiler')) out.push(Decoration.inline(pos, pos + node.nodeSize, open));
              if (exposes && node.type.name === 'fold' && node.attrs.why !== 'long') out.push(Decoration.node(pos, pos + node.nodeSize, open));
              const deaf = node.type.name === 'mention' ? live.quiet(node.attrs) : '';
              if (deaf) out.push(Decoration.node(pos, pos + node.nodeSize, { class: 'w-quiet', title: `Not told on ${deaf}: the name goes as words` }));
            });
            return DecorationSet.create(state.doc, out);
          },
        },
      }),
    ];
  },
});

export const extensions = () => [
  // No empty paragraph is kept after a part: a draft typed as Markdown is that part and nothing else.
  StarterKit.configure({ document: false, link: { openOnClick: false, autolink: false }, heading: { levels: [1, 2, 3, 4, 5, 6] }, hardBreak: false, trailingNode: { notAfter: ['source'] } }),
  Draft,
  TableKit.configure({ table: { resizable: false } }),
  Image.configure({ inline: false }),
  Spoiler,
  Sub,
  Sup,
  Color,
  Mention,
  Time,
  Emoji,
  Fold,
  Raw,
  Source,
  Parts,
  Typing,
];
