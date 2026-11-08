-- Writes (mail/ops.ts, docs/mail-design.md §2.4, §3.7): what the hub changed here and has yet to tell the server.
-- A change shows at once (mail_message.pending says which, and what the server had); the call waits here, batched
-- per account, op and value, up to 1000 messages, until the server answers.

CREATE TABLE IF NOT EXISTS mail_op (
  id          TEXT PRIMARY KEY,                 -- mop_
  account_id  TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  op          TEXT NOT NULL,                    -- flag | move
  args        TEXT NOT NULL,                    -- JSON: {"seen":1} | {"flagged":0} | {"to":"mbx_…"}
  message_ids TEXT NOT NULL DEFAULT '[]',       -- JSON: hub message ids, at most 1000
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL,
  error       TEXT,                             -- the last failure, while it is retried
  sent_at     INTEGER,                          -- a call is out with it: nothing joins it now
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_op_due ON mail_op(account_id, next_at);

-- Messages with a change the server has not confirmed: a thread's "waiting" mark, an account's count.
CREATE INDEX IF NOT EXISTS mail_message_pending ON mail_message(thread_id) WHERE pending IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_message_pending_acc ON mail_message(account_id) WHERE pending IS NOT NULL;

-- Ops an account answered 501 to (Proton's `answered`): asked for again, they are refused here at once.
CREATE TABLE IF NOT EXISTS mail_unsupported (
  account_id  TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  op          TEXT NOT NULL,                    -- flag.seen | flag.flagged | move
  why         TEXT,
  at          INTEGER NOT NULL,
  PRIMARY KEY (account_id, op)
);

-- Mail's settings on this hub: {"markRead": "view" | "manual"} (§14 Q3).
CREATE TABLE IF NOT EXISTS mail_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
