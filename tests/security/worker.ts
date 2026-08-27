import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { D1Database } from '@cloudflare/workers-types';

/**
 * Integration-test helpers: spawn the REAL runtime Worker in Miniflare
 * (the same workerd runtime used by `wrangler dev`) with a fresh, ephemeral
 * local D1, and apply the real migration files.
 */

export const RUNTIME_ENTRY = fileURLToPath(
  new URL('../../packages/runtime/src/index.ts', import.meta.url),
);
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export const SECRETS = {
  ADMIN_SECRET: 'test-admin-secret-0123456789abcdef',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  POW_SECRET: 'test-pow-secret-0123456789abcdef',
} as const;

export interface WorkerOptions {
  difficulty?: number;
  challengeTtlSeconds?: number;
  withRateLimiter?: boolean;
  allowedOrigins?: string;
  reactionBase?: number;
  reactionCeiling?: number;
  reactionEscalationVotes?: number;
  reactionIntervalSeconds?: number;
  reactionOptions?: string;
}

// The bundle is identical for every spawned worker: build it once, lazily.
// Passed INLINE via `script:` (not `scriptPath:`): in the installed Miniflare
// v4, loading a bundled file through `scriptPath` fails with an opaque workerd
// "internal error", while inline `script:` works (verified 2026-08-26,
// scripts/mf-debug.mjs).
let bundlePromise: Promise<string> | undefined;

function getBundleText(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = build({
      entryPoints: [RUNTIME_ENTRY],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
    }).then((result) => {
      const text = result.outputFiles?.[0]?.text;
      if (!text) throw new Error('esbuild produced no output for the worker bundle');
      return text;
    });
  }
  return bundlePromise;
}

export async function spawnWorker(options: WorkerOptions = {}): Promise<Miniflare> {
  const script = await getBundleText();

  const bindings: Record<string, unknown> = {
    ...SECRETS,
    POW_DIFFICULTY: options.difficulty ?? 16,
  };
  if (options.challengeTtlSeconds !== undefined) {
    bindings.CHALLENGE_TTL_SECONDS = options.challengeTtlSeconds;
  }
  if (options.allowedOrigins !== undefined) {
    bindings.ALLOWED_ORIGINS = options.allowedOrigins;
  }
  if (options.reactionBase !== undefined) bindings.REACTION_DIFFICULTY_BASE = options.reactionBase;
  if (options.reactionCeiling !== undefined) bindings.REACTION_DIFFICULTY_CEILING = options.reactionCeiling;
  if (options.reactionEscalationVotes !== undefined) bindings.REACTION_ESCALATION_VOTES = options.reactionEscalationVotes;
  if (options.reactionIntervalSeconds !== undefined) bindings.REACTION_MIN_INTERVAL_SECONDS = options.reactionIntervalSeconds;
  if (options.reactionOptions !== undefined) bindings.REACTION_OPTIONS = options.reactionOptions;

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'staticlayer',
          modules: true,
          script,
          compatibilityDate: '2026-08-26',
          bindings,
          ...(options.withRateLimiter
            ? { ratelimits: { RATE_LIMITER: { namespace_id: '1', simple: { limit: 1000, period: 60 } } } }
            : {}),
          d1Databases: { DB: 'staticlayer-test' },
        },
      ],
    }),
  );

  const db = await mf.getD1Database('DB');
  await applyMigrations(db);
  return mf;
}

/**
 * Apply all migrations/*.sql files, in filename order, one statement at a
 * time. Whitespace is collapsed to a single line: the local D1 `exec()` in the
 * installed Miniflare version rejects multi-line statements with an opaque
 * "incomplete input" error, while single-line SQL works (verified 2026-08-26).
 * Safe: the migrations contain no string literals, so collapsing whitespace
 * cannot change semantics.
 */
export async function applyMigrations(db: D1Database): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .replace(/\s+/g, ' ')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await db.exec(statement);
    }
  }
}
