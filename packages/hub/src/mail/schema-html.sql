-- Slice 3 (docs/mail.md, mail-design.md §7): remote images and files.

-- "Always show images from this sender". Slice 8's mail_sender may take this over as its `images` column.
CREATE TABLE IF NOT EXISTS mail_sender_images (
  address TEXT PRIMARY KEY,                     -- lower case
  allow   INTEGER NOT NULL,
  at      INTEGER NOT NULL
);

-- What a mail file is by its bytes (fileinfo.ts), keyed by its name in the media cache.
CREATE TABLE IF NOT EXISTS mail_file_info (
  key      TEXT PRIMARY KEY,
  info     TEXT NOT NULL,                       -- JSON FileInfo
  version  INTEGER NOT NULL,                    -- fileinfo.ts SNIFF_VERSION
  at       INTEGER NOT NULL
);
