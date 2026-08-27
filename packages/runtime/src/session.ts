import {
  base64UrlToBytes,
  bytesToBase64Url,
  hmacSha256,
  utf8EncodeStrict,
  verifyHmacSha256,
} from '@staticlayer/protocol';

/**
 * Minimal stateless admin session ("JWT-like", no external dependencies).
 *
 * Token format: `<base64url(payloadJson)>.<base64url(HMAC-SHA256(SESSION_SECRET, payloadB64))>`
 *
 * Payload (canonical JSON, fixed key order):
 *   { "sub": "admin", "iat": <unix seconds>, "exp": <unix seconds>, "csrf": "<base64url>" }
 *
 * Properties (SECURITY_REVIEW.md):
 *   - absolute 2h TTL (`exp`), NO sliding renewal: every verify re-checks exp;
 *   - `csrf` is a random nonce bound to the session for the signed
 *     double-submit CSRF token (used for PATCH/DELETE in a later phase);
 *   - signed with SESSION_SECRET only — never reused for PoW or login.
 */

export interface SessionPayload {
  sub: 'admin';
  iat: number;
  exp: number;
  csrf: string;
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  // Deterministic field order is guaranteed by object literal insertion order.
  const body = JSON.stringify({
    sub: payload.sub,
    iat: payload.iat,
    exp: payload.exp,
    csrf: payload.csrf,
  });
  const bodyB64 = bytesToBase64Url(utf8EncodeStrict(body));
  const sig = await hmacSha256(utf8EncodeStrict(secret), utf8EncodeStrict(bodyB64));
  return `${bodyB64}.${bytesToBase64Url(sig)}`;
}

/**
 * Verify a session token. Returns the payload, or null for ANY invalid input
 * (bad signature, malformed encoding, wrong shape, or expired) — fail closed.
 */
export async function verifySession(token: string, secret: string): Promise<SessionPayload | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const bodyB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let sig: Uint8Array;
  try {
    sig = base64UrlToBytes(sigB64);
  } catch {
    return null;
  }
  const ok = await verifyHmacSha256(utf8EncodeStrict(secret), utf8EncodeStrict(bodyB64), sig);
  if (!ok) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(bodyB64)));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.sub !== 'admin' || typeof p.iat !== 'number' || typeof p.exp !== 'number' || typeof p.csrf !== 'string') {
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (p.exp <= nowSec) return null; // absolute TTL, no sliding renewal

  return { sub: 'admin', iat: p.iat, exp: p.exp, csrf: p.csrf };
}
