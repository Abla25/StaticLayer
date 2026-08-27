-- StaticLayer v1.6 — pinned comments (admin highlight).
-- The owner can pin a comment so it stays at the top of the thread.
-- Purely a display flag on the comment row; no personal data.
ALTER TABLE comments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
