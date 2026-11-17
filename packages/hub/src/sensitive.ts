/**
 * Sensitive messages (docs/sensitive.md). The local model (jev) is asked one question about each message's text, and its
 * P(yes) is kept per question version. The page covers a message from one line on that chance up and hides it from a
 * second (protocol sensitive.ts `sensitiveLevel`). On a covered or hidden message, and from a message's menu, you say
 * whether it is sensitive; those answers score each question (agreement at the cover line, average precision), and a
 * new question is tried on them before it is put in use. Putting one in use asks it again about recent messages.
 *
 * Only the message's text is judged (with "[picture]" and the like for its files): the model reads no pictures. The
 * model is on this machine; nothing leaves it.
 *
 *   GET   /api/sensitive                       SensitiveState
 *   PATCH /api/sensitive/settings              Partial<SensitiveSettings> -> SensitiveSettings
 *   POST  /api/sensitive/prompts               { question } -> SensitiveTrial (tried on your answers, not in use)
 *   POST  /api/sensitive/prompts/:v/adopt      -> SensitiveState
 *   GET   /api/sensitive/disagreements?v=      { items: SensitiveDisagreement[], messages, identities }
 *   POST  /api/messages/:id/sensitive          { vote: boolean | null }
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { SENSITIVE_DEFAULTS } from '@dither-chat/protocol';
import { averagePrecision } from './embeddings.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;
export type SensitiveJudge = (question: string, texts: string[]) => Promise<(number | null)[]>;

export const DEFAULT_QUESTION = 'Is this message sensitive, something to keep off a screen others can see: about health, sex, violence, money trouble, grief, or anything private or upsetting?';
/** The demo hub's stand-in for the model: a few words. */
export const DEMO_WORDS = /\b(diagnos\w*|scan|biopsy|hospital|therap\w*|debt|overdraft|funeral|passed away|nude\w*|blood|password)\b/i;
export const demoJudge: SensitiveJudge = async (_q, texts) => texts.map((t) => (DEMO_WORDS.test(t) ? 0.85 : /\b(doctor|money|sad|cry)\b/i.test(t) ? 0.5 : 0.03));

/** Messages asked about in one call. */
const BATCH = 64;
/** Recent messages asked again when a question is put in use. */
const RESCORE = 2000;
/** The most messages waiting; past it the oldest are dropped (they stay unjudged and shown). */
const MAX_PENDING = 20_000;
/** After the model failed, wait this long before asking again. */
const BACKOFF_MS = 60_000;

