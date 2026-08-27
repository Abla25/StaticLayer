/**
 * StaticLayer Web Installer — local auth.
 *
 * Installer session cookie: HMAC-signed, HttpOnly, SameSite=Lax, Path=/.
 *
 * The OAuth access token is never stored in the cookie — the token lives in a
 * server-side in-memory store keyed by a random session id.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const SESSION_ID_BYTES = 32;

function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/* ------------------------------------------------------------------ */
/* Installer session cookie                                            */
/* ------------------------------------------------------------------ */

/** Sign a value for the installer session cookie: <value>.<hmac>. */
export function signSessionValue(value: string, secret: string): string {
  return `${value}.${hmacHex(secret, value)}`;
}

/** Verify a signed session cookie value; returns the value or null. */
export function verifySessionValue(token: string, secret: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!constantTimeEqualHex(sig, hmacHex(secret, value))) return null;
  return value;
}

export function newSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString('base64url');
}

export const SESSION_COOKIE = 'SLSession';

export function sessionCookieHeader(sessionId: string, secret: string, maxAgeMs = SESSION_TTL_MS): string {
  const value = signSessionValue(sessionId, secret);
  const maxAgeSec = Math.floor(maxAgeMs / 1000);
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
