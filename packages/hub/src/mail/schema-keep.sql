-- Keeping all mail (docs/mail.md "Keeping all mail", hub/src/mail/keep.ts): which accounts keep everything, how the
-- server's own search compares with what the hub holds, and the month windows audited on Gmail.

-- Set for an account here; one with no row keeps all of its mail when MailHub's keepAll says so (the hub main.ts runs:
-- on by default).
CREATE TABLE IF NOT EXISTS mail_keep (
  account_id  TEXT PRIMARY KEY REFERENCES mail_account(id) ON DELETE CASCADE,
  keep        INTEGER NOT NULL,
  paused      INTEGER NOT NULL DEFAULT 0
);

-- Each time a page asked a server's search (GET /api/mail/search with the servers), per account: its hits, how many
-- the hub held before the search stored them, how many of those had body text here, and how many the hub's own
-- search for the same query found. The query itself is not kept.
CREATE TABLE IF NOT EXISTS mail_search_measure (
  n           INTEGER PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  found       INTEGER NOT NULL,
  held        INTEGER NOT NULL,
  bodies      INTEGER NOT NULL,
  local       INTEGER NOT NULL,
  full        INTEGER NOT NULL DEFAULT 0      -- the answer was as long as asked: the server may have more
);
CREATE INDEX IF NOT EXISTS mail_search_measure_at ON mail_search_measure(account_id, at);

-- Gmail: a window of time searched on the server with operators only, its ids compared with what the hub holds.
-- `start` 0 is everything before the first month the hub holds.
CREATE TABLE IF NOT EXISTS mail_audit (
  account_id  TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  start       INTEGER NOT NULL,
  end         INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'todo',   -- todo | match | missed (found mail the hub had not) | full (a window too busy to tell)
  server      INTEGER,                        -- messages the server's search found in it
  held        INTEGER,                        -- of those, held here when it was searched
  caught      INTEGER NOT NULL DEFAULT 0,     -- missing here, stored since (all the times it was searched)
  estimate    INTEGER,                        -- the server's own estimate, from an ids-only search
  searches    INTEGER NOT NULL DEFAULT 0,     -- calls it took the last time
  checked_at  INTEGER,
  PRIMARY KEY (account_id, start)
);
