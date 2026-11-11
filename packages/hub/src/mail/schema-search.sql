-- Mail search (slice 7, docs/mail.md, docs/mail-design.md §11): the text each message is found by, and its full-text
-- index. Kept current by triggers, so whatever stores a message or a body's text (the first sync, a server search,
-- the reader, slice 2's prefetch) is searchable without calling anything.
--
--   subject  the subject
--   people   From, To and Cc, names and addresses
--   body     the body's search text once it is fetched (slice 2's mail_text: its first MAIL_LIMITS.textBytes, all of
--            it up to MAIL_LIMITS.keepTextBytes on an account that keeps all its mail), else the preview
--   files    its attachments' file names, once its body was fetched (filename:, and plain words too); they stay when
--            the body and its text go
--
-- mail_text (schema-big.sql, loaded before this file) outlives the body cache and has the one cap on search text
-- (MAIL_LIMITS.indexMb, oldest first, cache.ts). Its rows set the body here, and one that goes puts the preview back.
-- Everything here goes with its message.
--
-- Beside the text, what a search groups and filters by most, so a search for words reads no other table: the
-- message's account, thread and time, and whether it is only in Junk or Trash (searched only when asked for).
--
-- mail_search has an INTEGER PRIMARY KEY, so the index's rowids survive a VACUUM. Triggers are created only when
-- missing: a change to one needs a DROP TRIGGER first. A database from before `files` gets it in store.ts
-- (searchFiles): the column, the index made again with it, and these triggers again.

CREATE TABLE IF NOT EXISTS mail_search (
  n           INTEGER PRIMARY KEY,
  message_id  TEXT NOT NULL UNIQUE,
  account_id  TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  at          INTEGER NOT NULL,               -- received_at
  shut        INTEGER NOT NULL DEFAULT 1,     -- in no mailbox but Junk or Trash
  full        INTEGER NOT NULL DEFAULT 0,     -- body is mail_text's (else the preview)
  subject     TEXT NOT NULL DEFAULT '',
  people      TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  files       TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(subject, people, body, files, content = 'mail_search', content_rowid = 'n', tokenize = "unicode61 remove_diacritics 2");
-- The index's words, for correcting a misspelt one (as chat's message_fts_vocab).
CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts_vocab USING fts5vocab(mail_fts, row);

CREATE TRIGGER IF NOT EXISTS mail_search_insert AFTER INSERT ON mail_search BEGIN
  INSERT INTO mail_fts (rowid, subject, people, body, files) VALUES (new.n, new.subject, new.people, new.body, new.files);
END;
CREATE TRIGGER IF NOT EXISTS mail_search_delete AFTER DELETE ON mail_search BEGIN
  INSERT INTO mail_fts (mail_fts, rowid, subject, people, body, files) VALUES ('delete', old.n, old.subject, old.people, old.body, old.files);
END;
CREATE TRIGGER IF NOT EXISTS mail_search_update AFTER UPDATE OF subject, people, body, files ON mail_search
  WHEN old.subject IS NOT new.subject OR old.people IS NOT new.people OR old.body IS NOT new.body OR old.files IS NOT new.files BEGIN
  INSERT INTO mail_fts (mail_fts, rowid, subject, people, body, files) VALUES ('delete', old.n, old.subject, old.people, old.body, old.files);
  INSERT INTO mail_fts (rowid, subject, people, body, files) VALUES (new.n, new.subject, new.people, new.body, new.files);
END;

-- From the messages.
CREATE TRIGGER IF NOT EXISTS mail_message_search_insert AFTER INSERT ON mail_message BEGIN
  DELETE FROM mail_search WHERE message_id = new.id;
  INSERT INTO mail_search (message_id, account_id, thread_id, at, subject, people, body) VALUES (
    new.id, new.account_id, new.thread_id, new.received_at, new.subject,
    trim(COALESCE(new.from_name, '') || ' ' || COALESCE(new.from_addr, '') || ' '
      || COALESCE((SELECT group_concat(COALESCE(json_extract(value, '$.name'), '') || ' ' || COALESCE(json_extract(value, '$.email'), ''), ' ') FROM json_each(new.to_json)), '') || ' '
      || COALESCE((SELECT group_concat(COALESCE(json_extract(value, '$.name'), '') || ' ' || COALESCE(json_extract(value, '$.email'), ''), ' ') FROM json_each(new.cc_json)), '')),
    COALESCE(new.preview, ''));
