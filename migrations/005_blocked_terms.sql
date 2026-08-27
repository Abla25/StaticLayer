-- StaticLayer v1 — blocked terms (auto-reject comments containing them).
-- Case-insensitive substring match against the comment body at submit time;
-- a hit means the comment is never stored (auto-removed).
CREATE TABLE IF NOT EXISTS blocked_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
