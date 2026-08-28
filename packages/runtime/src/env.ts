import type { D1Database, Fetcher, RateLimit } from '@cloudflare/workers-types';

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
  /** Minimum seconds between challenge issue and submit (anti-bot time gate). */
  CHALLENGE_TIME_GATE_SECONDS?: number;
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

  // --- Cloudflare Access (optional admin SSO, "Sign in with Cloudflare") ----
  /**
   * Cloudflare Access team subdomain, e.g. "myteam" (or the full
   * "myteam.cloudflareaccess.com"). When set, the admin console offers
   * "Sign in with Cloudflare" and accepts a verified
   * `Cf-Access-Jwt-Assertion` header instead of the password.
   */
  CF_ACCESS_TEAM?: string;
  /** Optional Access Application AUID to enforce in the JWT `aud` claim. */
  CF_ACCESS_AUD?: string;
  /** Optional JWKS endpoint override (default https://{team}/cdn-cgi/access/certs). */
  CF_ACCESS_JWKS_URL?: string;

  // --- GitHub OAuth (optional password-less admin sign-in) ----------------
  /** GitHub OAuth App Client ID (see the in-app step-by-step guide). */
  GITHUB_CLIENT_ID?: string;
  /** GitHub OAuth App Client Secret — store with `wrangler secret put`. */
  GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated GitHub user IDs allowed to sign in, e.g. "108115781". */
  GITHUB_ADMIN_IDS?: string;
  /** Comma-separated GitHub logins allowed to sign in (case-insensitive). */
  GITHUB_ADMIN_LOGINS?: string;
  /** Test-only override for GitHub's token endpoint (default github.com). */
  GITHUB_TOKEN_URL?: string;
  /** Test-only override for GitHub's user endpoint (default api.github.com). */
  GITHUB_USER_URL?: string;
  /**
   * Test-only service binding used in place of `fetch()` to GitHub, so
   * integration tests can stub the OAuth endpoints with a mock Worker.
   */
  GITHUB_OAUTH_SERVICE?: Fetcher;
  /** Optional update-manifest URL for the admin "Check for updates" tab. */
  UPDATES_URL?: string;
}

export const DEFAULTS = {
  POW_DIFFICULTY: 16,
  CHALLENGE_TTL_SECONDS: 300,
  CHALLENGE_TIME_GATE_SECONDS: 3,
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
