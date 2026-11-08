-- Sending (slice 5, mail/outbox.ts): what waits to be sent, and drafts. Loaded after schema.sql.

CREATE TABLE IF NOT EXISTS mail_outbox (
  id               TEXT PRIMARY KEY,            -- mob_: mailId('mob', account, clientId)
  client_id        TEXT NOT NULL UNIQUE,        -- the page's id for the send: a retry sends once
  account_id       TEXT NOT NULL,
  kind             TEXT NOT NULL,               -- new | reply | replyAll | forward
  reply_to         TEXT,                        -- the hub message it answers or forwards (mml_)
  thread_id        TEXT,
  draft            TEXT NOT NULL,               -- JSON MailDraft, as sent: it goes back to the drafts if it does not go out
  draft_key        TEXT,
  outgoing         TEXT NOT NULL,               -- JSON OutgoingMail without attachments, made when it was accepted
  files            TEXT NOT NULL DEFAULT '[]',  -- JSON [{name, mime, size, path}]: copies in the outbox folder, once held is over
  state            TEXT NOT NULL,               -- held | queued | sending | sent | failed | undone
  hold_until       INTEGER,
  next_at          INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  unsure           INTEGER NOT NULL DEFAULT 0,  -- may have gone out (no answer in time)
  dry_run          INTEGER NOT NULL DEFAULT 0,
  sent_message_id  TEXT,                        -- the Message-ID it went out with
  sent_native      TEXT,                        -- its copy in Sent, where the extractor said
  dismissed        INTEGER NOT NULL DEFAULT 0,  -- no longer shown
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_outbox_state ON mail_outbox(state, updated_at);

-- Drafts live on the hub (dither-accounts has no drafts op). Keys: 't:<thread>' or 'new:<uuid>'.
CREATE TABLE IF NOT EXISTS mail_draft (
  key         TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  data        TEXT NOT NULL,                    -- JSON MailDraft
  updated_at  INTEGER NOT NULL
);
