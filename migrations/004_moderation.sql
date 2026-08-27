-- StaticLayer v1 — Phase: moderation settings + allow/block lists.
-- Editable settings (admin panel), merged with env-var defaults at runtime.
-- Keys: pow_difficulty, reaction_options, moderation_mode ('open'|'allowlist').
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Allow/block lists for nicknames (a ban is a 'block' entry).
-- `value` is stored lowercased; matching is case-insensitive.
CREATE TABLE IF NOT EXISTS moderation_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('allow', 'block')),
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS idx_moderation_lists_kind ON moderation_lists (kind);
