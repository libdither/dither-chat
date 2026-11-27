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
 *
 * DITHER_INBOX_EXPLORE: `1` (the default) sorts by a Thompson sample of the model instead of its mean, so a row it
 * knows little about sometimes rises into view (rank.ts `drawZ`), and every row moves a little (`EXPLORE_FLOOR`);
 * `0` sorts by the mean.
 *
 * Mail (docs/inbox.md, "Mail in the learned order"): a second model, the order with mail, learns from the opens of
 * chats and mail threads alike, over the same features and mail's own (rank.ts MAIL_FEATURES), each refit beside the
 * first. DITHER_INBOX_MAIL: `shadow` (the default) works it out for every row and sends it as the view's `shadow`,
 * while chats keep the first model's order and mail rows the formula's; `model` sorts chats and mail by it (chats and
 * mail compete in one ranking); `off` neither fits nor scores it.
 */
import { Database } from 'bun:sqlite';
import type { AttentionJudge, ScoreInput, Scored } from './attention.ts';
import type { OwedTable } from './owed.ts';
import type { NeedsModel } from './needsreply.ts';
import { EXPLORE_REASON } from '@dither-chat/protocol';
import { bondAt, drawZ, epochOf, EXAM_AT, EXPLORE_EPOCH, EXPLORE_FLOOR, EXPLORE_SCALE, FEATURES, FIT, fitRankSteps, GUESSED_CURVE, HORIZON, mailRankFeatures, predict, PRIOR, rankFeatures, Z_CLIP, type Features, type MailSide, type Moment, type Prediction, type RankModel } from './rank.ts';
import { flagged, isChoice, loadWorld, momentOf, mutedBy, Rebuild, seenAt } from './rankhistory.ts';
import { noteWork } from './stalls.ts';
import { BUSY_MS, type Store } from './store.ts';
import type { Triage } from './triage.ts';
import { jobFailed } from './errors.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type RankMode = 'model' | 'shadow' | 'off';
export const rankMode = (v: string | undefined): RankMode => (v === 'shadow' || v === 'off' ? v : 'model');
export const exploreOn = (v: string | undefined): boolean => v !== '0';
/** DITHER_INBOX_MAIL: the order with mail in shadow (the default), sorting the inbox, or neither. */
type MailRankMode = 'shadow' | 'model' | 'off';
export const mailRankMode = (v: string | undefined): MailRankMode => (v === 'model' || v === 'off' ? v : 'shadow');

/** It learns from the opens of the last two months, at most this many of the latest. */
const TRAIN_WINDOW = 60 * DAY;
const MAX_MOMENTS = 1500;
/** Refit after this many more opens, or a day after the last refit. */
const REFIT_AFTER = 10;
const CHECK_EVERY = 30 * MIN;
/** A score moved this far from the formula's says so in the reasons. */
const SAY_AFTER = 10;

const KEY = 'inbox_rank';
const MAIL_KEY = 'inbox_rank_mail';
/** Bump when the order with mail's features or rows change meaning: a model saved before is fitted again at start. */
export const MAIL_MODEL_VERSION = 1;

export class InboxRanker implements AttentionJudge {
  model: RankModel;
  /** The latest prediction per conversation, for `explain`: the mean, and the sample the inbox sorts by. */
  private last = new Map<string, Prediction & { formula: number; sampled: number }>();
  private busy: Promise<RankModel> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** After a refit: score everything again (main.ts broadcasts it). */
  onFit?: () => void;
  /** The inbox's owed table (owed.ts, attention.ts): history is scored with it, as the live rows are. */
  owedTable?: () => OwedTable;
  /** Mail's owed table (mail/attention.ts), for the mail rows of the replays. */
  mailOwedTable?: () => OwedTable | undefined;
  /** The needs-reply model the live scores use (needsreply.ts), so the replays score as the hub does. */
  needsModel?: () => NeedsModel | null;
  /** The order with mail (DITHER_INBOX_MAIL), fitted beside `model`; the prior until it has been. */
  mailModel: RankModel;
  /** The people graph's closeness by identity (closeness.ts), for mail's `mailBond`; asked for at each refit. */
  bonds?: () => Promise<Record<string, number[]> | null>;
  /** Each person's closeness by month, from the last refit's `bonds`. */
  private personBonds = new Map<string, number[]>();

