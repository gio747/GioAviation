-- GioAviation.aero — Migrazione 002: profilo pilota, attivazione password,
-- categorie, articoli, documenti.
-- Applica una volta sola via: Cloudflare dashboard → Workers & Pages → D1 →
-- gioaviation-db → Console (incolla tutto il file ed esegui), oppure
-- `wrangler d1 execute gioaviation-db --file=migration-002-backend.sql`.
--
-- Sicura da rieseguire: ogni ALTER TABLE è avvolto in un controllo "colonna
-- già esistente" tramite CREATE TABLE ... IF NOT EXISTS dove possibile;
-- gli ALTER TABLE ADD COLUMN vanno invece eseguiti una volta sola (SQLite
-- non supporta "ADD COLUMN IF NOT EXISTS"). Se li rilanci per errore su un
-- database già migrato, otterrai "duplicate column name": puoi ignorarlo.

-- ---------------------------------------------------------------- pilots --
-- Il pilota ora sceglie la propria password tramite un link di attivazione
-- (invece di ricevere una password generata via email). Il profilo va
-- completato al primo accesso.

ALTER TABLE pilots ADD COLUMN first_name TEXT;
ALTER TABLE pilots ADD COLUMN last_name TEXT;
ALTER TABLE pilots ADD COLUMN birth_year INTEGER;
ALTER TABLE pilots ADD COLUMN role TEXT;
ALTER TABLE pilots ADD COLUMN total_hours REAL;
ALTER TABLE pilots ADD COLUMN profile_completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pilots ADD COLUMN activation_token_hash TEXT;
ALTER TABLE pilots ADD COLUMN activation_expires TEXT;

-- ------------------------------------------------------------- categories --
-- Sottocategorie create liberamente dall'admin, condivise fra la libreria
-- documenti (kind='document') e gli articoli (kind='article').

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,              -- 'document' | 'article'
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE(kind, slug)
);

-- -------------------------------------------------------------- articles --
-- Contenuto pubblico, scritto in Markdown semplice, senza necessità di
-- registrazione per la lettura.

CREATE TABLE IF NOT EXISTS articles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  excerpt         TEXT,
  body_markdown   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'published'
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  published_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status, published_at);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category_id);

-- ------------------------------------------------------------- documents --
-- PDF riservati ai piloti approvati con profilo completo. Il file vero
-- vive su Cloudflare R2 (bucket "gioaviation-documents", binding DOCS);
-- questa tabella tiene solo i metadati e la chiave dell'oggetto R2.

CREATE TABLE IF NOT EXISTS documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  file_key        TEXT NOT NULL,       -- chiave oggetto in R2
  file_name       TEXT NOT NULL,       -- nome file mostrato al download
  file_size       INTEGER,
  content_type    TEXT,
  revision_label  TEXT,                -- es. "FCOM Vol 2 · Rev 14"
  revision_date   TEXT,                -- es. "2026-09-03"
  status          TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'published'
  uploaded_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status, category_id);
