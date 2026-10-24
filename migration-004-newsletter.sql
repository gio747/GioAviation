-- GioAviation.aero — migration 004: email notifications ("newsletter").
-- Run ONCE in Cloudflare dashboard → D1 → gioaviation-db → Console,
-- BEFORE merging the matching code (the new Worker reads these columns).
-- The currently live Worker keeps working after this migration, because it
-- only selects explicit columns.
--
-- Recipients are approved pilots who have activated their account (clicked the
-- emailed link, so the address is verified) AND opted in. Nobody is subscribed
-- by default: every existing pilot starts at 0.
--
--   pilots.newsletter_optin       1 = wants an email for each new article/document
--   pilots.newsletter_optin_at    when consent was given (proof of consent)
--   pilots.newsletter_optout_at   when they last unsubscribed
--   articles/documents.newsletter_sent_at
--                                 NULL = newsletter not sent yet; a date = already
--                                 sent (the Worker refuses to send it twice)

ALTER TABLE pilots ADD COLUMN newsletter_optin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pilots ADD COLUMN newsletter_optin_at TEXT;
ALTER TABLE pilots ADD COLUMN newsletter_optout_at TEXT;

ALTER TABLE articles ADD COLUMN newsletter_sent_at TEXT;
ALTER TABLE documents ADD COLUMN newsletter_sent_at TEXT;

CREATE INDEX IF NOT EXISTS idx_pilots_newsletter ON pilots(status, newsletter_optin);
