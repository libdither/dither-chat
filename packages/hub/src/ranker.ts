/**
 * The learned order in the hub (docs/inbox.md, "A learned order"): an AttentionJudge that gives every listed
 * conversation the model's score (rank.ts), and learns from the activity log in the background.
 *
 * Learning is a refit, as triage's votes are (learn.ts): every so often it rebuilds the inbox as it was at each of
 * your recent opens (rankhistory.ts), a few milliseconds at a time on a read-only connection of its own, and fits
 * both chances again from the prior. It refits a day after the last time, after ten more opens have had their few
 * hours to say what came of them, and at the start when it has never learned. With no log it is the prior, which
 * orders as the formula does.
 *
 * DITHER_INBOX_RANK: `model` (the default) sorts by it; `shadow` works it out and shows it in
 * `GET /api/attention/:id` without sorting by it; `off` does neither.
 */
import { Database } from 'bun:sqlite';
import type { AttentionJudge, ScoreInput, Scored } from './attention.ts';
import { EXAMINATION_ETA, FEATURES, fitRankSteps, HORIZON, predict, PRIOR, rankFeatures, type Moment, type Prediction, type RankModel } from './rank.ts';
import { flagged, isChoice, loadWorld, momentOf, mutedBy, Rebuild } from './rankhistory.ts';
import type { Store } from './store.ts';
import type { Triage } from './triage.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type RankMode = 'model' | 'shadow' | 'off';
export const rankMode = (v: string | undefined): RankMode => (v === 'shadow' || v === 'off' ? v : 'model');

/** It learns from the opens of the last two months, at most this many of the latest. */
export const TRAIN_WINDOW = 60 * DAY;
export const MAX_MOMENTS = 1500;
/** Refit after this many more opens, or a day after the last refit. */
export const REFIT_AFTER = 10;
const CHECK_EVERY = 30 * MIN;
/** A score moved this far from the formula's says so in the reasons. */
const SAY_AFTER = 10;

const KEY = 'inbox_rank';

export class InboxRanker implements AttentionJudge {
  model: RankModel;
  /** The latest prediction per conversation, for `explain`. */
  private last = new Map<string, Prediction & { formula: number }>();
  private busy: Promise<RankModel> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** After a refit: score everything again (main.ts broadcasts it). */
  onFit?: () => void;

  constructor(
    private store: Store,
    private triage: Pick<Triage, 'effectiveLevel'>,
    readonly mode: RankMode = 'model',
    /** The database file, for a read-only connection of its own while it rebuilds; without it, the store's own. */
    private file?: string,
    private now: () => number = Date.now,
  ) {
    const r = store.db.query(`SELECT value FROM meta WHERE key = ?`).get(KEY) as Row | null;
    let saved: RankModel | null = null;
    try {
      saved = r ? JSON.parse(r.value) : null;
    } catch {}
    this.model = saved?.open && saved?.send ? saved : PRIOR;
  }

  // ---------------------------------------------------------------- scoring

  rank(conversationId: string, x: ScoreInput, formula: Scored): { score: number; reason?: string } | null {
    // Muted places keep their place at the bottom, by the formula.
    if (this.mode === 'off' || x.muted) return null;
    const p = predict(this.model, rankFeatures(x, formula));
    this.last.set(conversationId, { ...p, formula: formula.score });
    if (this.mode === 'shadow') return null;
    const moved = p.points - formula.score;
    const reason =
      this.model.moments === 0 || Math.abs(moved) < SAY_AFTER
        ? undefined
        : moved > 0
          ? 'Higher: you often open chats like this at times like this'
          : 'Lower: you seldom open chats like this at times like this';
    return { score: p.points, reason };
  }

  explain(conversationId: string) {
    const p = this.last.get(conversationId);
    return p ? { mode: this.mode, open: round(p.open), send: round(p.send), points: p.points, formula: p.formula, fitAt: this.model.fitAt } : null;
  }

