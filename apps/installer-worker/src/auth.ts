/**
 * Hosted installer — local auth (Web Crypto API, Cloudflare Workers).
 *
 * Port of `apps/installer/src/auth.ts` using the Web Crypto API instead of
 * node:crypto, so the installer worker needs no nodejs_compat polyfills.
 * Same protocol: HMAC-SHA256 magic links + HMAC-signed HttpOnly session cookie.
 */

const SESSION_ID_BYTES = 32;
const MAGIC_NONCE_BYTES = 16;
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
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

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function newSessionId(): string {
  return randomHex(SESSION_ID_BYTES);
}

/* ------------------------------------------------------------------ */
/* Magic link                                                          */
/* ------------------------------------------------------------------ */

export interface MagicTokenResult {
  token: string;
  link: string;
  expiresAt: number;
}

export async function createMagicToken(
  email: string,
  secret: string,
  opts: { baseUrl?: string; nowMs?: number } = {},
): Promise<MagicTokenResult> {
  const now = opts.nowMs ?? Date.now();
  const expiresAt = now + MAGIC_LINK_TTL_MS;
  const nonce = randomHex(MAGIC_NONCE_BYTES);
  const payload = `${email}|${nonce}|${expiresAt}`;
  const payloadB64 = bytesToBase64Url(enc.encode(payload));
  const token = `${payloadB64}.${await hmacHex(secret, payloadB64)}`;
  return {
    token,
    link: `${opts.baseUrl ?? 'https://staticlayer.app'}/api/auth/verify?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}

/** Returns the verified email, or null on any invalid/expired token. */
export async function verifyMagicToken(token: string, secret: string, nowMs: number = Date.now()): Promise<string | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacHex(secret, payloadB64);
  if (!constantTimeEqualHex(sig, expected)) return null;

  let payload: string;
  try {
    payload = new TextDecoder().decode(base64UrlToBytes(payloadB64));
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
