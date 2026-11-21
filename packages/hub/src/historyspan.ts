/**
 * Stretches of a conversation's history known whole (`history_span`): each page an index job or a catch-up fetched
 * covers from its oldest message to where it started, and spans that touch are merged. A walk back jumps over them,
 * so what was fetched once is not fetched again (docs/indexing.md "History, and why a repeat is cheap";
 * docs/catch-up.md).
 */
import type { Store } from './store.ts';

type Row = Record<string, any>;

/** The span `ts` falls in (from_ts exclusive, to_ts inclusive), or null. */
export function spanAt(store: Store, cid: string, ts: number): Row | null {
  return store.one<Row>('SELECT * FROM history_span WHERE conversation_id = ? AND from_ts < ? AND to_ts >= ? ORDER BY from_ts LIMIT 1', cid, ts, ts);
}

/** [from, to] is known whole: merged with any span it touches. */
export function addSpan(store: Store, cid: string, from: number, to: number) {
  store.db.transaction(() => {
    const touching = store.raw<Row>('SELECT * FROM history_span WHERE conversation_id = ? AND from_ts <= ? AND to_ts >= ?', cid, to, from);
    let lo = from;
    let hi = to;
    for (const s of touching) {
      lo = Math.min(lo, s.from_ts);
      hi = Math.max(hi, s.to_ts);
    }
    store.db.query('DELETE FROM history_span WHERE conversation_id = ? AND from_ts <= ? AND to_ts >= ?').run(cid, to, from);
    store.db.query('INSERT INTO history_span (conversation_id, from_ts, to_ts) VALUES (?, ?, ?)').run(cid, lo, hi);
  })();
}
