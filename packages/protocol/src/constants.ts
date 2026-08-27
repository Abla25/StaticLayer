/**
 * Protocol constants and hard limits (schema v1).
 *
 * Limits are expressed in BYTES of the UTF-8 encoding, not code points.
 * These are the authoritative values used by both the Worker runtime and the
 * client-side Web Worker, so the canonical byte sequence is identical on both.
 */

/** Canonical schema version. Bumped only on a breaking wire change. */
export const PROTOCOL_VERSION = 1;

/** Length of a challenge id in bytes (CSPRNG-generated). */
export const CHALLENGE_ID_BYTES = 32;

/** Length of the SHA-256 digest in bytes. */
export const HASH_BYTES = 32;

/** Length of the PoW nonce in bytes (uint64, big-endian). */
export const NONCE_BYTES = 8;

/** Maximum value of a uint64. */
export const UINT64_MAX = (1n << 64n) - 1n;

/** Max host context length (UTF-8 bytes). */
export const MAX_HOST_CONTEXT_BYTES = 255;

/** Max article path length (UTF-8 bytes). */
export const MAX_ARTICLE_PATH_BYTES = 255;

/** Max nickname length (UTF-8 bytes). */
export const MAX_NICKNAME_BYTES = 50;

/** Max comment body length (UTF-8 bytes). */
export const MAX_BODY_BYTES = 3000;

/** PoW difficulty bounds, in leading-zero bits of the SHA-256 digest. */
export const MIN_DIFFICULTY = 0;
export const MAX_DIFFICULTY = 256;

/** Default difficulty used when a challenge does not specify one. */
export const DEFAULT_DIFFICULTY = 16;

/** HMAC-SHA256 output length in bytes. */
export const HMAC_SHA256_BYTES = 32;