END;
CREATE TRIGGER IF NOT EXISTS mail_message_search_people AFTER UPDATE OF subject, from_addr, from_name, to_json, cc_json ON mail_message BEGIN
  UPDATE mail_search SET subject = new.subject,
    people = trim(COALESCE(new.from_name, '') || ' ' || COALESCE(new.from_addr, '') || ' '
      || COALESCE((SELECT group_concat(COALESCE(json_extract(value, '$.name'), '') || ' ' || COALESCE(json_extract(value, '$.email'), ''), ' ') FROM json_each(new.to_json)), '') || ' '
      || COALESCE((SELECT group_concat(COALESCE(json_extract(value, '$.name'), '') || ' ' || COALESCE(json_extract(value, '$.email'), ''), ' ') FROM json_each(new.cc_json)), ''))
  WHERE message_id = new.id;
END;
CREATE TRIGGER IF NOT EXISTS mail_message_search_preview AFTER UPDATE OF preview ON mail_message WHEN new.preview IS NOT old.preview BEGIN
  UPDATE mail_search SET body = COALESCE(new.preview, '') WHERE message_id = new.id AND full = 0;
END;
CREATE TRIGGER IF NOT EXISTS mail_message_search_delete AFTER DELETE ON mail_message BEGIN
  DELETE FROM mail_search WHERE message_id = old.id;
END;
-- Threads merge and messages move between them (thread.ts).
CREATE TRIGGER IF NOT EXISTS mail_message_search_thread AFTER UPDATE OF thread_id ON mail_message WHEN new.thread_id IS NOT old.thread_id BEGIN
  UPDATE mail_search SET thread_id = new.thread_id WHERE message_id = new.id;
END;

-- Where it is: shut while no mailbox but Junk and Trash holds it.
CREATE TRIGGER IF NOT EXISTS mail_location_search_insert AFTER INSERT ON mail_location BEGIN
  UPDATE mail_search SET shut = NOT EXISTS (SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = new.message_id AND (b.role IS NULL OR b.role NOT IN ('junk', 'trash')))
  WHERE message_id = new.message_id;
END;
CREATE TRIGGER IF NOT EXISTS mail_location_search_delete AFTER DELETE ON mail_location BEGIN
  UPDATE mail_search SET shut = NOT EXISTS (SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = old.message_id AND (b.role IS NULL OR b.role NOT IN ('junk', 'trash')))
  WHERE message_id = old.message_id;
END;
-- A relist upserts every location it sees: only one that now names another message counts.
CREATE TRIGGER IF NOT EXISTS mail_location_search_update AFTER UPDATE OF message_id, mailbox_id ON mail_location
  WHEN new.message_id IS NOT old.message_id OR new.mailbox_id IS NOT old.mailbox_id BEGIN
  UPDATE mail_search SET shut = NOT EXISTS (SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = mail_search.message_id AND (b.role IS NULL OR b.role NOT IN ('junk', 'trash')))
  WHERE message_id IN (old.message_id, new.message_id);
END;
CREATE TRIGGER IF NOT EXISTS mailbox_search_role AFTER UPDATE OF role ON mailbox WHEN new.role IS NOT old.role BEGIN
  UPDATE mail_search SET shut = NOT EXISTS (SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = mail_search.message_id AND (b.role IS NULL OR b.role NOT IN ('junk', 'trash')))
  WHERE message_id IN (SELECT message_id FROM mail_location WHERE mailbox_id = new.id);
END;

-- From the search text (slice 2's mail_text): set when a body's text is stored, the preview again when its text goes
-- (its cap). A body leaving the body cache leaves its text, so nothing changes here then.
CREATE TRIGGER IF NOT EXISTS mail_text_search_insert AFTER INSERT ON mail_text BEGIN
  UPDATE mail_search SET body = new.text, full = 1 WHERE message_id = new.message_id;
END;
CREATE TRIGGER IF NOT EXISTS mail_text_search_update AFTER UPDATE OF text ON mail_text BEGIN
  UPDATE mail_search SET body = new.text, full = 1 WHERE message_id = new.message_id;
END;
CREATE TRIGGER IF NOT EXISTS mail_text_search_delete AFTER DELETE ON mail_text BEGIN
  UPDATE mail_search SET body = COALESCE((SELECT preview FROM mail_message WHERE id = old.message_id), ''), full = 0 WHERE message_id = old.message_id;
END;
