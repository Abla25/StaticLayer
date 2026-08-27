-- StaticLayer v1.6 — anonymous comment votes (like / upvote).
-- Each vote stores ONLY { comment_id, created_at, challenge_id } plus an
-- optional anonymous voter hash when the per-browser guard is used
-- (UNIQUE(comment_id, voter_hash) = one like per browser per comment).
-- No IP, no personal data; challenge_id UNIQUE blocks vote replay.
CREATE TABLE IF NOT EXISTS comment_votes (
  id           TEXT PRIMARY KEY,
  comment_id   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  challenge_id TEXT NOT NULL UNIQUE,
  voter_hash   TEXT,
  UNIQUE (comment_id, voter_hash)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_comment_votes_comment
  ON comment_votes (comment_id);
