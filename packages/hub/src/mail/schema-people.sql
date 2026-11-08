-- People in mail (slice 6, docs/mail-design.md §9, mail/people.ts): who is on each thread and how, so the hub can tell
-- who has written to you in a thread you took part in, whom you wrote to, and what their name is, without reading
-- every message again. Kept by MailStore.recompute's hook; a thread's rows go with it.

CREATE TABLE IF NOT EXISTS mail_party (
  address     TEXT NOT NULL,                    -- lower-cased; never one of the account's own
  thread_id   TEXT NOT NULL REFERENCES mail_thread(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL,
  sent        INTEGER NOT NULL DEFAULT 0,       -- messages from them in it
  got         INTEGER NOT NULL DEFAULT 0,       -- messages of yours to them in it (To, Cc), drafts not counted
  mine        INTEGER NOT NULL DEFAULT 0,       -- you wrote in this thread (not a draft)
  name        TEXT,                             -- the name on their latest From here, else the one you wrote to
  name_from   INTEGER NOT NULL DEFAULT 0,       -- 1: `name` is from a From
  name_at     INTEGER NOT NULL DEFAULT 0,       -- when that name was used
  last_at     INTEGER NOT NULL,                 -- the thread's last message
  PRIMARY KEY (address, thread_id)
);
CREATE INDEX IF NOT EXISTS mail_party_thread ON mail_party(thread_id);

-- Mail from one address, newest first: names and classes by sender.
CREATE INDEX IF NOT EXISTS mail_message_from ON mail_message(from_addr, received_at);
