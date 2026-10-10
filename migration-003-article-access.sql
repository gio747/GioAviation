-- GioAviation.aero — migration 003: per-article access level.
-- Run ONCE in Cloudflare dashboard → D1 → gioaviation-db → Console,
-- BEFORE deploying the matching src/index.js (otherwise /api/articles fails
-- on the new column).
--   'public'  = anyone can read it (default, so every existing article stays public)
--   'members' = body and excerpt only for approved pilots / admin; title stays listed

ALTER TABLE articles ADD COLUMN access TEXT NOT NULL DEFAULT 'public';
