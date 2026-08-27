/**
 * StaticLayer Web Installer — local auth.
 *
 * Two layers:
 *  1. Magic-link login (email ownership proof). The token is HMAC-signed and
 *     short-lived; it only proves "you can read that mailbox" to gate the
 *     installer UI. In dev mode (no SMTP) the server returns the link directly.
 *  2. Installer session cookie: HMAC-signed, HttpOnly, SameSite=Lax, Path=/.
 *
 * Neither layer stores the OAuth access token in the cookie — the token lives
 * in a server-side in-memory store keyed by a random session id.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const SESSION_ID_BYTES = 32;
const MAGIC_NONCE_BYTES = 16;

function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/* ------------------------------------------------------------------ */
/* Magic link                                                          */
/* ------------------------------------------------------------------ */

export interface MagicTokenResult {
  token: string;
  link: string;
  expiresAt: number;
}

export function createMagicToken(
  email: string,
  secret: string,
  opts: { baseUrl?: string; nowMs?: number } = {},
): MagicTokenResult {
  const now = opts.nowMs ?? Date.now();
  const expiresAt = now + MAGIC_LINK_TTL_MS;
  const nonce = randomBytes(MAGIC_NONCE_BYTES).toString('hex');
  const payload = `${email}|${nonce}|${expiresAt}`;
  // Sign the base64url form — the exact string that travels in the token —
  // so verification (which decodes the same string) recomputes the same HMAC.
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const token = `${payloadB64}.${hmacHex(secret, payloadB64)}`;
  return {
    token,
    link: `${opts.baseUrl ?? 'http://localhost:8788'}/api/auth/verify?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}

/** Returns the verified email, or null on any invalid/expired token. */
export function verifyMagicToken(token: string, secret: string, nowMs: number = Date.now()): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmacHex(secret, payloadB64);
  if (!constantTimeEqualHex(sig, expected)) return null;

  let payload: string;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = payload.split('|');
  if (parts.length !== 3) return null;
  const [email, , expiresAtStr] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return null;
  if (typeof email !== 'string' || email.length === 0 || email.length > 320) return null;
  return email;
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
