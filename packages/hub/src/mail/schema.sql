-- Mail (docs/mail.md, docs/mail-design.md §2.2), in the hub's own database beside the chat tables. Loaded by MailStore
-- after schema.sql, then every schema-*.sql in this directory in name order: a later slice adds its tables in a file of
-- its own (schema-ops.sql, schema-outbox.sql, …) rather than editing this one.
--
-- A message is keyed by (account, Message-ID), so a move keeps it; the extractor's ids, which change on a move under
-- IMAP, are its locations.

CREATE TABLE IF NOT EXISTS mail_account (
  id           TEXT PRIMARY KEY,                -- the manager's account id
  kind         TEXT NOT NULL,                   -- imap, proton, google
  label        TEXT NOT NULL,
  address      TEXT,                            -- status.self.email
  display_name TEXT,
  addresses    TEXT,                            -- JSON [{email, name}]: status.self.addresses, when the extractor says
  color        TEXT NOT NULL,
  level        TEXT CHECK (level IN ('read', 'write')),  -- grants.mail; NULL once access ends
  dry_run      INTEGER NOT NULL DEFAULT 0,
  online       INTEGER NOT NULL DEFAULT 0,
  problem      TEXT,                            -- JSON {layer, message}
  send         TEXT,                            -- JSON {ok, why, at}
  sync_mode    TEXT,                            -- status.details.sync (imap)
  synced_at    INTEGER,                         -- the first sync finished
  summary_headers INTEGER,                      -- status.details.summaryHeaders: 1 its summaries carry threading and bulk headers, 0 not (Proton); NULL: not said
  headers_seen INTEGER,                         -- 1 once a summary of it carried In-Reply-To, References or bulk headers
  id_per_message INTEGER,                       -- status.details.idPerMessage: 1 a message has one id in every mailbox (Proton, Gmail on the web); NULL: not said
  send_cap     INTEGER,                         -- status.details.sendCap: the most bytes of files one message may carry; NULL: not said
  max_recipients INTEGER,                       -- status.details.maxRecipients: the most addresses in To, Cc and Bcc together; NULL: not said
  provider     TEXT,                            -- status.details.provider: 'Gmail' and the like; NULL: not said
  hidden       INTEGER NOT NULL DEFAULT 0,
  gone_at      INTEGER,                         -- access ended: everything of it goes 24 h later
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox (
  id          TEXT PRIMARY KEY,                 -- mbx_: mailId('mbx', account, native id)
  account_id  TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  native_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,
  parent_id   TEXT,
  role        TEXT,
  unread      INTEGER,
  total       INTEGER,
  follow      TEXT,                             -- 'always' (inbox, sent, all|archive) | 'open' (slice 2) | NULL
  state       TEXT,                             -- the last mail.changes state
  state_at    INTEGER,
  list_next   TEXT,                             -- mail.list cursor past the oldest listed
  horizon     INTEGER,                          -- oldest receivedAt listed without gaps from the top
  complete    INTEGER NOT NULL DEFAULT 0,       -- listed to its end
  relist_gen  INTEGER NOT NULL DEFAULT 0,
  opened_at   INTEGER,
  UNIQUE (account_id, native_id)
);

CREATE TABLE IF NOT EXISTS mail_thread (
  id              TEXT PRIMARY KEY,             -- mth_
  account_id      TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  native_thread   TEXT,
  subject_key     TEXT NOT NULL,                -- thread.ts normalizeSubject
  subject         TEXT NOT NULL,
  first_at        INTEGER NOT NULL,
  last_at         INTEGER NOT NULL,
  last_message_id TEXT,
  count           INTEGER NOT NULL DEFAULT 0,
  unread          INTEGER NOT NULL DEFAULT 0,
  flagged         INTEGER NOT NULL DEFAULT 0,
  attachments     INTEGER NOT NULL DEFAULT 0,
  participants    TEXT NOT NULL DEFAULT '[]',   -- JSON [{e, n, f, l}]: address, name, messages from it, its latest
  roles           TEXT NOT NULL DEFAULT '[]',   -- JSON: roles of the mailboxes holding any of it
  mailboxes       TEXT NOT NULL DEFAULT '[]',   -- JSON: those mailboxes' ids
  labels          TEXT NOT NULL DEFAULT '[]',
  preview         TEXT,
  last_from_me    INTEGER NOT NULL DEFAULT 0,
  class           TEXT,                         -- slice 8
  person_ids      TEXT,                         -- slice 6
  muted           INTEGER NOT NULL DEFAULT 0,
  opened_at       INTEGER,
  opened_ms       INTEGER NOT NULL DEFAULT 0,
  listed          INTEGER NOT NULL DEFAULT 0    -- in the one-list inbox (slice 8)
);
CREATE INDEX IF NOT EXISTS mail_thread_last ON mail_thread(account_id, last_at DESC);
CREATE INDEX IF NOT EXISTS mail_thread_subject ON mail_thread(account_id, subject_key, last_at);
CREATE INDEX IF NOT EXISTS mail_thread_native ON mail_thread(account_id, native_thread);

CREATE TABLE IF NOT EXISTS mail_message (
  id              TEXT PRIMARY KEY,             -- mml_: key 'm:'+Message-ID, else 'e:'+emailId, else 'x:'+mailbox native id+'/'+native id (store.ts identify)
  account_id      TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  thread_id       TEXT NOT NULL REFERENCES mail_thread(id),
  thread_by       TEXT NOT NULL,                -- how it was threaded: native, ref, subject (provisional) or new
  message_id_hdr  TEXT,
  native_thread   TEXT,
  in_reply_to     TEXT,
  refs            TEXT NOT NULL DEFAULT '[]',   -- JSON
  from_addr       TEXT,
  from_name       TEXT,
  to_json         TEXT NOT NULL DEFAULT '[]',
  cc_json         TEXT NOT NULL DEFAULT '[]',
  subject         TEXT NOT NULL DEFAULT '',
  date            INTEGER NOT NULL,
  received_at     INTEGER NOT NULL,
  size            INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  preview         TEXT,                         -- made here from the body
  seen            INTEGER NOT NULL DEFAULT 0,
  flagged         INTEGER NOT NULL DEFAULT 0,
  answered        INTEGER NOT NULL DEFAULT 0,
  draft           INTEGER NOT NULL DEFAULT 0,
  labels          TEXT NOT NULL DEFAULT '[]',
  bulk            TEXT,                         -- JSON MailBulk, when the extractor gives it
  pending         TEXT,                         -- JSON: local flag changes the server has not confirmed (slice 4)
  seen_local      INTEGER NOT NULL DEFAULT 0,   -- read here
  addressed       TEXT NOT NULL DEFAULT 'hidden', -- to | cc | hidden | self
  class           TEXT,                         -- slice 8
  class_why       TEXT,
  images_allowed  INTEGER NOT NULL DEFAULT 0,   -- slice 3
  email_id        TEXT                          -- the server's id for it in every mailbox (Gmail's X-GM-MSGID), when it has one
);
CREATE INDEX IF NOT EXISTS mail_message_thread ON mail_message(thread_id, received_at);

