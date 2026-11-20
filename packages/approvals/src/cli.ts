#!/usr/bin/env bun
/**
 * dither-ask (docs/approvals.md, "dither-ask: the CLI"): ask the hub a question and get a signed answer, check answers
 * and commits against device keys, and run the review watcher. Exit codes: 0 answered (not deny) or sent, 77 denied,
 * 75 no answer, 76 an answer that doesn't verify, 69 the hub can't be reached or refused, 64 bad arguments, 1 a commit
 * not covered (verify-*), 65 a range that isn't one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { type ActionSpec, expandHome, Hub, HubError, readKeys, type RequestView, verifyAnswer } from './client.ts';
import { approvalTrailers, checkSigned, type Kind, KINDS, NAME_RE, policyPayload } from './statement.ts';
import { diffHash, GitError, verifyCommit, verifyRange } from './verify.ts';

const EXIT = { ok: 0, notCovered: 1, usage: 64, badRange: 65, unavailable: 69, noAnswer: 75, unverified: 76, denied: 77 } as const;

class Usage extends Error {}

const USAGE = `dither-ask: ask for approval on your devices (docs/approvals.md)

  request --kind K --title T [--body-file F] [--payload-file F] [--action ID[:signed|:any][=LABEL]]...
          [--urgency high|normal|low] [--expires S] [--topic T] [--wait S] [--keys F]
  alert   --title T [--body-file F] [--urgency high|normal|low]
  status  ID [--wait S] [--keys F]
  cancel  ID [--reason TEXT]
  keys
  verify  --keys F (--json F | --statement-file F --signature SIG)
  verify-commit REV --keys F [--repo NAME] [--git-dir D] [--json]
  verify-range BASE TIP --keys F [--repo NAME] [--git-dir D] [--json]
  diff-hash DIR [--base REV]
  policy  --name N --repo R --target T --path P... --line RE... --max-lines N --expires-days D [--wait S] [--keys F] --out F
  review status BRANCH [--repo R]
  review watch --config F [--once]

  --url (DITHER_ASK_URL) and --token-file (DITHER_ASK_TOKEN_FILE) name the hub and the asker's token.
  Exit: 0 approved/sent, 77 denied, 75 no answer, 76 does not verify, 69 hub unreachable, 64 usage.`;

/** Arguments: positional ones, and --flags (repeatable ones gathered). */
function parse(argv: string[]) {
  const pos: string[] = [];
  const opts = new Map<string, string[]>();
  const bools = new Set(['json', 'once', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h') opts.set('help', ['']);
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (bools.has(name)) opts.set(name, ['']);
      else {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new Usage(`--${name} needs a value`);
        opts.set(name, [...(opts.get(name) ?? []), v]);
      }
    } else pos.push(a);
  }
  return {
    pos,
    has: (n: string) => opts.has(n),
    one: (n: string) => opts.get(n)?.at(-1),
    all: (n: string) => opts.get(n) ?? [],
    num: (n: string) => {
      const v = opts.get(n)?.at(-1);
      if (v === undefined) return undefined;
      const x = Number(v);
      if (!Number.isFinite(x) || x < 0) throw new Usage(`--${n} is a number of seconds`);
      return x;
    },
  };
}
type Args = ReturnType<typeof parse>;

const readText = (f: string | undefined) => (f === undefined ? undefined : f === '-' ? readFileSync(0, 'utf8') : readFileSync(expandHome(f), 'utf8'));
const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));
const say = (s: string) => console.error(s);

/** "approve", "hold:any", "resume:signed=Resume the deploy" */
function actionOf(s: string): ActionSpec {
  const m = /^([a-z0-9-]{1,32})(?::(signed|any))?(?:=(.+))?$/.exec(s);
  if (!m) throw new Usage(`--action ${s}: want ID[:signed|:any][=LABEL]`);
  return { id: m[1]!, needs: m[1] === 'deny' ? 'any' : ((m[2] as 'signed' | 'any' | undefined) ?? 'signed'), ...(m[3] ? { label: m[3] } : {}) };
}

