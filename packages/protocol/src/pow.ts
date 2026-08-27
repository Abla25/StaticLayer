import { MAX_DIFFICULTY, MIN_DIFFICULTY, UINT64_MAX } from './constants.ts';
import { sha256 } from './crypto.ts';
import {
  encodeCanonicalPayload,
  encodeCanonicalPollPayload,
  encodeCanonicalPollPayloadMulti,
  type CanonicalPayload,
  type PollCanonicalPayload,
  type PollMultiCanonicalPayload,
} from './encoding.ts';
import { ProtocolError } from './errors.ts';

/**
 * Number of leading zero bits in a SHA-256 digest.
 * Used to express PoW difficulty as "the first `d` bits of the digest are 0".
 */
export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let b = byte;
    while ((b & 0x80) === 0) {
      bits += 1;
      b = (b << 1) & 0xff;
    }
    break;
  }
  return bits;
}

function assertDifficulty(difficulty: number): void {
  if (!Number.isInteger(difficulty) || difficulty < MIN_DIFFICULTY || difficulty > MAX_DIFFICULTY) {
    throw new ProtocolError(`difficulty must be an integer in [${MIN_DIFFICULTY}, ${MAX_DIFFICULTY}]`);
  }
}

/**
 * Verify a proof of work over a CANONICAL ENCODED payload.
 *
 * The client finds a `nonce` such that
 *   leadingZeroBits(SHA-256(encodeCanonicalPayload({...nonce}))) >= difficulty
 *
 * Because the encoding is canonical and SHA-256 is deterministic, any
 * implementation (Worker, browser Web Worker, test harness) reaches the exact
 * same verdict for the same logical payload — enforced by fixed vectors.
 */
export async function verifyPow(canonicalPayload: Uint8Array, difficulty: number): Promise<boolean> {
  assertDifficulty(difficulty);
  const digest = await sha256(canonicalPayload);
  return leadingZeroBits(digest) >= difficulty;
}

/** Convenience: encode the logical payload, then verify PoW. */
export async function verifyPowFields(
  payload: CanonicalPayload,
  difficulty: number,
): Promise<boolean> {
  return verifyPow(encodeCanonicalPayload(payload), difficulty);
}

export interface MineOptions {
  /** First nonce to try (default 0). */
  startNonce?: bigint;
  /** Upper bound on attempts before giving up (default 2^32). */
  maxAttempts?: bigint;
}

/**
 * Find a nonce satisfying `difficulty` for a payload without a nonce yet.
 *
 * Used by the client-side Web Worker to solve challenges, and by tests to
 * construct valid proofs from fixed vectors. For difficulty d the expected
 * number of attempts is 2^d.
 */
export async function mineNonce(
  base: Omit<CanonicalPayload, 'nonce'>,
  difficulty: number,
  options: MineOptions = {},
): Promise<bigint> {
  assertDifficulty(difficulty);
  const start = options.startNonce ?? 0n;
  const maxAttempts = options.maxAttempts ?? (1n << 32n);
  if (start < 0n || start > UINT64_MAX) {
    throw new ProtocolError('startNonce out of uint64 range');
  }

  let nonce = start;
  for (let i = 0n; i < maxAttempts; i++) {
    if (nonce > UINT64_MAX) break;
    const payload = encodeCanonicalPayload({ ...base, nonce });
    const digest = await sha256(payload);
    if (leadingZeroBits(digest) >= difficulty) {
      return nonce;
    }
    nonce += 1n;
  }
  throw new ProtocolError(`mineNonce: no nonce satisfying difficulty ${difficulty} within ${maxAttempts} attempts`);
}

/** Same as mineNonce but over the POLL payload schema (encodeCanonicalPollPayload). */
export async function minePollNonce(
  base: Omit<PollCanonicalPayload, 'nonce'>,
  difficulty: number,
  options: MineOptions = {},
): Promise<bigint> {
  assertDifficulty(difficulty);
  const start = options.startNonce ?? 0n;
  const maxAttempts = options.maxAttempts ?? (1n << 32n);
  if (start < 0n || start > UINT64_MAX) {
    throw new ProtocolError('startNonce out of uint64 range');
  }

  let nonce = start;
  for (let i = 0n; i < maxAttempts; i++) {
    if (nonce > UINT64_MAX) break;
    const payload = encodeCanonicalPollPayload({ ...base, nonce });
    const digest = await sha256(payload);
    if (leadingZeroBits(digest) >= difficulty) {
      return nonce;
    }
    nonce += 1n;
  }
  throw new ProtocolError(`minePollNonce: no nonce satisfying difficulty ${difficulty} within ${maxAttempts} attempts`);
}

/** Same as minePollNonce but over the MULTI-SELECT poll schema. */
export async function minePollNonceMulti(
  base: Omit<PollMultiCanonicalPayload, 'nonce'>,
  difficulty: number,
  options: MineOptions = {},
): Promise<bigint> {
  assertDifficulty(difficulty);
  const start = options.startNonce ?? 0n;
  const maxAttempts = options.maxAttempts ?? (1n << 32n);
  if (start < 0n || start > UINT64_MAX) {
    throw new ProtocolError('startNonce out of uint64 range');
  }

  let nonce = start;
  for (let i = 0n; i < maxAttempts; i++) {
    if (nonce > UINT64_MAX) break;
    const payload = encodeCanonicalPollPayloadMulti({ ...base, nonce });
    const digest = await sha256(payload);
    if (leadingZeroBits(digest) >= difficulty) {
      return nonce;
    }
    nonce += 1n;
  }
  throw new ProtocolError(`minePollNonceMulti: no nonce satisfying difficulty ${difficulty} within ${maxAttempts} attempts`);
}
