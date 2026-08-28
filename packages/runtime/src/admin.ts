import {
  bytesToBase64Url,
  constantTimeEqual,
  randomBytes,
  utf8EncodeStrict,
} from '@staticlayer/protocol';
import { DEFAULTS, envNumber, type Env } from './env.ts';
import { json, readJsonBody } from './http.ts';
import { applyRateLimit } from './ratelimit.ts';
import { requireAdmin } from './auth.ts';
import { signSession } from './session.ts';

/**
 * POST /api/admin/login  { "password": "<ADMIN_SECRET>" }
 *
 * - Compares the supplied password against ADMIN_SECRET in CONSTANT TIME.
 * - On success, sets a stateless signed session cookie:
 *
 *     __Host-StaticLayerSession=<token>; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=<ttl>
 *
 *   The `__Host-` prefix (RFC 6265bis) REQUIRES Secure + Path=/ and FORBIDS a
 *   Domain attribute — so Domain is NEVER emitted.
 *
 * - The response body returns the session-bound `csrf` value, needed later for
 *   the signed double-submit CSRF protection on PATCH/DELETE.
 *
 * NOTE: the password length leaks via `constantTimeEqual` (early return on
 *   length mismatch). The secret's length is not sensitive; the CONTENT
 *   comparison is timing-safe, which is the requirement.
 */
export async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  const limited = await applyRateLimit(env.RATE_LIMITER, 'login');
  if (limited) return limited;

  const read = await readJsonBody(request, 4096);
  if (!read.ok) {
    return json({ error: read.status === 413 ? 'request too large' : 'invalid JSON body' }, read.status);
  }
  const data = read.value;
  const password =
    typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).password === 'string'
      ? ((data as Record<string, unknown>).password as string)
      : '';

  const provided = utf8EncodeStrict(password);
  const expected = utf8EncodeStrict(env.ADMIN_SECRET);
  if (!constantTimeEqual(provided, expected)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const ttl = envNumber(env.SESSION_TTL_SECONDS, DEFAULTS.SESSION_TTL_SECONDS);
  const nowSec = Math.floor(Date.now() / 1000);
  // 32 CSPRNG bytes, base64url — bound to the session and used as the
  // double-submit CSRF token (Phase 2, SECURITY_REVIEW.md I9).
  const csrf = bytesToBase64Url(randomBytes(32));

  const token = await signSession(
    { sub: 'admin', iat: nowSec, exp: nowSec + ttl, csrf, method: 'password' },
    env.SESSION_SECRET,
  );

  // __Host- prefix: Secure + Path=/ + NO Domain (RFC 6265bis).
  const cookie = `__Host-StaticLayerSession=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl}`;

  return json({ csrf }, 200, { 'set-cookie': cookie });
}

/** POST /api/admin/logout — clears the admin session cookie. */
export function handleAdminLogout(): Response {
  const cookie = '__Host-StaticLayerSession=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

/**
 * GET /api/admin/session — restore an existing admin session on page load.
 * Returns the session-bound CSRF token when authenticated (the browser needs
 * it for PATCH/DELETE after a reload), otherwise { authed: false }.
 */
export async function handleAdminSession(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ authed: false });
  return json({ authed: true, csrf: auth.payload.csrf, method: auth.payload.method });
}