/** The answer as JSON, and its exit code. */
async function finish(v: RequestView, a: Args, expect: Parameters<typeof verifyAnswer>[2]): Promise<number> {
  const keysFile = a.one('keys');
  let verified: boolean | undefined;
  let why: string | undefined;
  if (keysFile && v.state === 'answered') {
    const r = await verifyAnswer(v, readKeys(keysFile), expect);
    verified = r.ok;
    why = r.reason;
  }
  out({
    id: v.id,
    kind: v.kind,
    state: v.state,
    action: v.action,
    message: v.message,
    signed: v.signed,
    device: v.device,
    ...(v.via ? { via: v.via } : {}),
    ...(v.statement ? { statement: v.statement, signature: v.signature } : {}),
    ...(v.cancelReason ? { cancelReason: v.cancelReason } : {}),
    ...(verified !== undefined ? { verified } : {}),
  });
  if (v.state === 'sent') return EXIT.ok;
  if (v.state !== 'answered') return say(`${v.id}: ${v.state === 'waiting' ? 'no answer yet' : v.state}`), EXIT.noAnswer;
  if (v.message) say(`The user's message: ${v.message}`);
  if (v.action === 'deny') return say(`${v.id}: denied`), EXIT.denied;
  if (verified === false) return say(`${v.id}: answered ${v.action}, but it does not verify: ${why}`), EXIT.unverified;
  say(`${v.id}: ${v.action}${v.signed ? ` (signed on ${v.device?.name ?? v.device?.id})` : ' (unsigned)'}`);
  return EXIT.ok;
}

async function request(a: Args, hub: () => Hub): Promise<number> {
  const kind = a.one('kind') as Kind;
  if (!KINDS.includes(kind)) throw new Usage(`--kind is one of ${KINDS.join(', ')}`);
  const title = a.one('title');
  if (!title) throw new Usage('--title is needed');
  const body = readText(a.one('body-file')) ?? '';
  const payload = readText(a.one('payload-file')) ?? '';
  const actions = a.all('action').map(actionOf);
  const h = hub();
  const v = await h.create({ kind, title, body, payload, ...(actions.length ? { actions } : {}), urgency: a.one('urgency'), expiresIn: a.num('expires'), topic: a.one('topic') });
  say(`${v.id}: asked (${kind}); answer on your phone or the page`);
  const wait = a.num('wait') ?? 0;
  const done = wait > 0 && v.state === 'waiting' ? await h.wait(v.id, wait) : v;
  return finish(done, a, { kind, title, body, payload, actions: actions.length ? withDeny(actions) : [{ id: 'approve', needs: 'signed' }, { id: 'deny', needs: 'any' }] });
}

const withDeny = (l: ActionSpec[]) => (l.some((x) => x.id === 'deny') ? l : [...l, { id: 'deny', needs: 'any' as const }]);

async function policy(a: Args, hub: () => Hub): Promise<number> {
  const name = a.one('name');
  if (!name || !NAME_RE.test(name)) throw new Usage('--name: a-z, 0-9 and -');
  const outFile = a.one('out');
  if (!outFile) throw new Usage('--out FILE: where the trailers go');
  const days = a.num('expires-days') ?? 365;
  const maxLines = a.num('max-lines');
  const payload = policyPayload({ name, repo: a.one('repo') ?? '', target: a.one('target') ?? 'main', paths: a.all('path'), lines: a.all('line'), maxLines: maxLines ?? 8 });
  const p = await import('./statement.ts');
  const parsed = p.parsePayload(payload);
  const pol = typeof parsed === 'string' ? parsed : p.readPolicy(parsed);
  if (typeof pol === 'string') throw new Usage(pol);
  const title = `Standing approval: ${name} (${pol.repo}, ${pol.target})`;
  const body = `Commits that change only these files:\n${pol.paths.map((x) => `  ${x}`).join('\n')}\nand only lines matching:\n${pol.lines.map((x) => `  ${x}`).join('\n')}\nat most ${pol.maxLines} lines, as many added as removed, for ${days} days, go through without asking.`;
  const h = hub();
  const v = await h.create({ kind: 'policy', title, body, payload, expiresIn: days * 86_400 });
  say(`${v.id}: asked for the standing approval ${name}; answer on your phone`);
  const done = await h.wait(v.id, a.num('wait') ?? 600);
  const code = await finish(done, a, { kind: 'policy', title, body, payload, actions: [{ id: 'approve', needs: 'signed' }, { id: 'deny', needs: 'any' }] });
  if (code !== EXIT.ok) return code;
  if (!done.statement || !done.signature) return say('approved without a signature: no trailers written'), EXIT.unverified;
  writeFileSync(expandHome(outFile), approvalTrailers({ statement: done.statement, payload, signature: done.signature, policy: name }));
  say(`the trailers are in ${outFile}: append them to each covered commit's message`);
  return EXIT.ok;
}

