import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { verifyAccessJwt } from '../../packages/runtime/src/admin-access.ts';
import { SECRETS, spawnWorker } from './worker.ts';

const BASE = 'http://localhost';

/**
 * "Sign in with Cloudflare" — Cloudflare Access JWT verification.
 * The pure verifier is tested with a real RS256 keypair; the endpoint is
 * tested for configuration detection and the no-token path (the full flow
 * needs a live Cloudflare Access JWKS endpoint).
 */

function b64urlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function generateKeyPair(kid: string): Promise<{ keyPair: CryptoKeyPair; jwk: { kid: string; kty: string; n: string; e: string } }> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as { kty: string; n: string; e: string };
  return { keyPair, jwk: { kid, kty: jwk.kty, n: jwk.n, e: jwk.e } };
}

async function signJwt(payload: Record<string, unknown>, keyPair: CryptoKeyPair, kid: string): Promise<string> {
  const header = { alg: 'RS256', kid };
  const h = b64urlBytes(new TextEncoder().encode(JSON.stringify(header)));
  const p = b64urlBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlBytes(new Uint8Array(sig))}`;
}

const ISSUER = 'https://myteam.cloudflareaccess.com';
const NOW = 1_700_000_000;

describe('verifyAccessJwt (pure, RS256)', () => {
  let keyPair: CryptoKeyPair;
  let jwk: { kid: string; kty: string; n: string; e: string };
  beforeAll(async () => {
    ({ keyPair, jwk } = await generateKeyPair('kid-1'));
  });

  it('accepts a valid Cloudflare Access token', async () => {
    const token = await signJwt({ iss: ISSUER, aud: ['aud-123'], exp: NOW + 3600, nbf: NOW - 60, email: 'owner@example.com' }, keyPair, 'kid-1');
    const result = await verifyAccessJwt(token, { jwks: [jwk], issuer: ISSUER, audience: 'aud-123', nowSec: NOW });
    expect(result).toEqual({ ok: true, email: 'owner@example.com' });
  });

  it('accepts a token with a string aud when no audience is enforced', async () => {
    const token = await signJwt({ iss: ISSUER, aud: 'something-else', exp: NOW + 3600, email: 'a@b.com' }, keyPair, 'kid-1');
    const result = await verifyAccessJwt(token, { jwks: [jwk], issuer: ISSUER, nowSec: NOW });
    expect(result.ok).toBe(true);
  });

  it('rejects an expired token', async () => {
    const token = await signJwt({ iss: ISSUER, exp: NOW - 10, email: 'a@b.com' }, keyPair, 'kid-1');
    expect(await verifyAccessJwt(token, { jwks: [jwk], issuer: ISSUER, nowSec: NOW })).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects a wrong issuer', async () => {
    const token = await signJwt({ iss: 'https://evil.example', exp: NOW + 3600, email: 'a@b.com' }, keyPair, 'kid-1');
    expect(await verifyAccessJwt(token, { jwks: [jwk], issuer: ISSUER, nowSec: NOW })).toMatchObject({ ok: false, reason: 'wrong issuer' });
  });

  it('rejects a wrong audience when enforced', async () => {
    const token = await signJwt({ iss: ISSUER, aud: 'other', exp: NOW + 3600, email: 'a@b.com' }, keyPair, 'kid-1');
    expect(await verifyAccessJwt(token, { jwks: [jwk], issuer: ISSUER, audience: 'aud-123', nowSec: NOW })).toMatchObject({ ok: false, reason: 'wrong audience' });
  });

  it('rejects an unknown kid', async () => {
    const token = await signJwt({ iss: ISSUER, exp: NOW + 3600, email: 'a@b.com' }, keyPair, 'kid-999');
    expect(await verifyAccessJwt(token, { jwks: [jwk], issuer: ISSUER, nowSec: NOW })).toMatchObject({ ok: false, reason: 'unknown key id' });
  });

  it('rejects a tampered signature', async () => {
    const token = await signJwt({ iss: ISSUER, exp: NOW + 3600, email: 'a@b.com' }, keyPair, 'kid-1');
    const parts = token.split('.');
    const sig = parts[2].endsWith('A') ? parts[2].slice(0, -1) + 'B' : parts[2].slice(0, -1) + 'A';
    const tampered = `${parts[0]}.${parts[1]}.${sig}`;
    expect(await verifyAccessJwt(tampered, { jwks: [jwk], issuer: ISSUER, nowSec: NOW })).toMatchObject({ ok: false, reason: 'invalid signature' });
  });

  it('rejects malformed tokens and missing email', async () => {
    expect(await verifyAccessJwt('garbage', { jwks: [jwk], issuer: ISSUER })).toMatchObject({ ok: false });
    const noEmail = await signJwt({ iss: ISSUER, exp: NOW + 3600 }, keyPair, 'kid-1');
    expect(await verifyAccessJwt(noEmail, { jwks: [jwk], issuer: ISSUER, nowSec: NOW })).toMatchObject({ ok: false, reason: 'missing email' });
  });
});

describe('admin access endpoint', () => {
  let mf: Miniflare | undefined;
  afterEach(async () => { await mf?.dispose(); mf = undefined; });

  it('reports configured=false when CF_ACCESS_TEAM is unset', async () => {
    mf = await spawnWorker();
    const res = await mf.dispatchFetch(`${BASE}/api/admin/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });

  it('reports configured=true and requires a JWT (401 without one)', async () => {
    mf = await spawnWorker({}, { CF_ACCESS_TEAM: 'myteam' });
    const res = await mf.dispatchFetch(`${BASE}/api/admin/access`);
    expect(await res.json()).toEqual({ configured: true });

    const login = await mf.dispatchFetch(`${BASE}/api/admin/access`, { method: 'POST' });
    expect(login.status).toBe(401);
  });

  it('never issues a session for an invalid/unverifiable JWT', async () => {
    mf = await spawnWorker({}, { CF_ACCESS_TEAM: 'myteam' });
    const login = await mf.dispatchFetch(`${BASE}/api/admin/access`, {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': 'x.y.z' },
    });
    // Fail closed: 4xx (bad token) or 5xx (jwks unavailable) — never 2xx.
    expect(login.status).toBeGreaterThanOrEqual(400);
    // Never issue a session cookie on failure.
    expect(login.headers.get('set-cookie')).toBeNull();
  });
});
