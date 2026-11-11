/**
 * MailStore opening a mail database an older hub made (store.ts MAIL_COLUMNS). #95 put an index on mail_text.cut into
 * a schema file, and the live hub's mail_text, made before `cut`, failed it on start: old-database.test.ts's fixtures
 * then predated mail, so its tables were always made fresh. Here every fixture in test/fixtures/old-db that has mail
 * tables is opened by MailStore, and must end up with what a new database has: the same columns, indexes and
 * triggers, and its rows.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIL_LIMITS } from '../src/mail/limits.ts';
import { MAIL_COLUMNS, MailStore, mailSchemas } from '../src/mail/store.ts';

const fixtures = join(import.meta.dir, 'fixtures/old-db');

const columns = (db: Database, table: string) => (db.query(`SELECT name FROM pragma_table_info(?) ORDER BY name`).all(table) as { name: string }[]).map((c) => c.name);
/** The mail tables, and the indexes and triggers on them, by name. */
const mailTables = (db: Database) =>
  (db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'mail%' OR name = 'mailbox') AND name NOT LIKE 'mail_fts_%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
const objects = (db: Database, type: 'index' | 'trigger') =>
  (db.query(`SELECT name FROM sqlite_master WHERE type = ? AND (tbl_name LIKE 'mail%' OR tbl_name = 'mailbox') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all(type) as { name: string }[]).map((o) => o.name);

function fresh(): Database {
  const db = new Database(':memory:', { strict: true });
  db.exec('PRAGMA foreign_keys = ON');
  new MailStore(db);
  return db;
}

describe('the mail schema', () => {
  test('every column MailStore adds to an older table is in its CREATE TABLE too', () => {
    const db = new Database(':memory:', { strict: true });
    for (const sql of mailSchemas()) db.exec(sql);
    for (const [table, cols] of Object.entries(MAIL_COLUMNS)) {
      const have = columns(db, table);
      expect(have.length).toBeGreaterThan(0);
      for (const c of Object.keys(cols)) expect({ table, column: c, made: have.includes(c) }).toEqual({ table, column: c, made: true });
    }
  });

  test('a new database opens twice (the second start changes nothing)', () => {
    const db = fresh();
    const before = mailTables(db).map((t) => [t, columns(db, t)]);
    new MailStore(db);
    expect(mailTables(db).map((t) => [t, columns(db, t)])).toEqual(before);
  });
});

const old = readdirSync(fixtures)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ name: f.slice(0, -5), fx: JSON.parse(readFileSync(join(fixtures, f), 'utf8')) as { commit: string; committed: string; tables: string[] } }))
  .filter((f) => f.fx.tables.includes('mail_account'));

test('there is a fixture with mail tables', () => {
  expect(old.length).toBeGreaterThan(0);
});

for (const { name, fx } of old) {
  describe(`a mail database from ${fx.committed.slice(0, 10)} (${fx.commit.slice(0, 12)})`, () => {
    test('MailStore opens it and it ends up as a new one is, rows kept', () => {
      const db = Database.deserialize(Bun.gunzipSync(readFileSync(join(fixtures, `${name}.sqlite.gz`))));
      db.exec('PRAGMA foreign_keys = ON');
      const count = (t: string) => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
      const rows = Object.fromEntries(mailTables(db).map((t) => [t, count(t)]));
      expect(rows.mail_message).toBeGreaterThan(0);

      new MailStore(db);

      const now = fresh();
      expect(mailTables(db)).toEqual(mailTables(now));
      for (const t of mailTables(now)) expect({ table: t, columns: columns(db, t) }).toEqual({ table: t, columns: columns(now, t) });
      expect(objects(db, 'index')).toEqual(objects(now, 'index'));
      expect(objects(db, 'trigger')).toEqual(objects(now, 'trigger'));
      for (const [t, n] of Object.entries(rows)) expect({ table: t, rows: count(t) }).toEqual({ table: t, rows: n });
      // What the migration fills in: where old search text was cut, and the full-text index (made again with `files`).
      const longCut = db.query(`SELECT count(*) AS n FROM mail_text WHERE length(text) >= ? AND cut != ?`).get(MAIL_LIMITS.textBytes, MAIL_LIMITS.textBytes) as { n: number };
      expect(longCut.n).toBe(0);
      expect(count('mail_search')).toBe(rows.mail_search);
      expect((db.query(`SELECT count(*) AS n FROM mail_fts`).get() as { n: number }).n).toBe(rows.mail_search);
      // And it opens again as it is.
      new MailStore(db);
      for (const t of mailTables(now)) expect(columns(db, t)).toEqual(columns(now, t));
    });
  });
}
