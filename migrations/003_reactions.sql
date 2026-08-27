-- Reactions (anonymous, PoW-protected) — Phase reactions.
-- Each row is ONE anonymous reaction event: no user, no IP, no identifier.
-- article_path + reaction + created_at only.

CREATE TABLE IF NOT EXISTS reactions (
  id TEXT PRIMARY KEY,
  article_path TEXT NOT NULL,
  reaction TEXT NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_reactions_article
  ON reactions(article_path, created_at);

CREATE INDEX IF NOT EXISTS idx_reactions_article_reaction
  ON reactions(article_path, reaction);
