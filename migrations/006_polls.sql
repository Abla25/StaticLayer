-- StaticLayer v1 — polls (StrawPoll-style, privacy-first).
-- A poll belongs to ONE article path; options are stored as JSON in `options`.
-- `single_vote` enables the optional per-browser single-vote guard: the server
-- stores only an anonymous hash of a signed voter token (never the token
-- itself, never any personal data), and UNIQUE(poll_id, voter_hash) rejects a
-- second vote from the same browser. Rows without a voter_hash (casual polls)
-- never conflict.
CREATE TABLE IF NOT EXISTS polls (
  id           TEXT PRIMARY KEY,
  article_path TEXT NOT NULL,
  question     TEXT NOT NULL,
  -- JSON array of strings
  options      TEXT NOT NULL,
  multi        INTEGER NOT NULL DEFAULT 0,
  single_vote  INTEGER NOT NULL DEFAULT 0,
  -- 'open' | 'closed'
  status       TEXT NOT NULL DEFAULT 'open',
  created_at   INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_polls_article ON polls (article_path, status);

CREATE TABLE IF NOT EXISTS poll_votes (
  id           TEXT PRIMARY KEY,
  poll_id      TEXT NOT NULL,
  option       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  challenge_id TEXT NOT NULL,
  -- optional anonymous single-vote guard
  voter_hash   TEXT,
  UNIQUE (poll_id, voter_hash)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes (poll_id, option);