  forget(conversationId: string) {
    this.last.delete(conversationId);
  }

  /** For `GET /api/attention/model`: what it learned, as weights on named features (no ids, nothing said). */
  view() {
    const m = this.model;
    const diff = (k: 'open' | 'send') => Object.fromEntries(FEATURES.map((f) => [f, round((m[k][f] ?? 0) - (PRIOR[k][f] ?? 0))]).filter(([, v]) => v !== 0));
    return { mode: this.mode, fitAt: m.fitAt, moments: m.moments, rows: m.rows, horizon: HORIZON, prior: { open: PRIOR.open, send: PRIOR.send }, learned: { open: diff('open'), send: diff('send') } };
  }

  // ---------------------------------------------------------------- learning

  /** Opens whose horizon has passed since the last refit: what a refit would learn that this one did not. */
  private maturedSince(t: number, now: number): number {
    return (this.store.db.query(`SELECT COUNT(*) AS n FROM visit WHERE view IN ('conversation', 'person') AND start_at > ? AND start_at <= ?`).get(t - HORIZON, now - HORIZON) as Row).n;
  }

  /** Whether to refit now. The log cleared since: back to the prior at once. */
  due(now = this.now()): boolean {
    const fitAt = this.model.fitAt;
    if (this.model.moments > 0 && !(this.store.db.query('SELECT 1 FROM visit LIMIT 1').get() as Row | null)) return true;
    if (fitAt === null) return this.maturedSince(-Infinity, now) > 0;
    return now - fitAt >= DAY || this.maturedSince(fitAt, now) >= REFIT_AFTER;
  }

  /** Rebuild the recent opens and fit again from the prior, a little at a time. Resolves with the new model. */
  refit(o: { stepMs?: number; pauseMs?: number } = {}): Promise<RankModel> {
    this.busy ??= this.fit(o.stepMs ?? 25, o.pauseMs ?? 10).finally(() => (this.busy = null));
    return this.busy;
  }

  private async fit(stepMs: number, pauseMs: number): Promise<RankModel> {
    const now = this.now();
    const own = this.file ? new Database(this.file, { readonly: true }) : null;
    const db = own ?? this.store.db;
    let rebuild: Rebuild | null = null;
    const pause = () => new Promise((r) => setTimeout(r, pauseMs));
    /** Run steps for about `stepMs` at a time, pausing between. */
    const run = async <T>(g: Generator<undefined, T>): Promise<T> => {
      for (let start = performance.now(); ; ) {
        const r = g.next();
        if (r.done) return r.value;
        if (performance.now() - start >= stepMs) {
          await pause();
          start = performance.now();
        }
      }
    };
    try {
      const since = now - TRAIN_WINDOW;
      // Two more weeks of stays before the window, for where you had been by its first open.
      const w = loadWorld(db, mutedBy(this.triage), since - 14 * DAY, await run(flagged(db)));
      const opens = w.stays.filter((s) => isChoice(s) && s.targets.length && s.start >= since && s.start + HORIZON <= now).slice(-MAX_MOMENTS);
      const moments: Moment[] = [];
      let i = 0;
      rebuild = new Rebuild(db, w, opens.map((s) => s.start), (t, world) => {
        const m = momentOf(world, opens[i++], t);
        if (m) moments.push(m);
      });
      while (!rebuild.step(stepMs)) await pause();
      this.model = moments.length ? await run(fitRankSteps(moments, now, { eta: EXAMINATION_ETA })) : { ...PRIOR, fitAt: now };
      this.store.db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(KEY, JSON.stringify(this.model));
      this.onFit?.();
      return this.model;
    } finally {
      rebuild?.close();
      own?.close();
    }
  }

  start() {
    if (this.mode === 'off' || this.timer) return;
    const check = () => {
      if (!this.busy && this.due()) this.refit().catch((e) => console.error('inbox ranking: refit failed', e));
    };
    setTimeout(check, 20_000);
    this.timer = setInterval(check, CHECK_EVERY);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;
