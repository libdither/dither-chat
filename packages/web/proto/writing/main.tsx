/**
 * The writing-model demo: one box that writes to a chat, a post or a mail. Its controls come from where the draft is
 * going, it says nothing while what arrives is what was typed, and when something would not arrive as written it marks
 * the words and says so. A prototype for docs/research/writing-model.md, not part of the app.
 */
import { Editor } from '@tiptap/core';
import { Placeholder } from '@tiptap/extensions';
import { EditorState } from '@tiptap/pm/state';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { doc, para, text, type Node as DocNode } from '../../../protocol/src/writing/doc.ts';
import { add, agree, apart, choose, done, draft as newDraft, leave, move, outcome, together, went, write, type Draft } from '../../../protocol/src/writing/draft.ts';
import { preview, send, type Options, type Sent } from '../../../protocol/src/writing/encode.ts';
import { carries, type Change } from '../../../protocol/src/writing/fit.ts';
import type { Way } from '../../../protocol/src/writing/lens.ts';
import { PLACES, PROFILES, type Fields, type Profile } from '../../../protocol/src/writing/profile.ts';
import { live, type Person } from './live.ts';
import { activeIn, blank, block, offers, partAt, PICTURE, redrawLooks, setWay, style, touched, unhide, wayOf, wayOfAll } from './parts.ts';
import { extensions } from './schema.ts';

const KIT: Person = { kind: 'user', label: 'Kit', ids: { signal: 'uuid-kit', whatsapp: '15550100', telegram: '7001', discord: '8001', matrix: '@kit:example.org', slack: 'U8KIT', zulip: '17', bluesky: 'did:plc:kit', mastodon: 'kit@example.social', github: 'kit', reddit: 'kit' } };
const SAM: Person = { kind: 'user', label: 'Sam', ids: { discord: '8002', slack: 'U8SAM' } };
const ALL: Person = { kind: 'everyone', label: 'everyone', ids: {} };
const PEOPLE = [KIT, SAM, ALL];
const mention = (p: Person): DocNode => ({ type: 'mention', attrs: p });
const link = (href: string) => ({ type: 'link', attrs: { href } });
const item = (...content: DocNode[]): DocNode => ({ type: 'listItem', content });
const cell = (type: string, s: string): DocNode => ({ type, content: [para(s)] });
const NEWSLETTER = '<table width="100%" style="background:#1f3a5f;color:#fff;font-family:Georgia,serif"><tr><td style="padding:14px"><b style="font-size:18px">Northbound Outfitters</b><br>Winter sale: 30% off boots until Sunday</td></tr></table>';
const friday = Math.floor(Date.now() / 86400000) * 86400 + 3 * 86400 + 19 * 3600;

/** A place to write, as the chat it is in hands it to the box: which routes there are, and whether one or several. */
interface Scene {
  id: string;
  name: string;
  about: string;
  /** The chat the draft is in. */
  chat: string;
  /** The places offered, and the ones chosen at the start. */
  routes: string[];
  chosen: string[];
  many: boolean;
  to: string;
  fields: Fields;
  doc: DocNode;
}
const SCENES: Scene[] = [
  { id: 'chat', name: 'A chat with Kit', about: 'One person, the ways to reach them. Pick how it goes; the draft stays.', chat: 'kit', routes: ['signal', 'whatsapp', 'discord', 'sms', 'mail'], chosen: ['signal'], many: false, to: 'Kit', fields: {}, doc: doc(para()) },
  {
    id: 'post', name: 'A post from your accounts', about: 'The same words to several networks, each with its own limit.', chat: 'compose', routes: ['x', 'bluesky', 'mastodon', 'reddit'], chosen: ['x', 'bluesky', 'mastodon'], many: true, to: '', fields: { warning: '', title: '', place: '' },
    doc: doc(para('Finished the trail guide with ', mention(KIT), '. The last chapter ', text('ends at the lighthouse', 'spoiler'), '.'), para(), para('Read it: ', text('the guide', link('https://example.org/guide')), ' #hiking')),
  },
  {
    id: 'mail', name: 'A mail', about: 'Everything a mail can hold. Switch it to Signal to see it step down.', chat: 'kit', routes: ['mail', 'signal', 'matrix'], chosen: ['mail'], many: false, to: 'Kit', fields: { title: 'Dinner on Friday', to: 'kit@example.org' },
    doc: doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Dinner on Friday')] },
      para('Hi Kit, ', text('good', 'bold'), text(' news', 'bold', 'italic'), ': the table is booked for ', { type: 'time', attrs: { at: friday } }, '.'),
      { type: 'bulletList', content: [item(para('Bread'), { type: 'orderedList', content: [item(para('rye')), item(para('sourdough'))] }), item(para('Cheese'))] },
      { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', 'Dish'), cell('tableHeader', 'Cost')] }, { type: 'tableRow', content: [cell('tableCell', 'Soup'), cell('tableCell', '4')] }] },
      { type: 'blockquote', content: [para('Sam wrote: can we bring the dog?')] },
    ),
  },
  { id: 'forward', name: 'A newsletter, forwarded', about: 'A block kept exactly as its own HTML, with your words above it.', chat: 'kit', routes: ['mail', 'signal', 'discord'], chosen: ['mail'], many: false, to: 'Kit', fields: { title: 'Fwd: Winter sale', to: 'kit@example.org' }, doc: doc(para('Thought of you:'), { type: 'raw', attrs: { format: 'html', source: NEWSLETTER, text: 'Northbound Outfitters\nWinter sale: 30% off boots until Sunday' } }) },
  {
    id: 'any', name: 'Any place', about: 'Every network in the model, for trying what each one carries.', chat: 'compose', routes: PLACES, chosen: ['discord'], many: true, to: '', fields: {},
    doc: doc(para('Hello ', mention(KIT), ' and ', mention(SAM), ': ', text('bold', 'bold'), ', ', text('struck', 'strike'), ', ', text('hidden', 'spoiler'), ', x', text('2', 'sup'), '.'), { type: 'fold', attrs: { title: 'The ending' }, content: [para('It was the gardener.')] }),
  },
];

