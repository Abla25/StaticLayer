import type { D1Database, RateLimit } from '@cloudflare/workers-types';

/**
 * Worker environment (bindings + vars), defined in `wrangler.jsonc`.
 *
 * EXACTLY three secrets, strictly separated roles (SECURITY_REVIEW.md §6):
 *   - ADMIN_SECRET:  timing-safe comparison during admin login.
 *   - SESSION_SECRET: signing the stateless admin session + CSRF binding.
 *   - POW_SECRET:     signing/verifying PoW challenges (HMAC-SHA256).
 */
export interface Env {
  ADMIN_SECRET: string;
  SESSION_SECRET: string;
  POW_SECRET: string;

  DB: D1Database;
  /** Optional in tests/local: the Worker degrades gracefully if absent. */
  RATE_LIMITER?: RateLimit;

  // Tunables (vars in wrangler.jsonc; overridable per test).
  POW_DIFFICULTY?: number;
  CHALLENGE_TTL_SECONDS?: number;
  SESSION_TTL_SECONDS?: number;
  MAX_REQUEST_BYTES?: number;
  /**
   * Comma-separated list of allowed origins for cross-origin requests
   * (CORS). Empty by default => same-origin only, fail-closed.
   * See packages/runtime/src/cors.ts.
   */
  ALLOWED_ORIGINS?: string;

  // --- reactions (anonymous, PoW-protected) -------------------------------
  /** Comma-separated allowed reactions, e.g. "👍,❤️,🎉". Empty => disabled. */
  REACTION_OPTIONS?: string;
  /** Difficulty for the first reactions on an article (default 16). */
  REACTION_DIFFICULTY_BASE?: number;
  /** Hard cap on reaction difficulty (default 20). */
  REACTION_DIFFICULTY_CEILING?: number;
  /** Votes per +1 difficulty step (default 20). */
  REACTION_ESCALATION_VOTES?: number;
  /** Minimum seconds between accepted reactions on the same article. */
  REACTION_MIN_INTERVAL_SECONDS?: number;
}

export const DEFAULTS = {
  POW_DIFFICULTY: 16,
  CHALLENGE_TTL_SECONDS: 300,
  SESSION_TTL_SECONDS: 7200,
  MAX_REQUEST_BYTES: 65536,
  REACTION_OPTIONS: '👍,❤️,🎉',
  REACTION_DIFFICULTY_BASE: 16,
  REACTION_DIFFICULTY_CEILING: 20,
  REACTION_ESCALATION_VOTES: 20,
  REACTION_MIN_INTERVAL_SECONDS: 3,
} as const;

/** Read a numeric var, falling back to the default for missing/invalid values. */
export function envNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
