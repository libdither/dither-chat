-- Big mailboxes (slice 2, docs/mail.md): where each mailbox's listing can resume, and the search text.

-- Each `next` cursor a mailbox's listing gave, with the oldest receivedAt listed above it. When old mail is dropped
-- (the per-account cap), the listing goes back to the deepest cursor above what was dropped.
CREATE TABLE IF NOT EXISTS mail_page (
  mailbox_id  TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  cursor      TEXT NOT NULL,
  above       INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, cursor)
);
CREATE INDEX IF NOT EXISTS mail_page_above ON mail_page(mailbox_id, above);

-- The first MAIL_LIMITS.textBytes of each fetched body's text, for search (slice 7 indexes it). It outlives the body
-- cache and has its own cap (MAIL_LIMITS.indexMb), oldest mail first. An account that keeps all its mail (keep.ts)
-- keeps up to MAIL_LIMITS.keepTextBytes of each, outside the cap. `cut`: 0 when the text is whole, else the length
-- it was cut to (a database from before it gets the column in store.ts).
CREATE TABLE IF NOT EXISTS mail_text (
  message_id   TEXT PRIMARY KEY REFERENCES mail_message(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  received_at  INTEGER NOT NULL,
  cut          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mail_text_age ON mail_text(received_at);

CREATE INDEX IF NOT EXISTS mail_message_age ON mail_message(account_id, received_at);
CREATE INDEX IF NOT EXISTS mail_body_used ON mail_body(used_at);
