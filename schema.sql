-- GioAviation.aero — D1 schema for pilot access requests and accounts.
-- Apply once via: Cloudflare dashboard → Workers & Pages → D1 → gioaviation-db → Console
-- (paste this whole file and run it), or `wrangler d1 execute gioaviation-db --file=schema.sql`.

CREATE TABLE IF NOT EXISTS pilots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  company       TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  password_hash TEXT,
  password_salt TEXT,
  created_at    TEXT NOT NULL,
  approved_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_pilots_status ON pilots(status);
