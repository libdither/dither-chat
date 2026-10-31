-- dither-chat hub schema (SQLite).
--
-- Layers:
--   1. transport     account, vantage, message_seen      which of your accounts sees what
--   2. social graph  identity, person                    who is who, across networks
--   3. places        space, space_edge, conversation, participant
--   4. content       message, attachment, reaction
--   5. overlay       folder, folder_item, notify_rule, triage   hub-only, never written back
--
-- Network objects are keyed by (network, native_id) and get deterministic
-- hub ids (see protocol/src/ids.ts), so re-ingesting anything is a no-op.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 1. transport ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,
  network       TEXT NOT NULL,
  label         TEXT NOT NULL,                 -- "main", "alt", "personal"
  color         TEXT NOT NULL,                 -- annotates everything seen through this account
  adapter       TEXT NOT NULL,                 -- adapter kind: 'matrix' | 'signal' | 'discord' | 'demo'
  config        TEXT NOT NULL DEFAULT '{}',    -- non-secret JSON (homeserver, phone, sandbox options)
  token         TEXT NOT NULL,                 -- adapter WebSocket secret
  self_identity TEXT,
  status        TEXT NOT NULL DEFAULT 'offline',
  attention     TEXT,                          -- JSON Attention
  capabilities  TEXT NOT NULL DEFAULT '[]',
  live_view     TEXT,                          -- JSON {vncPort,width,height} while a sandbox runs
  enabled       INTEGER NOT NULL DEFAULT 1,
  demo          INTEGER NOT NULL DEFAULT 0,
  position      REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- Which account observes which space or conversation, plus that account's
-- read state. Two Discord accounts in the same guild give two vantage rows on
-- one space row.
CREATE TABLE IF NOT EXISTS vantage (
  account_id   TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('space', 'conversation')),
  target_id    TEXT NOT NULL,
  last_read_ts INTEGER,
  unread       INTEGER NOT NULL DEFAULT 0,
  mentions     INTEGER NOT NULL DEFAULT 0,
  native_mute  TEXT,                           -- JSON NativeMute, as the network reports it
  PRIMARY KEY (account_id, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS vantage_target ON vantage(target_kind, target_id);

-- 2. social graph ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS person (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  avatar_url TEXT,
  note       TEXT,
  starred    INTEGER NOT NULL DEFAULT 0,      -- VIP: always notify
  is_self    INTEGER NOT NULL DEFAULT 0,
  manual     INTEGER NOT NULL DEFAULT 0,      -- the user merged or renamed it; ingest won't touch the name
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity (
  id           TEXT PRIMARY KEY,
  network      TEXT NOT NULL,
  native_id    TEXT NOT NULL,
  handle       TEXT,
  display_name TEXT,
  avatar_url   TEXT,
  is_bot       INTEGER NOT NULL DEFAULT 0,
  person_id    TEXT REFERENCES person(id) ON DELETE SET NULL,
  seen_via     TEXT,                           -- an account id that can fetch this identity's media
  updated_at   INTEGER NOT NULL,
  UNIQUE (network, native_id)
);
CREATE INDEX IF NOT EXISTS identity_person ON identity(person_id);

-- 3. places ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS space (
  id         TEXT PRIMARY KEY,
  network    TEXT NOT NULL,
  native_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('community', 'section')),
  name       TEXT NOT NULL,
  topic      TEXT,
  icon_url   TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (network, native_id)
);

-- Containment is a graph: a Matrix room can sit in several spaces, and
-- subspaces can have several parents.
CREATE TABLE IF NOT EXISTS space_edge (
  parent_id  TEXT NOT NULL,                  -- no FK: a parent may be announced after its children
  child_kind TEXT NOT NULL CHECK (child_kind IN ('space', 'conversation')),
  child_id   TEXT NOT NULL,
  position   TEXT,
  PRIMARY KEY (parent_id, child_kind, child_id)
);
CREATE INDEX IF NOT EXISTS space_edge_child ON space_edge(child_kind, child_id);

CREATE TABLE IF NOT EXISTS conversation (
  id              TEXT PRIMARY KEY,
  network         TEXT NOT NULL,
  native_id       TEXT NOT NULL,
  shape           TEXT NOT NULL CHECK (shape IN ('direct', 'group', 'channel', 'thread', 'self')),
  variant         TEXT NOT NULL DEFAULT 'text',
  parent_id       TEXT,                       -- threads: the conversation they hang off
  name            TEXT,
  topic           TEXT,
  avatar_url      TEXT,
  encrypted       INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  last_message_at INTEGER,
  updated_at      INTEGER NOT NULL,
  UNIQUE (network, native_id)
);
CREATE INDEX IF NOT EXISTS conversation_parent ON conversation(parent_id);

-- Members of directs, groups and self chats. Big channels don't list members here.
CREATE TABLE IF NOT EXISTS participant (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  identity_id     TEXT NOT NULL REFERENCES identity(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, identity_id)
);
CREATE INDEX IF NOT EXISTS participant_identity ON participant(identity_id);

-- 4. content -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  network         TEXT NOT NULL,
  native_id       TEXT NOT NULL,
  author_id       TEXT REFERENCES identity(id),
  ts              INTEGER NOT NULL,
  edited_ts       INTEGER,
  kind            TEXT NOT NULL DEFAULT 'text',
  body            TEXT NOT NULL DEFAULT '',   -- canonical Markdown subset (protocol MessageFact.body)
  reply_to_id     TEXT,                       -- hub id; may point at a message not fetched yet
  thread_id       TEXT,                       -- conversation this message is the root of
  mentions_self   INTEGER NOT NULL DEFAULT 0,
  deleted         INTEGER NOT NULL DEFAULT 0,
  extra           TEXT,
  UNIQUE (network, native_id)
);
CREATE INDEX IF NOT EXISTS message_conv_ts ON message(conversation_id, ts);

