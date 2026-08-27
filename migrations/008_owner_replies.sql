-- StaticLayer v1 — admin (owner) replies.
-- Owner replies are created from the admin panel, marked as such, and appear
-- immediately (already approved). The public widget shows an "Author" badge.
ALTER TABLE comments ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments (parent_id, created_at);