async function verifyOne(a: Args): Promise<number> {
  const keysFile = a.one('keys');
  if (!keysFile) throw new Usage('--keys is needed');
  let statement: string | undefined;
  let signature: string | undefined;
  const j = a.one('json');
  if (j) {
    const v = JSON.parse(readText(j)!);
    statement = v.statement;
    signature = v.signature;
  } else {
    statement = readText(a.one('statement-file'));
    signature = a.one('signature');
  }
  if (!statement || !signature) throw new Usage('--json F, or --statement-file F and --signature SIG');
  const c = await checkSigned(statement, signature, readKeys(keysFile));
  out({ ok: c.ok, ...(c.reason ? { reason: c.reason } : {}), ...(c.statement ? { statement: c.statement } : {}), ...(c.device ? { device: { id: c.device.id, kind: c.device.kind, name: c.device.name } } : {}) });
  return c.ok ? EXIT.ok : EXIT.unverified;
}

async function verifyGit(cmd: string, a: Args): Promise<number> {
  const keysFile = a.one('keys');
  if (!keysFile) throw new Usage('--keys is needed');
  const dir = a.one('git-dir') ?? process.cwd();
  const o = { keys: readKeys(keysFile), repo: a.one('repo') };
  if (cmd === 'verify-commit') {
    if (a.pos.length !== 2) throw new Usage('verify-commit REV');
    const c = await verifyCommit(dir, a.pos[1]!, o);
    if (a.has('json')) out({ ok: c.covered, commits: [c] });
    if (!c.covered) say(`${c.rev.slice(0, 12)}: not covered: ${c.reason}`);
    return c.covered ? EXIT.ok : EXIT.notCovered;
  }
  if (a.pos.length !== 3) throw new Usage('verify-range BASE TIP');
  const r = await verifyRange(dir, a.pos[1]!, a.pos[2]!, o);
  if (a.has('json')) out(r);
  if (r.reason) return say(r.reason), EXIT.badRange;
  for (const c of r.commits) if (!c.covered) say(`${c.rev.slice(0, 12)}: not covered: ${c.reason}`);
  if (r.ok && !a.has('json')) say(`${r.commits.length} commit${r.commits.length === 1 ? '' : 's'} covered`);
  return r.ok ? EXIT.ok : EXIT.notCovered;
}

async function main(argv: string[]): Promise<number> {
  const a = parse(argv);
  const cmd = a.pos[0];
  if (!cmd || a.has('help')) return console.log(USAGE), cmd ? EXIT.ok : EXIT.usage;
  const hub = () => Hub.from({ url: a.one('url'), tokenFile: a.one('token-file') });
  switch (cmd) {
    case 'request':
      return request(a, hub);
    case 'alert': {
      const title = a.one('title');
      if (!title) throw new Usage('--title is needed');
      const v = await hub().create({ kind: 'alert', title, body: readText(a.one('body-file')) ?? '', urgency: a.one('urgency') ?? 'normal' });
      return finish(v, a, {});
    }
    case 'status': {
      const id = a.pos[1];
      if (!id) throw new Usage('status ID');
      const h = hub();
      const wait = a.num('wait') ?? 0;
      return finish(wait > 0 ? await h.wait(id, wait) : await h.get(id), a, {});
    }
    case 'cancel': {
      const id = a.pos[1];
      if (!id) throw new Usage('cancel ID');
      const v = await hub().cancel(id, a.one('reason'));
      out({ id: v.id, state: v.state });
      return EXIT.ok;
    }
    case 'keys':
      process.stdout.write(await hub().text('/api/approvals/keys'));
      return EXIT.ok;
    case 'verify':
      return verifyOne(a);
    case 'verify-commit':
    case 'verify-range':
      return verifyGit(cmd, a);
    case 'diff-hash': {
      if (!a.pos[1]) throw new Usage('diff-hash DIR');
      console.log(diffHash(a.pos[1], a.one('base') ?? 'HEAD'));
      return EXIT.ok;
    }
    case 'policy':
      return policy(a, hub);
    case 'review': {
      const { reviewCommand } = await import('./review.ts');
      return reviewCommand(a.pos.slice(1), { repo: a.one('repo'), config: a.one('config'), once: a.has('once'), hub });
    }
    default:
      throw new Usage(`no command ${cmd}`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof Usage) say(`${e.message}\n\n${USAGE}`), process.exit(EXIT.usage);
      // Not reached, refused (401) or broken (5xx): unavailable; anything else the hub refused is the caller's.
      if (e instanceof HubError) say(e.message), process.exit(e.status === 0 || e.status === 401 || e.status >= 500 ? EXIT.unavailable : EXIT.usage);
      if (e instanceof GitError) say(e.message), process.exit(EXIT.badRange);
      say(String((e as Error)?.stack ?? e));
      process.exit(1);
    },
  );
}

export { main, EXIT };
