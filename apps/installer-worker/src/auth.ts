/**
 * Hosted installer — local auth (Web Crypto API, Cloudflare Workers).
 *
 * Port of `apps/installer/src/auth.ts` using the Web Crypto API instead of
 * node:crypto, so the installer worker needs no nodejs_compat polyfills.
 * Same protocol: HMAC-SHA256-signed HttpOnly session cookie.
 */

const SESSION_ID_BYTES = 32;
export const SESSION_TTL_MS = 30 * 60 * 1000;

const enc = new TextEncoder();

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newSessionId(): string {
  return randomHex(SESSION_ID_BYTES);
}

/* ------------------------------------------------------------------ */
/* Installer session cookie                                            */
/* ------------------------------------------------------------------ */

export async function signSessionValue(value: string, secret: string): Promise<string> {
  return `${value}.${await hmacHex(secret, value)}`;
}

export async function verifySessionValue(token: string, secret: string): Promise<string | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!constantTimeEqualHex(sig, await hmacHex(secret, value))) return null;
  return value;
}

export const SESSION_COOKIE = 'SLSession';

export async function sessionCookieHeader(sessionId: string, secret: string, maxAgeMs = SESSION_TTL_MS): Promise<string> {
  const value = await signSessionValue(sessionId, secret);
  const maxAgeSec = Math.floor(maxAgeMs / 1000);
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}