interface Tool {
  what: string;
  label: string;
  title: string;
  run: (e: Editor) => void;
  on?: (e: Editor) => boolean;
  block?: boolean;
}
const mark = (what: string, label: string, title: string, run: (e: Editor) => void): Tool => ({ what, label, title, run, on: (e) => e.isActive(what) });
const TOOLS: Tool[] = [
  mark('bold', 'B', 'Bold', (e) => e.chain().focus().toggleBold().run()),
  mark('italic', 'I', 'Italic', (e) => e.chain().focus().toggleItalic().run()),
  mark('underline', 'U', 'Underline', (e) => e.chain().focus().toggleUnderline().run()),
  mark('strike', 'S', 'Strikethrough', (e) => e.chain().focus().toggleStrike().run()),
  mark('code', '<>', 'Code', (e) => e.chain().focus().toggleCode().run()),
  mark('spoiler', 'Spoiler', 'Hidden until the reader taps it', (e) => e.chain().focus().toggleMark('spoiler').run()),
  // What it does is the box's to say (see `linkTool`): it asks for the address in the box.
  mark('link', 'Link', 'A link with words of its own', () => {}),
  mark('color', 'Colour', 'Coloured text', (e) => e.chain().focus().toggleMark('color', { color: '#c2410c' }).run()),
  mark('sup', 'x²', 'Superscript', (e) => e.chain().focus().toggleMark('sup').run()),
  { what: 'heading', label: 'Heading', title: 'Heading', block: true, run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), on: (e) => e.isActive('heading') },
  { what: 'blockquote', label: 'Quote', title: 'Quote', block: true, run: (e) => e.chain().focus().toggleBlockquote().run(), on: (e) => e.isActive('blockquote') },
  { what: 'bulletList', label: 'List', title: 'Bulleted list', block: true, run: (e) => e.chain().focus().toggleBulletList().run(), on: (e) => e.isActive('bulletList') },
  { what: 'orderedList', label: '1. List', title: 'Numbered list', block: true, run: (e) => e.chain().focus().toggleOrderedList().run(), on: (e) => e.isActive('orderedList') },
  { what: 'codeBlock', label: 'Code block', title: 'Code block', block: true, run: (e) => e.chain().focus().toggleCodeBlock().run(), on: (e) => e.isActive('codeBlock') },
  { what: 'table', label: 'Table', title: 'Table', block: true, run: (e) => e.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() },
  { what: 'horizontalRule', label: 'Rule', title: 'A line across', block: true, run: (e) => e.chain().focus().setHorizontalRule().run() },
  { what: 'fold', label: 'Fold', title: 'A block the reader opens', block: true, run: (e) => e.chain().focus().toggleWrap('fold').run(), on: (e) => e.isActive('fold') },
  { what: 'image', label: 'Picture', title: 'A picture in the text', block: true, run: (e) => e.chain().focus().insertContent({ type: 'image', attrs: { src: PICTURE, alt: 'The view from the hut' } }).run() },
  { what: 'time', label: 'Time', title: 'A time each reader sees in their own time zone', block: true, run: (e) => e.chain().focus().insertContent([{ type: 'time', attrs: { at: friday } }, { type: 'text', text: ' ' }]).run() },
];

const WIRE: Record<string, string> = { markers: 'marker characters in the text', ranges: 'plain text with ranges beside it', html: 'HTML with a plain copy', blocks: 'its own tree of blocks' };
/** How the box behaves comes from what is written at the places chosen, never from the page it is on. */
type Role = Profile['role'];
const roleOf = (keys: string[]): Role => {
  const roles = new Set(keys.map((k) => PROFILES[k].role));
  return roles.size === 1 ? PROFILES[keys[0]].role : roles.has('mail') ? 'mail' : roles.size ? 'post' : 'chat';
};
const HINT: Record<Role, string> = { chat: 'Message', post: 'What’s happening?', comment: 'Write a comment', mail: 'Write your mail' };
const WORD: Record<Role, string> = { chat: 'Send', post: 'Post', comment: 'Comment', mail: 'Send' };
const CHOICE: Record<keyof Options, string> = { lead: 'Title as the first line', warn: 'Warning first', thread: 'A thread' };
/** The ways a draft can be written: with the buttons, or typed. */
const WAYS: [Way, string, string][] = [
  ['rich', 'Rich', 'Rich text: a style is put on the words, with the buttons or by typing its markers'],
  ['markdown', 'Markdown', 'Markdown: the markers stay where you type them, drawn as they will read'],
  ['html', 'HTML', 'HTML: typed as it is sent, with a look at it beneath'],
];
const TAG: Record<string, string> = { rich: 'Rich', markdown: 'Markdown', html: 'HTML', kept: 'Kept as HTML' };
const SHORT: Record<string, string> = { rich: 'Rich', markdown: 'MD', html: 'HTML', kept: 'Kept' };
/** Markdown where some place carries a style at all; HTML where some place takes HTML as it is typed (a mail, Matrix). */
const waysFor = (keys: string[]): Way[] => ['rich', ...(TOOLS.some((t) => keys.some((k) => carries(PROFILES[k], t.what))) ? (['markdown'] as Way[]) : []), ...(keys.some((k) => PROFILES[k].rules?.raw?.includes('html')) ? (['html'] as Way[]) : [])];
/**
 * The way a kind of writing was last written, on this device: a chat as Markdown stays so for the next message. HTML
 * is chosen for one mail, never for the next.
 */