-- Full-text search over bodies, kept current by triggers. Store backfills it once for older databases.
-- It follows message.rowid, so after a VACUUM run: INSERT INTO message_fts(message_fts) VALUES ('rebuild');
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(body, content = 'message', content_rowid = 'rowid', tokenize = "unicode61 remove_diacritics 2");
CREATE TRIGGER IF NOT EXISTS message_fts_insert AFTER INSERT ON message BEGIN
  INSERT INTO message_fts (rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS message_fts_delete AFTER DELETE ON message BEGIN
  INSERT INTO message_fts (message_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS message_fts_update AFTER UPDATE OF body ON message WHEN old.body IS NOT new.body BEGIN
  INSERT INTO message_fts (message_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO message_fts (rowid, body) VALUES (new.rowid, new.body);
END;

-- The same message arriving through several accounts is stored once.
CREATE TABLE IF NOT EXISTS message_seen (
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, account_id)
);
CREATE INDEX IF NOT EXISTS message_seen_account ON message_seen(account_id);

CREATE TABLE IF NOT EXISTS attachment (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  mime       TEXT,
  name       TEXT,
  size       INTEGER,
  width      INTEGER,
  height     INTEGER,
  url        TEXT NOT NULL,                  -- MediaUrl as the adapter gave it
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS attachment_message ON attachment(message_id);

-- Who reacted, as far as we know. See docs/reactions.md.
CREATE TABLE IF NOT EXISTS reaction (
  message_id  TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES identity(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  style       TEXT NOT NULL DEFAULT 'normal' CHECK (style IN ('normal', 'super')),
  PRIMARY KEY (message_id, identity_id, key, style)
);

-- One row per reaction shown on a message, in the order they first appeared.
CREATE TABLE IF NOT EXISTS reaction_tally (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  style      TEXT NOT NULL DEFAULT 'normal',
  count      INTEGER,                         -- the network's total; NULL when it names every reactor
  colors     TEXT,                            -- JSON array of CSS colours (super reactions)
  UNIQUE (message_id, key, style)
);

-- Custom emoji seen on reactions or offered by a ReactionContext.
CREATE TABLE IF NOT EXISTS custom_emoji (
  network  TEXT NOT NULL,
  key      TEXT NOT NULL,
  name     TEXT NOT NULL,
  url      TEXT NOT NULL,
  animated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (network, key)
);

-- 5. overlay (hub-only) ------------------------------------------------------

CREATE TABLE IF NOT EXISTS folder (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  icon     TEXT,
  color    TEXT,
  position REAL NOT NULL
);

-- A folder holds anything from any network: communities, single conversations, people.
CREATE TABLE IF NOT EXISTS folder_item (
  folder_id TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('space', 'conversation', 'person')),
  item_id   TEXT NOT NULL,
  position  REAL NOT NULL,
  PRIMARY KEY (folder_id, item_kind, item_id)
);

-- How you arranged your sidebar: order, pins, hidden places, closed folders.
CREATE TABLE IF NOT EXISTS place_pref (
  kind      TEXT NOT NULL CHECK (kind IN ('folder', 'space', 'conversation')),
  id        TEXT NOT NULL,
  position  REAL,
  pinned    INTEGER NOT NULL DEFAULT 0,
  hidden    INTEGER NOT NULL DEFAULT 0,
  open      INTEGER NOT NULL DEFAULT 0,
  railed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, id)
);

-- Categories are questions; scores are a provider's answers; overrides are yours and always win.
CREATE TABLE IF NOT EXISTS category (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  question TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',
  color    TEXT,
  position REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS category_score (
  category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('space', 'conversation')),
  place_id    TEXT NOT NULL,
  p           REAL NOT NULL,
  provider    TEXT NOT NULL,
  input_hash  TEXT NOT NULL,
  PRIMARY KEY (category_id, kind, place_id)
);
CREATE INDEX IF NOT EXISTS category_score_place ON category_score(kind, place_id);
CREATE TABLE IF NOT EXISTS category_override (
  category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('space', 'conversation')),
  place_id    TEXT NOT NULL,
  assigned    INTEGER NOT NULL,
  PRIMARY KEY (category_id, kind, place_id)
);

-- Devices that opted in to Web Push (webpush.ts).
CREATE TABLE IF NOT EXISTS push_subscription (
  id         TEXT PRIMARY KEY,               -- fingerprint of the endpoint
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  last_error TEXT,
  failures   INTEGER NOT NULL DEFAULT 0
);

-- Most specific scope wins: conversation > thread parent > section > community
-- > account > network > global. Person and keyword rules can only raise
-- urgency (push), never silence a conversation the user asked to hear.
CREATE TABLE IF NOT EXISTS notify_rule (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL CHECK (scope IN ('global', 'network', 'account', 'space', 'conversation', 'person', 'keyword')),
  target     TEXT,
  level      TEXT NOT NULL CHECK (level IN ('all', 'mentions', 'smart', 'digest', 'none')),
  created_at INTEGER NOT NULL,
  UNIQUE (scope, target)
);

-- Every live message gets a decision and the reasons for it, so the UI can
-- answer "why did this ping me?" and learn from corrections.
CREATE TABLE IF NOT EXISTS triage (
  message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  decision   TEXT NOT NULL CHECK (decision IN ('push', 'digest', 'silent')),
  score      REAL,
  reasons    TEXT NOT NULL,                  -- JSON string[]
  decided_by TEXT NOT NULL,                  -- 'rules' | 'model'
  feedback   TEXT,                           -- 'should_push' | 'should_not_push'
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS triage_created ON triage(created_at);
