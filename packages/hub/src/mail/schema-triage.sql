-- Triage of mail (slice 9, docs/mail-design.md §10, mail/triage.ts): the decision on each new message from a person,
-- made by chat's decision model (learn.ts) from the same kind of facts, and your vote on it. Votes join chat's in
-- training (votes.ts). Not tied to mail_message: a message the server no longer has keeps its row while it has a
-- vote, as chat's triage rows do; rows without one go with it.

CREATE TABLE IF NOT EXISTS mail_triage (
  message_id  TEXT PRIMARY KEY,                 -- mml_
  thread_id   TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  address     TEXT,                             -- the sender, lower-cased: whose person the author feature is
  decision    TEXT NOT NULL,                    -- push | quiet | digest | drop | silent, after quiet hours
  level       TEXT,                             -- what the model rated it, before quiet hours held it
  score       REAL,
  reasons     TEXT NOT NULL,                    -- JSON string[]
  decided_by  TEXT NOT NULL,                    -- rules | learned
  facts       TEXT,                             -- JSON learn.ts Facts; NULL for a silent one
  words       TEXT,                             -- JSON string[]: the model's words of it, kept for learning
  probs       TEXT,                             -- JSON { ping, active, interesting }
  delivered   INTEGER NOT NULL DEFAULT 0,       -- a notification went out
  feedback    TEXT,                             -- your vote: push | quiet | digest | drop
  feedback_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_triage_thread ON mail_triage(thread_id);
CREATE INDEX IF NOT EXISTS mail_triage_created ON mail_triage(created_at);
CREATE INDEX IF NOT EXISTS mail_triage_voted ON mail_triage(feedback_at) WHERE feedback IS NOT NULL;
