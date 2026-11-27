/**
 * The loudness replay (docs/notifications.md, "The numbers"): the last days of a hub's decisions put through the one
 * loudness scale (loudness.ts) as it starts, before any answer, against what the tiers did with the same messages.
 * Counts and rates only, never message text, names or ids.
 *
 *   bun scripts/loudness-replay.ts --live <hub.sqlite> --out <scratch dir> [--days 30]
 *   bun scripts/loudness-replay.ts --db <a copy> --out <scratch dir>
 *
 * It never opens the live database for writing: it copies it with VACUUM INTO (read-only) and works on the copy. Each
 * message's start is what triage stored with it then (its facts, the local model's answer, the two chances), so
 * nothing is asked of the local model again. The moment is read from the visit log (a computer in use within two
 * minutes), quiet hours as set now, and "minutes since the last sound" from the replay's own sounds.
 *
 * Reports: sounds a day (each message, and as the devices would sound them: once a chat's burst of five minutes),
 * every band against the tiers, and of the messages you answered within 30 minutes, the share at "show" or louder.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { words, type Facts } from '../packages/hub/src/learn.ts';
import { emptyAttnModel, loudness, TIER_BAND } from '../packages/hub/src/loudness.ts';
import { Interactions, SELF_SQL } from '../packages/hub/src/interact.ts';
import { inQuietHours } from '../packages/hub/src/quiethours.ts';
import { Store } from '../packages/hub/src/store.ts';
import { conversingAll } from '../packages/hub/src/tiers.ts';
import { Triage } from '../packages/hub/src/triage.ts';
import { PHONE } from '../packages/hub/src/delivery.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BANDS: P.LoudBand[] = ['sound', 'show', 'inbox', 'unread'];

const argv = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const outDir = resolve(opt('out', join(import.meta.dir, '..', '.replay'))!);
const days = Number(opt('days', '30'));
const readily = (opt('readily', 'learned') as P.AttentionPrefs['readily']) ?? 'learned';

function copyLive(): string {
  const given = opt('db');
  if (given) return resolve(given);
  const live = resolve(opt('live', join(import.meta.dir, '..', '.data', 'hub.sqlite'))!);
  if (!existsSync(live)) throw new Error(`no database at ${live}: pass --live <hub.sqlite> or --db <copy>`);
  mkdirSync(outDir, { recursive: true });
  const copy = join(outDir, `hub-copy-${Date.now()}.sqlite`);
  const src = new Database(live, { readonly: true });
  src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  src.close();
  return copy;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function main() {
  const store = new Store(copyLive(), () => null);
  const db = store.db;
  const triage = new Triage(store);
  const end = (db.query(`SELECT MAX(created_at) AS t FROM triage`).get() as Row).t as number;
  const from = end - days * DAY;
  const rows = db
    .query(
      `SELECT t.message_id AS id, m.conversation_id AS conv, m.ts, t.created_at AS at, m.body, t.decision, t.facts, t.probs
       FROM triage t JOIN message m ON m.id = t.message_id
       WHERE t.created_at >= ? AND t.decision != 'silent' AND t.facts IS NOT NULL AND (m.author_id IS NULL OR m.author_id NOT IN ${SELF_SQL})
         AND ABS(t.created_at - m.ts) < ${HOUR} ORDER BY m.ts`,
    )
    .all(from) as Row[];
  // Live messages only (decided within the hour of arriving): history fetched later never notified anyone.
  console.error(`${rows.length} decisions over ${days} days`);
  const alwaysPeople = new Set(store.rules().filter((r) => r.scope === 'person' && r.level === 'all' && r.target).map((r) => r.target!));
  const always = new Map<string, boolean>();

  // The Conversation reasons as of each message, from a fold of who wrote when; your answers within 30 minutes.
  const fold = new Interactions();
  const wanted = new Map(rows.map((r) => [r.id as string, r]));
  const whys = new Map<string, ReturnType<typeof conversingAll>>();
  const quick = new Set<string>();
  const pending = new Map<string, { id: string; ts: number }[]>();
  for (const m of db
    .query(
      `SELECT m.id, m.conversation_id AS conv, m.ts, COALESCE(i.person_id, m.author_id) AS author, m.author_id IN ${SELF_SQL} AS mine
       FROM message m LEFT JOIN identity i ON i.id = m.author_id WHERE m.ts >= ? AND m.ts <= ? AND m.deleted = 0 ORDER BY m.ts`,
    )
    .iterate(from - 60 * DAY, end + HOUR) as Iterable<Row>) {
    const r = wanted.get(m.id);
    if (r) {
      const f = JSON.parse(r.facts) as Facts;
      whys.set(m.id, conversingAll(f, { lastOwn: fold.lastOwn(m.conv), answerRate: fold.answerRate(m.conv, m.ts) }, m.ts));
      (pending.get(m.conv) ?? pending.set(m.conv, []).get(m.conv)!).push({ id: m.id, ts: m.ts });
    }
    if (m.mine) {
      for (const p of pending.get(m.conv) ?? []) if (m.ts - p.ts <= 30 * MIN) quick.add(p.id);
      pending.delete(m.conv);
    }
    fold.message({ conv: m.conv, ts: m.ts, author: m.author, mine: !!m.mine });
  }

  // A computer in use: a visit from a device that is not a phone, active, spanning the moment (two minutes' slack).
  const desks = (db.query(`SELECT start_at, end_at, device_label FROM visit WHERE end_at >= ? AND active > 0 ORDER BY start_at`).all(from - HOUR) as Row[]).filter((v) => !PHONE.test(v.device_label ?? ''));
  const deskAt = (ts: number) => desks.some((v) => v.start_at - 2 * MIN <= ts && ts <= v.end_at + 2 * MIN);
  const quiet = store.quietHours();

  const model = emptyAttnModel();
  let lastSound: number | null = null;
  const chatSound = new Map<string, number>();
  const tz = -new Date().getTimezoneOffset() * MIN;
  const dayOf = (ts: number) => Math.floor((ts + tz) / DAY);
  const byDay = new Map<number, { sounds: number; buzzes: number; tierPush: number; tierBuzz: number; n: number }>();
  const cross: Record<string, Record<string, number>> = {};
  const quickBand: Record<string, number> = {};
  const quickTier: Record<string, number> = {};
  const quickMissWhy: Record<string, number> = {};
  const tierChat = new Map<string, number>();
  for (const r of rows) {
    const f = JSON.parse(r.facts) as Facts;
    const probs = r.probs ? (JSON.parse(r.probs) as Partial<P.TriageProbs>) : {};
    if (!always.has(r.conv)) {
      const eff = triage.effectiveLevel(r.conv);
      always.set(r.conv, eff.level === 'all' && !eff.native);
    }
    const forced = always.get(r.conv) || (f.author !== null && alwaysPeople.has(f.author));
    const out = loudness(
      {
        facts: f,
        words: words(r.body ?? ''),
        importance: typeof probs.important === 'number' ? probs.important : 0.3,
        ...(f.judge !== undefined && typeof probs.alert === 'number' ? { alert: probs.alert } : {}),
        why: whys.get(r.id) ?? [],
        moment: { desk: deskAt(r.ts), hour: new Date(r.ts).getHours(), sinceSound: lastSound !== null ? r.ts - lastSound : null, quiet: inQuietHours(quiet, r.ts) },
        ...(forced ? { rule: 'always' as const } : f.cap ? { rule: 'list' as const } : {}),
      },
      model,
      readily,
    );
    const d = dayOf(r.at);
    const day = byDay.get(d) ?? byDay.set(d, { sounds: 0, buzzes: 0, tierPush: 0, tierBuzz: 0, n: 0 }).get(d)!;
    day.n++;
    if (out.band === 'sound') {
      day.sounds++;
      // The devices sound once a chat's burst (delivery.ts BURST_MS).
      if (!chatSound.has(r.conv) || r.ts - chatSound.get(r.conv)! >= 5 * MIN) day.buzzes++;
      chatSound.set(r.conv, r.ts);
      lastSound = r.ts;
    }
    if (r.decision === 'push') {
      day.tierPush++;
      if (!tierChat.has(r.conv) || r.ts - tierChat.get(r.conv)! >= 5 * MIN) day.tierBuzz++;
      tierChat.set(r.conv, r.ts);
    }
    const tb = TIER_BAND[r.decision as P.NotifyTier] ?? 'unread';
    (cross[tb] ??= {})[out.band] = (cross[tb][out.band] ?? 0) + 1;
    if (quick.has(r.id)) {
      quickBand[out.band] = (quickBand[out.band] ?? 0) + 1;
      quickTier[tb] = (quickTier[tb] ?? 0) + 1;
      if (out.band !== 'sound' && out.band !== 'show') {
        const w = out.parts.wait;
        const k = `${out.band} (tier ${tb}): ${f.shape}${(whys.get(r.id) ?? []).length ? '' : ' no-reason'}${f.judge === undefined ? ' unjudged' : ''}${f.cap ? ' list-only' : ''} want${out.parts.want >= 0.8 ? '>=.8' : out.parts.want >= 0.5 ? '>=.5' : '<.5'} keeps-${['min', 'hour', 'today', 'days'][w.indexOf(Math.max(...w))]}`;
        quickMissWhy[k] = (quickMissWhy[k] ?? 0) + 1;
      }
    }
  }
  const ds = [...byDay.values()].filter((d) => d.n >= 50);
  const mean = (k: keyof (typeof ds)[number]) => r1(ds.reduce((s, d) => s + (d[k] as number), 0) / Math.max(1, ds.length));
  const nQuick = Object.values(quickBand).reduce((a, b) => a + b, 0);
  const report = {
    days: ds.length,
    decisions: rows.length,
    readily,
    perDay: { soundMessages: mean('sounds'), soundBuzzes: mean('buzzes'), tierAlerts: mean('tierPush'), tierBuzzes: mean('tierBuzz') },
    maxDay: { soundBuzzes: Math.max(0, ...ds.map((d) => d.buzzes)), tierBuzzes: Math.max(0, ...ds.map((d) => d.tierBuzz)) },
    quick: {
      answeredWithin30: nQuick,
      atShowOrLouder: r3(((quickBand.sound ?? 0) + (quickBand.show ?? 0)) / Math.max(1, nQuick)),
      tiersAlertOrConversation: r3(((quickTier.sound ?? 0) + (quickTier.show ?? 0)) / Math.max(1, nQuick)),
      byBand: quickBand,
      belowShowByKind: quickMissWhy,
    },
    tiersAgainstBands: cross,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'loudness-replay.json'), JSON.stringify(report, null, 2));
  const md = [
    `# Loudness replay`,
    '',
    `${rows.length} decisions over ${ds.length} days (days with 50 or more), the scale as it starts (no answers yet), nudge "${readily}".`,
    '',
    `| A day | Loudness | Tiers |`,
    `| --- | --- | --- |`,
    `| Messages that would sound | ${report.perDay.soundMessages} | ${report.perDay.tierAlerts} |`,
    `| Sounds on the devices (once a chat's five minutes) | ${report.perDay.soundBuzzes} | ${report.perDay.tierBuzzes} |`,
    `| Busiest day's sounds | ${report.maxDay.soundBuzzes} | ${report.maxDay.tierBuzzes} |`,
    '',
    `Answered within 30 minutes: ${nQuick} messages; at "show" or louder ${Math.round(report.quick.atShowOrLouder * 1000) / 10}% (tiers: an alert or a Conversation ${Math.round(report.quick.tiersAlertOrConversation * 1000) / 10}%).`,
    '',
    `Below "show" among them, by kind: ${Object.entries(quickMissWhy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`,
    '',
    `## Bands against the tiers (rows: the tier, as a band; columns: the loudness)`,
    '',
    `| | ${BANDS.join(' | ')} |`,
    `| --- | ${BANDS.map(() => '---').join(' | ')} |`,
    ...BANDS.map((t) => `| ${t} | ${BANDS.map((b) => cross[t]?.[b] ?? 0).join(' | ')} |`),
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'loudness-replay.md'), md);
  console.log(md);
  store.db.close();
}

main();
