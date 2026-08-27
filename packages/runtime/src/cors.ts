import type { Env } from './env.ts';
import { json } from './http.ts';

/**
 * Cross-Origin Resource Sharing — explicit allowlist (THREAT_MODEL T15/T16).
 *
 * Fail-closed: if `ALLOWED_ORIGINS` is empty (default), NO cross-origin
 * request is allowed and no `Access-Control-Allow-Origin` header is ever set.
 * Only origins listed explicitly are echoed back (never `*`), including for
 * admin routes. `Vary: Origin` keeps caches honest per-origin.
 */

export interface CorsDecision {
  allowed: boolean;
  origin: string | null;
}

/** Parse the comma-separated `ALLOWED_ORIGINS` var. Empty => same-origin only. */
export function parseAllowedOrigins(env: Env): string[] {
  const raw = env.ALLOWED_ORIGINS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Decide whether an incoming request's Origin is allowlisted. */
export function decideCors(request: Request, allowedOrigins: string[]): CorsDecision {
  const origin = request.headers.get('origin');
  if (!origin) return { allowed: false, origin: null };
  return { allowed: allowedOrigins.includes(origin), origin };
}

const CORS_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const CORS_HEADERS = 'content-type, x-csrf-token';

/** Attach per-origin CORS headers to an existing response (only if allowed). */
export function withCors(response: Response, decision: CorsDecision): Response {
  if (!decision.allowed || !decision.origin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', decision.origin);
  headers.set('vary', 'origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Handle an OPTIONS preflight. Returns a response for OPTIONS requests, or
 * null when the request is not a preflight. Disallowed origins get a 403 —
 * the browser never sees CORS headers.
 */
export function handlePreflight(request: Request, decision: CorsDecision): Response | null {
  if (request.method !== 'OPTIONS') return null;
  if (!decision.allowed || !decision.origin) {
    return json({ error: 'origin not allowed' }, 403);
  }
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': decision.origin,
      'access-control-allow-methods': CORS_METHODS,
      'access-control-allow-headers': CORS_HEADERS,
      'access-control-max-age': '86400',
      vary: 'origin',
      'cache-control': 'no-store',
    },
  });
}
