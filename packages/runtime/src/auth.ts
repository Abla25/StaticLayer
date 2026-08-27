import { constantTimeEqual, utf8EncodeStrict } from '@staticlayer/protocol';
import type { Env } from './env.ts';
import { json } from './http.ts';
import { verifySession, type SessionPayload } from './session.ts';

/**
 * Admin authentication middleware (Phase 2).
 *
 * The stateless session is carried in the `__Host-StaticLayerSession` cookie
 * (Secure; HttpOnly; SameSite=Strict; Path=/; NO Domain — RFC 6265bis).
 * `verifySession` re-verifies the HMAC signature and the absolute `exp` on
 * every request (no sliding renewal).
 *
 * CSRF: PATCH/DELETE additionally require the `X-CSRF-Token` header to match
 * the session-bound `csrf` value (signed double-submit), compared in constant
 * time. An attacker cannot forge the header (no cross-site read of the value)
 * and the cookie is not sent cross-site (SameSite=Strict + Host-only).
 */

const SESSION_COOKIE = '__Host-StaticLayerSession';

export function getSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

export type AdminAuth =
  | { ok: true; payload: SessionPayload }
  | { ok: false; response: Response };

/** Session gate: 401 when the cookie is missing, unverifiable, or expired. */
export async function requireAdmin(request: Request, env: Env): Promise<AdminAuth> {
  const token = getSessionCookie(request);
  if (!token) {
    return { ok: false, response: json({ error: 'unauthorized' }, 401) };
  }
  const payload = await verifySession(token, env.SESSION_SECRET);
  if (!payload) {
    return { ok: false, response: json({ error: 'unauthorized' }, 401) };
  }
  return { ok: true, payload };
}

/**
 * CSRF gate for state-changing admin requests (PATCH/DELETE).
 * Returns false when the header is missing or does not match the session-bound
 * token (constant-time comparison).
 */
export async function requireCsrf(request: Request, payload: SessionPayload): Promise<boolean> {
  const header = request.headers.get('x-csrf-token');
  if (!header) return false;
  return constantTimeEqual(
    utf8EncodeStrict(header),
    utf8EncodeStrict(payload.csrf),
  );
}
