/**
 * The suggested layout (folderplan.ts), backtested: a made-up sidebar like the demo's servers scenario, a layout a
 * person made of it by hand, and how close the rules come from nothing. The bars are the backtest's findings on the
 * a real sidebar (docs/organize.md): network folders and shared words are near-certain, topic only suggests.
 */
import { describe, expect, test } from 'bun:test';
import { applyPlan, hasWord, leaveOneOut, nameWords, placement, planFolders, scoreLayout, type PlanInput, type PlanSpace } from '../src/folderplan.ts';
import type { FolderView } from '../src/index.ts';

const MAIN = 'acc_main';
const ALT = 'acc_alt';
const MX = 'acc_mx';
type S = [id: string, name: string, acc: string, channels: string];
const SERVERS: S[] = [
  ['rust', 'Rust Programming Language', MAIN, 'help beginners async embedded'],
  ['dither', 'libdither', MAIN, 'general development voice'],
  ['bevy', 'Bevy Engine', MAIN, 'help ecs rendering showcase'],
  ['tokio', 'Tokio Runtime', MAIN, 'tokio-users async tracing'],
  ['zig', 'Zig Programming', MAIN, 'help compiler build-system'],
  ['lean', 'Lean Prover', MAIN, 'mathlib tactics new-members'],
  ['helix', 'Helix Editor', MAIN, 'help plugins lsp'],
  ['compilers', 'Compiler Hangout', MAIN, 'parsing type-systems llvm codegen'],
  ['nixpkgs', 'Nixpkgs Contributors', MAIN, 'flakes packaging nixos-modules'],
  ['kestrel', 'Kestrel Talks', MAIN, 'videos patreon memes'],
  ['tinker', 'Tinker Lab Fans', MAIN, 'builds videos off-topic'],
  ['pixelws', 'Pixel Workshop', MAIN, 'streams art-share palettes'],
  ['synth', 'Synth Diaries', MAIN, 'patches modular videos'],
  ['wb-robotics', 'Westbrook Robotics', MAIN, 'build-season cad general'],
  ['wb-math', 'Westbrook Math Club', MAIN, 'problems contests'],
  ['wb-games', 'Westbrook Game Night', MAIN, 'lfg general'],
  ['wb-seniors', 'Westbrook Seniors 2022', MAIN, 'announcements general'],
  ['counting', 'Count to a Million', MAIN, 'counting'],
  ['realm', 'Minecraft Realm 2019', MAIN, 'builds general'],
  ['raided', 'The Old Guild', MAIN, 'general'],
  ['harbor', 'Harbor Neighbours', MAIN, 'events free-stuff lost-and-found'],
  ['cityclimb', 'City Climbing Meetup', MAIN, 'plans gear beta'],
  ['lk-cs', 'Lakeside CS Society', ALT, 'announcements projects internships'],
  ['lk-chess', 'Lakeside Chess Club', ALT, 'games puzzles events'],
  ['lk-anime', 'Lakeside Anime Club', ALT, 'watch-party recs'],
  ['lk-hack', 'HackLakeside 2026', ALT, 'teams help-desk announcements'],
  ['lk-dorms', 'Lakeside Dorms', ALT, 'north-hall laundry marketplace'],
  ['lk-film', 'Lakeside Film Society', ALT, 'screenings'],
  ['ash', 'Ashford College', ALT, 'announcements class-of-2027 general'],
  ['ash-climb', 'Ashford Climbing', ALT, 'sessions gear'],
  ['ash-hang', 'Ashford Hangout', ALT, 'general memes vc-chat'],
  ['ash-gazette', 'Ashford Gazette', ALT, 'pitches edits'],
  ['mossy', 'Mossy Board Games', ALT, 'game-nights rules-questions'],
  ['reading', 'Tuesday Reading Circle', ALT, 'meetups reading-group'],
  ['riverside', 'Riverside Meetups', ALT, 'events carpool'],
  ['owls', 'Night Owls Chess', ALT, 'blitz arena'],
  ['corner', 'Quiet Corner', ALT, 'general'],
  ['hk', 'Hollow Knight Speedrunning', ALT, 'community runs'],
  ['nixos', 'NixOS', MX, 'nixos help nix-dev'],
  ['rustmx', 'Rust Community', MX, 'rust help'],
];
const spaces: PlanSpace[] = SERVERS.map(([id, name, acc, ch]) => ({ id, name, network: acc === MX ? 'matrix' : 'discord', text: ch, accountIds: acc === 'acc_main' && id === 'dither' ? [MAIN, ALT] : [acc] }));
const accounts = [
  { id: MAIN, network: 'discord' as const, label: 'zyansheep' },
  { id: ALT, network: 'discord' as const, label: 'zyn.alt' },
  { id: MX, network: 'matrix' as const, label: '@zyansheep' },
];
const networkFolders = [
  { accountId: MAIN, name: 'Coding', spaces: ['rust', 'dither', 'bevy', 'tokio', 'zig', 'lean', 'helix'] },
  { accountId: MAIN, name: 'Creators', spaces: ['kestrel', 'tinker', 'pixelws'] },
  { accountId: MAIN, name: null, spaces: ['wb-robotics', 'wb-math'] },
  { accountId: ALT, name: null, spaces: ['ash-gazette', 'mossy', 'ash-climb'] },
  { accountId: ALT, name: null, spaces: ['reading', 'riverside'] },
  { accountId: ALT, name: null, spaces: ['lk-cs', 'lk-chess'] },
];
const folder = (id: string, ids: string[]): FolderView => ({ id, name: id, icon: null, color: null, items: ids.map((x) => ({ kind: 'space' as const, id: x })) });
/** How the person filed it by hand. */
const TRUTH: FolderView[] = [
  folder('Coding', ['rust', 'dither', 'bevy', 'tokio', 'zig', 'lean', 'helix', 'compilers', 'nixpkgs', 'nixos', 'rustmx']),
  folder('Creators', ['kestrel', 'tinker', 'pixelws', 'synth']),
  folder('Westbrook', ['wb-robotics', 'wb-math', 'wb-games', 'wb-seniors']),
  folder('Old', ['counting', 'realm', 'raided']),
  folder('Bay Area', ['harbor', 'cityclimb']),
  folder('Lakeside', ['lk-cs', 'lk-chess', 'lk-anime', 'lk-hack', 'lk-dorms', 'lk-film']),
  folder('Ashford', ['ash', 'ash-climb', 'ash-hang', 'ash-gazette', 'mossy']),
  folder('Reading', ['reading', 'riverside']),
  folder('Other', ['owls', 'corner', 'hk']),
];
const input: PlanInput = { accounts, spaces, folders: [], networkFolders };
const truth = placement(TRUTH);
const ids = spaces.map((s) => s.id);
let n = 0;
const newId = () => `f${n++}`;

