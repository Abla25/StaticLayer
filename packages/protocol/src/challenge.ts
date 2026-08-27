import { CHALLENGE_ID_BYTES, MAX_ARTICLE_PATH_BYTES, MAX_DIFFICULTY, MAX_HOST_CONTEXT_BYTES, MIN_DIFFICULTY, PROTOCOL_VERSION, UINT64_MAX } from './constants.ts';
import { hmacSha256, verifyHmacSha256 } from './crypto.ts';
import { ProtocolError } from './errors.ts';
import { utf8EncodeStrict } from './utf8.ts';

/**
 * A server-issued PoW challenge. `expiresAt` (unix seconds) and `difficulty`
 * are covered by the challenge signature, so a client cannot weaken or extend
 * a challenge without invalidating the signature.
 *
 * The challenge is STATELESS on the server: it is verified purely from the
 * fields echoed back by the client plus the signature, which is recomputed
 * with `POW_SECRET`.
 */
export interface ChallengeFields {
  version: number;
  hostContext: string;
  articlePath: string;
  challengeId: Uint8Array; // exactly CHALLENGE_ID_BYTES
  expiresAt: bigint; // unix seconds (uint64)
  difficulty: number; // leading-zero bits required by verifyPow
}

export type Secret = string | Uint8Array;

/**
 * Canonical binary encoding of a CHALLENGE (the part that gets signed).
 *
 * This is a distinct encoding from the PoW payload: it covers only the fields
 * the client is NOT allowed to alter (host context, article path, challenge
 * id, expiry, difficulty). Big-endian, length-prefixed, same UTF-8 rules.
 *
 *   offset  size  field
 *   0       1     version          uint8
 *   1       2     host_context_len uint16 BE
 *   3       n     host_context     UTF-8
 *   ...     2     article_path_len uint16 BE
 *   ...     n     article_path     UTF-8
 *   ...     32    challenge_id     raw
 *   ...     8     expires_at       uint64 BE (unix seconds)
 *   ...     1     difficulty       uint8
 */
export function encodeCanonicalChallenge(c: ChallengeFields): Uint8Array {
  if (c.version !== PROTOCOL_VERSION) {
    throw new ProtocolError(`Unsupported protocol version: ${c.version}`);
  }
  const host = utf8EncodeStrict(c.hostContext);
  const path = utf8EncodeStrict(c.articlePath);
  if (host.length > MAX_HOST_CONTEXT_BYTES) {
    throw new ProtocolError(`hostContext exceeds ${MAX_HOST_CONTEXT_BYTES} UTF-8 bytes`);
  }
  if (path.length > MAX_ARTICLE_PATH_BYTES) {
    throw new ProtocolError(`articlePath exceeds ${MAX_ARTICLE_PATH_BYTES} UTF-8 bytes`);
  }
  if (c.challengeId.length !== CHALLENGE_ID_BYTES) {
    throw new ProtocolError(`challengeId must be exactly ${CHALLENGE_ID_BYTES} bytes`);
  }
  if (c.expiresAt < 0n || c.expiresAt > UINT64_MAX) {
    throw new ProtocolError('expiresAt out of uint64 range');
  }
  assertDifficulty(c.difficulty);

  const total = 1 + 2 + host.length + 2 + path.length + CHALLENGE_ID_BYTES + 8 + 1;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;

  view.setUint8(o, c.version);
  o += 1;
  view.setUint16(o, host.length, false);
  o += 2;
  out.set(host, o);
  o += host.length;
  view.setUint16(o, path.length, false);
  o += 2;
  out.set(path, o);
  o += path.length;
  out.set(c.challengeId, o);
  o += CHALLENGE_ID_BYTES;
  view.setBigUint64(o, c.expiresAt, false);
  o += 8;
  view.setUint8(o, c.difficulty);
  o += 1;

  if (o !== total) {
    throw new ProtocolError(`internal challenge encoding error: wrote ${o} of ${total} bytes`);
  }
  return out;
}

/** Normalize a secret (string -> UTF-8 bytes). */
export function secretToBytes(secret: Secret): Uint8Array {
  return typeof secret === 'string' ? utf8EncodeStrict(secret) : secret;
}

/**
 * Sign a challenge with `POW_SECRET` (HMAC-SHA256 over the canonical
 * challenge encoding). Returns the 32-byte raw signature.
 */
export async function signChallenge(c: ChallengeFields, secret: Secret): Promise<Uint8Array> {
  const canonical = encodeCanonicalChallenge(c);
  return hmacSha256(secretToBytes(secret), canonical);
}

/**
 * Verify a challenge signature in constant time.
 *
 * Returns false — never throws — for ANY invalid input (bad signature, wrong
 * length, or a structurally invalid challenge such as an unsupported version
 * or oversized field). Attacker-controlled input can therefore never cause an
 * unhandled exception; the caller simply rejects the request.
 */
export async function verifyChallenge(
  c: ChallengeFields,
  signature: Uint8Array,
  secret: Secret,
): Promise<boolean> {
  let canonical: Uint8Array;
  try {
    canonical = encodeCanonicalChallenge(c);
  } catch {
    return false;
  }
  return verifyHmacSha256(secretToBytes(secret), canonical, signature);
}

export function assertDifficulty(difficulty: number): void {
  if (!Number.isInteger(difficulty) || difficulty < MIN_DIFFICULTY || difficulty > MAX_DIFFICULTY) {
    throw new ProtocolError(`difficulty must be an integer in [${MIN_DIFFICULTY}, ${MAX_DIFFICULTY}]`);
  }
}
