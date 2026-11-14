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
  created_at INTEGER NOT NULL,
  name_source TEXT NOT NULL DEFAULT 'network' -- network | merge (P.NameSource); 'user' until 2026-11-11, when nicknames moved to identity
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
  nickname     TEXT,                           -- your own name for this account, only you see it: set here, or taken from your private nickname on its network
  net_nickname TEXT,                           -- your private nickname for them as their network last said it (Signal), '' none; NULL never said
  net_note     TEXT,                           -- your private note about them as their network last said it (Signal), '' none; NULL never said
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
  imported        INTEGER NOT NULL DEFAULT 0, -- inserted by a history import, not yet sent by the network (docs/import.md)
  extra           TEXT,
  UNIQUE (network, native_id)
);
CREATE INDEX IF NOT EXISTS message_conv_ts ON message(conversation_id, ts);
-- The inbox, outcomes and embeddings read by time across conversations, and "what you wrote" by author.
CREATE INDEX IF NOT EXISTS message_ts ON message(ts);
CREATE INDEX IF NOT EXISTS message_author_ts ON message(author_id, ts);
-- Deleted and disappeared messages, for Settings → Message history's Forget (docs/history.md).
CREATE INDEX IF NOT EXISTS message_gone ON message(gone_how) WHERE gone_how IS NOT NULL;
-- Logged posts by the post they answer (posts.ts, docs/feed.md "Threads"): a thread read back from what was logged.
CREATE INDEX IF NOT EXISTS message_post_reply ON message(reply_to_id) WHERE native_id LIKE 'post:%';

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
  position   INTEGER NOT NULL DEFAULT 0,
  alt        TEXT,                           -- its description (alt text), searched (rich.ts)
  extra      TEXT                            -- JSON: spoiler, explicit, voice (hub rich.ts attachmentExtra)
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
  position REAL NOT NULL,
  parent_id  TEXT,                            -- the folder it sits in (one level: a parent has none)
  parent_pos REAL                             -- its place among the parent's items
);

-- A folder holds anything from any network: communities, single conversations, people.
CREATE TABLE IF NOT EXISTS folder_item (
  folder_id TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('space', 'conversation', 'person')),
  item_id   TEXT NOT NULL,
  position  REAL NOT NULL,
  PRIMARY KEY (folder_id, item_kind, item_id)
);

-- How you arranged your sidebar: order, pins, hidden places, closed folders. And whom the @ picker offers there
-- (docs/mentions.md): NULL inherits from the place it is in.
CREATE TABLE IF NOT EXISTS place_pref (
  kind      TEXT NOT NULL CHECK (kind IN ('folder', 'space', 'conversation')),
  id        TEXT NOT NULL,
  position  REAL,
  pinned    INTEGER NOT NULL DEFAULT 0,
  hidden    INTEGER NOT NULL DEFAULT 0,
  open      INTEGER NOT NULL DEFAULT 0,
  railed    INTEGER NOT NULL DEFAULT 0,
  mention_scope TEXT,                         -- here | friends | everyone
  mention_same  INTEGER,                      -- 1: friends and everyone only on the chat's network
  PRIMARY KEY (kind, id)
);