  constructor(
    private store: Store,
    private triage: Pick<Triage, 'effectiveLevel'>,
    readonly mode: RankMode = 'model',
    /** The database file, for a read-only connection of its own while it rebuilds; without it, the store's own. */
    private file?: string,
    private now: () => number = Date.now,
    /** Sort by a Thompson sample instead of the mean (DITHER_INBOX_EXPLORE). */
    readonly explore = true,
    /** The order with mail (DITHER_INBOX_MAIL). */
    readonly mailMode: MailRankMode = 'shadow',
  ) {
    const load = (key: string): RankModel | null => {
      const r = store.db.query(`SELECT value FROM meta WHERE key = ?`).get(key) as Row | null;
      try {
        const saved = r ? (JSON.parse(r.value) as RankModel) : null;
        return saved?.open && saved?.send ? saved : null;
      } catch {
        return null;
      }
    };
    this.model = load(KEY) ?? PRIOR;
    const mail = load(MAIL_KEY);
    this.mailModel = mail && mail.v === MAIL_MODEL_VERSION ? mail : PRIOR;
  }

  /** Whether the order with mail is worked out at all. */
  private get withMail(): boolean {
    return this.mode !== 'off' && this.mailMode !== 'off';
  }

  /** The model that sorts the inbox: the order with mail once DITHER_INBOX_MAIL is `model`. */
  private get live(): RankModel {
    return this.withMail && this.mailMode === 'model' ? this.mailModel : this.model;
  }

  // ---------------------------------------------------------------- scoring

  /** A row's features: a mail thread's with mail's own (`mail`), else a conversation's. */
  private features(x: ScoreInput, formula: Scored, mail?: MailSide | null): Features {
    if (!mail) return rankFeatures(x, formula);
    const bond = mail.person ? bondAt(this.personBonds.get(mail.person), x.now) : 0;
    return mailRankFeatures(x, formula, { ...mail, known: !!mail.person, bond });
  }

  /**
   * The inbox's score for a row, or null to keep the formula's. A mail thread's (`mail`) only once the order with mail
   * sorts the inbox (DITHER_INBOX_MAIL=model); until then it keeps its formula points.
   */
  rank(conversationId: string, x: ScoreInput, formula: Scored, mail?: MailSide | null): { score: number; reason?: string } | null {
    // Muted places keep their place at the bottom, by the formula.
    if (this.mode === 'off' || x.muted) return null;
    if (mail && !(this.withMail && this.mailMode === 'model')) return null;
    const m = this.live;
    const f = this.features(x, formula, mail);
    const p = predict(m, f);
    // The same draw for the conversation until the epoch turns: live updates move it only as its features do.
    const z = this.explore && m.cov ? drawZ(`${conversationId}|${epochOf(m, x.now)}`) : null;
    const sampled = z ? predict(m, f, z).points : p.points;
    this.last.set(conversationId, { ...p, formula: formula.score, sampled });
    if (this.mode === 'shadow') return null;
    const moved = p.points - formula.score;
    const what = mail ? 'mail' : 'chats';
    const reason =
      sampled - p.points >= SAY_AFTER
        ? EXPLORE_REASON
        : m.moments === 0 || Math.abs(moved) < SAY_AFTER
          ? undefined
          : moved > 0
            ? `Higher: you often open ${what} like this at times like this`
            : `Lower: you seldom open ${what} like this at times like this`;
    return { score: sampled, reason };
  }