function score(rules: { network?: boolean; personas?: boolean; words?: boolean }) {
  const plan = planFolders({ ...input, networkFolders: rules.network ? networkFolders : [] });
  const steps = plan.steps.filter((s) => (s.rule === 'word' ? rules.words : rules.network));
  const after = applyPlan([], plan, { steps: new Set(steps.map((s) => s.id)), personas: !!rules.personas }, newId, ids.map((id) => `space:${id}`));
  return { plan, after, s: scoreLayout(placement(after), truth, ids) };
}

/** FOLDERPLAN_PRINT=1 bun test test/folderplan.test.ts -t print: the backtest's numbers, and the servers put back wrong. */
test.if(!!process.env.FOLDERPLAN_PRINT)('print the numbers', () => {
  for (const [k, r] of Object.entries({ network: { network: true }, 'network+personas': { network: true, personas: true }, 'network+words+personas': { network: true, words: true, personas: true }, 'words+personas (no network folders)': { words: true, personas: true } })) {
    const { s } = score(r);
    console.log(`${k.padEnd(40)} placed right ${s.placedRight.toFixed(2)}  pairs P ${s.pairPrecision.toFixed(2)} R ${s.pairRecall.toFixed(2)}  loose ${s.loose.toFixed(2)}`);
  }
  console.log('leave one out', leaveOneOut(input, TRUTH));
  const t = placement(TRUTH);
  for (const id of ids) {
    const folders = TRUTH.map((f) => ({ ...f, items: f.items.filter((it) => it.id !== id) }));
    const plan = planFolders({ ...input, folders, networkFolders: [] });
    const st = plan.steps.find((x) => x.spaces.includes(id));
    const sug = plan.suggest[id] ?? [];
    if (!st && sug[0]?.folder !== t.get(id)) console.log(id, '->', sug.map((x) => `${x.folder} ${x.score.toFixed(2)}`).join(', '), '| is', t.get(id));
  }
});

describe('words', () => {
  test('filler words do not name folders; a run-together name still has its word', () => {
    expect(nameWords('The Rust Programming Language Community Server')).toEqual(['rust', 'programming', 'language']);
    expect(hasWord('HackLakeside 2026', 'lakeside')).toBe(true);
    expect(hasWord('Lake Tahoe', 'lakeside')).toBe(true);
    expect(hasWord('Quiet Corner', 'corner')).toBe(true);
    expect(hasWord('Bevy Engine', 'corner')).toBe(false);
  });
});

