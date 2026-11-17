/**
 * Same person? (docs/same-person.md), the hub's side: runs matches.ts on a thread of its own, asks jev about the pairs
 * it is unsure of, keeps your decisions, merges what you pick, takes the picture hashes the browser makes; and, while
 * the adversarial `profiles` switch is on, collects profiles in the background (ProfileCollector).
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { type MatchRun, run as runMatches } from './matches.ts';
import type { People } from './people.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

/** A run this old is redone when the list is asked for. */
const STALE_MS = 15 * 60_000;
/** After a merge or a decision, the list is worked out again this soon (several clicks make one run). */
const SETTLE_MS = 4000;
const JEV_QUESTION = 'Do these two chat accounts belong to the same person?';
const JEV_INSTRUCT = 'Given two chat accounts (their names, handles, networks and bios), judge whether one person owns both';

interface MatchesDeps {
  store: Store;
  /** The database file, for the worker's own connection; null (a test's in-memory hub): run here. */
  file: string | null;
  /** jev, the machine's yes/no model, for unsure pairs; null: not asked. */
  jevUrl: string | null;
  log?: (line: string) => void;
  /** People changed (a merge): send the changes out. */
  flush?: () => void;
}

export class SameMatches {
  private last: MatchRun | null = null;
  private at: number | null = null;
  private running: Promise<void> | null = null;
  private next: Promise<void> | null = null;
  private settle: Timer | null = null;
  private worker: Worker | null = null;
  private asking = false;

  constructor(private d: MatchesDeps) {}

  /** The list, as last worked out; starts a run when there is none or it is old. */
  view(opts: { side?: string } = {}): P.MatchesView {
    if (!this.running && (!this.at || Date.now() - this.at > STALE_MS)) void this.refresh();
    const s = this.d.store;
    const r = this.last;
    const decided = new Map<string, Row>((s.db.query('SELECT key, decision, until FROM match_decision').all() as Row[]).map((x) => [x.key, x]));
    const now = Date.now();
    const open = (x: P.MatchSuggestion) => {
      const d = decided.get(x.key);
      return !d || (d.decision === 'later' && !!d.until && d.until < now);
    };
    let suggestions = (r?.suggestions ?? []).filter(open);
    if (opts.side) suggestions = suggestions.filter((x) => x.a.id === opts.side || x.b.id === opts.side);
    const ids = new Set(suggestions.flatMap((x) => [x.a.id, x.b.id]));
    const live = (r?.groups ?? []).filter((g) => g.sides.every((id) => ids.has(id)));
    const ret = s.retention();
    return {
      suggestions: suggestions.map((x) => ({ ...x, a: this.side(x.a), b: this.side(x.b) })),
      groups: opts.side ? live.filter((g) => g.sides.includes(opts.side!)) : live,
      ...(opts.side ? {} : { faint: (r?.faint ?? []).filter(open).map((x) => ({ ...x, a: this.side(x.a), b: this.side(x.b) })) }),
      at: this.at,
      running: !!this.running,
      picturesWaiting: this.pictures(10_000).length,
      learned: r?.learned ?? { yes: 0, no: 0, fitted: false },
      profiles: { kept: (s.db.query(`SELECT COUNT(DISTINCT target_id) AS n FROM about WHERE target_id LIKE 'idn_%'`).get() as Row).n, collecting: !!(ret.adversarial && ret.profiles) },
    };
  }

  /** A side as the page shows it: its picture through the hub's media path. */
  private side(x: P.MatchSide): P.MatchSide {
    const s = this.d.store;
    const r = s.one<Row>(`SELECT avatar_url, seen_via FROM identity WHERE id IN (${x.identities.map(() => '?').join(',')}) AND avatar_url IS NOT NULL LIMIT 1`, ...x.identities.map((i) => i.id));
    const p = x.id.startsWith('per_') ? s.one<Row>('SELECT name FROM person WHERE id = ?', x.id) : null;
    return { ...x, name: p?.name ?? x.name, avatar: r ? s.mediaUrl(r.avatar_url, r.seen_via) : null };
  }

