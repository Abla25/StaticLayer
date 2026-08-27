-- StaticLayer v1 — nested replies.
-- Adds an optional parent to a comment. Depth is capped client-side (3 levels);
-- the server validates the parent exists, is approved and belongs to the same
-- article. The public read excludes replies whose parent is pending, and keeps
-- replies whose parent was deleted (the widget renders a "removed" placeholder).
ALTER TABLE comments ADD COLUMN parent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments (parent_id, created_at);
