-- StaticLayer v1.6 — visitor "report" flags (minimal, zero personal data).
-- A visitor can flag a comment; the owner sees the count in moderation.
-- A flag stores ONLY { comment_id, created_at, challenge_id } — no reason
-- text, no identity, no IP. challenge_id UNIQUE also makes flags single-use
-- (anti-replay on top of the consumed PoW challenge).
CREATE TABLE IF NOT EXISTS comment_flags (
  id           TEXT PRIMARY KEY,
  comment_id   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  challenge_id TEXT NOT NULL UNIQUE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_comment_flags_comment
  ON comment_flags (comment_id, created_at);
