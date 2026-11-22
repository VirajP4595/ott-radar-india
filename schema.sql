-- Manual release entries added by the site owner. TMDB data is never stored server-side.
CREATE TABLE IF NOT EXISTS manual (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  title TEXT NOT NULL,
  poster_path TEXT,
  original_language TEXT,
  languages TEXT, -- comma-separated codes, e.g. "te,hi,ta"
  platform TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Expected', 'Confirmed')),
  label TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_manual_date ON manual (date);
