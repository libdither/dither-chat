/**
 * Time spent in each place, kept as a decayed total so it follows current habits, and the sort settings
 * built on it (docs/organize.md). Devices measure and send batches; the hub only adds them up. Nothing here
 * holds message content: ids, seconds and times.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { addDecayed, cleanDelta, decayed, DEFAULT_ARRANGE, USAGE_HALF_LIFE } from '@dither-chat/protocol';

type Row = Record<string, any>;
const SORT_MODES: P.SortMode[] = ['manual', 'smart', 'recent', 'az'];
/** The Groups list had a scope of its own until it joined the inbox; a stored one is ignored. */
const SCOPES: P.SortScope[] = ['rail', 'people'];
/** A place you have not touched in this long, and whose score has decayed to nothing, is forgotten. */
const FORGET_MS = 90 * 86_400_000;

type Place = { kind: P.UsageKind; id: string };

export class UsageStore {
  /** `changed` places were added to, `removed` ones forgotten; `all` when everything was. For the live socket and the journal. */
  constructor(
    private db: Database,
    private onChange?: (changed: Place[], removed: Place[], all?: boolean) => void,
  ) {}

  list(): P.UsageView[] {
    return this.views(this.db.query('SELECT * FROM place_usage').all() as Row[]);
  }

  /** These places, those that are still kept. */
  get(places: Place[]): P.UsageView[] {
    if (!places.length) return [];
    return this.views(this.db.query(`SELECT u.* FROM place_usage u JOIN json_each(?) j ON u.kind = j.value ->> 'kind' AND u.id = j.value ->> 'id'`).all(JSON.stringify(places)) as Row[]);
  }

  private views(rows: Row[]): P.UsageView[] {
    return rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      score: r.score,
      visitScore: r.visit_score,
      at: r.score_at,
      seconds: r.seconds,
      visits: r.visits,
      lastVisit: r.last_visit,
    }));
  }

  state(now = Date.now()): P.UsageState {
    return { now, halfLife: USAGE_HALF_LIFE, places: this.list(), arrange: this.arrange() };
  }

  /** Adds one device's batch. A batch id seen before is ignored, so resending after a lost answer is safe. */
  apply(batch: string | undefined, deltas: Partial<P.UsageDelta>[], now = Date.now()): number {
    let n = 0;
    const changed: Place[] = [];
    let removed: Place[] = [];
    this.db.transaction(() => {
      if (batch) {
        if (this.db.query('SELECT 1 FROM usage_batch WHERE id = ?').get(batch)) return;
        this.db.query('INSERT INTO usage_batch (id, at) VALUES (?, ?)').run(batch, now);
      }
      for (const raw of deltas.slice(0, 500)) {
        const d = cleanDelta(raw, now);
        if (!d) continue;
        const r = this.db.query('SELECT * FROM place_usage WHERE kind = ? AND id = ?').get(d.kind, d.id) as Row | null;
        const next = addDecayed(r ? { score: r.score, visitScore: r.visit_score, at: r.score_at } : null, d);
        const lastVisit = Math.max(r?.last_visit ?? 0, d.lastVisit ?? 0) || null;
        this.db
          .query(
            `INSERT INTO place_usage (kind, id, score, visit_score, score_at, seconds, visits, last_visit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (kind, id) DO UPDATE SET score = excluded.score, visit_score = excluded.visit_score, score_at = excluded.score_at,
               seconds = seconds + excluded.seconds, visits = visits + excluded.visits, last_visit = excluded.last_visit`,
          )
          .run(d.kind, d.id, next.score, next.visitScore, next.at, d.seconds, d.visits, lastVisit);
        changed.push({ kind: d.kind, id: d.id });
        n++;
      }
      removed = this.prune(now);
    })();
    if (changed.length || removed.length) this.onChange?.(changed, removed);
    return n;
  }

  private prune(now: number): Place[] {
    const gone: Place[] = [];
    this.db.query('DELETE FROM usage_batch WHERE at < ?').run(now - 7 * 86_400_000);
    for (const r of this.db.query('SELECT kind, id, score, visit_score, score_at FROM place_usage WHERE COALESCE(last_visit, score_at) < ?').all(now - FORGET_MS) as Row[]) {
      if (decayed(r.score, r.score_at, now) < 1 && decayed(r.visit_score, r.score_at, now) < 0.01) {
        this.db.query('DELETE FROM place_usage WHERE kind = ? AND id = ?').run(r.kind, r.id);
        gone.push({ kind: r.kind, id: r.id });
      }
    }
    return gone;
  }

  /** Everything, or one place. */
  reset(place?: { kind: string; id: string }) {
    if (place) this.db.query('DELETE FROM place_usage WHERE kind = ? AND id = ?').run(place.kind, place.id);
    else this.db.exec('DELETE FROM place_usage; DELETE FROM usage_batch;');
    this.onChange?.([], place ? [place as Place] : [], !place);
  }

  arrange(): P.ArrangeSettings {
    const get = (k: string) => {
      const r = this.db.query('SELECT value FROM arrange_setting WHERE key = ?').get(k) as Row | null;
      try {
        return r ? JSON.parse(r.value) : null;
      } catch {
        return null;
      }
    };
    const stored: Record<string, P.SortMode> = get('sort') ?? {};
    const sort = { ...DEFAULT_ARRANGE.sort };
    for (const scope of SCOPES) if (SORT_MODES.includes(stored[scope])) sort[scope] = stored[scope];
    return { sort, dismissed: get('dismissed') ?? {}, ...(get('followArchive') === false ? { followArchive: false } : {}) };
  }

  /** Only what is given changes: a sort mode per scope, and dismissals per category (null brings one back). */
  patchArrange(p: { sort?: Partial<Record<string, string>>; dismissed?: Record<string, string[] | null>; followArchive?: unknown }): P.ArrangeSettings {
    const cur = this.arrange();
    const put = (k: string, v: unknown) => this.db.query('INSERT OR REPLACE INTO arrange_setting (key, value) VALUES (?, ?)').run(k, JSON.stringify(v));
    if (typeof p.followArchive === 'boolean') put('followArchive', p.followArchive);
    if (p.sort) {
      const sort = { ...cur.sort };
      for (const [scope, mode] of Object.entries(p.sort)) {
        if (SCOPES.includes(scope as P.SortScope) && SORT_MODES.includes(mode as P.SortMode)) sort[scope as P.SortScope] = mode as P.SortMode;
      }
      // Manual only means something where you can arrange by hand: the rail.
      if (sort.people === 'manual') sort.people = 'recent';
      put('sort', sort);
    }
    if (p.dismissed) {
      const dismissed = { ...cur.dismissed };
      for (const [cat, keys] of Object.entries(p.dismissed)) {
        if (keys === null) delete dismissed[cat];
        else if (Array.isArray(keys)) dismissed[cat] = keys.filter((k) => typeof k === 'string').slice(0, 500);
      }
      put('dismissed', dismissed);
    }
    return this.arrange();
  }
}