-- Which route a chat sends through when you do not say (docs/chats.md): the one you last chose. A chat is
-- 'person:<id>' or a conversation id; a route is a conversation and one of your accounts in it. Read against the
-- routes the chat has now, so one that went away (a split, an account removed) is passed over, not followed.
CREATE TABLE IF NOT EXISTS chat_route (
  chat_id         TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  set_at          INTEGER NOT NULL
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

-- A rule of yours on a place or a person (docs/notifications.md): 'all' always alerts, 'digest' keeps a place to
-- the list, 'none' mutes it; no rule is Automatic. Most specific scope wins: conversation > thread parent > section >
-- community > account > network > global. 'mentions' and 'smart' are from before the tiers: 'mentions' still reads
-- as "the network notifies only mentions here", 'smart' rows are deleted at the migration.
CREATE TABLE IF NOT EXISTS notify_rule (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL CHECK (scope IN ('global', 'network', 'account', 'space', 'conversation', 'person', 'keyword')),
  target     TEXT,
  level      TEXT NOT NULL CHECK (level IN ('all', 'mentions', 'smart', 'digest', 'none')),
  created_at INTEGER NOT NULL,
  UNIQUE (scope, target)
);

-- Every live message gets a decision and the reasons for it, so the UI can
-- answer "why did this alert me?" and learn from your marks.
-- The tier, by the codes of the four levels it replaced: 'push' is Alert, 'quiet' Conversation, 'digest' List,
-- 'drop' below the list (docs/notifications.md).
CREATE TABLE IF NOT EXISTS triage (
  message_id  TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  decision    TEXT NOT NULL CHECK (decision IN ('push', 'quiet', 'digest', 'drop', 'silent')),
  score       REAL,                          -- its importance, 0 to 1: the list and the inbox sort by it
  reasons     TEXT NOT NULL,                 -- JSON string[]
  decided_by  TEXT NOT NULL,                 -- 'rules' | 'model' | 'learned'
  feedback    TEXT CHECK (feedback IN ('push', 'quiet', 'digest', 'drop')),  -- a vote from before the tiers: the level you voted it to
  feedback_at INTEGER,
  facts       TEXT,                          -- JSON learn.ts Facts: what it was decided from, for training
  probs       TEXT,                          -- JSON { alert, important }: the model's chances ({ ping, active, interesting } before the tiers)
  shadow      TEXT,                          -- JSON, as probs: the candidate model's, which never decides
  explore     TEXT,                          -- from before the tiers: 'up' | 'down', exploration changed the decision
  propensity  REAL,                          -- from before the tiers: the chance of what exploration did
  created_at  INTEGER NOT NULL,
  was         TEXT,                          -- the level it was decided at before the tiers, when it was
  alert_mark  INTEGER,                       -- your mark: 1 it should have alerted, 0 the alert was wrong
  less_mark   INTEGER,                       -- your mark: 1 less like this
  marked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS triage_created ON triage(created_at);
-- The inbox's picks by tier, best first (store.ts inboxQueries).
CREATE INDEX IF NOT EXISTS triage_tier_score ON triage(decision, score);
CREATE INDEX IF NOT EXISTS triage_feedback ON triage(feedback_at) WHERE feedback IS NOT NULL;
CREATE INDEX IF NOT EXISTS triage_marked ON triage(marked_at) WHERE marked_at IS NOT NULL;

-- Live messages handed to triage and not yet decided (main.ts): a restart decides what a crash left in the queue.
CREATE TABLE IF NOT EXISTS triage_pending (
  message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL
);

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

-- ------------------------------------------------------------------ button counts (clicks.ts, docs/button-counts.md)
-- Presses of the app's controls per day, from devices that switched it on. Keys and pages are strings from the
-- app's code ("inbox: row (DM, unread)", "conversation"): no names, text or ids.
CREATE TABLE IF NOT EXISTS click_count (
  day    TEXT NOT NULL,             -- the device's date, YYYY-MM-DD
  key    TEXT NOT NULL,
  page   TEXT NOT NULL,
  device TEXT NOT NULL CHECK (device IN ('phone', 'desktop')),
  n      INTEGER NOT NULL,
  PRIMARY KEY (day, key, page, device)
) WITHOUT ROWID;
-- Batches already counted, so a resent one is not counted twice.
CREATE TABLE IF NOT EXISTS click_batch (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
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
-- Every turn addressed to you that the fold closed (attention.ts, owed.ts): when it began, whether and when you
-- answered, so the owed table can be fitted. Rebuilt with the conversation's features; times and keys only.
-- Your marks on whether a message needs a reply (replymarks.ts, docs/inbox.md "Marks"): none or needs. One per
-- message (a chat message, or mail's with target_kind 'mail'); undone ones are kept with undone_at. `origin_id` is the
-- mark you made when this row was made for another route of the same chat. Not part of the activity log.
CREATE TABLE IF NOT EXISTS reply_mark (
  message_id      TEXT PRIMARY KEY,
  target_kind     TEXT NOT NULL DEFAULT 'message',   -- message, mail
  conversation_id TEXT NOT NULL,                     -- its conversation, or mail thread
  mark            TEXT NOT NULL,                     -- none, needs
  at              INTEGER NOT NULL,
  surface         TEXT,                              -- row, message, notification
  device          TEXT,
  undone_at       INTEGER,
  origin_id       TEXT
);
CREATE INDEX IF NOT EXISTS reply_mark_conversation ON reply_mark(conversation_id);
CREATE INDEX IF NOT EXISTS reply_mark_origin ON reply_mark(origin_id) WHERE origin_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS owed_turn (
  conversation_id TEXT NOT NULL,
  addressed       INTEGER NOT NULL,            -- its first message for you
  shape           TEXT NOT NULL,
  author_key      TEXT,
  answered_at     INTEGER,                     -- your answer (or the message you reacted to); NULL: it ran out
  timed           INTEGER NOT NULL DEFAULT 1,  -- 0: a reaction answered it, at no known time
  dismissed       INTEGER NOT NULL DEFAULT 0,  -- 1: you marked it "No reply needed" (reply_mark)
  PRIMARY KEY (conversation_id, addressed)
) WITHOUT ROWID;

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
  depth           INTEGER,                   -- the deepest inbox row on screen during the stay, when the list was
  read_to_id      TEXT,
  read_to_ts      INTEGER,
  sent            INTEGER NOT NULL DEFAULT 0,
  reactions       INTEGER NOT NULL DEFAULT 0,
  history         INTEGER NOT NULL DEFAULT 0,   -- older pages loaded
  threads         INTEGER NOT NULL DEFAULT 0,
  attachments     INTEGER NOT NULL DEFAULT 0,
  next_view       TEXT,
  closed          INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  seen_to_ts      INTEGER,                   -- the newest message on screen, read or not
  owed_since      INTEGER,                   -- the reply you owed there as the stay began (attention's owedSince)
  owed_shown      INTEGER,                   -- and whether its row showed it (↩)
  typed           INTEGER NOT NULL DEFAULT 0,   -- edits to the message box: a count only
  draft_left      INTEGER,                   -- a draft was left in the message box
  exit            TEXT                       -- VisitExit: route, hidden, closed
);
CREATE INDEX IF NOT EXISTS visit_start ON visit(start_at);
CREATE INDEX IF NOT EXISTS visit_conv ON visit(conversation_id, start_at) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS visit_person ON visit(person_id, start_at) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS visit_push ON visit(push_id) WHERE push_id IS NOT NULL;

-- What you did to an inbox row that says what you made of it (InboxAction): Mark As Read on a row showing a reply
-- you owed. Ids and times only; part of the log (deleted with it, kept for its retention).
CREATE TABLE IF NOT EXISTS inbox_action (
  id          TEXT PRIMARY KEY,               -- made by the device
  device      TEXT NOT NULL,
  action      TEXT NOT NULL,                  -- read
  target_kind TEXT NOT NULL,                  -- conversation, mail
  target_id   TEXT NOT NULL,
  at          INTEGER NOT NULL,
  owed_since  INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_action_at ON inbox_action(at);

-- Every push the hub sends, by the id the device sees (`nid` in the payload), and what came of it.
-- The *_at columns are the first time any device said so; notification_event has each device's word.
CREATE TABLE IF NOT EXISTS notification (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,             -- message, held (quiet hours summary), request (docs/add.md); digest, before the tiers
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

-- The phone's list (phonelist.ts, docs/notifications.md "The phone's list"): one row per episode of a chat on the
-- list, from its first list message that asked for the phone until the row went (or, held, would have gone). Kept
-- whether or not the activity log is on, so the cap, the snoozes and the day's coins outlast a restart. Ids, times
-- and counts only.
CREATE TABLE IF NOT EXISTS phone_episode (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,             -- the chat, or the mail thread
  day             TEXT NOT NULL,             -- the hub's local day it began, YYYY-MM-DD: one coin per chat per day
  mode            TEXT NOT NULL,             -- DITHER_PHONE_LIST when it began: 'on' or 'shadow'
  arm             TEXT NOT NULL,             -- why: 'prior' (the network notifies, or it is to you), 'keep' (marked), 'trial', 'gated'
  propensity      REAL,                      -- 'trial' and 'gated': the coin's exact chance of a trial
  sent            INTEGER NOT NULL,          -- 1 when the gate sends its rows to the phones (in shadow: would have)
  first_ts        INTEGER NOT NULL,          -- the first message's time: read past it, a held episode ends
  started_at      INTEGER NOT NULL,
  last_at         INTEGER NOT NULL,          -- its last push
  posts           INTEGER NOT NULL DEFAULT 0,
  ended_at        INTEGER,
  outcome         TEXT,                      -- 'tapped', 'dismissed' (one swipe), 'cleared' (clear-all), 'read', 'expired', 'superseded'
  outcome_at      INTEGER
);
CREATE INDEX IF NOT EXISTS phone_episode_open ON phone_episode(conversation_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS phone_episode_day ON phone_episode(day, conversation_id);
CREATE INDEX IF NOT EXISTS phone_episode_ended ON phone_episode(outcome_at) WHERE outcome = 'dismissed';
-- A chat whose row the phone swiped away: its list rows wait until this, or until something above the list comes.
CREATE TABLE IF NOT EXISTS phone_snooze (
  conversation_id TEXT PRIMARY KEY,
  until           INTEGER NOT NULL
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
-- People's Friends and Following read the follows in kept profiles (add.ts profileFollows, docs/profile.md
-- "Connections"): only these rows, not every profile with its posts. The query repeats this WHERE to use it.
CREATE INDEX IF NOT EXISTS about_following ON about(account_id) WHERE json_extract(data, '$.relationship') = 'following';

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

-- ------------------------------------------------------------------ history imports (imports/, docs/import.md)
-- Sources themselves live under <data>/imports/sources/<id>/; these rows say what each import did, so it can be
-- rerun, reviewed and undone. A message inserted by an import has message.imported = 1 until the network sends it.
CREATE TABLE IF NOT EXISTS import_run (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  source_sha  TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  reader      TEXT NOT NULL,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,              -- running, done, error, stopped
  counts      TEXT,                       -- JSON ImportCounts
  error       TEXT
);

-- Which sources brought a message. With imported = 1 and only one source here, undoing that source deletes it.
CREATE TABLE IF NOT EXISTS import_origin (
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  source_sha TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  PRIMARY KEY (message_id, source_sha)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS import_origin_source ON import_origin(source_sha);

-- Where a source disagrees with the hub. The hub keeps its version until a decision says otherwise.
CREATE TABLE IF NOT EXISTS import_conflict (
  message_id   TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,             -- body, deleted
  source_sha   TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  source_value TEXT NOT NULL,             -- JSON: what the source says
  detected_at  INTEGER NOT NULL,
  decision     TEXT,                      -- NULL (keep the hub's), 'take-source', 'ignore'
  decided_at   INTEGER,
  PRIMARY KEY (message_id, kind, source_sha)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS import_conflict_source ON import_conflict(source_sha, kind);

-- The gap between an import and live sync, fetched page by page through the account (imports/gapfill.ts).
CREATE TABLE IF NOT EXISTS gap_fill (
  account_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  gap_end         INTEGER,                -- newest imported message; NULL: none, so back to the start
  pages           INTEGER NOT NULL DEFAULT 0,
  fetched         INTEGER NOT NULL DEFAULT 0,
  done            INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (account_id, conversation_id)
) WITHOUT ROWID;

-- Index jobs (jobs.ts, docs/indexing.md): fetch a server, a folder of servers or a conversation whole, through your
-- accounts, paced per account, carried on after a restart, and run again if they repeat.
CREATE TABLE IF NOT EXISTS job (
  id            TEXT PRIMARY KEY,
  target_kind   TEXT NOT NULL CHECK (target_kind IN ('space', 'folder', 'conversation')),
  target_id     TEXT NOT NULL,
  history       INTEGER NOT NULL,
  members       INTEGER NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 1, -- 0 low, 1 normal, 2 high
  repeat_hours  REAL,                     -- NULL: once
  state         TEXT NOT NULL,            -- queued, running, paused, done, failed
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  next_run_at   INTEGER,                  -- a repeating job's next run
  skipped       INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);

-- One conversation to page back to its start, or one space whose members to walk, in a job's current run.
CREATE TABLE IF NOT EXISTS job_task (
  job_id      TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('threads', 'history', 'members')),
  target_id   TEXT NOT NULL,              -- cnv_ for threads and history, spc_ for members
  account_id  TEXT NOT NULL,
  cursor      INTEGER,                    -- history: the next page ends before this ts; NULL: from now
  walk        TEXT,                       -- members: JSON name prefixes still to ask; threads: JSON {archived, offset}
  pages       INTEGER NOT NULL DEFAULT 0,
  fetched     INTEGER NOT NULL DEFAULT 0, -- messages new to the hub, or members listed
  done        INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (job_id, kind, target_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS job_task_account ON job_task(account_id, done);

-- Stretches of a conversation known to be whole: fetched page after page with nothing between. A later run skips
-- them, so a repeating job fetches only what is new. from_ts 0: back to the conversation's start.
CREATE TABLE IF NOT EXISTS history_span (
  conversation_id TEXT NOT NULL,
  from_ts         INTEGER NOT NULL,
  to_ts           INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, from_ts)
) WITHOUT ROWID;

-- Remote media (an attachment's URL) the archiver could not keep, so it stops asking (mediaarchive.ts).
CREATE TABLE IF NOT EXISTS media_archive_fail (
  key     TEXT PRIMARY KEY,               -- sha256 of the URL, as the media cache names it
  tries   INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  error   TEXT
) WITHOUT ROWID;

-- What each kept file is by its bytes (mediainfo.ts, fileinfo.ts, docs/files.md), keyed like the media cache: the
-- sha256 of the attachment's URL. Names and sizes of an archive's first entries in `list`; nothing is extracted.
CREATE TABLE IF NOT EXISTS media_info (
  key      TEXT PRIMARY KEY,
  mime     TEXT NOT NULL,
  kind     TEXT NOT NULL,               -- protocol FileKind: the viewer that shows it
  size     INTEGER NOT NULL,
  pages    INTEGER,
  encoding TEXT,
  lines    INTEGER,
  language TEXT,
  entries  INTEGER,
  list     TEXT,                        -- JSON [{name, size, dir?}]
  width    INTEGER,
  height   INTEGER,
  duration REAL,                        -- seconds
  partial  INTEGER NOT NULL DEFAULT 0,  -- lines or entries counted in the first part only
  version  INTEGER NOT NULL,            -- fileinfo.ts SNIFF_VERSION
  at       INTEGER NOT NULL
) WITHOUT ROWID;

-- Who your accounts have seen as a member of which space, from what their clients loaded anyway (a `members` event,
-- source 'seen'). Adversarial: written only with the members setting on (docs/history.md). Never the whole list.
CREATE TABLE IF NOT EXISTS membership (
  space_id    TEXT NOT NULL,              -- spc_…
  identity_id TEXT NOT NULL,              -- idn_…
  joined_at   INTEGER,                    -- where the network says
  roles       TEXT,                       -- JSON: role names
  nick        TEXT,
  source      TEXT NOT NULL CHECK (source IN ('seen', 'walk')),
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  account_id  TEXT,                       -- the account that saw them last
  PRIMARY KEY (space_id, identity_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS membership_identity ON membership(identity_id);

-- A space's member and online counts as the network last gave them, beside how many membership has.
CREATE TABLE IF NOT EXISTS member_coverage (
  space_id    TEXT PRIMARY KEY,
  total       INTEGER,
  online      INTEGER,
  reported_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Notices (notices/, docs/notices.md): what accounts and services tell you through dither-accounts' `notifications`
-- interface, each with triage's decision on it. Kept 30 days; a marked one longer, while it is learned from.
CREATE TABLE IF NOT EXISTS notice (
  id          TEXT PRIMARY KEY,           -- ntc_<hash(account, native id)>: also the id marks take
  account     TEXT NOT NULL,              -- the manager's account id
  native_id   TEXT NOT NULL,              -- the extractor's own id
  grp         TEXT NOT NULL,              -- ntg_<hash(account, context or source)>: one notification per group
  source      TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  url         TEXT,
  reason      TEXT,
  context     TEXT,
  subject     TEXT,                       -- JSON {kind, title, url, state}
  actors      TEXT,                       -- JSON [{name, url}]
  urgency     TEXT NOT NULL CHECK (urgency IN ('high', 'normal', 'low')),
  at          INTEGER NOT NULL,           -- when the source last raised it
  unread      INTEGER NOT NULL DEFAULT 1,
  read_at     INTEGER,
  decision    TEXT,                       -- push | digest | drop | silent; null until decided
  importance  REAL,
  alert       REAL,                       -- the alert chance
  reasons     TEXT,                       -- JSON, the deciding one first
  decided_by  TEXT,
  facts       TEXT,                       -- JSON learn.ts Facts, for marks to be learned from
  words       TEXT,                       -- JSON
  delivered   INTEGER NOT NULL DEFAULT 0, -- a notification went out
  caught      INTEGER NOT NULL DEFAULT 0, -- decided as a catch-up found it (it notified nobody)
  shown_ts    INTEGER,                    -- its time (at) as its notification last showed it; kept across updates
  held_at     INTEGER,                    -- when quiet hours first held it (counted once for their summary)
  decided_at  INTEGER,
  alert_mark  INTEGER,                    -- 1 should have alerted, 0 the alert was wrong
  less_mark   INTEGER,                    -- 1 less like this
  marked_at   INTEGER,
  created_at  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS notice_at ON notice(at);
CREATE INDEX IF NOT EXISTS notice_grp ON notice(grp, at);
CREATE INDEX IF NOT EXISTS notice_marked ON notice(marked_at) WHERE marked_at IS NOT NULL;