const liked = (role: Role): Way => {
  try {
    const v = localStorage.getItem('writing.way.' + role);
    return v === 'markdown' || v === 'html' ? v : 'rich';
  } catch {
    return 'rich';
  }
};
const like = (role: Role, way: Way) => {
  try {
    localStorage.setItem('writing.way.' + role, way);
  } catch {
    // Not kept, then: it is a convenience.
  }
};
const fresh = (keys: string[]) => blank(waysFor(keys).includes(liked(roleOf(keys))) ? liked(roleOf(keys)) : 'rich');
const first = (s: Scene) => (s.doc.content?.length === 1 && !s.doc.content[0].content?.length ? fresh(s.chosen) : s.doc);
const start = (s: Scene) => newDraft(s.chat, s.chosen, first(s), s.fields);
/** An address as it was meant: "example.org" is a web page, "kit@example.org" a mail address. */
const address = (v: string) => {
  const s = v.trim();
  return !s || /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : /^[^\s/@]+@[^\s/@]+$/.test(s) ? `mailto:${s}` : `https://${s}`;
};
const how = (pr: Profile) => (pr.id === 'mail' ? 'by mail' : pr.id === 'sms' ? 'by text' : `on ${pr.name}`);
const at = (pr: Profile) => (pr.id === 'mail' ? 'in a mail' : pr.id === 'sms' ? 'in a text' : `on ${pr.name}`);
const names = (ids: string[]) => ids.map((id) => PROFILES[id].name).join(', ').replace(/, ([^,]*)$/, ' and $1');
const quoted = (c: Change) => (c.words?.length && c.key !== 'warning' ? ': ' + c.words.slice(0, 3).map((w) => `“${w.length > 48 ? w.slice(0, 46) + '…' : w}”`).join(', ') + (c.words.length > 3 ? ` and ${c.words.length - 3} more` : '') : '');
const bad = (c: Change) => c.level === 'blocked' || c.level === 'exposed';

