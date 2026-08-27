import { HASH_BYTES, HMAC_SHA256_BYTES } from './constants.ts';

const subtle = globalThis.crypto.subtle;

/**
 * Cryptographically secure random bytes (CSPRNG).
 * Uses `crypto.getRandomValues` — available in Workers, browsers and Node >= 19.
 */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** SHA-256 digest. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest);
}

/** HMAC-SHA256, constant-time verified by construction. */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', cryptoKey, data as BufferSource);
  return new Uint8Array(sig);
}

/**
 * Constant-time byte comparison.
 *
 * NOTE: Cloudflare Workers exposes `crypto.subtle.timingSafeEqual` as a
 * non-standard extension, but that API is NOT available in browsers. The
 * protocol package must run identically in the Worker, the client Web Worker
 * and the test runner, so we implement the comparison ourselves.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/**
 * Verify an HMAC-SHA256 signature by re-computing it and comparing in
 * constant time. Never leaks (via timing) whether a prefix matched.
 */
export async function verifyHmacSha256(
  key: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (signature.length !== HMAC_SHA256_BYTES) return false;
  const expected = await hmacSha256(key, data);
  return constantTimeEqual(expected, signature);
}

/** Assert that `digest` has the expected byte length (guards against misuse). */
export function assertDigestLength(digest: Uint8Array): void {
  if (digest.length !== HASH_BYTES) {
    throw new Error(`internal error: unexpected digest length ${digest.length}`);
  }
}
