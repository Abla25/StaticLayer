/**
 * @staticlayer/protocol — StaticLayer v1 PoW protocol.
 *
 * Canonical BINARY encoding, hashing, challenge signing/verification and PoW
 * verification. Zero runtime dependencies; Web Crypto only, so the exact same
 * module runs in the Cloudflare Worker, the client Web Worker and the test
 * runner and produces identical byte sequences.
 *
 * Primary API (per spec):
 *   - encodeCanonicalPayload()
 *   - hashPayload()
 *   - signChallenge()
 *   - verifyChallenge()
 *   - verifyPow()
 */

export { PROTOCOL_VERSION, CHALLENGE_ID_BYTES, HASH_BYTES, NONCE_BYTES, UINT64_MAX, MAX_HOST_CONTEXT_BYTES, MAX_ARTICLE_PATH_BYTES, MAX_NICKNAME_BYTES, MAX_BODY_BYTES, MIN_DIFFICULTY, MAX_DIFFICULTY, DEFAULT_DIFFICULTY, HMAC_SHA256_BYTES } from './constants.ts';
export { ProtocolError } from './errors.ts';
export { hasUnpairedSurrogate, utf8EncodeStrict, utf8DecodeStrict } from './utf8.ts';
export { encodeCanonicalPayload, decodeCanonicalPayload, serializeNonce, parseNonce, type CanonicalPayload } from './encoding.ts';
export { randomBytes, sha256, hmacSha256, constantTimeEqual, verifyHmacSha256 } from './crypto.ts';
export { bytesToBase64Url, base64UrlToBytes, bytesToHex, hexToBytes } from './base64url.ts';
export { encodeCanonicalChallenge, signChallenge, verifyChallenge, assertDifficulty, type ChallengeFields, type Secret } from './challenge.ts';
export { verifyPow, verifyPowFields, mineNonce, leadingZeroBits, type MineOptions } from './pow.ts';

import { sha256 as sha256Impl } from './crypto.ts';
import { utf8EncodeStrict } from './utf8.ts';

/** Encode a JS string to UTF-8 bytes (same encoding rules as the protocol). */
export function utf8ToBytes(s: string): Uint8Array {
  return utf8EncodeStrict(s);
}

/**
 * Hash a canonical payload with SHA-256. Returns the raw 32-byte digest.
 *
 * The client and the server MUST produce the exact same digest for the same
 * logical payload; the fixed test vectors in `test/test-vectors.ts` enforce
 * this property against independently computed values.
 */
export async function hashPayload(canonicalPayload: Uint8Array): Promise<Uint8Array> {
  return sha256Impl(canonicalPayload);
}