function App() {
  const holder = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, tick] = useState(0);
  const [scene, setScene] = useState(SCENES[0]);
  /** The draft: its words, its places, and what is one place's alone (protocol/src/writing/draft.ts). */
  const [draft, setDraft] = useState<Draft>(() => start(SCENES[0]));
  /** Whose words the box shows: 'all', or a place that is written separately. */
  const [tab, setTab] = useState('all');
  const [fmt, setFmt] = useState(false);
  const [tall, setTall] = useState(false);
  const [shown, setShown] = useState(false);
  const [view, setView] = useState<'reads' | 'wire' | 'draft'>('reads');
  const [menu, setMenu] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  /** A link is being added where nothing is selected: its address is asked for, and goes in as its own words. */
  const [newLink, setNewLink] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const tabRef = useRef(tab);
  const roleRef = useRef<Role>('chat');
  const toRef = useRef(scene.to);

  const out = useMemo(() => outcome(draft, (key) => PROFILES[key]), [draft]);
  const { sent, due: chosen, stopped, exposing, differing, empty } = out;
  const profiles = chosen.map((id) => PROFILES[id]);
  const gone = draft.places.filter((p) => p.sent !== undefined).map((p) => p.key);
  const own = (id: string) => draft.places.find((p) => p.key === id);
  const fields = draft.fields;
  const role = roleOf(chosen);
  roleRef.current = role;
  toRef.current = scene.to;
  const has = (f: 'title' | 'warning' | 'place') => profiles.find((pr) => pr.fields?.[f]);
  /** The box shows these words, quietly: nothing is sent to the editor's listeners. */
  const put = (next: string, body: DocNode) => {
    tabRef.current = next;
    setTab(next);
    setNewLink(false);
    if (!editor) return;
    editor.commands.setContent(body, { emitUpdate: false });
    // Undo belongs to one draft: what was typed in another, or sent, must not come back into this one.
    editor.view.updateState(EditorState.create({ schema: editor.schema, doc: editor.state.doc, plugins: editor.state.plugins }));
  };

  const deliver = (ids: string[], agreed = false) => {
    if (!ids.length || empty) return;
    const several = ids.filter((id) => sent[id].parts);
    const where = ids.length === 1 && scene.to ? `${scene.to} ${how(PROFILES[ids[0]])}` : names(ids);
    setLog((l) => [`${roleOf(ids) === 'post' ? 'Posted to' : 'Sent to'} ${where}${several.length ? ', as ' + several.map((id) => `${sent[id].parts!.length} ${PROFILES[id].role === 'post' ? 'posts' : 'messages'} on ${PROFILES[id].name}`).join(' and ') : ''}`, ...l].slice(0, 3));
    setAsk(false);
    // What the writer was asked about and chose to send is kept with the place: it is not asked again.
    const told = (id: string) => sent[id].changes.filter((c) => c.level === 'exposed').flatMap((c) => c.words ?? []);
    const next = went(agreed ? exposing.reduce((d, id) => agree(d, id, told(id)), draft) : draft, ids, Date.now());
    if (!done(next)) {
      // It went to some: the draft stays for the rest.
      setDraft(next);
      if (ids.includes(tab)) put('all', draft.doc);
      return;
    }
    // A new draft for the same places. What was beside the text went with it; whom it is for stays.
    const kept = Object.fromEntries(Object.entries(draft.fields).map(([k, v]) => [k, k === 'to' || k === 'place' ? v : '']));
    const keys = draft.places.map((p) => p.key);
    setDraft(newDraft(scene.chat, keys, fresh(keys), kept));
    put('all', fresh(keys));
  };
  const onSend = () => out.ready && (exposing.length ? setAsk(true) : deliver(chosen));

  // What the editor asks while typing. Set on every draw, read when a key is pressed.
  const inBox = (id: string) => (tab === 'all' ? !own(id)?.doc : tab === id);
  const exposedAt = names(chosen.filter((id) => inBox(id) && sent[id].changes.some((c) => c.key === 'hidden' && c.level === 'exposed')));
  live.people = PEOPLE;
  live.carries = (what) => profiles.some((pr) => carries(pr, what));
  live.exposes = () => exposedAt;
  live.quiet = (attrs) => names(profiles.filter((pr) => !(pr.entities.includes('mention') && (attrs.kind === 'everyone' ? pr.rules?.mentionKinds?.includes('everyone') : attrs.ids?.[pr.space ?? pr.id]))).map((pr) => pr.id));
  // Enter sends a message to one chat, while the box is not opened up. Anywhere else it is a new line.
  live.enterSends = () => role === 'chat' && chosen.length === 1 && !tall;
  live.send = onSend;
  // Under an HTML part: what the place gets, at the first place chosen that takes HTML (or the first chosen).
  live.look = (blocks) => {
    const pr = profiles.find((x) => x.rules?.raw?.includes('html')) ?? profiles[0];
    if (!pr) return { html: '', where: '', notes: [] };
    const s = send(doc(...blocks), pr);
    const w = s.wire as Record<string, unknown>;
    const html = typeof w?.['text/html'] === 'string' ? w['text/html'] : typeof w?.formatted_body === 'string' ? w.formatted_body : preview(s.reads);
    return { html: html as string, where: at(pr), notes: s.changes.map((c) => c.say) };
  };
  live.hint = () => HINT[role] + (role === 'chat' && scene.to ? ' ' + scene.to : '');

  useEffect(() => {
    const hint = () => HINT[roleRef.current] + (roleRef.current === 'chat' && toRef.current ? ' ' + toRef.current : '');
    const e = new Editor({ element: holder.current!, extensions: [...extensions(), Placeholder.configure({ placeholder: hint })], content: first(scene), enableInputRules: ['typing'], enablePasteRules: false });
    e.on('update', () => setDraft((d) => write(d, e.getJSON() as DocNode, tabRef.current === 'all' ? undefined : tabRef.current)));
    e.on('transaction', () => tick((n) => n + 1));
    setEditor(e);
    (window as any).editor = e;
    return () => e.destroy();
  }, []);
  // The marks in the text depend on where it goes: draw them again when that changes.
  useEffect(() => (editor?.view.dispatch(editor.state.tr.setMeta('places', 1)), redrawLooks()), [chosen.join(), exposedAt, tab, role, editor]);
  useEffect(() => {
    const close = (ev: MouseEvent) => !(ev.target as HTMLElement).closest('.has-menu') && setMenu(null);
    // Escape goes back: out of a menu, out of the question before sending, out of adding a link.
    const back = (ev: KeyboardEvent) => ev.key === 'Escape' && (setMenu(null), setAsk(false), setNewLink(false));
    document.addEventListener('click', close);
    document.addEventListener('keydown', back);
    return () => (document.removeEventListener('click', close), document.removeEventListener('keydown', back));
  }, []);

  const open = (s: Scene) => {
    setScene(s);
    setDraft(start(s));
    setFmt(roleOf(s.chosen) === 'mail');
    setTall(roleOf(s.chosen) === 'mail');
    setAsk(false);
    setMenu(null);
    setLog([]);
    setNote('');
    put('all', first(s));
  };
  const show = (next: string) => put(next, own(next)?.doc ?? draft.doc);
  const setApart = (id: string) => {
    setDraft((d) => apart(d, id));
    put(id, own(id)?.doc ?? draft.doc);
    setAsk(false);
  };
  const setTogether = (id: string) => {
    setDraft((d) => together(d, id));
    if (tab === id) put('all', draft.doc);
  };
  const leaveOut = (id: string) => {
    setDraft((d) => leave(d, id));
    if (tab === id) put('all', draft.doc);
    setAsk(false);
  };
  /** Another place as well (a post), or another way to the same person: the draft moves there as it is. */
  const pick = (id: string) => {
    setDraft((d) => (scene.many ? add(d, id) : move(d, d.chat, [id])));
    setMenu(null);
    // A mail is written opened up: its Cc and its tools are there.
    if (!scene.many && PROFILES[id].role === 'mail') (setTall(true), setFmt(true));
  };
  const linkTool = () => {
    if (!editor) return;
    if (editor.isActive('link')) return void editor.chain().focus().extendMarkRange('link').unsetLink().run();
    if (editor.state.selection.empty) setNewLink(true);
    else editor.chain().setLink({ href: '' }).run();
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[data-attr=href]')?.focus());
  };
  const addLink = (v: string) => {
    const href = address(v);
    setNewLink(false);
    if (href) editor?.chain().focus().insertContent([{ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }, { type: 'text', text: ' ' }]).run();
  };
  const opt = (id: string, o: Options) => setDraft((d) => choose(d, id, o));
  // Someone added to a mail makes it a group's: the draft moves to that chat, with everything in it.
  const setField = (k: keyof Fields, v: string) => setDraft((d) => ({ ...(k === 'cc' ? move(d, v.trim() ? `${scene.chat}+group` : scene.chat, d.places.map((p) => p.key)) : d), fields: { ...d.fields, [k]: v } }));
  const field = (k: keyof Fields, label: string, hint: string, lead = '') => (
    <label class="field">
      {/* With several places chosen, a field says whose it is. */}
      <span>{label}{chosen.length > 1 && <small> {names(profiles.filter((pr) => (k === 'cc' ? pr.fields?.people : pr.fields?.[k as 'title'])).map((pr) => pr.id))}</small>}</span>
      {lead && <em>{lead}</em>}
      <input data-field={k} value={fields[k] ?? ''} placeholder={hint} onInput={(e) => setField(k, (e.target as HTMLInputElement).value)} />
    </label>
  );
  /** One line for each problem, with the places it is about. */
  const grouped = (ids: string[], want: (c: Change) => boolean) => {
    const out = new Map<string, { c: Change; ids: string[] }>();
    for (const id of ids)
      for (const c of sent[id].changes.filter(want)) {
        const k = c.key === 'limit' ? c.key + c.level : [c.key, c.say, ...(c.words ?? [])].join('|');
        out.set(k, { c: out.get(k)?.c ?? c, ids: [...(out.get(k)?.ids ?? []), id] });
      }
    return [...out.values()];
  };
  const tell = (c: Change, ids: string[]) => {
    const where = chosen.length === 1 ? at(PROFILES[ids[0]]) : `on ${names(ids)}`;
    if (c.key === 'limit' && ids.length > 1) return `Too long for ${names(ids)}`;
    return (c.say.includes(' there') ? c.say.replace(' there', ' ' + where) : chosen.length === 1 ? c.say : `${names(ids)}: ${c.say}`) + quoted(c);
  };
  /** What can be done about a problem, at the places it is about. What is about one place alone is in that place's menu too. */
  const fixes = (c: Change, ids: string[]) => {
    const out: [string, () => void][] = [];
    const one = ids.length === 1 ? PROFILES[ids[0]] : null;
    const threads = ids.filter((id) => sent[id].thread && !sent[id].parts);
    if (c.key === 'limit' && threads.length) out.push([threads.length > 1 ? 'Make them threads' : `Make it a thread of ${sent[threads[0]].thread}${one ? '' : ` on ${PROFILES[threads[0]].name}`}`, () => threads.forEach((id) => opt(id, { thread: true }))]);
    if (c.key === 'warning') out.push(['Put the warning first there', () => ids.forEach((id) => opt(id, { warn: true }))]);
    if (c.key === 'title') out.push(['Put it as the first line there', () => ids.forEach((id) => opt(id, { lead: true }))]);
    const warns = ids.filter((id) => PROFILES[id].fields?.warning);
    // Where nothing can hide it, the writer may decide it need not be hidden.
    if (c.key === 'hidden' && chosen.length === 1) out.push(['Show the words openly', () => editor && unhide(editor)]);
    if (c.key === 'hidden' && warns.length) out.push([`Give it a content warning${one ? '' : ` on ${names(warns)}`}`, () => document.querySelector<HTMLInputElement>('input[data-field=warning]')?.focus()]);
    if (one && chosen.length > 1 && bad(c)) {
      if (/^(hidden|limit|warning|lost)$/.test(c.key) && !own(one.id)?.doc) out.push([`Write ${one.name} separately`, () => setApart(one.id)]);
      out.push([`Leave ${one.name} out`, () => leaveOut(one.id)]);
    }
    if (!one && ids.length < chosen.length && bad(c)) out.push(['Leave them out', () => ids.forEach(leaveOut)]);
    return out;
  };
  /** A count beside a place: always for a short post, elsewhere only when the limit is near. */
  const size = (id: string) => {
    const s = sent[id].size;
    if (!s || s.max === null) return null;
    if (sent[id].parts) return <small class="count">{sent[id].parts!.length} {PROFILES[id].role === 'post' ? 'posts' : 'messages'}</small>;
    if (s.n <= s.max * 0.8 && !(PROFILES[id].role === 'post' && s.max <= 1000)) return null;
    return <small class={s.over ? 'count over' : 'count'}>{s.n}/{s.max}</small>;
  };
  // How the draft is written, and the part the caret is in.
  const blocks = (editor?.getJSON().content ?? []) as DocNode[];
  const wayAll = wayOfAll(blocks);
  const part = editor ? partAt(editor.state) : null;
  const act = editor ? activeIn(editor.state) : null;
  const ways = [...new Set([...waysFor(chosen), ...blocks.filter((b) => b.type === 'source').map((b) => wayOf(b) as Way)])];
  const isOn = (t: Tool) => (act ? act.has(t.what) : !!(editor && t.on?.(editor)));
  // A tool is there when a place carries what it makes, or when the caret is on such a thing: it can always be undone.
  // In a part typed as Markdown or HTML it puts the markers in, where that way of writing has some.
  const tools = TOOLS.filter((t) => (!part || offers(part.lang, t.what)) && (live.carries(t.what) || isOn(t)));
  const ats = live.carries('mention') && part?.lang !== 'html';
  const use = (t: Tool) => {
    if (!editor) return;
    if (part && (t.block ? block(editor, t.what) : style(editor, t.what))) return;
    if (t.what === 'link') linkTool();
    else t.run(editor);
  };
  /** The whole draft, or the part the caret is in, written another way. What is sent stays what it was. */
  const change = (to: Way, scope: 'all' | 'here') => {
    if (!editor) return;
    setMenu(null);
    setNote('');
    const el = holder.current!;
    const go = () => {
      el.classList.remove('lens-out');
      if (!setWay(editor, to, scope)) return setNote('This part holds something the editor here cannot show that way. It is left as it was.');
      if (scope === 'all') (el.classList.add('lens-in'), setTimeout(() => el.classList.remove('lens-in'), 300));
    };
    // The whole draft written a way is how the next one of its kind starts.
    if (scope === 'all') (to !== 'html' && like(role, to), to === 'rich' && setFmt(true));
    // The markers shrink away before the words are shown without them, and grow in after.
    if (scope !== 'all' || !blocks.some((b) => b.type === 'source') || matchMedia('(prefers-reduced-motion: reduce)').matches) return go();
    el.classList.add('lens-out');
    setTimeout(go, 160);
  };
  /** The blocks the caret is in, for the tag beside them: only where the box is opened up, for long writing. */
  const here = (() => {
    if (!editor || !tall || ways.length < 2 || !blocks.length) return null;
    const [a, b] = touched(editor.state);
    let pos = 0;
    for (let i = 0; i < a; i++) pos += editor.state.doc.child(i).nodeSize;
    const dom = editor.view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return null;
    const kinds = new Set(blocks.slice(a, b).map(wayOf));
    return { top: dom.offsetTop, way: kinds.size === 1 ? [...kinds][0] : null, n: b - a };
  })();
  const problems = grouped(chosen, bad);
  /** The choices made for a place that are at work now, each with its way back. */
  const choices = draft.places.flatMap((p) => {
    const pr = PROFILES[p.key];
    const at = { thread: !!sent[p.key]?.parts, lead: !!fields.title?.trim() && !pr.fields?.title, warn: !!fields.warning?.trim() && !pr.fields?.warning };
    return (Object.keys(CHOICE) as (keyof Options)[]).filter((k) => p.options?.[k] && at[k] && p.sent === undefined).map((k) => ({ id: p.key, k }));
  });
  const compact = role === 'chat' && chosen.length === 1 && !tall;
  const inLink = !!editor?.isActive('link');
  const inFold = !!editor?.isActive('fold');
  const reads = (s: Sent) => <div class="reads" dangerouslySetInnerHTML={{ __html: preview(s.reads) }} />;

  const partTag = (where: 'beside' | 'row') =>
    here && (
                <span class={`parttag ${where} has-menu`} style={where === 'beside' ? { top: here.top + 'px' } : undefined}>
                  <button class="tag" title="How this part is written" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === 'part-' + where ? null : 'part-' + where)}>{where === 'row' ? 'This part: ' : ''}{here.way ? (where === 'row' ? SHORT[here.way] : TAG[here.way]) : 'Mixed'} ▾</button>
                  {menu === 'part-' + where && (
                    <div class="menu right">
                      <small>{here.way === 'kept' ? 'Kept exactly as it came. Make it' : here.n > 1 ? `Write these ${here.n} parts as` : 'Write this part as'}</small>
                      {here.way === 'kept' ? (
                        <>
                          <button data-way="html" onMouseDown={(e) => e.preventDefault()} onClick={() => change('html', 'here')}>HTML to edit</button>
                          <button data-way="rich" onMouseDown={(e) => e.preventDefault()} onClick={() => change('rich', 'here')}>Text, as far as it can be read</button>
                        </>
                      ) : (
                        WAYS.filter(([w]) => ways.includes(w)).map(([w, label]) => (
                          <button data-way={w} onMouseDown={(e) => e.preventDefault()} onClick={() => change(w, 'here')}>{w === 'rich' ? 'Rich text' : label}<small>{here.way === w ? ' ✓' : ''}</small></button>
                        ))
                      )}
                    </div>
                  )}
                </span>
                  );

  return (
    <div class="page">
      <header>
        <h1>One box for every place</h1>
        <p>A chat message, a post and a mail are one kind of draft here. The box offers what the place you write to can carry, says nothing while what arrives is what you typed, and marks the words when it is not.</p>
        <div class="row">
          {SCENES.map((s) => (
            <button class={s.id === scene.id ? 'chip on' : 'chip'} onClick={() => open(s)}>{s.name}</button>
          ))}
        </div>
        <p class="about">{scene.about}</p>
      </header>
      <main class={shown ? 'two' : ''}>
        <section class={`box${tall ? ' tall' : ''}${compact ? '' : ' stack'}`}>
          {log.length > 0 && <div class="log">{log.map((l, i) => <div class={i ? 'old' : ''}>✓ {l}</div>)}</div>}
          {/* Where it goes. A chat with one way to reach someone shows nothing here. */}
          {(scene.routes.length > 1 || role !== 'chat') && (
            <div class="to">
              {scene.many ? (
                <>
                  <span class="lbl">{role === 'post' ? 'Post to' : 'Write to'}</span>
                  {scene.routes.map((id) =>
                    gone.includes(id) ? (
                      <span class="place done" title="It has gone there">{PROFILES[id].name} ✓</span>
                    ) : !chosen.includes(id) ? (
                      <button class="place" onClick={() => pick(id)} title="Add it">{PROFILES[id].name}</button>
                    ) : (
                      <span class="has-menu">
                        <button class={stopped.includes(id) ? 'place on stop' : 'place on'} title={stopped.includes(id) ? sent[id].changes[0].say : ''} onClick={() => setMenu(menu === id ? null : id)}>
                          {PROFILES[id].name} {size(id)}
                        </button>
                        {menu === id && (
                          <div class="menu">
                            {sent[id].thread && !sent[id].parts && <button onClick={() => (opt(id, { thread: true }), setMenu(null))}>Make it a thread of {sent[id].thread}</button>}
                            {own(id)?.options?.thread && sent[id].parts && <button onClick={() => (opt(id, { thread: false }), setMenu(null))}>One post, not a thread</button>}
                            {!own(id)?.doc ? chosen.length > 1 && <button onClick={() => (setApart(id), setMenu(null))}>Write {PROFILES[id].name} separately</button> : <button onClick={() => (setTogether(id), setMenu(null))}>The same words as the others</button>}
                            <button onClick={() => (setShown(true), setMenu(null))}>See how it arrives</button>
                            {chosen.length > 1 && <button onClick={() => (leaveOut(id), setMenu(null))}>Leave {PROFILES[id].name} out</button>}
                            {chosen.length === 1 && <button disabled>The only place it goes</button>}
                          </div>
                        )}
                      </span>
                    ),
                  )}
                </>
              ) : (
                <span class="has-menu">
                  <span class="lbl">To {scene.to} </span>
                  <button class="route" onClick={() => setMenu(menu === 'route' ? null : 'route')}>{how(profiles[0])} ▾</button>
                  {menu === 'route' && (
                    <div class="menu">
                      {scene.routes.map((id) => (
                        <button onClick={() => pick(id)}>{PROFILES[id].name}<small>{id === chosen[0] ? ' ✓' : ''}</small></button>
                      ))}
                      <hr />
                      <button onClick={() => (setShown(true), setMenu(null))}>See how it arrives</button>
                    </div>
                  )}
                  {size(chosen[0])}
                </span>
              )}
            </div>
          )}
          {/* What a place has beside the text shows only while the draft goes to such a place. */}
          {profiles.some((pr) => pr.fields?.people) && tall && field('cc', 'Cc', 'Add someone')}
          {fields.cc?.trim() && profiles.some((pr) => pr.fields?.people) && <div class="notice">With {fields.cc.trim()} added this is a group conversation. It will be sent in the group’s chat, and this draft goes there with you.</div>}
          {has('place') && field('place', has('place')!.fields!.place!.word, 'cooking', has('place')!.fields!.place!.prefix)}
          {has('title') && field('title', has('title')!.fields!.title!.word, has('title')!.fields!.title!.required ? 'Needed' : 'Optional')}
          {has('warning') && field('warning', 'Content warning', 'Optional: readers open the post to see it')}
          {chosen.some((id) => own(id)?.doc) && (
            <div class="tabs">
              <button class={tab === 'all' ? 'on' : ''} onClick={() => show('all')}>{names(chosen.filter((id) => !own(id)?.doc)) || 'The others'}</button>
              {chosen.filter((id) => own(id)?.doc).map((id) => (
                <span class={tab === id ? 'on' : ''}>
                  <button onClick={() => show(id)}>{PROFILES[id].name} only</button>
                  <button class="x" title="Use the same words as the others again" onClick={() => setTogether(id)}>✕</button>
                </span>
              ))}
            </div>
          )}
          {fmt && editor && (tools.length > 0 || ats || ways.length > 1) && (
            <div class="tools">
              {ways.length > 1 && (
                <>
                  <span class="ways" role="group" aria-label="How the message is written">
                    {WAYS.filter(([w]) => ways.includes(w)).map(([w, label, title]) => (
                      <button class={wayAll === w ? 'way on' : 'way'} data-way={w} title={title} onMouseDown={(e) => e.preventDefault()} onClick={() => change(w, 'all')}>{label}</button>
                    ))}
                  </span>
                  {here && partTag('row')}
                  {tools.length > 0 && <i class="sep" />}
                </>
              )}
              {tools.map((t, i) => (
                <>
                  {t.block && !tools[i - 1]?.block && i > 0 && <i class="sep" />}
                  <button class={isOn(t) ? 'tool on' : 'tool'} title={t.title} onMouseDown={(e) => e.preventDefault()} onClick={() => use(t)}>{t.label}</button>
                </>
              ))}
              {ats && (
                <span class="has-menu">
                  <button class="tool" title="Mention someone" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === 'at' ? null : 'at')}>@</button>
                  {menu === 'at' && (
                    <div class="menu">
                      {PEOPLE.map((p) => (
                        <button onClick={() => (editor.chain().focus().insertContent([mention(p), { type: 'text', text: ' ' }]).run(), setMenu(null))}>@{p.label}</button>
                      ))}
                    </div>
                  )}
                </span>
              )}
            </div>
          )}
          {/* What the thing under the caret holds beside its words. */}
          {editor && (inLink || inFold || newLink) && (
            <div class="attr">
              {inLink && (
                <label>
                  <span>Link to</span>
                  <input data-attr="href" value={editor.getAttributes('link').href ?? ''} placeholder="https://" onInput={(e) => editor.chain().extendMarkRange('link').updateAttributes('link', { href: (e.target as HTMLInputElement).value.trim() }).run()} onChange={(e) => editor.chain().extendMarkRange('link').updateAttributes('link', { href: address((e.target as HTMLInputElement).value) }).run()} onKeyDown={(e) => e.key === 'Enter' && ((e.target as HTMLInputElement).blur(), editor.commands.focus())} />
                </label>
              )}
              {newLink && !inLink && (
                <label>
                  <span>Link to</span>
                  <input data-attr="href" placeholder="An address, then Enter" onKeyDown={(e) => e.key === 'Enter' && addLink((e.target as HTMLInputElement).value)} />
                </label>
              )}
              {inFold && (
                <label>
                  <span>Fold says</span>
                  <input data-attr="title" value={editor.getAttributes('fold').title ?? ''} placeholder="Spoiler" onInput={(e) => editor.commands.updateAttributes('fold', { title: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.key === 'Enter' && editor.commands.focus()} />
                </label>
              )}
            </div>
          )}
          <div class="write">
            <div class="docwrap">
              <div class="doc" ref={holder} />
              {/* How the part the caret is in is written, and the way to write that part another way. */}
              {partTag('beside')}
            </div>
            <div class="side">
              {(tools.length > 0 || ats || ways.length > 1) && <button class={fmt ? 'ico on' : 'ico'} title={`Formatting${wayAll && wayAll !== 'rich' ? ` · written as ${TAG[wayAll]}` : ''}`} onClick={() => setFmt(!fmt)}>{wayAll === 'markdown' ? 'M↓' : wayAll === 'html' ? '</>' : 'Aa'}</button>}
              <button class={tall ? 'ico on' : 'ico'} title={tall ? 'Make it small again' : 'Open it up'} onClick={() => setTall(!tall)}>{tall ? '⤡' : '⤢'}</button>
              {/* A draft goes whole: while one place cannot take it, it waits. */}
              <button class="send" disabled={!out.ready} title={stopped.length ? `${names(stopped)}: ${sent[stopped[0]].changes[0].say.toLowerCase()}` : ''} onClick={onSend}>{WORD[role]}{chosen.length > 1 ? ` to ${chosen.length}` : ''}</button>
            </div>
          </div>
          {note && <div class="notice">{note}</div>}
          {/* Nothing below the box while what arrives is what was typed. */}
          {ask && (
            <div class="ask">
              {grouped(exposing, (c) => c.level === 'exposed').map(({ c, ids }) => <p>{tell(c, ids)}.</p>)}
              <div class="row">
                <button class="chip warn" onClick={() => deliver(chosen, true)}>{WORD[role]} anyway</button>
                {chosen.length > exposing.length && <button class="chip" onClick={() => deliver(chosen.filter((id) => !exposing.includes(id)))}>{WORD[role]} to the others only</button>}
                <button class="chip" onClick={() => setAsk(false)}>Go back</button>
              </div>
            </div>
          )}
          {!ask && !empty && problems.length > 0 && (
            <ul class="problems">
              {problems.map(({ c, ids }) => (
                <li>
                  {tell(c, ids)}
                  {fixes(c, ids).filter(([label]) => !label.startsWith('Leave ') || problems.find((x) => x.ids.join() === ids.join())?.c === c).map(([label, run]) => <button class="fix" onClick={run}>{label}</button>)}
                </li>
              ))}
            </ul>
          )}
          {choices.length > 0 && (
            <div class="choices">
              {choices.map(({ id, k }) => (
                <button class="choice" title="Undo this" onClick={() => opt(id, { [k]: false })}>{CHOICE[k]}{chosen.length > 1 || k !== 'thread' ? ` ${at(PROFILES[id])}` : ''} ✕</button>
              ))}
            </div>
          )}
          {!empty && differing.length > 0 && (
            <button class="differs" onClick={() => setShown(!shown)}>
              Looks different {chosen.length > 3 ? `in ${differing.length} places` : chosen.length > 1 ? `on ${names(differing)}` : at(profiles[0])} · {shown ? 'Close' : 'See how'}
            </button>
          )}
        </section>
        {shown && (
          <section class="arrives">
            <div class="row">
              <h2>How it arrives</h2>
              <button class={view === 'reads' ? 'chip on' : 'chip'} onClick={() => setView('reads')}>As read there</button>
              <button class={view === 'wire' ? 'chip on' : 'chip'} onClick={() => setView('wire')}>What is sent</button>
              <button class={view === 'draft' ? 'chip on' : 'chip'} onClick={() => setView('draft')}>What is kept</button>
              <button class="x" onClick={() => setShown(false)}>Close</button>
            </div>
            {view === 'draft' && (
              <article class="card">
                <h3>The draft<small>one tree, its places, and what is one place’s alone</small></h3>
                <pre class="wire">{JSON.stringify(draft, null, 1)}</pre>
              </article>
            )}
            {view !== 'draft' && chosen.map((id) => {
              const s = sent[id];
              const pr = PROFILES[id];
              return (
                <article class={stopped.includes(id) ? 'card stop' : 'card'}>
                  <h3>{pr.name}<small>{WIRE[pr.wire.family]}</small>{s.size && <span class={s.size.over && !s.parts ? 'count over' : 'count'}>{s.parts ? `${s.parts.length} ${pr.role === 'post' ? 'posts' : 'messages'}` : s.size.max === null || s.size.n < s.size.max * 0.5 ? `${s.size.n} ${s.size.unit}` : `${s.size.n} of ${s.size.max} ${s.size.unit}`}</span>}</h3>
                  {s.changes.length > 0 && (
                    <ul class="changes">
                      {s.changes.map((c) => (
                        <li class={bad(c) ? 'bad' : ''}>
                          {c.say}{c.n > 1 && !c.words ? ` (${c.n})` : ''}{quoted(c)}
                          {!bad(c) && fixes(c, [id]).map(([label, run]) => <button class="fix" onClick={run}>{label}</button>)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {view === 'reads' ? (
                    <>
                      {pr.fields?.title && fields.title && <div class="subject">{fields.title}</div>}
                      {s.parts ? (
                        s.parts.map((p, i) => (
                          <div class="part">
                            <small>{i + 1} of {s.parts!.length}</small>
                            <div class="reads" dangerouslySetInnerHTML={{ __html: preview(p.tree) }} />
                          </div>
                        ))
                      ) : pr.fields?.warning && fields.warning ? (
                        <details class="cw"><summary>{fields.warning}</summary>{reads(s)}</details>
                      ) : (
                        reads(s)
                      )}
                      {s.files.length > 0 && <div class="files">{s.files.map((f) => <span>📎 {String(f.attrs?.alt || 'picture')}</span>)}</div>}
                    </>
                  ) : (
                    <pre class="wire">{(s.parts ?? [s]).map((p, i) => (s.parts ? `— ${i + 1} of ${s.parts.length} —\n` : '') + p.show + (p.beside ? `\n\n— beside the text —\n${p.beside}` : '')).join('\n\n')}</pre>
                  )}
                </article>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
