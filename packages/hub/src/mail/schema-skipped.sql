-- Ids an extractor left out of a mail.changes, mail.list or mail.search answer because it could not parse them (the
-- answer's `skipped`; docs/mail.md "Skipped messages"). Each stays pending here until a summary of it comes, mail.get
-- reads it, or the server removes it: a relist never deletes its location meanwhile (sync.ts). `next_at` is the next
-- mail.get, further off after each failure.
CREATE TABLE IF NOT EXISTS mail_skipped (
  mailbox_id  TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  native_id   TEXT NOT NULL,
  first_at    INTEGER NOT NULL,
  tries       INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL,
  error       TEXT,
  PRIMARY KEY (mailbox_id, native_id)
);
CREATE INDEX IF NOT EXISTS mail_skipped_next ON mail_skipped(next_at);