  /**
   * The order with mail's score for a row while it runs in shadow (its mean, in the formula's points), or null: not
   * in shadow, or a muted place (which keeps the formula's place at the bottom in every order).
   */
  shadow(conversationId: string, x: ScoreInput, formula: Scored, mail?: MailSide | null): number | null {
    if (!this.withMail || this.mailMode !== 'shadow' || x.muted) return null;
    const p = predict(this.mailModel, this.features(x, formula, mail));
    this.lastShadow.set(conversationId, p.points);
    return p.points;
  }
  private lastShadow = new Map<string, number>();

  explain(conversationId: string) {
    const p = this.last.get(conversationId);
    const m = this.live;
    const withMail = this.withMail ? { mode: this.mailMode, shadow: this.lastShadow.get(conversationId) ?? null, fitAt: this.mailModel.fitAt } : null;
    return p
      ? { mode: this.mode, open: round(p.open), send: round(p.send), points: p.points, sampled: p.sampled, explore: this.explore && !!m.cov, formula: p.formula, fitAt: m.fitAt, withMail }
      : withMail && { mode: this.mode, withMail };
  }

  forget(conversationId: string) {
    this.last.delete(conversationId);
    this.lastShadow.delete(conversationId);
  }

  /** For `GET /api/attention/model`: what it learned, as weights on named features (no ids, nothing said). */
  view() {
    const m = this.model;
    const diffOf = (m: RankModel, k: 'open' | 'send') => Object.fromEntries(FEATURES.map((f) => [f, round((m[k][f] ?? 0) - (PRIOR[k][f] ?? 0))]).filter(([, v]) => v !== 0));
    const diff = (k: 'open' | 'send') => diffOf(m, k);
    const mm = this.mailModel;
    return {
      withMail: this.withMail ? { mode: this.mailMode, fitAt: mm.fitAt, moments: mm.moments, rows: mm.rows, learned: { open: diffOf(mm, 'open'), send: diffOf(mm, 'send') } } : { mode: 'off' as const },
      mode: this.mode,
      fitAt: m.fitAt,
      // A refit is due (the first check is 20 s after a start) or working out: a test waits for neither (verify-response.ts).
      due: this.due(),
      refitting: !!this.busy,
      moments: m.moments,
      rows: m.rows,
      horizon: HORIZON,
      prior: { open: PRIOR.open, send: PRIOR.send },
      learned: { open: diff('open'), send: diff('send') },
      examination: this.examinationView(),
      explore: { on: this.explore, sampling: this.explore && !!m.cov, epochMinutes: EXPLORE_EPOCH / MIN, zClip: Z_CLIP, scale: EXPLORE_SCALE, floor: EXPLORE_FLOOR },
    };
  }

  /**
   * "Seeing a row because it is listed", per stretch of rows (1-based): the curve fitted with the model (or null),
   * the guess it started from, and how often the list was on screen down to there in a stay (`visit.depth`).
   */
  private examinationView() {
    const m = this.model;
    const since = this.now() - TRAIN_WINDOW;
    const depths = this.store.db.query(`SELECT depth, COUNT(*) AS n FROM visit WHERE depth IS NOT NULL AND start_at >= ? GROUP BY depth`).all(since) as Row[];
    const stays = depths.reduce((a, r) => a + r.n, 0);
    const shown = (p: number) => (stays ? round(depths.reduce((a, r) => a + (r.depth >= p ? r.n : 0), 0) / stays) : null);
    return {
      fittedFrom: m.curve ? (m.curveFrom ?? 0) : 0,
      staysWithDepth: stays,
      rows: EXAM_AT.map((p, b) => ({ from: p + 1, to: b + 1 < EXAM_AT.length ? EXAM_AT[b + 1] : null, fitted: m.curve?.[b] ?? null, guess: round(GUESSED_CURVE[b]), onScreen: shown(p) })),
    };
  }

  // ---------------------------------------------------------------- learning

  /** Opens whose horizon has passed since the last refit: what a refit would learn that this one did not. */
  private maturedSince(t: number, now: number): number {
    const views = this.withMail ? `('conversation', 'person', 'mail')` : `('conversation', 'person')`;
    return (this.store.db.query(`SELECT COUNT(*) AS n FROM visit WHERE view IN ${views} AND start_at > ? AND start_at <= ?`).get(t - HORIZON, now - HORIZON) as Row).n;
  }