export function sensitiveTables(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS sensitive_prompt (
    version    INTEGER PRIMARY KEY,
    question   TEXT NOT NULL,
    made_at    INTEGER NOT NULL,
    adopted_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sensitive_score (
    message_id TEXT NOT NULL,
    version    INTEGER NOT NULL,
    p          REAL NOT NULL,
    at         INTEGER NOT NULL,
    PRIMARY KEY (message_id, version)
  ) WITHOUT ROWID`);
  db.run(`CREATE TABLE IF NOT EXISTS sensitive_vote (
    message_id TEXT PRIMARY KEY,
    vote       INTEGER NOT NULL,  -- 1 sensitive, 0 fine
    p          REAL,              -- the chance it was shown with
    version    INTEGER,
    at         INTEGER NOT NULL
  ) WITHOUT ROWID`);
}

/** The text the model reads: the body, and a word for each file. */
export function judgeText(body: string, kinds: string[]): string | null {
  const files = kinds.map((k) => `[${k.startsWith('image') ? 'picture' : k.startsWith('video') ? 'video' : k.startsWith('audio') ? 'voice message' : 'file'}]`);
  const t = [body.trim().slice(0, 2000), ...files].filter(Boolean).join(' ');
  return t.length >= 2 ? t : null;
}

/** How a question's chances agree with your answers, at a cover line. */
export function agreementOf(version: number, pairs: { p: number | null; vote: boolean }[], cover: number): P.SensitiveAgreement {
  const judged = pairs.filter((x): x is { p: number; vote: boolean } => x.p != null);
  const matrix = { yesSensitive: 0, yesFine: 0, noSensitive: 0, noFine: 0 };
  for (const x of judged) {
    const yes = x.p >= cover;
    if (yes && x.vote) matrix.yesSensitive++;
    else if (yes) matrix.yesFine++;
    else if (x.vote) matrix.noSensitive++;
    else matrix.noFine++;
  }
  const n = judged.length;
  const ap = averagePrecision(judged.map((x) => x.p), judged.map((x) => (x.vote ? 1 : 0)));
  // The best line: each distinct chance (and just above the highest) tried as the cover line.
  let best: { line: number; agreement: number } | null = null;
  const lines = [...new Set(judged.map((x) => x.p))].sort((a, b) => a - b);
  for (const line of [...lines, 1.0001]) {
    const a = judged.filter((x) => x.p >= line === x.vote).length / n;
    if (!best || a > best.agreement + 1e-9) best = { line: Math.min(1, Math.round(line * 1000) / 1000), agreement: a };
  }
  return { version, n, unjudged: pairs.length - n, matrix, agreement: n ? (matrix.yesSensitive + matrix.noFine) / n : null, ap: Number.isNaN(ap) ? null : ap, best: n ? best : null };
}

interface SensitiveDeps {
  store: Store;
  /** The model; null when there is none (only your answers count). */
  judge: SensitiveJudge | null;
  model: string | null;
  flush: () => void;
  messages: (ids: string[]) => { messages: P.MessageView[]; identities: P.IdentityView[] };
  now?: () => number;
}

class Refused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class Sensitive {
  private pending = new Set<string>();
  private running: Promise<void> | null = null;
  private resting = 0;

  constructor(private d: SensitiveDeps) {
    sensitiveTables(this.db);
    if (!this.db.query('SELECT 1 FROM sensitive_prompt LIMIT 1').get()) {
      const now = this.now();
      this.db.query('INSERT INTO sensitive_prompt (version, question, made_at, adopted_at) VALUES (1, ?, ?, ?)').run(DEFAULT_QUESTION, now, now);
    }
  }

  private get db() {
    return this.d.store.db;
  }
  private now() {
    return this.d.now?.() ?? Date.now();
  }

  static handles(path: string): boolean {
    return path === '/api/sensitive' || path.startsWith('/api/sensitive/') || /^\/api\/messages\/[\w-]+\/sensitive$/.test(path);
  }

  // ---------------------------------------------------------------- settings and questions

  settings(): P.SensitiveSettings {
    const r = this.db.query(`SELECT value FROM meta WHERE key = 'sensitive_settings'`).get() as Row | null;
    try {
      return { ...SENSITIVE_DEFAULTS, ...(r ? JSON.parse(r.value) : {}) };
    } catch {
      return { ...SENSITIVE_DEFAULTS };
    }
  }

  setSettings(patch: Partial<P.SensitiveSettings>): P.SensitiveSettings {
    const s = { ...this.settings() };
    if (typeof patch.on === 'boolean') s.on = patch.on;
    if (patch.style === 'blur' || patch.style === 'bar') s.style = patch.style;
    if (patch.top === 'line' || patch.top === 'gone') s.top = patch.top;
    const unit = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : null);
    const cover = unit(patch.cover);
    const hide = unit(patch.hide);
    if (cover != null) s.cover = cover;
    if (hide != null) s.hide = hide;
    // The lines keep their order: the one moved pushes the other.
    if (s.hide < s.cover) cover != null ? (s.hide = s.cover) : (s.cover = s.hide);
    this.db.query(`INSERT INTO meta (key, value) VALUES ('sensitive_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(s));
    return s;
  }

  /** The question in use: the one adopted last. */
  version(): number {
    return ((this.db.query('SELECT version FROM sensitive_prompt WHERE adopted_at IS NOT NULL ORDER BY adopted_at DESC, version DESC LIMIT 1').get() as Row | null)?.version as number) ?? 1;
  }

  private question(version: number): string | null {
    return ((this.db.query('SELECT question FROM sensitive_prompt WHERE version = ?').get(version) as Row | null)?.question as string) ?? null;
  }

  prompts(): P.SensitivePromptView[] {
    const inUse = this.version();
    return (this.db.query('SELECT * FROM sensitive_prompt ORDER BY version DESC').all() as Row[]).map((r) => ({ version: r.version, question: r.question, madeAt: r.made_at, adoptedAt: r.adopted_at ?? null, inUse: r.version === inUse }));
  }

  state(): P.SensitiveState {
    const settings = this.settings();
    const version = this.version();
    return { settings, version, prompts: this.prompts(), agreement: this.agreement(version, settings.cover), model: this.d.judge ? this.d.model : null, pending: this.pending.size };
  }

  // ---------------------------------------------------------------- your answers

  vote(messageId: string, vote: boolean | null) {
    if (!this.db.query('SELECT 1 FROM message WHERE id = ?').get(messageId)) throw new Refused('No such message', 404);
    if (vote === null) this.db.query('DELETE FROM sensitive_vote WHERE message_id = ?').run(messageId);
    else {
      const shown = this.marks([messageId]).get(messageId);
      this.db
        .query(`INSERT INTO sensitive_vote (message_id, vote, p, version, at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(message_id) DO UPDATE SET vote = excluded.vote, p = excluded.p, version = excluded.version, at = excluded.at`)
        .run(messageId, vote ? 1 : 0, shown?.p ?? null, shown?.v ?? null, this.now());
    }
    this.touched([messageId]);
  }

  private votes(version: number): { id: string; p: number | null; vote: boolean }[] {
    return (this.db.query('SELECT v.message_id AS id, v.vote, s.p FROM sensitive_vote v LEFT JOIN sensitive_score s ON s.message_id = v.message_id AND s.version = ?').all(version) as Row[]).map((r) => ({ id: r.id, p: r.p ?? null, vote: !!r.vote }));
  }

  agreement(version: number, cover = this.settings().cover): P.SensitiveAgreement {
    return agreementOf(version, this.votes(version), cover);
  }

  /** Where a question and your answers part, the furthest apart first. */
  disagreements(version: number, cover = this.settings().cover): P.SensitiveDisagreement[] {
    return this.votes(version)
      .filter((x): x is { id: string; p: number; vote: boolean } => x.p != null && x.p >= cover !== x.vote)
      .sort((a, b) => Math.abs(b.p - cover) - Math.abs(a.p - cover))
      .map((x) => ({ messageId: x.id, p: x.p, vote: x.vote }));
  }

  // ---------------------------------------------------------------- trying and adopting a question

  /** A new question, asked about every message you answered on, scored against your answers. Not put in use. */
  async trial(question: string): Promise<P.SensitiveTrial> {
    const q = question.trim().replace(/\s+/g, ' ');
    if (q.length < 8 || q.length > 600) throw new Refused('A question of 8 to 600 characters');
    if (!this.d.judge) throw new Refused('No model to ask', 503);
    let version = (this.db.query('SELECT version FROM sensitive_prompt WHERE question = ?').get(q) as Row | null)?.version as number | undefined;
    if (!version) {
      version = (((this.db.query('SELECT MAX(version) AS v FROM sensitive_prompt').get() as Row).v as number) ?? 0) + 1;
      this.db.query('INSERT INTO sensitive_prompt (version, question, made_at) VALUES (?, ?, ?)').run(version, q, this.now());
    }
    const voted = (this.db.query('SELECT message_id AS id FROM sensitive_vote').all() as Row[]).map((r) => r.id as string);
    await this.score(voted, version);
    // The question in use, too, may not have judged every answer (an answer from a message's menu on an old message).
    const inUse = this.version();
    await this.score(voted, inUse);
    const cover = this.settings().cover;
    return { prompt: this.prompts().find((p) => p.version === version)!, agreement: this.agreement(version, cover), inUse: this.agreement(inUse, cover) };
  }

  adopt(version: number) {
    if (!this.question(version)) throw new Refused('No such question', 404);
    this.db.query('UPDATE sensitive_prompt SET adopted_at = ? WHERE version = ?').run(this.now(), version);
    const recent = (this.db.query(`SELECT id FROM message WHERE kind != 'system' AND deleted = 0 ORDER BY ts DESC LIMIT ${RESCORE}`).all() as Row[]).map((r) => r.id as string);
    this.later(recent.reverse());
  }

  // ---------------------------------------------------------------- asking the model

  /** New (or edited) messages: asked about in the background, in order. */
  later(ids: string[]) {
    if (!this.d.judge) return;
    for (const id of ids) {
      this.pending.delete(id);
      this.pending.add(id);
    }
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.values().next().value!);
    // After the ingest that stored them has committed.
    queueMicrotask(() => this.kick());
  }

  private kick() {
    if (this.running || !this.pending.size || this.now() < this.resting) return;
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.pending.size && this.now() >= this.resting) this.kick();
    });
  }

  /** Resolves when nothing is waiting (tests). */
  async idle() {
    await null; // the kick a `later` put off
    while (this.running) await this.running;
  }

  private async drain() {
    while (this.pending.size) {
      const version = this.version();
      const batch = [...this.pending].slice(0, BATCH);
      try {
        await this.score(batch, version);
        for (const id of batch) this.pending.delete(id);
      } catch (e) {
        console.error(`sensitive: ${(e as Error).message}; asking again in a minute`);
        this.resting = this.now() + BACKOFF_MS;
        setTimeout(() => this.kick(), BACKOFF_MS).unref?.();
        return;
      }
    }
  }

  /** Asks one question about the messages it has not judged yet; keeps the answers and redraws those messages. */
  private async score(ids: string[], version: number) {
    const question = this.question(version);
    if (!question || !this.d.judge || !ids.length) return;
    const judged = new Set((this.db.query(`SELECT message_id FROM sensitive_score WHERE version = ? AND message_id IN (SELECT value FROM json_each(?))`).all(version, JSON.stringify(ids)) as Row[]).map((r) => r.message_id as string));
    const todo = this.texts(ids.filter((id) => !judged.has(id)));
    for (let i = 0; i < todo.length; i += BATCH) {
      const part = todo.slice(i, i + BATCH);
      const p = await this.d.judge(question, part.map((x) => x.text));
      const now = this.now();
      const put = this.db.query('INSERT OR REPLACE INTO sensitive_score (message_id, version, p, at) VALUES (?, ?, ?, ?)');
      this.db.transaction(() => part.forEach((x, j) => p[j] != null && Number.isFinite(p[j]) && put.run(x.id, version, Math.round(Math.max(0, Math.min(1, p[j]!)) * 1000) / 1000, now)))();
      this.touched(part.map((x) => x.id));
    }
  }

  private texts(ids: string[]): { id: string; text: string }[] {
    if (!ids.length) return [];
    const rows = this.db.query(`SELECT id, body FROM message WHERE id IN (SELECT value FROM json_each(?)) AND kind != 'system' AND deleted = 0`).all(JSON.stringify(ids)) as Row[];
    const kinds = new Map<string, string[]>();
    for (const a of this.db.query(`SELECT message_id, mime FROM attachment WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY position`).all(JSON.stringify(ids)) as Row[]) (kinds.get(a.message_id) ?? kinds.set(a.message_id, []).get(a.message_id)!).push(a.mime ?? '');
    return rows.flatMap((r) => {
      const text = judgeText(r.body ?? '', kinds.get(r.id) ?? []);
      return text ? [{ id: r.id as string, text }] : [];
    });
  }

  private touched(ids: string[]) {
    const dirty = this.d.store.dirty.messages;
    for (const id of ids) dirty.set(id, dirty.get(id) ?? false);
    this.d.flush();
  }

  // ---------------------------------------------------------------- what message views carry

  /** Each message's chance (from the question in use, else the newest that judged it) and your answer. */
  marks(ids: string[]): Map<string, P.SensitiveMark> {
    const out = new Map<string, P.SensitiveMark>();
    if (!ids.length) return out;
    const inUse = this.version();
    const list = JSON.stringify(ids);
    for (const r of this.db.query(`SELECT message_id, version, p FROM sensitive_score WHERE message_id IN (SELECT value FROM json_each(?))`).all(list) as Row[]) {
      const had = out.get(r.message_id);
      if (!had || (had.v !== inUse && (r.version === inUse || r.version > had.v))) out.set(r.message_id, { p: r.p, v: r.version });
    }
    for (const r of this.db.query(`SELECT message_id, vote, p, version FROM sensitive_vote WHERE message_id IN (SELECT value FROM json_each(?))`).all(list) as Row[]) {
      out.set(r.message_id, { ...(out.get(r.message_id) ?? { p: r.p ?? 0, v: r.version ?? inUse }), vote: !!r.vote });
    }
    return out;
  }

  // ---------------------------------------------------------------- routes

  async route(req: Request, url: URL, path: string): Promise<Response | null> {
    const method = req.method;
    const body = async <T>() => ((await req.json().catch(() => ({}))) ?? {}) as T;
    try {
      if (path === '/api/sensitive' && method === 'GET') return Response.json(this.state());
      if (path === '/api/sensitive/settings' && method === 'PATCH') {
        return Response.json(this.setSettings(await body<Partial<P.SensitiveSettings>>()));
      }
      if (path === '/api/sensitive/prompts' && method === 'POST') {
        const b = await body<{ question?: unknown }>();
        if (typeof b.question !== 'string') throw new Refused('Say question');
        return Response.json(await this.trial(b.question));
      }
      let m = path.match(/^\/api\/sensitive\/prompts\/(\d+)\/adopt$/);
      if (m && method === 'POST') {
        this.adopt(Number(m[1]));
        return Response.json(this.state());
      }
      if (path === '/api/sensitive/disagreements' && method === 'GET') {
        const v = Number(url.searchParams.get('v')) || this.version();
        const items = this.disagreements(v).slice(0, 100);
        return Response.json({ items, ...this.d.messages(items.map((x) => x.messageId)) });
      }
      m = path.match(/^\/api\/messages\/([\w-]+)\/sensitive$/);
      if (m && method === 'POST') {
        const b = await body<{ vote?: unknown }>();
        if (b.vote !== null && typeof b.vote !== 'boolean') throw new Refused('Say vote: true, false or null');
        this.vote(m[1], b.vote);
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (e) {
      if (e instanceof Refused) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  }
}
