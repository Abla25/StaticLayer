-- StaticLayer v1 — Phase 2: admin moderation queue.
-- The admin queue queries WHERE status = ? ORDER BY created_at.
CREATE INDEX IF NOT EXISTS idx_comments_status_created
  ON comments (status, created_at);
