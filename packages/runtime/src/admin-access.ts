import { bytesToBase64Url, base64UrlToBytes, randomBytes } from '@staticlayer/protocol';
import type { JsonWebKey } from '@cloudflare/workers-types';
import { DEFAULTS, envNumber, type Env } from './env.ts';
import { json } from './http.ts';
import { applyRateLimit } from './ratelimit.ts';
import { signSession } from './session.ts';

/**
 * "Sign in with Cloudflare" for the admin console.
 *
 * Recommended setup: protect /admin.html with **Cloudflare Access** (Zero
 * Trust) in the operator's own account. Cloudflare authenticates the operator
 * (email / SSO) at the edge and injects a `Cf-Access-Jwt-Assertion` header to
 * this Worker. We verify that JWT against the team's public keys and, on
 * success, issue the SAME stateless admin session cookie used by password
 * login — no password to remember, and identity is verified by Cloudflare
 * (the operator's own infrastructure), not by StaticLayer.
 *
 * Privacy: the JWT is verified and discarded — never stored, never logged,
 * never sent anywhere. The operator's email is returned once in the response
 * body for display only; the session cookie contains only { sub, iat, exp,
 * csrf } exactly as with password login. No IP, no fingerprint.
 *
 * Env:
 *   CF_ACCESS_TEAM     team subdomain, e.g. "myteam" (or full domain).
 *   CF_ACCESS_AUD      optional Access Application AUID to enforce in `aud`.
 *   CF_ACCESS_JWKS_URL optional JWKS endpoint override (used by tests).
 */

/** Normalize the team var to a bare host, e.g. "myteam.cloudflareaccess.com". */
export function teamDomain(env: Env): string | null {
  const raw = env.CF_ACCESS_TEAM?.trim();
  if (!raw) return null;
  const host = raw.includes('.') ? raw : `${raw}.cloudflareaccess.com`;
  return host.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// JWKS cache is per-isolate; Cloudflare rotates keys rarely, so a 1h TTL is
// safe. `fetch()` calls are only made when the operator configures Access.
/** JWK as served by Cloudflare's /cdn-cgi/access/certs (includes `kid`). */
type AccessJwk = JsonWebKey & { kid?: string };

let jwksCache: { url: string; keys: AccessJwk[]; fetchedAt: number } | undefined;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function fetchJwks(url: string): Promise<AccessJwk[]> {
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(url, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: AccessJwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('invalid jwks payload');
  jwksCache = { url, keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

interface AccessJwtHeader {
  alg?: string;
  kid?: string;
}

interface AccessJwtClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  email?: unknown;
}

export type AccessVerifyResult = { ok: true; email: string } | { ok: false; reason: string };

function decodeJsonPart<T>(part: string): T | null {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(part);
  } catch {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

/**
 * Verify a Cloudflare Access JWT (RS256) against a JWKS key set.
 * Pure function (no fetch) so it is unit-testable with a generated keypair.
 * All checks are fail-closed: bad encoding, unknown kid, wrong issuer,
 * expired token, wrong audience, invalid signature => `{ ok: false }`.
 */
export async function verifyAccessJwt(
  token: string,
  opts: { jwks: AccessJwk[]; issuer: string; audience?: string; nowSec?: number },
): Promise<AccessVerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = decodeJsonPart<AccessJwtHeader>(headerB64);
  const payload = decodeJsonPart<AccessJwtClaims>(payloadB64);
  if (!header || !payload) return { ok: false, reason: 'invalid token encoding' };
  if (header.alg !== 'RS256') return { ok: false, reason: 'unexpected algorithm' };

  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, reason: 'expired' };
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return { ok: false, reason: 'not yet valid' };
  if (payload.iss !== opts.issuer) return { ok: false, reason: 'wrong issuer' };

  if (opts.audience) {
    const aud = payload.aud;
    const matches = Array.isArray(aud) ? aud.includes(opts.audience) : aud === opts.audience;
    if (!matches) return { ok: false, reason: 'wrong audience' };
  }

  const email = typeof payload.email === 'string' && payload.email.length > 0 && payload.email.length <= 320 ? payload.email : '';
  if (!email) return { ok: false, reason: 'missing email' };

  const jwk = opts.jwks.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown key id' };

  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(sigB64);
  } catch {
    return { ok: false, reason: 'invalid signature encoding' };
  }

  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, data as BufferSource);
    if (!valid) return { ok: false, reason: 'invalid signature' };
  } catch {
    return { ok: false, reason: 'signature verification failed' };
  }

  return { ok: true, email };
}

/** GET /api/admin/access — is "Sign in with Cloudflare" configured? */
export function handleAdminAccessStatus(request: Request, env: Env): Response {
  return json({ configured: teamDomain(env) !== null });
}

/** POST /api/admin/access — verify the Cf-Access-Jwt-Assertion and log in. */
export async function handleAdminAccessLogin(request: Request, env: Env): Promise<Response> {
  const limited = await applyRateLimit(env.RATE_LIMITER, 'login');
  if (limited) return limited;

  const team = teamDomain(env);
  if (!team) return json({ error: 'cloudflare access is not configured' }, 501);

  const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? '';
  if (!token) return json({ error: 'no access token' }, 401);

  const jwksUrl = env.CF_ACCESS_JWKS_URL?.trim() || `https://${team}/cdn-cgi/access/certs`;
  let keys: AccessJwk[];
  try {
    keys = await fetchJwks(jwksUrl);
  } catch (err) {
    return json({ error: `jwks unavailable: ${(err as Error).message}` }, 502);
  }

  const verified = await verifyAccessJwt(token, {
    jwks: keys,
    issuer: `https://${team}`,
    audience: env.CF_ACCESS_AUD?.trim() || undefined,
  });
  if (!verified.ok) return json({ error: `invalid access token: ${verified.reason}` }, 401);

  const ttl = envNumber(env.SESSION_TTL_SECONDS, DEFAULTS.SESSION_TTL_SECONDS);
  const nowSec = Math.floor(Date.now() / 1000);
  const csrf = bytesToBase64Url(randomBytes(32));
  const session = await signSession(
    { sub: 'admin', iat: nowSec, exp: nowSec + ttl, csrf, method: 'cloudflare' },
    env.SESSION_SECRET,
  );
  const cookie = `__Host-StaticLayerSession=${session}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl}`;

  return json({ csrf, email: verified.email, via: 'cloudflare-access' }, 200, { 'set-cookie': cookie });
}
