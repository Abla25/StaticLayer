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
  /** Min seconds between challenge issue and submit; default 0 in tests. */
  timeGateSeconds?: number;
  withRateLimiter?: boolean;
  allowedOrigins?: string;
  reactionBase?: number;
  reactionCeiling?: number;
  reactionEscalationVotes?: number;
  reactionIntervalSeconds?: number;
  reactionOptions?: string;
  /** Skip applying migrations/*.sql — leaves the D1 database completely empty (installer scenario). */
  skipMigrations?: boolean;
  /**
   * When set, a second "github-mock" Worker is spawned and exposed to the
   * runtime as the GITHUB_OAUTH_SERVICE service binding, stubbing GitHub's
   * OAuth endpoints without any network (no outbound fetch needed).
   */
  mockGithub?: {
    tokenJson?: unknown;
    userJson?: unknown;
    tokenStatus?: number;
    userStatus?: number;
    /** When set, the mock rejects token exchanges whose body `code` differs. */
    expectCode?: string;
  };
}

/** Inline mock Worker for the GitHub OAuth endpoints (see mockGithub option). */
const GITHUB_MOCK_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { 'content-type': 'application/json' };
    if (url.pathname === '/login/oauth/access_token') {
      let body = null;
      try { body = await request.json(); } catch {}
      if (env.MOCK_EXPECT_CODE && (!body || body.code !== env.MOCK_EXPECT_CODE)) {
        return new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 401, headers });
      }
      const status = typeof env.MOCK_TOKEN_STATUS === 'number' ? env.MOCK_TOKEN_STATUS : 200;
      return new Response(
        JSON.stringify(env.MOCK_TOKEN_JSON ?? { access_token: 'gho_fake_token', token_type: 'bearer' }),
        { status, headers },
      );
    }
    if (url.pathname === '/user') {
      const status = typeof env.MOCK_USER_STATUS === 'number' ? env.MOCK_USER_STATUS : 200;
      return new Response(
        JSON.stringify(env.MOCK_USER_JSON ?? { id: 108115781, login: 'Abla25' }),
        { status, headers },
      );
    }
    return new Response('{"error":"not mocked"}', { status: 404, headers });
  }
}`;
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

export async function spawnWorker(
  options: WorkerOptions = {},
  extraBindings: Record<string, unknown> = {},
): Promise<Miniflare> {
  const script = await getBundleText();

  const bindings: Record<string, unknown> = {
    ...SECRETS,
    POW_DIFFICULTY: options.difficulty ?? 16,
    ...extraBindings,
  };
  if (options.challengeTtlSeconds !== undefined) {
    bindings.CHALLENGE_TTL_SECONDS = options.challengeTtlSeconds;
  }
  // Time gate OFF by default so existing tests stay fast.
  bindings.CHALLENGE_TIME_GATE_SECONDS = options.timeGateSeconds ?? 0;
  if (options.allowedOrigins !== undefined) {
    bindings.ALLOWED_ORIGINS = options.allowedOrigins;
  }
  if (options.reactionBase !== undefined) bindings.REACTION_DIFFICULTY_BASE = options.reactionBase;
  if (options.reactionCeiling !== undefined) bindings.REACTION_DIFFICULTY_CEILING = options.reactionCeiling;
  if (options.reactionEscalationVotes !== undefined) bindings.REACTION_ESCALATION_VOTES = options.reactionEscalationVotes;
  if (options.reactionIntervalSeconds !== undefined) bindings.REACTION_MIN_INTERVAL_SECONDS = options.reactionIntervalSeconds;
  if (options.reactionOptions !== undefined) bindings.REACTION_OPTIONS = options.reactionOptions;

  const converted = convertV4MiniflareOptions({
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
        ...(options.mockGithub
          ? { serviceBindings: { GITHUB_OAUTH_SERVICE: 'github-mock' } }
          : {}),
        d1Databases: { DB: 'staticlayer-test' },
      },
      ...(options.mockGithub
        ? [
            {
              name: 'github-mock',
              modules: true,
              script: GITHUB_MOCK_SCRIPT,
              compatibilityDate: '2026-08-26',
              bindings: Object.fromEntries(
                Object.entries({
                  MOCK_TOKEN_JSON: options.mockGithub.tokenJson,
                  MOCK_USER_JSON: options.mockGithub.userJson,
                  MOCK_TOKEN_STATUS: options.mockGithub.tokenStatus,
                  MOCK_USER_STATUS: options.mockGithub.userStatus,
                  MOCK_EXPECT_CODE: options.mockGithub.expectCode,
                }).filter(([, v]) => v !== undefined),
              ),
            },
          ]
        : []),
    ],
  });

  const mf = new Miniflare(converted);

  const db = await mf.getD1Database('DB');
  if (!options.skipMigrations) await applyMigrations(db);
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
