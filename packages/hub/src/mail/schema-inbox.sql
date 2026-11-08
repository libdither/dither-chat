-- Classification and the one-list inbox (slice 8, docs/mail-design.md §4 and §10; mail/classify.ts, mail/attention.ts).
-- A message's class and the rule that decided are mail_message.class and class_why; a thread's is mail_thread.class,
-- and mail_thread.listed says whether the one-list inbox lists it.

-- Your "This is a person" / "Not a person" (§4's rule 1), for a sender or for one thread.
CREATE TABLE IF NOT EXISTS mail_override (
  scope  TEXT NOT NULL CHECK (scope IN ('sender', 'thread')),
  key    TEXT NOT NULL,                         -- a lower-cased address, or a thread id
  class  TEXT NOT NULL CHECK (class IN ('personal', 'bulk')),
  at     INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

-- Per thread: attention.ts's fold of its messages (ConvState), and what the views and the listing read of it.
CREATE TABLE IF NOT EXISTS mail_feature (
  thread_id   TEXT PRIMARY KEY REFERENCES mail_thread(id) ON DELETE CASCADE,
  state       TEXT,                             -- JSON ConvState; NULL: not folded (not from a person)
  owed_since  INTEGER,                          -- the first message to you not answered yet
  unknown     INTEGER NOT NULL DEFAULT 0,       -- personal only by §4's rule 11 (a sender nobody knows)
  sent_at     INTEGER                           -- you answered it from here (the outbox), before Sent's copy came
);
CREATE INDEX IF NOT EXISTS mail_feature_owed ON mail_feature(owed_since) WHERE owed_since IS NOT NULL;

-- How you answer each correspondent, per thread (attention.ts Tally), keyed by their address. Summed with chat's
-- conv_author_feature for the same person (attention.ts).
CREATE TABLE IF NOT EXISTS mail_author_feature (
  thread_id   TEXT NOT NULL REFERENCES mail_thread(id) ON DELETE CASCADE,
  author_key  TEXT NOT NULL,
  tally       TEXT NOT NULL,
  PRIMARY KEY (thread_id, author_key)
);
CREATE INDEX IF NOT EXISTS mail_author_feature_key ON mail_author_feature(author_key);

CREATE INDEX IF NOT EXISTS mail_thread_listed ON mail_thread(listed) WHERE listed = 1;
