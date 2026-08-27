-- StaticLayer v1 — initial schema (Phase 1)
-- D1 / SQLite. Applied via `wrangler d1 migrations apply` (see
-- docs/cloudflare-assumptions.md §7).

-- Anti-replay table. `challenge_id` is the canonical base64url text form of
-- the 32-byte CSPRNG challenge id. It is the single-writer PK that makes the
-- atomic anti-replay invariant hold: INSERT OR IGNORE + meta.changes check in
-- one D1 batch() transaction.
CREATE TABLE IF NOT EXISTS used_challenges (
  challenge_id TEXT PRIMARY KEY,
  used_at      INTEGER NOT NULL
) WITHOUT ROWID;

-- Public comments. `status` is plain-text pipeline state ('published' for v1).
-- `challenge_id` records which challenge was consumed by this comment.
CREATE TABLE IF NOT EXISTS comments (
  id           TEXT PRIMARY KEY,
  article_path TEXT NOT NULL,
  nickname     TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  challenge_id TEXT NOT NULL
) WITHOUT ROWID;

-- Listing endpoint reads are ordered per article.
CREATE INDEX IF NOT EXISTS idx_comments_article_path
  ON comments (article_path, created_at);