CREATE TABLE IF NOT EXISTS mail_location (
  mailbox_id  TEXT NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  native_id   TEXT NOT NULL,                    -- the extractor's id for it in this mailbox
  message_id  TEXT NOT NULL REFERENCES mail_message(id) ON DELETE CASCADE,
  seen_gen    INTEGER NOT NULL DEFAULT 0,       -- the relist that last saw it
  PRIMARY KEY (mailbox_id, native_id)
);
CREATE INDEX IF NOT EXISTS mail_location_message ON mail_location(message_id);

-- Every Message-ID seen (a message's own, and those it refers to), for threading by reference.
CREATE TABLE IF NOT EXISTS mail_ref (
  account_id  TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  ref         TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  PRIMARY KEY (account_id, ref)
);
CREATE INDEX IF NOT EXISTS mail_ref_thread ON mail_ref(thread_id);

-- Bodies fetched with mail.get. Eviction and the size cap are slice 2's.
CREATE TABLE IF NOT EXISTS mail_body (
  message_id  TEXT PRIMARY KEY REFERENCES mail_message(id) ON DELETE CASCADE,
  text        TEXT,
  html        TEXT,
  parts       TEXT NOT NULL DEFAULT '[]',       -- JSON MailAttachment[]
  reply_to    TEXT NOT NULL DEFAULT '[]',
  bcc         TEXT NOT NULL DEFAULT '[]',
  bytes       INTEGER NOT NULL DEFAULT 0,
  fetched_at  INTEGER NOT NULL,
  used_at     INTEGER NOT NULL,
  keep        INTEGER NOT NULL DEFAULT 0
);
