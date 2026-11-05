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
  status       TEXT,                           -- JSON { text, emoji, at }: their custom status or About, as last heard
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
  -- The mention of you was @everyone or @here: it notifies like one, but is not addressed to you.
  mentions_all    INTEGER NOT NULL DEFAULT 0,
  deleted         INTEGER NOT NULL DEFAULT 0,
  -- When gone, how and when (docs/history.md): 'deleted' or 'disappeared'; the body stays if the hub kept it.
  gone_how        TEXT,
  gone_at         INTEGER,
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
-- The index's words and how many messages have each, for correcting a misspelt word (docs/search.md).
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts_vocab USING fts5vocab(message_fts, row);

-- Forwards this hub sent, by the message they became, so they show as forwards even where the network has no
-- such thing. Keyed by hub message id; the message itself may arrive before or after this row.
CREATE TABLE IF NOT EXISTS forward_sent (
  message_id TEXT PRIMARY KEY,
  data       TEXT NOT NULL,                  -- JSON ForwardView
  created_at INTEGER NOT NULL
);

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
  position REAL NOT NULL DEFAULT 0,
  -- P(yes) at which a place belongs; NULL is the provider's default (protocol categoryThreshold).
  threshold REAL
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
  failures   INTEGER NOT NULL DEFAULT 0,
  -- added later, so push.ts also adds them to older databases
  last_error_at   INTEGER,
  last_test_at    INTEGER,
  last_arrived_at INTEGER                    -- the device said a test push reached it
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
-- 'push' is Important, 'quiet' Active, 'drop' below the digest (docs/notifications.md).
CREATE TABLE IF NOT EXISTS triage (
  message_id  TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  decision    TEXT NOT NULL CHECK (decision IN ('push', 'quiet', 'digest', 'drop', 'silent')),
  score       REAL,                          -- how much it matters, 0 to 1: the digest is sorted by it
  reasons     TEXT NOT NULL,                 -- JSON string[]
  decided_by  TEXT NOT NULL,                 -- 'rules' | 'model' | 'learned'
  feedback    TEXT CHECK (feedback IN ('push', 'quiet', 'digest', 'drop')),  -- the level you voted it to
  feedback_at INTEGER,
  facts       TEXT,                          -- JSON learn.ts Facts: what it was decided from, for training
  probs       TEXT,                          -- JSON { ping, active, interesting }: the model's chances
  shadow      TEXT,                          -- JSON { ping, active, interesting }: the candidate model's, which never decides
  explore     TEXT,                          -- 'up' | 'down': exploration changed the decision (shadow.ts)
  propensity  REAL,                          -- the chance of what was done, when exploration drew; NULL when it did not
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS triage_created ON triage(created_at);
CREATE INDEX IF NOT EXISTS triage_feedback ON triage(feedback_at) WHERE feedback IS NOT NULL;

-- "Mark all read" tells each network one conversation at a time (readqueue.ts).
CREATE TABLE IF NOT EXISTS read_queue (
  account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  up_to           TEXT NOT NULL,             -- native message id
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_at         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (account_id, conversation_id)
);

-- ------------------------------------------------------------------ usage and automatic order (usage.ts, docs/organize.md)
-- How much you use each place: decayed seconds and visits (half-life a week), as of score_at. Ids and times only.
CREATE TABLE IF NOT EXISTS place_usage (
  kind        TEXT NOT NULL CHECK (kind IN ('space', 'conversation', 'person')),
  id          TEXT NOT NULL,
  score       REAL NOT NULL DEFAULT 0,
  visit_score REAL NOT NULL DEFAULT 0,
  score_at    INTEGER NOT NULL,
  seconds     REAL NOT NULL DEFAULT 0,     -- all time, not decayed
  visits      INTEGER NOT NULL DEFAULT 0,
  last_visit  INTEGER,
  PRIMARY KEY (kind, id)
);
-- Batches already counted, so a device that resends one (its answer was lost) does not count it twice.
CREATE TABLE IF NOT EXISTS usage_batch (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
-- Sort modes and dismissed folder suggestions, shared by your devices. JSON values.
CREATE TABLE IF NOT EXISTS arrange_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ------------------------------------------------------------------ the inbox's attention score (attention.ts, docs/inbox.md)
-- What each conversation's message metadata says about you there, folded in message order up to a cursor
-- (ts, rowid). Authors, times, replies, mentions and triage decisions only: never what was said.
-- `state` is JSON (attention.ts ConvState); its decayed sums share one reference time.
CREATE TABLE IF NOT EXISTS conv_feature (
  conversation_id TEXT PRIMARY KEY,
  cursor_ts       INTEGER NOT NULL DEFAULT 0,
  cursor_rid      INTEGER NOT NULL DEFAULT 0,
  stale_at        INTEGER,                    -- an older message arrived at this time: fold again from the start once quiet
  state           TEXT NOT NULL
);
-- The same, per author you were addressed by in that conversation (a person, else an identity), so a reply rate
-- can be had per person across all their conversations by summing.
CREATE TABLE IF NOT EXISTS conv_author_feature (
  conversation_id TEXT NOT NULL,
  author_key      TEXT NOT NULL,
  tally           TEXT NOT NULL,              -- JSON Tally
  PRIMARY KEY (conversation_id, author_key)
);
CREATE INDEX IF NOT EXISTS conv_author_feature_author ON conv_author_feature(author_key);

-- ------------------------------------------------------------------ the change journal (journal.ts, docs/sync.md)
-- What changed, by object, at which position, so a client that comes back asks only for that. Compacted: one row
-- per object, at its latest change. Holds ids only; what an object is now is read from its own table at sync time.
-- `conv` is a message's conversation, so timelines can find their changes. Old rows are dropped (journal.ts); a
-- client from before the oldest kept position starts over with /api/bootstrap.
CREATE TABLE IF NOT EXISTS sync_change (
  kind    TEXT NOT NULL,                       -- account, identity, person, space, conversation, message, attention, usage, or a list: folders, rules...
  id      TEXT NOT NULL,                       -- '*' for a list kept whole
  seq     INTEGER NOT NULL,
  conv    TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  at      INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sync_change_seq ON sync_change(seq);
CREATE INDEX IF NOT EXISTS sync_change_kind ON sync_change(kind, seq);
CREATE INDEX IF NOT EXISTS sync_change_conv ON sync_change(conv, seq) WHERE conv IS NOT NULL;

-- ------------------------------------------------------------------ the activity log (activity.ts, docs/activity.md)
-- Labelled data for triage: where you stayed, how you got there, and what each notification led to. Ids, times and
-- counts only: never what was said or searched. Bounded by the retention setting and a row cap; deletable from Settings.

-- One stay on a screen or place. The device sends it again while it lasts, with the same id: the latest wins.
CREATE TABLE IF NOT EXISTS visit (
  id              TEXT PRIMARY KEY,
  device          TEXT NOT NULL,
  device_label    TEXT,
  view            TEXT NOT NULL,             -- VisitView: inbox, conversation, space, person, search, settings...
  conversation_id TEXT,
  space_id        TEXT,
  person_id       TEXT,
  start_at        INTEGER NOT NULL,
  end_at          INTEGER NOT NULL,
  active          REAL NOT NULL DEFAULT 0,   -- seconds visible, focused and in use
  source          TEXT NOT NULL,             -- VisitSource: notification, inbox, rail, search, link, back...
  push_id         TEXT,                      -- the notification tapped
  rank            INTEGER,                   -- inbox row position, attention score and "needs you", when from the inbox
  score           REAL,
  needs           INTEGER,
  read_to_id      TEXT,
  read_to_ts      INTEGER,
  sent            INTEGER NOT NULL DEFAULT 0,
  reactions       INTEGER NOT NULL DEFAULT 0,
  history         INTEGER NOT NULL DEFAULT 0,   -- older pages loaded
  threads         INTEGER NOT NULL DEFAULT 0,
  attachments     INTEGER NOT NULL DEFAULT 0,
  next_view       TEXT,
  closed          INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visit_start ON visit(start_at);
CREATE INDEX IF NOT EXISTS visit_conv ON visit(conversation_id, start_at) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS visit_person ON visit(person_id, start_at) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS visit_push ON visit(push_id) WHERE push_id IS NOT NULL;

-- Every push and digest the hub sends, by the id the device sees (`nid` in the payload), and what came of it.
-- The *_at columns are the first time any device said so; notification_event has each device's word.
CREATE TABLE IF NOT EXISTS notification (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,             -- message, held (quiet hours summary), digest
  message_id      TEXT,
  conversation_id TEXT,
  sent_at         INTEGER NOT NULL,
  devices         INTEGER,                   -- push registrations it went to
  accepted        INTEGER,                   -- of those, how many push servers took it
  delivered_at    INTEGER,
  shown_at        INTEGER,
  suppressed_at   INTEGER,
  tapped_at       INTEGER,
  dismissed_at    INTEGER,
  replied_at      INTEGER,
  visit_id        TEXT                       -- the visit the tap led to
);
CREATE INDEX IF NOT EXISTS notification_sent ON notification(sent_at);
CREATE INDEX IF NOT EXISTS notification_conv ON notification(conversation_id, sent_at);
CREATE INDEX IF NOT EXISTS notification_message ON notification(message_id) WHERE message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS notification_event (
  notification_id TEXT NOT NULL,
  device          TEXT NOT NULL DEFAULT '',  -- push registration id, or the page's device id
  event           TEXT NOT NULL,
  at              INTEGER NOT NULL,
  PRIMARY KEY (notification_id, device, event)
) WITHOUT ROWID;

-- What triage knew from the log when it decided (DITHER_ACTIVITY_FEATURES), so training sees no later outcomes.
CREATE TABLE IF NOT EXISTS triage_input (
  message_id TEXT PRIMARY KEY,
  features   TEXT NOT NULL,                  -- JSON { conversation, person } of PlaceActivity
  at         INTEGER NOT NULL
);

-- The last About an adapter gave for a conversation or space, per account (about.ts, docs/group-settings.md).
-- Shown, read-only, while that account is offline. Native ids inside, as the adapter sent it.
CREATE TABLE IF NOT EXISTS about (
  target_id  TEXT NOT NULL,                  -- cnv_… or spc_…
  account_id TEXT NOT NULL,
  data       TEXT NOT NULL,                  -- JSON About
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (target_id, account_id)
) WITHOUT ROWID;

-- History (docs/history.md). What changed about places and people: old and new as JSON, who did it when the
-- network says. Message-level history lives in message_event and receipt, which go with their message.
CREATE TABLE IF NOT EXISTS change_log (
  id          INTEGER PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('conversation', 'space', 'identity')),
  target_id   TEXT NOT NULL,
  field       TEXT NOT NULL,              -- name, topic, avatar, displayName, …, a setting key, member, role
  old         TEXT,                       -- JSON
  new         TEXT,                       -- JSON
  actor_id    TEXT,                       -- identity that made the change
  at          INTEGER NOT NULL,
  account_id  TEXT                        -- the account that saw it
);
CREATE INDEX IF NOT EXISTS change_log_target ON change_log(target_kind, target_id, field, at);

-- What happened to a message besides being deleted: earlier versions, reactions taken back, pins.
CREATE TABLE IF NOT EXISTS message_event (
  id         INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('edit', 'unreact', 'pin', 'unpin')),
  data       TEXT,                        -- JSON: edit { body } (the version before); unreact { key, style }
  actor_id   TEXT,
  at         INTEGER NOT NULL,
  account_id TEXT
);
CREATE INDEX IF NOT EXISTS message_event_msg ON message_event(message_id, kind, at);

-- Who got, read and played your messages. The first time of each counts.
CREATE TABLE IF NOT EXISTS receipt (
  message_id  TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('delivered', 'read', 'played')),
  at          INTEGER NOT NULL,
  PRIMARY KEY (message_id, identity_id, state)
) WITHOUT ROWID;
