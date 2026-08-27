import type { Env } from './env.ts';

/**
 * Idempotent D1 schema bootstrap (migrations 001..005).
 *
 * The installers create the D1 database and bind it as `DB`, but they cannot
 * run `wrangler d1 migrations apply` inside the customer's account — so the
 * runtime applies the same DDL lazily, once per isolate, before any DB-backed
 * API call. Every statement is `IF NOT EXISTS`, so concurrent isolates and
 * re-deploys are safe; after the first run the batch is skipped entirely.
 */

const SCHEMA_STATEMENTS: string[] = [
  // 001_initial.sql
  `CREATE TABLE IF NOT EXISTS used_challenges (
    challenge_id TEXT PRIMARY KEY,
    used_at      INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS comments (
    id           TEXT PRIMARY KEY,
    article_path TEXT NOT NULL,
    nickname     TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL,
    status       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    challenge_id TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_comments_article_path
    ON comments (article_path, created_at)`,
  // 002_admin_queue.sql
  `CREATE INDEX IF NOT EXISTS idx_comments_status_created
    ON comments (status, created_at)`,
  // 003_reactions.sql
  `CREATE TABLE IF NOT EXISTS reactions (
    id TEXT PRIMARY KEY,
    article_path TEXT NOT NULL,
    reaction TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_reactions_article
    ON reactions(article_path, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_reactions_article_reaction
    ON reactions(article_path, reaction)`,
  // 004_moderation.sql
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS moderation_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('allow', 'block')),
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (kind, value)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_moderation_lists_kind ON moderation_lists (kind)`,
  // 005_blocked_terms.sql
  `CREATE TABLE IF NOT EXISTS blocked_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`,
];

let schemaReady = false;

/**
 * Apply the schema once per isolate. Resolves immediately (no DB call) on
 * subsequent calls within the same isolate. Throws if the batch fails, so the
 * caller can surface a clear 500 instead of a Cloudflare HTML error page.
 */
export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA_STATEMENTS.map((sql) => env.DB.prepare(sql)));
  schemaReady = true;
}

/** Test-only: clear the once-per-isolate cache (each Miniflare D1 is fresh). */
export function resetSchemaBootstrapForTests(): void {
  schemaReady = false;
}