  /**
   * Work the list out again (on the worker). One run at a time: asked during one, it resolves once a run that began
   * after the ask is done (several asks during one share that next run), so what changed before the ask is in it.
   */
  refresh(): Promise<void> {
    if (this.running) {
      return (this.next ??= this.running.then(() => {
        this.next = null;
        return this.refresh();
      }));
    }
    this.running = this.once()
      .catch((e) => this.d.log?.(`same person: the run failed: ${(e as Error).message}`))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async once() {
    const r = await this.compute();
    this.last = r;
    this.at = Date.now();
    this.d.log?.(`same person: ${r.suggestions.length} pairs, ${r.groups.length} groups in ${r.ms} ms; ${r.ask.length} for jev, ${r.pictures.length} pictures to hash`);
    if (r.ask.length) void this.askJev(r.ask);
  }

  private compute(): Promise<MatchRun> {
    if (!this.d.file) return Promise.resolve(runMatches(this.d.store.db));
    this.worker ??= this.startWorker();
    const w = this.worker;
    return new Promise((resolve, reject) => {
      w.onmessage = (e: MessageEvent<{ t: 'done'; run: MatchRun } | { t: 'failed'; error: string }>) => (e.data.t === 'done' ? resolve(e.data.run) : reject(new Error(e.data.error)));
      w.onerror = (e) => {
        this.worker = null;
        reject(new Error(e.message));
      };
      w.postMessage({ file: this.d.file });
    });
  }

  private startWorker(): Worker {
    const w = new Worker(new URL('./matches-worker.ts', import.meta.url).href);
    (w as { unref?: () => void }).unref?.();
    return w;
  }

  /** jev reads the unsure pairs' cards; its answers count in the next run. */
  private async askJev(ask: MatchRun['ask']) {
    if (!this.d.jevUrl || this.asking) return;
    this.asking = true;
    try {
      const res = await fetch(`${this.d.jevUrl}/v1/judge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: JEV_QUESTION, texts: ask.map((a) => a.card), instruct: JEV_INSTRUCT }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`jev answered ${res.status}`);
      const p = ((await res.json()) as { p?: (number | null)[] }).p;
      if (!Array.isArray(p) || p.length !== ask.length) throw new Error('jev gave no answers');
      const put = this.d.store.db.query('INSERT INTO match_model (key, card, p, at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET card = excluded.card, p = excluded.p, at = excluded.at');
      let n = 0;
      this.d.store.db.transaction(() => {
        ask.forEach((a, i) => {
          const v = p[i];
          if (typeof v === 'number' && Number.isFinite(v)) {
            put.run(a.key, a.hash, Math.min(0.999, Math.max(0.001, v)), Date.now());
            n++;
          }
        })
      })();
      if (n) this.soon();
    } catch (e) {
      this.d.log?.(`same person: jev: ${(e as Error).message}`);
    } finally {
      this.asking = false;
    }
  }

  private soon() {
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = null;
      void this.refresh();
    }, SETTLE_MS);
    (this.settle as { unref?: () => void }).unref?.();
  }

  /** Not the same (for good), or Later (a month). */
  decide(key: string, decision: P.MatchDecision) {
    const sug = this.last?.suggestions.find((x) => x.key === key) ?? this.last?.faint.find((x) => x.key === key);
    const until = decision === 'later' ? Date.now() + 30 * 86_400_000 : null;
    this.d.store.db
      .query('INSERT INTO match_decision (key, decision, until, features, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET decision = excluded.decision, until = excluded.until, features = excluded.features, at = excluded.at')
      .run(key, decision, until, sug ? JSON.stringify(byKind(sug)) : null, Date.now());
    if (decision === 'no') this.soon();
  }

  /** The demo world was put back as it began (POST /api/demo/reset): what was decided and hashed goes with it. */
  forget(): Promise<void> {
    for (const t of ['match_decision', 'match_model', 'picture_hash']) this.d.store.db.run(`DELETE FROM ${t}`);
    this.last = null;
    this.at = null;
    return this.refresh();
  }

  /** Undo a decision (the toast's Undo): the pair comes back once the list is worked out again. */
  undecide(key: string): Promise<void> {
    this.d.store.db.query(`DELETE FROM match_decision WHERE key = ? AND decision != 'yes'`).run(key);
    return this.refresh();
  }

  /**
   * Make these sides one person: the first person among them keeps its name; an identity no person holds gets one.
   * Each suggested pair among them is kept as a yes, to learn from. Returns the person.
   */
  merge(sides: string[]): string {
    const s = this.d.store;
    const ids = [...new Set(sides)].filter((id) => /^(per|idn)_[\w-]+$/.test(id));
    if (ids.length < 2) throw Object.assign(new Error('pick two or more'), { status: 400 });
    // Everything is checked before anything changes: none of them may be you, or one of your own accounts.
    for (const id of ids) {
      const row = id.startsWith('per_')
        ? s.one<Row>('SELECT is_self FROM person WHERE id = ?', id)
        : s.one<Row>(
            `SELECT (EXISTS (SELECT 1 FROM account WHERE self_identity = i.id) OR COALESCE(p.is_self, 0)) AS is_self FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.id = ?`,
            id,
          );
      if (!row) throw Object.assign(new Error(`no such person: ${id}`), { status: 404 });
      if (row.is_self) throw Object.assign(new Error('That is you'), { status: 400 });
    }
    const persons = ids.map((id) => (id.startsWith('per_') ? id : s.ensurePerson(id)));
    const into = persons[0];
    for (const from of persons.slice(1)) s.mergePersons(into, from);
    const set = new Set(ids);
    const put = s.db.query('INSERT INTO match_decision (key, decision, until, features, at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT (key) DO UPDATE SET decision = excluded.decision, features = excluded.features, at = excluded.at');
    for (const x of this.last?.suggestions ?? []) if (set.has(x.a.id) && set.has(x.b.id)) put.run(x.key, 'yes', JSON.stringify(byKind(x)), Date.now());
    // What they were part of is out of date at once; the next run puts the merged person back in.
    if (this.last) this.last = { ...this.last, suggestions: this.last.suggestions.filter((x) => !set.has(x.a.id) && !set.has(x.b.id)), faint: this.last.faint.filter((x) => !set.has(x.a.id) && !set.has(x.b.id)), groups: this.last.groups.filter((g) => !g.sides.some((id) => set.has(id))) };
    this.d.flush?.();
    this.soon();
    return into;
  }

  /** Pictures for the browser to hash, those of pairs first; a picture hashed since the run is left out. */
  pictures(limit: number): P.PictureToHash[] {
    const s = this.d.store;
    const done = new Map<string, string>((s.db.query('SELECT identity_id, url FROM picture_hash').all() as Row[]).map((r) => [r.identity_id, r.url]));
    const out: P.PictureToHash[] = [];
    for (const p of this.last?.pictures ?? []) {
      if (out.length >= limit) break;
      if (done.get(p.identityId) === p.url) continue;
      const src = s.mediaUrl(p.url, p.via);
      if (src) out.push({ identityId: p.identityId, url: p.url, src });
    }
    return out;
  }

  /** Hashes the browser made: 16 hex digits, or null for a picture that would not load. */
  savePictures(items: { identityId: string; url: string; hash: string | null }[]): number {
    const put = this.d.store.db.query('INSERT INTO picture_hash (identity_id, url, hash, at) VALUES (?, ?, ?, ?) ON CONFLICT (identity_id) DO UPDATE SET url = excluded.url, hash = excluded.hash, at = excluded.at');
    let n = 0;
    this.d.store.db.transaction(() => {
      for (const it of items.slice(0, 500)) {
        if (typeof it?.identityId !== 'string' || typeof it.url !== 'string') continue;
        if (it.hash !== null && !/^[0-9a-f]{16}$/.test(it.hash)) continue;
        put.run(it.identityId, it.url, it.hash, Date.now());
        n++;
      }
    })();
    if (n) this.soon();
    return n;
  }

  stop() {
    if (this.settle) clearTimeout(this.settle);
    this.worker?.terminate();
    this.worker = null;
  }
}

/** A suggestion's evidence summed by kind: what a decision is learned from. */
function byKind(x: P.MatchSuggestion): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of x.evidence) out[e.kind] = (out[e.kind] ?? 0) + e.weight;
  return out;
}

// ------------------------------------------------------------------ collecting profiles

/**
 * How often each network is asked for a profile, per account, and how many a day at most: slower than a person
 * clicking through profiles, so collecting never looks like a scraper.
 */
export const COLLECT_PACE: Partial<Record<P.Network, { gapMs: number; perDay: number }>> = {
  discord: { gapMs: 90_000, perDay: 400 },
  x: { gapMs: 300_000, perDay: 120 },
  telegram: { gapMs: 60_000, perDay: 500 },
  signal: { gapMs: 20_000, perDay: 1500 },
  whatsapp: { gapMs: 360_000, perDay: 100 },
  matrix: { gapMs: 30_000, perDay: 800 },
  messenger: { gapMs: 300_000, perDay: 100 },
};
/** A profile asked this recently is not asked again. */
const COLLECT_FRESH_MS = 14 * 86_400_000;
/** A profile the network would not give is tried again after this. */
const RETRY_MS = 86_400_000;
const TICK_MS = 15_000;

interface CollectorDeps {
  store: Store;
  people: Pick<People, 'get'>;
  online: (accountId: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Profiles collected in the background (adversarial `profiles`, docs/same-person.md): the people you have direct chats
 * with first, then your groups, then servers' channels, then server members your accounts recorded. One profile at a
 * time per account, at COLLECT_PACE, through the same command as opening a profile. Nothing happens with the switch
 * off.
 */
export class ProfileCollector {
  private timer: Timer | null = null;
  private lastAt = new Map<string, number>();
  private today = new Map<string, { day: string; n: number }>();
  private failed = new Map<string, number>();
  private queue: Map<P.Network, string[]> | null = null;
  private queueAt = 0;
  private busy = false;
  collected = 0;

  constructor(private d: CollectorDeps) {}

  private now = () => (this.d.now ?? Date.now)();

  start() {
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  on(): boolean {
    const r = this.d.store.retention();
    return !!(r.adversarial && r.profiles);
  }

  /** One step: for each network with an account free to ask, the next profile due. Returns the identities asked. */
  async tick(): Promise<string[]> {
    if (!this.on() || this.busy) return [];
    this.busy = true;
    const asked: string[] = [];
    try {
      const now = this.now();
      if (!this.queue || now - this.queueAt > 3600_000) this.build();
      const day = new Date(now).toISOString().slice(0, 10);
      const accounts = this.d.store.db.query('SELECT id, network, capabilities FROM account').all() as Row[];
      for (const [network, pace] of Object.entries(COLLECT_PACE) as [P.Network, { gapMs: number; perDay: number }][]) {
        const acc = accounts.find((a) => a.network === network && this.d.online(a.id) && (JSON.parse(a.capabilities ?? '[]') as string[]).includes('profile'));
        if (!acc) continue;
        if (now - (this.lastAt.get(network) ?? 0) < pace.gapMs) continue;
        const t = this.today.get(network);
        if (t && t.day === day && t.n >= pace.perDay) continue;
        const id = this.next(network, now);
        if (!id) continue;
        this.lastAt.set(network, now);
        this.today.set(network, { day, n: (t?.day === day ? t.n : 0) + 1 });
        asked.push(id);
        try {
          const v = await this.d.people.get(id);
          if (v.stale) this.failed.set(id, now);
          else this.collected++;
        } catch {
          this.failed.set(id, now);
        }
      }
    } finally {
      this.busy = false;
    }
    return asked;
  }

  /** The next identity on a network whose kept profile is missing or old. */
  private next(network: P.Network, now: number): string | null {
    const q = this.queue?.get(network);
    if (!q) return null;
    const fresh = this.d.store.db.query('SELECT MAX(fetched_at) AS at FROM about WHERE target_id = ?');
    while (q.length) {
      const id = q.shift()!;
      const f = this.failed.get(id);
      if (f && now - f < RETRY_MS) continue;
      const at = (fresh.get(id) as Row | null)?.at;
      if (at && now - at < COLLECT_FRESH_MS) continue;
      return id;
    }
    return null;
  }

  /** Who to ask, in order: direct chats, groups, servers' channels, then recorded members. */
  private build() {
    const s = this.d.store;
    const self = new Set((s.db.query('SELECT self_identity AS id FROM account WHERE self_identity IS NOT NULL').all() as Row[]).map((r) => r.id));
    const order = new Map<string, number>();
    const rank = (sql: string, n: number) => {
      for (const r of s.db.query(sql).all() as Row[]) if (!order.has(r.id) && !self.has(r.id)) order.set(r.id, n);
    };
    rank(`SELECT DISTINCT p.identity_id AS id FROM participant p JOIN conversation c ON c.id = p.conversation_id WHERE c.shape = 'direct'`, 0);
    rank(`SELECT DISTINCT p.identity_id AS id FROM participant p JOIN conversation c ON c.id = p.conversation_id WHERE c.shape = 'group'`, 1);
    rank(`SELECT DISTINCT p.identity_id AS id FROM participant p JOIN conversation c ON c.id = p.conversation_id WHERE c.shape = 'channel'`, 2);
    if (s.recordsMembers()) rank('SELECT DISTINCT identity_id AS id FROM membership', 3);
    const nets = new Map<string, P.Network>((s.db.query('SELECT id, network FROM identity WHERE is_bot = 0').all() as Row[]).map((r) => [r.id, r.network]));
    const queue = new Map<P.Network, string[]>();
    for (const [id] of [...order].sort((a, b) => a[1] - b[1])) {
      const net = nets.get(id);
      if (!net || !COLLECT_PACE[net]) continue;
      (queue.get(net) ?? queue.set(net, []).get(net)!).push(id);
    }
    this.queue = queue;
    this.queueAt = this.now();
  }

  /** For the settings page: on or off, how many kept, collected since start, waiting by network. */
  status(): P.ProfileCollectStatus {
    const s = this.d.store;
    const now = this.now();
    if (this.on() && (!this.queue || now - this.queueAt > 3600_000)) this.build();
    const kept = (s.db.query(`SELECT COUNT(DISTINCT target_id) AS n FROM about WHERE target_id LIKE 'idn_%'`).get() as Row).n;
    const versions = (s.db.query('SELECT COUNT(*) AS n FROM profile_version').get() as Row).n;
    const day = new Date(now).toISOString().slice(0, 10);
    return {
      on: this.on(),
      kept,
      versions,
      collected: this.collected,
      networks: Object.entries(COLLECT_PACE).map(([network, pace]) => ({
        network: network as P.Network,
        name: NETWORK_META[network as P.Network]?.name ?? network,
        waiting: this.queue?.get(network as P.Network)?.length ?? 0,
        today: this.today.get(network)?.day === day ? this.today.get(network)!.n : 0,
        perDay: pace!.perDay,
        everySeconds: Math.round(pace!.gapMs / 1000),
      })),
    };
  }
}