describe('the suggested layout', () => {
  test('the network folders alone never put two servers together wrongly', () => {
    const { s } = score({ network: true });
    expect(s.pairPrecision).toBe(1);
    expect(s.placedRight).toBeGreaterThanOrEqual(0.3);
  });

  test('with shared words and accounts kept apart, most land right and almost none together wrongly', () => {
    const { s, plan } = score({ network: true, words: true, personas: true });
    // Measured 2026-11-13: placed right 0.68, pair precision 1.00 (a real sidebar: 0.67 and 0.98).
    expect(s.placedRight).toBeGreaterThan(0.65);
    expect(s.pairPrecision).toBeGreaterThan(0.95);
    const names = plan.steps.map((x) => x.name);
    expect(names).toContain('Lakeside');
    expect(names).toContain('Westbrook');
    // The unnamed Discord folder mostly of Ashford servers goes in whole, the board games with it.
    expect(plan.steps.find((x) => x.name === 'Ashford')!.spaces).toContain('mossy');
  });

  test('two big accounts on one network get a folder each; the matrix spaces are the main one’s', () => {
    const { plan, after } = score({ network: true, words: true, personas: true });
    expect(plan.personas.map((p) => p.label)).toEqual(['zyansheep', 'zyn.alt']);
    expect(plan.personaOf.nixos).toBe(MAIN);
    expect(plan.personaOf['lk-cs']).toBe(ALT);
    const alt = after.find((f) => f.name === 'zyn.alt')!;
    const inner = alt.items.filter((i) => i.kind === 'folder').map((i) => after.find((f) => f.id === i.id)!.name);
    expect(inner).toEqual(expect.arrayContaining(['Lakeside', 'Ashford']));
    // Folders first, then its loose servers; nothing deeper than one level.
    expect(alt.items.findIndex((i) => i.kind === 'space')).toBeGreaterThan(alt.items.findLastIndex((i) => i.kind === 'folder'));
    for (const f of after) if (alt.items.some((i) => i.kind === 'folder' && i.id === f.id)) expect(f.items.every((i) => i.kind !== 'folder')).toBe(true);
  });

  test('with no network folders, shared words still find the schools', () => {
    const { s, plan } = score({ words: true, personas: true });
    expect(plan.steps.map((x) => x.name).sort()).toEqual(['Ashford', 'Lakeside', 'Westbrook']);
    expect(s.pairPrecision).toBe(1);
  });

  test('nothing you arranged moves, and a folder of the same name is added to', () => {
    const mine = [folder('Coding', ['rust', 'compilers']), { ...folder('Lakeside', ['lk-cs']), id: 'mine-lk' }];
    const plan = planFolders({ ...input, folders: mine });
    for (const st of plan.steps) expect(st.spaces).not.toContain('rust');
    expect(plan.steps.find((x) => x.rule === 'network' && x.name === 'Coding')!.into).toBe('Coding');
    expect(plan.steps.find((x) => x.name === 'Lakeside')!.into).toBe('mine-lk');
  });

  test('a server loose in an account’s folder is still loose: a step files it out of there', () => {
    const acct: FolderView = { id: 'acct', name: 'zyn.alt', icon: null, color: null, items: [{ kind: 'folder', id: 'Other' }, ...['lk-cs', 'lk-chess', 'lk-anime'].map((id) => ({ kind: 'space' as const, id }))] };
    const mine = [acct, folder('Other', ['owls'])];
    const plan = planFolders({ ...input, folders: mine, networkFolders: [] });
    const lk = plan.steps.find((x) => x.name === 'Lakeside')!;
    expect(lk.spaces).toEqual(expect.arrayContaining(['lk-cs', 'lk-chess', 'lk-anime']));
    const after = applyPlan(mine, plan, { steps: new Set([lk.id]), personas: true }, newId);
    const a = after.find((f) => f.id === 'acct')!;
    expect(a.items.filter((i) => i.kind === 'space')).toEqual([]);
    expect(a.items.some((i) => i.kind === 'folder' && after.find((f) => f.id === i.id)?.name === 'Lakeside')).toBe(true);
    // The account's folder is never a suggestion: only the folders inside it.
    for (const xs of Object.values(plan.suggest)) expect(xs.map((x) => x.folder)).not.toContain('acct');
  });

  test('a server no rule places gets its nearest folders as suggestions, not a folder', () => {
    const plan = planFolders({ ...input, folders: TRUTH.filter((f) => f.id !== 'Other').map((f) => ({ ...f, items: f.items.filter((i) => i.id !== 'compilers') })) });
    expect(plan.steps.flatMap((s) => s.spaces)).not.toContain('compilers');
    expect(plan.suggest.compilers?.length).toBeGreaterThan(0);
  });

  test('a new server: the word rule or the suggestions put it back', () => {
    const r = leaveOneOut(input, TRUTH);
    // Measured 2026-11-13: top-1 and top-2 both 0.68 here, all of it the word rule: names and a few channel names share
    // too few words for the suggestions to find the rest. On a real sidebar, with the local model's scores, 0.41 and 0.57.
    expect(r.top1).toBeGreaterThan(0.5);
    expect(r.top2).toBeGreaterThanOrEqual(r.top1);
  });
});