  /** Whether to refit now. The log cleared since: back to the prior at once. */
  due(now = this.now()): boolean {
    const fitAt = this.model.fitAt;
    if (this.model.moments > 0 && !(this.store.db.query('SELECT 1 FROM visit LIMIT 1').get() as Row | null)) return true;
    // Saved before the hub fitted its examination curve and how sure it is: fit again at start.
    const live = this.live;
    if (live.moments > 0 && (!live.cov || (FIT.curve && !live.curve))) return true;
    // The order with mail was never fitted (or fitted before its features last changed), while the first was.
    if (this.withMail && this.mailModel.fitAt === null && fitAt !== null) return true;
    if (fitAt === null) return this.maturedSince(-Infinity, now) > 0;
    return now - fitAt >= DAY || this.maturedSince(fitAt, now) >= REFIT_AFTER;
  }

  /** Rebuild the recent opens and fit again from the prior, a little at a time. Resolves with the new model. */
  refit(o: { stepMs?: number; pauseMs?: number } = {}): Promise<RankModel> {
    this.busy ??= this.fit(o.stepMs ?? 25, o.pauseMs ?? 10).finally(() => (this.busy = null));
    return this.busy;
  }

  private async fit(stepMs: number, pauseMs: number): Promise<RankModel> {
    noteWork('inbox ranking refit');
    const now = this.now();
    const own = this.file ? new Database(this.file, { readonly: true }) : null;
    own?.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
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
          noteWork('inbox ranking refit');
          start = performance.now();
        }
      }
    };
    try {
      const since = now - TRAIN_WINDOW;
      const mail = this.withMail;
      const bonds = mail ? await this.bonds?.().catch(() => null) : null;
      // Two more weeks of stays before the window, for where you had been by its first open.
      const w = loadWorld(db, mutedBy(this.triage), since - 14 * DAY, await run(flagged(db)), { mail, bonds });
      w.owedTable = this.owedTable?.();
      w.mailOwedTable = this.mailOwedTable?.();
      w.needsModel = this.needsModel?.() ?? null;
      if (w.bonds) this.personBonds = w.bonds;
      const opens = w.stays.filter((s) => isChoice(s) && s.targets.length && s.start >= since && s.start + HORIZON <= now).slice(-MAX_MOMENTS);
      // Chats alone for the first model (unless the order with mail sorts the inbox), and everything for that one.
      const chatsToo = !mail || this.mailMode !== 'model';
      const moments: Moment[] = [];
      const withMail: Moment[] = [];
      let i = 0;
      rebuild = new Rebuild(db, w, opens.map((s) => s.start), (t, world) => {
        const stay = opens[i++];
        const seen = seenAt(world, t);
        const chats = mail ? seen.filter((s) => !s.mail) : seen;
        const m = chatsToo ? momentOf(world, stay, t, chats) : null;
        if (m) moments.push(m);
        const all = mail ? momentOf(world, stay, t, seen) : null;
        if (all) withMail.push(all);
      });
      while (!rebuild.step(stepMs)) {
        await pause();
        noteWork('inbox ranking refit');
      }
      const put = this.store.db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`);
      if (chatsToo) {
        this.model = moments.length ? await run(fitRankSteps(moments, now, FIT)) : { ...PRIOR, fitAt: now };
        put.run(KEY, JSON.stringify(this.model));
      } else this.model = { ...this.model, fitAt: now };
      if (mail) {
        this.mailModel = { ...(withMail.length ? await run(fitRankSteps(withMail, now, FIT)) : { ...PRIOR, fitAt: now }), v: MAIL_MODEL_VERSION };
        put.run(MAIL_KEY, JSON.stringify(this.mailModel));
      }
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
      if (!this.busy && this.due()) this.refit().catch((e) => (console.error('inbox ranking: refit failed', e), jobFailed('inbox ranking: refit', e)));
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
