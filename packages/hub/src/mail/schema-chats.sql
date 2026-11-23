-- Mail as chats (docs/mail.md "Mail as chats", mail/places.ts): one mail that reached two of your accounts is two
-- messages with one Message-ID, shown once in a person's chat.
CREATE INDEX IF NOT EXISTS mail_message_hdr ON mail_message(message_id_hdr) WHERE message_id_hdr IS NOT NULL;
